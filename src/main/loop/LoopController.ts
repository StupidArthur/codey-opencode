import { randomBytes } from 'node:crypto'
import type { ExecutionOutcome, LoopTerminalSummary, PermissionPreset, RunnerEvent } from '../../shared/contracts'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentRuntime } from '../runtime/AgentRuntime'
import { TURN_CANCELLED_MESSAGE, TURN_DEADLINE_MESSAGE } from '../runtime/AgentRuntime'
import type { EvidenceCollector } from '../evidence/EvidenceCollector'
import type { EvidenceBundle, FileStateMap, ToolCallFact, VerificationRequest, VerificationRun, VerificationExecutorFn, WorkspaceSnapshot } from '../evidence/evidence'
import { VERIFY_DIR, inputFingerprint } from '../evidence/evidence'
import { describeMethod } from '../evidence/VerificationExecutor'
import { LoopEvaluator, type CheckRequest, type LoopDecision, type SandboxScript, type WorkspaceHints } from './LoopEvaluator'
import { decisionInstruction, decisionReAskPrompt, extractDecision, type ModelDecisionShape } from './ModelDecision'

/** One pending sandbox check request. `rid` is the nonce identity of the
 *  request; `fingerprint` is the input snapshot the check was requested
 *  against. A request persists until its inputs change or the loop stops
 *  needing it; the nonce artifact paths keep a previous request's leftovers
 *  from ever satisfying the current one. */
interface SandboxRequest {
  rid: string
  fingerprint: string
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}

/** The repository-script kind a sandbox wrapper script name belongs to
 *  (`tests.cmd` → 'tests'), or undefined for unknown names. */
function sandboxKindOfScript(name: string): 'tests' | 'typecheck' | 'build' | undefined {
  if (!name.endsWith('.cmd')) return undefined
  const kind = name.slice(0, -'.cmd'.length)
  return kind === 'tests' || kind === 'typecheck' || kind === 'build' ? kind : undefined
}

export interface LoopBudget {
  maxContinuations: number
  maxElapsedMs: number
  maxNoProgress: number
  maxSameError: number
}

/** Frozen V1 defaults from the final system design. */
export const DEFAULT_LOOP_BUDGET: LoopBudget = {
  maxContinuations: 16,
  maxElapsedMs: 2 * 60 * 60 * 1000,
  maxNoProgress: 3,
  maxSameError: 2
}

export interface LoopRunInput {
  /** Acceptance-focused spec evaluated by the completion gate. */
  rootSpec: string
  /** Full frozen Plan shown to the build agent but not parsed as requirements. */
  executionContext?: string
  workspacePath: string
  /** Session permission preset the verification executor must obey. */
  permission: PermissionPreset
  takeEvents: () => RunnerEvent[]
  /** User-requested cancellation checked between model turns and product checks. */
  isCancelled?: () => boolean
}

export interface LoopRunResult {
  terminal: LoopTerminalSummary
  finalResponse: string
  evidence: EvidenceBundle
  continuations: number
  decision?: LoopDecision
}

/** Structured blocker marker the model is instructed to emit; not a broad regex. */
const BLOCKED_MARKER = /^\[BLOCKED\]/m

/**
 * Evidence-gated loop with a four-condition completion gate. Completion is
 * combines model-assessed semantic coverage with product-validated evidence,
 * current workspace inputs and counter-evidence. Sandbox checks are reported
 * artifacts, not independently captured child-process exits; non-code tasks
 * may cite product-observed artifacts when no runnable checks exist.
 * The remaining gaps and workspace issues become the next continuation prompt.
 * Budgets stop the loop.
 */
export class LoopController {
  private readonly evaluator = new LoopEvaluator()
  /** Pending sandbox check requests (kind → identity + input snapshot). */
  private readonly sandboxRequests = new Map<string, SandboxRequest>()

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly collector: EvidenceCollector,
    private readonly budget: LoopBudget = DEFAULT_LOOP_BUDGET,
    /** Wall-clock source; injectable so budget boundaries are testable without waiting. */
    private readonly now: () => number = Date.now,
    private readonly verify?: VerificationExecutorFn
  ) {}

  async run(input: LoopRunInput): Promise<LoopRunResult> {
    const startedAt = this.now()
    const deadline = startedAt + this.budget.maxElapsedMs
    const errorCounts = new Map<string, number>()
    const startSnapshot = await this.collector.baseline(input.workspacePath)
    const changedTurnByFile = new Map<string, number>()
    const hints = await workspaceHints(input.workspacePath)
    let prevSnapshot = startSnapshot
    let allRuns: VerificationRun[] = []
    let noProgress = 0
    let continuations = 0
    let turn = 0
    let finalResponse = ''
    let prompt = decisionInstruction(input.rootSpec, input.executionContext)
    let failure: string | undefined
    let lastDecision: LoopDecision | undefined
    let lastIncompleteCount = Number.MAX_SAFE_INTEGER
    let lastModelIncompleteCount = Number.MAX_SAFE_INTEGER
    const knownCheckSignatures = new Set<string>()

    throwIfCancelled(input)
    for (;;) {
      throwIfCancelled(input)
      // Budget before entering a turn: an exhausted loop must not start
      // another model round just because the previous turn ended cleanly.
      if (this.now() >= deadline) {
        return this.finish('budget_exhausted', 'Loop reached the 2 hour wall-clock budget before the next turn.', finalResponse, bundleOf(allRuns), continuations, lastDecision)
      }
      turn += 1
      failure = undefined
      let text = ''
      try {
        text = (await this.runtime.prompt(prompt, { timeoutMs: Math.max(deadline - this.now(), 1_000), agent: 'build' })).text
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }
      if (failure?.includes(TURN_CANCELLED_MESSAGE)) throw new Error(TURN_CANCELLED_MESSAGE)
      throwIfCancelled(input)
      const events = input.takeEvents()
      const toolFacts = (this.runtime.takeToolFacts?.() ?? []).map((fact: ToolCallFact) => ({ ...fact, turn }))
      const outcome: ExecutionOutcome = failure ? 'failed' : 'completed'
      const { bundle, snapshot } = await this.collector.collect(
        input.workspacePath, startSnapshot, prevSnapshot, events, toolFacts, outcome
      )
      prevSnapshot = snapshot
      for (const file of bundle.turnChangedFiles) changedTurnByFile.set(file, turn)
      bundle.verification = allRuns

      if (failure) {
        // A deadline termination is a budget exhaustion, not a runtime error:
        // it must be classified before the repeated-error rule can rename it.
        if (failure.includes(TURN_DEADLINE_MESSAGE)) {
          return this.finish(
            'budget_exhausted',
            "Loop reached the wall-clock budget during a model turn; the turn was cancelled through the backend's public abort API and the collected evidence is preserved.",
            finalResponse, bundle, continuations, lastDecision
          )
        }
        const count = (errorCounts.get(failure) ?? 0) + 1
        errorCounts.set(failure, count)
        if (count >= this.budget.maxSameError) {
          return this.finish('failed', `Same error repeated ${count} times: ${truncate(failure)}`, finalResponse, bundle, continuations, lastDecision)
        }
      } else {
        finalResponse = text

        // The model's structured decision: parsed and schema-validated here,
        // with ONE strict re-ask when the block is missing or malformed.
        let modelDecision: ModelDecisionShape | undefined
        let decisionError: string | undefined
        if (!failure) {
          const parsed = extractDecision(text)
          if (parsed.ok) {
            modelDecision = parsed.decision
          } else if (this.now() < deadline) {
            throwIfCancelled(input)
            const reAskDeadline = Math.max(deadline - this.now(), 1_000)
            try {
              const reAsk = await this.runtime.prompt(decisionReAskPrompt(parsed.error), { timeoutMs: reAskDeadline, agent: 'build' })
              const reParsed = extractDecision(reAsk.text)
              if (reParsed.ok) {
                modelDecision = reParsed.decision
                text = `${text}\n\n${reAsk.text}`
              } else {
                decisionError = reParsed.error
              }
            } catch (error) {
              decisionError = `re-ask for the decision block failed: ${error instanceof Error ? error.message : String(error)}`
            }
            const reAskFacts = (this.runtime.takeToolFacts?.() ?? []).map((fact: ToolCallFact) => ({ ...fact, turn }))
            bundle.toolFacts = [...bundle.toolFacts, ...reAskFacts]
          } else {
            decisionError = parsed.error
          }
        }

        // `fileStates` defaults to the turn's collected snapshot; the callers
        // that run checks pass a FRESH re-read of the workspace so a change
        // that happened while the checks were running is caught before any
        // terminal accepts the checks' outcome (see `reDecideAfterChecks`).
        const decide = (fileStates: FileStateMap = snapshot.fileStates): LoopDecision => this.evaluator.decide({
          rootSpec: input.rootSpec, bundle, fileStates, changedTurnByFile, turn, hints,
          permission: input.permission, sandboxRequests: this.sandboxRequests,
          ...(modelDecision ? { modelDecision } : {}), ...(decisionError ? { decisionError } : {})
        })
        let decision = decide()
        lastDecision = decision
        if (decision.decision === 'completed') {
          // A nominally complete state that arrives after the deadline is not
          // accepted as completion.
          if (this.now() >= deadline) {
            return this.finish('budget_exhausted', 'Loop reached the 2 hour wall-clock budget; a nominally complete state arrived after the deadline and is not accepted as completed.', finalResponse, bundle, continuations, decision)
          }
          return this.finish('completed', decision.reason, finalResponse, bundle, continuations, decision)
        }
        if (decision.decision === 'blocked') {
          // The model's blocked call is final, but the product still runs its
          // own suggested checks first so the terminal Remaining names what
          // actually passed and what is missing (available evidence for every
          // terminal state). Sandbox checks are resolved against the current
          // request identity so a leftover artifact can never fake a pass here.
          const rids = this.reconcileSandboxRequests(decision, snapshot.fileStates)
          if (this.verify && decision.nextChecks.length > 0 && this.now() < deadline) {
            throwIfCancelled(input)
            const checkDeadline = Math.max(deadline - this.now(), 1_000)
            const blockedRuns: VerificationRun[] = []
            for (const request of decision.nextChecks) {
              throwIfCancelled(input)
              try {
                blockedRuns.push(await this.verify(this.withRequest(request, input, turn, checkDeadline, rids)))
              } catch (error) {
                blockedRuns.push({
                  id: `verr-b${blockedRuns.length}-${turn}`,
                  turn, label: request.label, method: request.method.kind === 'shell' ? 'shell' : 'builtin',
                  command: describeMethod(request.method),
                  exitCode: null, signal: null, outputTail: String((error as Error)?.message ?? error).slice(0, 300),
                  scope: request.scope, targets: request.targets, facts: [], stamps: new Map(),
                  outcome: 'observed', at: new Date().toISOString()
                })
              }
            }
            if (blockedRuns.length > 0) {
              allRuns = allRuns.concat(blockedRuns)
              bundle.verification = allRuns
              // Re-decide with the same blocked model decision: the terminal
              // stays blocked, now with the checks' facts in the evidence.
              // The decision runs against a FRESH workspace read so an input
              // change during the checks refuses the runs as current evidence.
              decision = decide(await this.freshFileStates(input.workspacePath, startSnapshot))
              lastDecision = decision
            }
          }
          return this.finish('blocked', decision.reason, finalResponse, bundle, continuations, decision)
        }
        // Plain-text [BLOCKED] markers are candidate information only: they
        // are honored as a blocked terminal only when no structured decision
        // exists, and the saved decision still carries the remaining items.
        if (!modelDecision && BLOCKED_MARKER.test(text)) {
          return this.finish('blocked', 'The model reported that it needs user input to continue.', finalResponse, bundle, continuations, decision)
        }

        // Sandbox requests are reconciled against the CURRENT input snapshot
        // before any check runs: a request is re-created (fresh nonce +
        // fingerprint) whenever the workspace inputs no longer match, so the
        // checks this turn always target the request the current inputs belong
        // to and a leftover artifact from a previous request cannot pass.
        const rids = this.reconcileSandboxRequests(decision, snapshot.fileStates)
        const newRuns: VerificationRun[] = []
        if (this.verify && decision.nextChecks.length > 0 && this.now() < deadline) {
          throwIfCancelled(input)
          const checkDeadline = Math.max(deadline - this.now(), 1_000)
          for (const request of decision.nextChecks) {
            throwIfCancelled(input)
            try {
              newRuns.push(await this.verify(this.withRequest(request, input, turn, checkDeadline, rids)))
            } catch (error) {
              newRuns.push({
                id: `verr-${newRuns.length}-${turn}`,
                turn, label: request.label, method: request.method.kind === 'shell' ? 'shell' : 'builtin',
                command: describeMethod(request.method),
                exitCode: null, signal: null, outputTail: String((error as Error)?.message ?? error).slice(0, 300),
                scope: request.scope, targets: request.targets, facts: [], stamps: new Map(),
                outcome: 'observed', at: new Date().toISOString()
              })
            }
          }
        }
        if (newRuns.length > 0) {
          allRuns = allRuns.concat(newRuns)
          bundle.verification = allRuns
          // TODO 7 A: the product re-reads the workspace AFTER the checks ran
          // and verifies the inputs still match the fingerprints the checks
          // were requested against. A change during the check window makes
          // those runs invalid (runValid refuses the fingerprint binding), so
          // completion cannot be accepted on stale evidence and the next
          // continuation re-requests the checks against the current snapshot.
          decision = decide(await this.freshFileStates(input.workspacePath, startSnapshot))
          lastDecision = decision
          if (decision.decision === 'completed') {
            if (this.now() >= deadline) {
              return this.finish('budget_exhausted', 'Loop reached the 2 hour wall-clock budget; a nominally complete state arrived after the deadline and is not accepted as completed.', finalResponse, bundle, continuations, decision)
            }
            return this.finish('completed', decision.reason, finalResponse, bundle, continuations, decision)
          }
        }

        // Meaningful progress only: content changes (hash-based, so identical
        // rewrites do not count), NEW passing checks (a repeated pass of the
        // same check object does not count), or a shrinking requirement list —
        // both the product's parsed items and the model's own coverage.
        const newDistinctPass = newRuns.some((run) =>
          run.outcome === 'passed'
          && !knownCheckSignatures.has(checkSignature(run))
        )
        for (const run of newRuns) {
          if (run.outcome === 'passed') knownCheckSignatures.add(checkSignature(run))
        }
        const progressed = bundle.turnChangedFiles.length > 0
          || newDistinctPass
          || decision.incomplete.length < lastIncompleteCount
          || (modelDecision ? modelDecision.incomplete.length < lastModelIncompleteCount : false)
        lastIncompleteCount = decision.incomplete.length
        if (modelDecision) lastModelIncompleteCount = modelDecision.incomplete.length
        noProgress = progressed ? 0 : noProgress + 1
        if (noProgress >= this.budget.maxNoProgress) {
          return this.finish('failed', `No progress after ${noProgress} consecutive continuations.`, finalResponse, bundle, continuations, decision)
        }

        // Sandbox verification wrappers are product material: written by the
        // controller (workspace-write only) under request-specific nonce names,
        // run by the model inside the active agent backend's tool execution, verified by the
        // product's own executor against the same nonce artifacts. The exact
        // commands are appended to the next prompt so the model runs THIS
        // request's scripts, never a stale copy.
        let promptExtra = ''
        if (decision.sandboxScripts.length > 0) {
          throwIfCancelled(input)
          promptExtra = await this.materializeSandboxScripts(decision.sandboxScripts, rids, input.workspacePath)
        }
        prompt = promptExtra ? `${decision.nextPrompt}\n\n${promptExtra}` : decision.nextPrompt
      }

      if (this.now() >= deadline) {
        return this.finish('budget_exhausted', 'Loop reached the 2 hour wall-clock budget.', finalResponse, bundle, continuations, lastDecision)
      }
      if (continuations >= this.budget.maxContinuations) {
        return this.finish('budget_exhausted', `Loop reached the ${this.budget.maxContinuations} continuation budget.`, finalResponse, bundle, continuations, lastDecision)
      }
      continuations += 1
      if (failure) prompt = continueAfterFailure(input.rootSpec, bundle, failure)
    }
  }

  /** Re-read the workspace's current file states. Used after checks have run:
   *  the product verifies the inputs that the checks were requested against
   *  did not change while the checks were executing. */
  private async freshFileStates(workspacePath: string, startSnapshot: WorkspaceSnapshot): Promise<FileStateMap> {
    return this.collector.currentFileStates(workspacePath, startSnapshot)
  }

  /** Attach the loop's execution context (cwd, turn, deadline, permission) and,
   *  for sandbox checks, resolve the request-specific nonce artifact paths,
   *  request id, input fingerprint and stable check object. */
  private withRequest(request: CheckRequest, input: LoopRunInput, turn: number, timeoutMs: number, rids: ReadonlyMap<string, string>): VerificationRequest {
    const base: VerificationRequest = {
      ...request,
      cwd: input.workspacePath,
      turn,
      timeoutMs,
      permission: { preset: input.permission, workspacePath: input.workspacePath }
    }
    if (!request.sandbox) return base
    const rid = rids.get(request.sandbox.kind)
    if (!rid) return base
    const exit = `${VERIFY_DIR}/${request.sandbox.kind}-${rid}.exit`
    const log = `${VERIFY_DIR}/${request.sandbox.kind}-${rid}.log`
    return {
      ...base,
      // The method and targets are request-specific: the check reads the
      // artifact THIS request produces, so a leftover `.exit` from a previous
      // request or a previous Round cannot satisfy it.
      method: { kind: 'content-equals', target: exit, expected: '0' },
      targets: [exit, log],
      requestId: rid,
      inputFingerprint: this.sandboxRequests.get(request.sandbox.kind)?.fingerprint,
      checkObject: `sandbox:${request.sandbox.kind}`
    }
  }

  /** Reconcile the pending sandbox requests against the current input snapshot:
   *  a request is kept while its inputs still match, re-created with a fresh
   *  nonce + fingerprint when they do not. Returns the current rid per kind. */
  private reconcileSandboxRequests(decision: LoopDecision, fileStates: FileStateMap): Map<string, string> {
    const rids = new Map<string, string>()
    if (decision.sandboxScripts.length === 0) return rids
    const fingerprint = inputFingerprint(fileStates)
    for (const script of decision.sandboxScripts) {
      const kind = sandboxKindOfScript(script.name)
      if (!kind) continue
      const current = this.sandboxRequests.get(kind)
      if (!current || current.fingerprint !== fingerprint) {
        this.sandboxRequests.set(kind, { rid: randomHex(8), fingerprint })
      }
      rids.set(kind, this.sandboxRequests.get(kind)!.rid)
    }
    return rids
  }

  /** Materialize this decision's sandbox wrappers under their request-specific
   *  nonce names and return the exact commands the model must run next. */
  private async materializeSandboxScripts(scripts: SandboxScript[], rids: ReadonlyMap<string, string>, workspacePath: string): Promise<string> {
    const dir = join(workspacePath, VERIFY_DIR)
    await mkdir(dir, { recursive: true })
    const lines: string[] = []
    for (const script of scripts) {
      const kind = sandboxKindOfScript(script.name)
      const rid = kind ? rids.get(kind) : undefined
      if (!kind || !rid) continue
      const resolved: SandboxScript = {
        name: `${kind}-${rid}.cmd`,
        command: `cmd /c ${VERIFY_DIR}\\${kind}-${rid}.cmd`,
        content: [
          '@echo off',
          'cd /d "%~dp0.."',
          // `call` is required: npm/pnpm are batch files themselves, and
          // invoking one from a batch without `call` transfers control — the
          // exit-code line would never run.
          `call ${script.script ?? ''} > "%~dp0${kind}-${rid}.log" 2>&1`,
          `echo %ERRORLEVEL% > "%~dp0${kind}-${rid}.exit"`,
          ''
        ].join('\r\n')
      }
      await writeFile(join(dir, resolved.name), resolved.content, { encoding: 'utf8' })
      lines.push(`- ${resolved.command}`)
    }
    if (lines.length === 0) return ''
    return ['Run these verification scripts exactly as written so the product can verify the results:', ...lines].join('\n')
  }

  private finish(
    status: LoopTerminalSummary['status'],
    reason: string,
    finalResponse: string,
    evidence: EvidenceBundle,
    continuations: number,
    decision?: LoopDecision
  ): LoopRunResult {
    return { terminal: { status, reason }, finalResponse, evidence, continuations, ...(decision ? { decision } : {}) }
  }
}

/** A minimal bundle for terminals that happen outside a collected turn
 *  (the pre-turn budget exit) so already-recorded runs are never dropped. */
function bundleOf(runs: VerificationRun[]): EvidenceBundle {
  return {
    changedFiles: [], turnChangedFiles: [], newFiles: [], deletedFiles: [], preexistingChanges: [],
    toolFacts: [], verification: runs, outcome: 'failed'
  }
}

async function workspaceHints(workspacePath: string): Promise<WorkspaceHints> {  const hints: WorkspaceHints = { packageJson: false, hasTypecheckScript: false, hasTestScript: false, hasBuildScript: false, tsconfig: false }
  try {
    const manifest = JSON.parse(await readFile(join(workspacePath, 'package.json'), 'utf8'))
    hints.packageJson = true
    const scripts: Record<string, string> = manifest.scripts ?? {}
    hints.hasTypecheckScript = typeof scripts.typecheck === 'string'
    hints.hasTestScript = typeof scripts.test === 'string'
    hints.hasBuildScript = typeof scripts.build === 'string'
  } catch { /* no package.json */ }
  try {
    await readFile(join(workspacePath, 'tsconfig.json'))
    hints.tsconfig = true
  } catch { /* no tsconfig */ }
  return hints
}

function continueAfterFailure(rootSpec: string, evidence: EvidenceBundle, failure: string): string {
  const changed = evidence.changedFiles.slice(0, 10).join(', ') || 'none'
  const lines = [
    'The previous attempt failed. Continue the original task; do not repeat the same error.',
    `Original spec: ${truncate(rootSpec, 1500)}`,
    `Changed files so far: ${changed}`,
    `The previous attempt failed with: ${truncate(failure)}`,
    'End your reply with the temporal-decision block as instructed.'
  ]
  return lines.join('\n')
}

/** Identity of a check object: a re-run of the same check does not count as
 *  new progress even when it passes again. Sandbox runs share the stable
 *  `sandbox:<kind>` object across request nonces. */
function checkSignature(run: VerificationRun): string {
  if (run.checkObject) return run.checkObject
  return `${run.method}|${run.command}|${[...run.targets].sort().join(',')}`
}

function truncate(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function throwIfCancelled(input: LoopRunInput): void {
  if (input.isCancelled?.()) throw new Error(TURN_CANCELLED_MESSAGE)
}
