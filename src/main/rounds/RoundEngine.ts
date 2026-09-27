import { randomUUID } from 'node:crypto'
import type { EvidenceSummary, ExecutionOutcome, LoopTerminalSummary, RoundMode, RoundStatus, RoundSummary, RunnerEvent, SessionSummary } from '../../shared/contracts'
import type { AgentRuntime } from '../runtime/AgentRuntime'
import { TURN_CANCELLED_MESSAGE } from '../runtime/AgentRuntime'
import type { EvidenceCollector } from '../evidence/EvidenceCollector'
import type { EvidenceBundle, VerificationExecutorFn, VerificationRun } from '../evidence/evidence'
import { LoopController } from '../loop/LoopController'
import type { ProductStore } from '../persistence/ProductStore'
import { planGuidance } from '../plan/PlanGuidance'
import type { ResultBuilder } from '../result/ResultBuilder'

export interface RoundEngineDeps {
  store: ProductStore
  /** Lazily start the runtime composition for this product mode. */
  ensureRuntime: (mode: RoundMode) => Promise<AgentRuntime>
  evidence: EvidenceCollector
  resultBuilder: ResultBuilder
  /** Returns and clears the runner events accumulated since the last execution. */
  takeEvents: () => RunnerEvent[]
  /** Product-owned verification executor; the only source of passed/failed checks. */
  verify?: VerificationExecutorFn
  /** True after the user requests cancellation of the current submit. */
  isCancellationRequested?: () => boolean
  /** High-level phase timing for performance diagnostics. */
  onDiagnostic?: (type: string, payload?: unknown) => void
  onRoundChanged?: () => Promise<void> | void
}

export interface SubmitInput {
  session: SessionSummary
  mode: RoundMode
  spec: string
}

/**
 * Turns one user submit into a product Round. Plan/Vibe reuse their open
 * Round; Loop always creates a fresh Round and runs to a terminal state.
 */
export class RoundEngine {
  constructor(private readonly deps: RoundEngineDeps) {}

  async submit(input: SubmitInput): Promise<{ roundId: string; outcome: ExecutionOutcome }> {
    const { store } = this.deps
    const rounds = store.listRounds(input.session.id)
    const open = rounds.at(-1)
    if (open?.status === 'active' && open.mode !== input.mode) await this.finalize(input.session, open)
    if (open?.status === 'active' && open.mode === 'loop') await this.finalizeLoopInterrupted(input.session, open)
    if (input.mode === 'loop') return this.submitLoop(input)

    const current = store.listRounds(input.session.id).at(-1)
    const round = current?.status === 'active' && current.mode === input.mode
      ? current
      : this.createRound(input.session, input.mode, input.spec)
    return this.submitDirect(input, round, input.mode)
  }

  private async submitDirect(input: SubmitInput, round: RoundSummary, mode: 'plan' | 'vibe'): Promise<{ roundId: string; outcome: ExecutionOutcome }> {
    const { store } = this.deps
    store.markRoundExecutionStarted(input.session.id, round.id)
    try {
      throwIfCancelled(this.deps.isCancellationRequested)
      const runtime = await this.deps.ensureRuntime(mode)
      throwIfCancelled(this.deps.isCancellationRequested)
      const baselineStartedAt = Date.now()
      this.deps.onDiagnostic?.('evidence.baseline.start', { mode, roundId: round.id })
      const baseline = await this.deps.evidence.baseline(input.session.workspacePath)
      this.deps.onDiagnostic?.('evidence.baseline.end', { mode, roundId: round.id, durationMs: Date.now() - baselineStartedAt })
      throwIfCancelled(this.deps.isCancellationRequested)
      // Plan turns carry product-owned guidance on the SAME OpenCode session; the
      // stored plan version keeps the user's original spec verbatim.
      const prompt = mode === 'plan' ? planGuidance(input.spec) : input.spec
      const promptStartedAt = Date.now()
      this.deps.onDiagnostic?.('model.prompt.start', { mode, roundId: round.id })
      const { text } = await runtime.prompt(prompt, { agent: mode === 'plan' ? 'plan' : 'build' })
      this.deps.onDiagnostic?.('model.prompt.end', { mode, roundId: round.id, durationMs: Date.now() - promptStartedAt, chars: text.length })
      const toolFacts = (runtime.takeToolFacts?.() ?? []).map((fact) => ({ ...fact, turn: 1 }))
      const collectStartedAt = Date.now()
      this.deps.onDiagnostic?.('evidence.collect.start', { mode, roundId: round.id })
      const { bundle } = await this.deps.evidence.collect(
        input.session.workspacePath, baseline, baseline, this.deps.takeEvents(), toolFacts, 'completed'
      )
      this.deps.onDiagnostic?.('evidence.collect.end', { mode, roundId: round.id, durationMs: Date.now() - collectStartedAt, changedFiles: bundle.changedFiles.length, toolFacts: toolFacts.length })
      this.saveEvidence(round.id, bundle)
      if (mode === 'plan') {
        store.appendPlanVersion(round.id, { id: randomUUID(), submittedSpec: input.spec, planMarkdown: text, createdAt: new Date().toISOString() })
      } else {
        store.appendVibeEntry(round.id, { id: randomUUID(), specMarkdown: input.spec, assistantOutput: text, executionOutcome: 'completed', createdAt: new Date().toISOString() })
      }
      round.bodyMarkdown = text
      round.updatedAt = new Date().toISOString()
      store.saveRound(input.session.id, round)
      store.markRoundExecutionFinished(input.session.id, round.id, 'active')
      if (round.title === 'New Session' || !round.title) round.title = titleFor(input.spec, mode)
      await this.deps.onRoundChanged?.()
      return { roundId: round.id, outcome: 'completed' }
    } catch (error) {
      if (isCancelled(error, this.deps.isCancellationRequested)) {
        if (mode === 'vibe') {
          store.appendVibeEntry(round.id, {
            id: randomUUID(),
            specMarkdown: input.spec,
            assistantOutput: '',
            executionOutcome: 'interrupted',
            createdAt: new Date().toISOString()
          })
        }
        round.updatedAt = new Date().toISOString()
        store.saveRound(input.session.id, round)
        try { store.markRoundExecutionFinished(input.session.id, round.id, 'active') } catch { /* already inactive */ }
        await this.deps.onRoundChanged?.()
        return { roundId: round.id, outcome: 'interrupted' }
      }
      this.terminate(input.session, round, 'failed')
      await this.deps.onRoundChanged?.()
      throw error
    }
  }

  async endCurrent(session: SessionSummary): Promise<void> {
    const open = this.deps.store.listRounds(session.id).at(-1)
    if (open?.status === 'active') await this.finalize(session, open)
  }

  private async submitLoop(input: SubmitInput): Promise<{ roundId: string; outcome: ExecutionOutcome }> {
    const { store } = this.deps
    const round = this.createRound(input.session, 'loop', input.spec)
    store.markRoundExecutionStarted(input.session.id, round.id)
    try {
      throwIfCancelled(this.deps.isCancellationRequested)
      const runtime = await this.deps.ensureRuntime('loop')
      throwIfCancelled(this.deps.isCancellationRequested)
      const loop = new LoopController(runtime, this.deps.evidence, undefined, Date.now, this.deps.verify)
      const result = await loop.run({
        rootSpec: input.spec,
        workspacePath: input.session.workspacePath,
        permission: input.session.permission,
        takeEvents: this.deps.takeEvents,
        isCancelled: this.deps.isCancellationRequested
      })
      this.saveEvidence(round.id, result.evidence)
      const document = this.deps.resultBuilder.build({
        finalResponse: result.finalResponse,
        evidence: result.evidence,
        outcome: result.terminal.status === 'completed' ? 'completed' : 'failed',
        loopTerminal: result.terminal,
        decision: result.decision,
        round: {
          mode: 'loop',
          turns: [{
            spec: input.spec,
            outcome: result.terminal.status === 'completed' ? 'completed' : result.terminal.status === 'blocked' ? 'blocked' : 'failed',
            output: result.finalResponse
          }]
        }
      })
      store.saveResult(round.id, document)
      this.terminate(input.session, round, toRoundStatus(result.terminal.status), result.finalResponse)
      await this.deps.onRoundChanged?.()
      return { roundId: round.id, outcome: result.terminal.status === 'completed' ? 'completed' : 'failed' }
    } catch (error) {
      if (isCancelled(error, this.deps.isCancellationRequested)) {
        this.terminate(input.session, round, 'interrupted')
        await this.deps.onRoundChanged?.()
        return { roundId: round.id, outcome: 'interrupted' }
      }
      this.terminate(input.session, round, 'failed')
      await this.deps.onRoundChanged?.()
      throw error
    }
  }

  /** Finalize an open Plan/Vibe Round; Vibe gets a top-level Result document
   *  built from the WHOLE conversation of the round, not the last reply. */
  private async finalize(session: SessionSummary, round: RoundSummary): Promise<void> {
    const { store } = this.deps
    if (round.mode === 'vibe') {
      const entries = store.listVibeEntries(round.id)
      const last = entries.at(-1)
      const evidence = bundleFromRecords(store.listEvidence(round.id))
      const document = this.deps.resultBuilder.build({
        finalResponse: last?.assistantOutput ?? '',
        evidence,
        outcome: last?.executionOutcome ?? 'completed',
        round: {
          mode: 'vibe',
          turns: entries.map((entry) => ({ spec: entry.specMarkdown, outcome: entry.executionOutcome, output: entry.assistantOutput }))
        }
      })
      store.saveResult(round.id, document)
    } else if (round.mode === 'plan') {
      // A Plan round also records what the phase produced: every version.
      const versions = store.listPlanVersions(round.id)
      if (versions.length > 0) {
        const evidence = bundleFromRecords(store.listEvidence(round.id))
        const document = this.deps.resultBuilder.build({
          finalResponse: versions.at(-1)?.planMarkdown ?? '',
          evidence,
          outcome: 'completed',
          round: {
            mode: 'plan',
            turns: versions.map((version) => ({ spec: version.submittedSpec, outcome: 'completed' as const, output: version.planMarkdown }))
          }
        })
        store.saveResult(round.id, document)
      }
    }
    round.status = 'completed'
    round.updatedAt = new Date().toISOString()
    store.saveRound(session.id, round)
    await this.deps.onRoundChanged?.()
  }

  /** Move a Round to a terminal status, tolerating an already-inactive runtime. */
  private terminate(session: SessionSummary, round: RoundSummary, status: RoundStatus, body?: string): void {
    round.updatedAt = new Date().toISOString()
    if (body !== undefined) round.bodyMarkdown = body
    try { this.deps.store.markRoundExecutionFinished(session.id, round.id, status) }
    catch { /* runtime already inactive; the status write below is what matters */ }
    round.status = status
    this.deps.store.saveRound(session.id, round)
  }

  private async finalizeLoopInterrupted(session: SessionSummary, round: RoundSummary): Promise<void> {
    this.terminate(session, round, 'interrupted')
  }

  private createRound(session: SessionSummary, mode: RoundMode, spec: string): RoundSummary {
    const rounds = this.deps.store.listRounds(session.id)
    const title = titleFor(spec, mode)
    if (session.title === 'New Session') {
      session.title = title
      this.deps.store.saveSession(session)
    }
    const round: RoundSummary = {
      id: randomUUID(),
      sequence: rounds.length + 1,
      mode,
      status: 'active',
      title,
      updatedAt: new Date().toISOString(),
      bodyMarkdown: ''
    }
    this.deps.store.saveRound(session.id, round)
    return round
  }

  private saveEvidence(roundId: string, evidence: EvidenceBundle): void {
    for (const record of this.deps.evidence.toRecords(evidence)) this.deps.store.saveEvidence(roundId, record)
  }
}

function bundleFromRecords(records: EvidenceSummary[]): EvidenceBundle {
  const changedFiles: string[] = []
  const newFiles: string[] = []
  const deletedFiles: string[] = []
  const verification: VerificationRun[] = []
  let gitDiffSummary: string | undefined
  for (const record of records) {
    if (record.kind === 'workspace' && record.label === 'git diff --stat') { gitDiffSummary = record.detail; continue }
    if (record.kind === 'workspace') {
      changedFiles.push(record.label)
      if (record.detail === 'created') newFiles.push(record.label)
      if (record.detail === 'deleted') deletedFiles.push(record.label)
    } else if (record.kind === 'command') {
      verification.push({
        id: record.id, turn: record.turn ?? 1, label: record.label,
        method: record.command?.startsWith('builtin:') ? 'builtin' : 'shell',
        command: record.command ?? record.label,
        exitCode: record.exitCode ?? null, signal: null, outputTail: record.detail,
        // Sandbox runs are workspace-scoped regardless of their (nonce)
        // artifact targets; reconstructed here from the persisted identity.
        scope: record.checkObject ? 'workspace' : record.targets && record.targets.length > 0 ? 'file' : 'workspace',
        targets: record.targets ?? [], facts: record.facts ?? [], stamps: new Map(),
        outcome: record.denial ? 'denied' : record.outcome === 'observed' ? 'observed' : record.outcome,
        ...(record.denial ? { denial: record.denial } : {}),
        ...(record.requestId ? { requestId: record.requestId } : {}),
        ...(record.inputFingerprint ? { inputFingerprint: record.inputFingerprint } : {}),
        ...(record.checkObject ? { checkObject: record.checkObject } : {}),
        at: record.observedAt
      })
    }
  }
  return {
    changedFiles: [...new Set(changedFiles)],
    turnChangedFiles: [],
    newFiles: [...new Set(newFiles)],
    deletedFiles: [...new Set(deletedFiles)],
    preexistingChanges: [],
    ...(gitDiffSummary ? { gitDiffSummary } : {}), toolFacts: [], verification, outcome: 'completed'
  }
}

function toRoundStatus(status: LoopTerminalSummary['status']): RoundStatus {
  return status
}

function titleFor(spec: string, mode: RoundMode): string {
  const line = spec.split('\n').find((part) => part.trim() && !part.trimStart().startsWith('#'))
  return line?.trim().slice(0, 64) || mode
}

function throwIfCancelled(probe?: () => boolean): void {
  if (probe?.()) throw new Error(TURN_CANCELLED_MESSAGE)
}

function isCancelled(error: unknown, probe?: () => boolean): boolean {
  return probe?.() === true || (error instanceof Error && error.message === TURN_CANCELLED_MESSAGE)
}
