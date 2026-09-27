import { randomUUID } from 'node:crypto'
import type { EvidenceSummary, ExecutionOutcome, InteractiveMode, LoopTerminalSummary, RoundMode, RoundStatus, RoundSummary, RunOutcome, RunnerEvent, SessionSummary } from '../../shared/contracts'
import type { AgentRuntime } from '../runtime/AgentRuntime'
import { TURN_CANCELLED_MESSAGE } from '../runtime/AgentRuntime'
import type { EvidenceCollector } from '../evidence/EvidenceCollector'
import type { EvidenceBundle, VerificationExecutorFn, VerificationRun, WorkspaceSnapshot as EvidenceWorkspaceSnapshot } from '../evidence/evidence'
import { LoopController } from '../loop/LoopController'
import type { ProductStore } from '../persistence/ProductStore'
import { evaluatePlanReadiness, loopPlanGuidance } from '../plan/PlanGuidance'
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
  mode: InteractiveMode
  spec: string
}

/**
 * New work has two modes. Vibe executes immediately with the build agent.
 * Loop first builds a read-only, versioned execution contract; autonomous
 * execution is a separate explicit transition after the plan quality gate.
 */
export class RoundEngine {
  constructor(private readonly deps: RoundEngineDeps) {}

  async submit(input: SubmitInput): Promise<{ roundId: string; outcome: RunOutcome }> {
    const { store } = this.deps
    const open = store.listRounds(input.session.id).at(-1)
    if (open?.status === 'active' && open.mode !== input.mode) await this.finalize(input.session, open)

    const current = store.listRounds(input.session.id).at(-1)
    if (input.mode === 'loop') {
      const round = current?.status === 'active' && current.mode === 'loop'
        ? current
        : this.createRound(input.session, 'loop', input.spec)
      if (round.loopPhase === 'running') throw new Error('Loop 已开始执行，不能在当前 Run 中修改 Plan。')
      return this.submitLoopPlan(input, round)
    }

    const round = current?.status === 'active' && current.mode === 'vibe'
      ? current
      : this.createRound(input.session, 'vibe', input.spec)
    return this.submitVibe(input, round)
  }

  private async submitVibe(input: SubmitInput, round: RoundSummary): Promise<{ roundId: string; outcome: RunOutcome }> {
    const { store } = this.deps
    store.markRoundExecutionStarted(input.session.id, round.id)
    try {
      throwIfCancelled(this.deps.isCancellationRequested)
      const runtime = await this.deps.ensureRuntime('vibe')
      throwIfCancelled(this.deps.isCancellationRequested)
      const baselineStartedAt = Date.now()
      this.deps.onDiagnostic?.('evidence.baseline.start', { mode: 'vibe', roundId: round.id })
      const baseline = await this.deps.evidence.baseline(input.session.workspacePath)
      store.saveRoundBaseline(round.id, serializeEvidenceSnapshot(baseline))
      this.deps.onDiagnostic?.('evidence.baseline.end', { mode: 'vibe', roundId: round.id, durationMs: Date.now() - baselineStartedAt })
      throwIfCancelled(this.deps.isCancellationRequested)

      const promptStartedAt = Date.now()
      this.deps.onDiagnostic?.('model.prompt.start', { mode: 'vibe', roundId: round.id })
      const { text } = await runtime.prompt(input.spec, { agent: 'build' })
      this.deps.onDiagnostic?.('model.prompt.end', { mode: 'vibe', roundId: round.id, durationMs: Date.now() - promptStartedAt, chars: text.length })
      const toolFacts = (runtime.takeToolFacts?.() ?? []).map((fact) => ({ ...fact, turn: 1 }))
      const { bundle } = await this.deps.evidence.collect(
        input.session.workspacePath, baseline, baseline, this.deps.takeEvents(), toolFacts, 'completed'
      )
      this.saveEvidence(round.id, bundle)
      store.appendVibeEntry(round.id, {
        id: randomUUID(), specMarkdown: input.spec, assistantOutput: text,
        executionOutcome: 'completed', createdAt: new Date().toISOString()
      })
      round.bodyMarkdown = text
      round.updatedAt = new Date().toISOString()
      store.saveRound(input.session.id, round)
      store.markRoundExecutionFinished(input.session.id, round.id, 'active')
      await this.deps.onRoundChanged?.()
      return { roundId: round.id, outcome: 'completed' }
    } catch (error) {
      if (isCancelled(error, this.deps.isCancellationRequested)) {
        store.appendVibeEntry(round.id, {
          id: randomUUID(), specMarkdown: input.spec, assistantOutput: '',
          executionOutcome: 'interrupted', createdAt: new Date().toISOString()
        })
        round.updatedAt = new Date().toISOString()
        store.saveRound(input.session.id, round)
        try { store.markRoundExecutionFinished(input.session.id, round.id, 'active') } catch { /* already inactive */ }
        await this.deps.onRoundChanged?.()
        return { roundId: round.id, outcome: 'interrupted' }
      }
      const failure = messageOf(error)
      store.appendVibeEntry(round.id, {
        id: randomUUID(), specMarkdown: input.spec,
        assistantOutput: failure ? `执行失败：${failure}` : '执行失败。',
        executionOutcome: 'failed', createdAt: new Date().toISOString()
      })
      round.bodyMarkdown = failure ? `执行失败：${failure}` : '执行失败。'
      round.updatedAt = new Date().toISOString()
      store.saveRound(input.session.id, round)
      try { store.markRoundExecutionFinished(input.session.id, round.id, 'active') } catch { /* already inactive */ }
      await this.deps.onRoundChanged?.()
      throw error
    }
  }

  private async submitLoopPlan(input: SubmitInput, round: RoundSummary): Promise<{ roundId: string; outcome: RunOutcome }> {
    const { store } = this.deps
    round.loopPhase = 'planning'
    store.saveRound(input.session.id, round)
    store.markRoundExecutionStarted(input.session.id, round.id)
    try {
      throwIfCancelled(this.deps.isCancellationRequested)
      const runtime = await this.deps.ensureRuntime('loop')
      throwIfCancelled(this.deps.isCancellationRequested)
      const baseline = await this.deps.evidence.baseline(input.session.workspacePath)
      const previous = store.listPlanVersions(round.id).at(-1)
      const prompt = loopPlanGuidance(input.spec, previous?.planMarkdown)
      const { text } = await runtime.prompt(prompt, { agent: 'plan' })
      const toolFacts = (runtime.takeToolFacts?.() ?? []).map((fact) => ({ ...fact, turn: 1 }))
      const { bundle } = await this.deps.evidence.collect(
        input.session.workspacePath, baseline, baseline, this.deps.takeEvents(), toolFacts, 'completed'
      )
      this.saveEvidence(round.id, bundle)

      const readiness = evaluatePlanReadiness(text)
      store.appendPlanVersion(round.id, {
        id: randomUUID(),
        submittedSpec: input.spec,
        planMarkdown: text,
        readiness,
        createdAt: new Date().toISOString()
      })
      round.bodyMarkdown = text
      round.loopPhase = readiness.ready ? 'ready' : 'planning'
      round.updatedAt = new Date().toISOString()
      store.saveRound(input.session.id, round)
      store.markRoundExecutionFinished(input.session.id, round.id, 'active')
      await this.deps.onRoundChanged?.()
      return { roundId: round.id, outcome: 'completed' }
    } catch (error) {
      round.loopPhase = 'planning'
      round.updatedAt = new Date().toISOString()
      store.saveRound(input.session.id, round)
      try { store.markRoundExecutionFinished(input.session.id, round.id, 'active') } catch { /* already inactive */ }
      await this.deps.onRoundChanged?.()
      if (isCancelled(error, this.deps.isCancellationRequested)) return { roundId: round.id, outcome: 'interrupted' }
      throw error
    }
  }

  async endCurrent(session: SessionSummary): Promise<void> {
    const open = this.deps.store.listRounds(session.id).at(-1)
    if (open?.status === 'active') await this.finalize(session, open)
  }

  /** Reconcile executions that died with the app. The store owns the
   *  runtime_active crash marker; the engine reconstructs the historical
   *  document so every terminal Round still has a Result. */
  async reconcileInterrupted(session: SessionSummary): Promise<void> {
    const { store } = this.deps
    if (store.reconcileInterruptedRounds(session.id) === 0) return

    for (const round of store.listRounds(session.id)) {
      if (round.status !== 'interrupted' || store.getResult(round.id)) continue
      let evidence = bundleFromRecords(store.listEvidence(round.id), 'interrupted')
      const savedBaseline = store.getRoundBaseline(round.id)
      if (savedBaseline) {
        try {
          const baseline = deserializeEvidenceSnapshot(savedBaseline)
          const projected = await this.deps.evidence.collect(
            session.workspacePath, baseline, baseline, [], [], 'interrupted'
          )
          projected.bundle.verification = evidence.verification
          evidence = projected.bundle
          store.deleteEvidenceKind(round.id, 'workspace')
          for (const record of this.deps.evidence.toRecords(evidence)) {
            if (record.kind === 'workspace') store.saveEvidence(round.id, record)
          }
        } catch {
          // Persisted evidence remains the fallback when workspace projection
          // cannot be reconstructed after a crash.
        }
      }

      if (round.mode === 'vibe') {
        const entries = store.listVibeEntries(round.id)
        const last = entries.at(-1)
        store.saveResult(round.id, this.deps.resultBuilder.build({
          finalResponse: last?.assistantOutput ?? round.bodyMarkdown,
          evidence,
          outcome: 'interrupted',
          round: {
            mode: 'vibe',
            turns: entries.map((entry) => ({
              spec: entry.specMarkdown,
              outcome: entry.executionOutcome,
              output: entry.assistantOutput
            }))
          }
        }))
        continue
      }

      if (round.mode === 'plan') {
        const versions = store.listPlanVersions(round.id)
        store.saveResult(round.id, this.deps.resultBuilder.build({
          finalResponse: versions.at(-1)?.planMarkdown ?? round.bodyMarkdown,
          evidence,
          outcome: 'interrupted',
          round: {
            mode: 'plan',
            turns: versions.map((version) => ({
              spec: version.submittedSpec,
              outcome: 'completed' as const,
              output: version.planMarkdown
            }))
          }
        }))
        continue
      }

      store.saveResult(round.id, this.deps.resultBuilder.build({
        finalResponse: round.bodyMarkdown,
        evidence,
        outcome: 'interrupted',
        loopTerminal: {
          status: 'interrupted',
          reason: '应用在 Loop 执行期间退出；已按重启时可观察到的 Workspace 状态恢复结果。'
        },
        round: {
          mode: 'loop',
          turns: [{ spec: round.title, outcome: 'interrupted', output: round.bodyMarkdown }]
        }
      }))
    }
  }

  async startLoop(session: SessionSummary): Promise<{ roundId: string; outcome: RunOutcome }> {
    const { store } = this.deps
    const open = store.listRounds(session.id).at(-1)
    if (!open || open.status !== 'active' || open.mode !== 'loop') throw new Error('当前没有可启动的 Loop Round。')
    const versions = store.listPlanVersions(open.id)
    const plan = versions.at(-1)
    if (!plan?.readiness?.ready) throw new Error('Plan 尚未通过质量门槛，不能启动 Loop。')
    if (open.loopPhase !== 'ready') throw new Error('Loop Plan 尚未进入 Ready 状态。')

    store.approveLoopPlan(session.id, open.id, plan.id)
    const round = store.listRounds(session.id).find(item => item.id === open.id) ?? { ...open, loopPhase: 'running' as const, approvedPlanVersionId: plan.id }
    store.markRoundExecutionStarted(session.id, round.id)

    let runtime: AgentRuntime | undefined
    let cancellationBaseline: EvidenceWorkspaceSnapshot | undefined
    try {
      throwIfCancelled(this.deps.isCancellationRequested)
      runtime = await this.deps.ensureRuntime('loop')
      throwIfCancelled(this.deps.isCancellationRequested)
      cancellationBaseline = await this.deps.evidence.baseline(session.workspacePath)
      store.saveRoundBaseline(round.id, serializeEvidenceSnapshot(cancellationBaseline))

      const loop = new LoopController(runtime, this.deps.evidence, undefined, Date.now, this.deps.verify)
      const result = await loop.run({
        rootSpec: loopAcceptanceSpec(plan.planMarkdown),
        executionContext: plan.planMarkdown,
        workspacePath: session.workspacePath,
        permission: session.permission,
        takeEvents: this.deps.takeEvents,
        isCancelled: this.deps.isCancellationRequested
      })
      this.saveEvidence(round.id, result.evidence)
      const executionOutcome = toExecutionOutcome(result.terminal.status)
      const document = this.deps.resultBuilder.build({
        finalResponse: result.finalResponse,
        evidence: result.evidence,
        outcome: executionOutcome,
        loopTerminal: result.terminal,
        decision: result.decision,
        round: {
          mode: 'loop',
          turns: [{
            spec: plan.planMarkdown,
            outcome: executionOutcome,
            output: result.finalResponse
          }]
        }
      })
      round.status = toRoundStatus(result.terminal.status)
      round.loopPhase = 'terminal'
      round.bodyMarkdown = result.finalResponse
      round.updatedAt = new Date().toISOString()
      store.commitRoundTerminal(session.id, round, document)
      await this.deps.onRoundChanged?.()
      return { roundId: round.id, outcome: result.terminal.status }
    } catch (error) {
      if (isCancelled(error, this.deps.isCancellationRequested)) {
        let evidence = bundleFromRecords(store.listEvidence(round.id), 'interrupted')
        if (cancellationBaseline) {
          try {
            const toolFacts = (runtime?.takeToolFacts?.() ?? []).map((fact) => ({ ...fact, turn: 1 }))
            const collected = await this.deps.evidence.collect(
              session.workspacePath,
              cancellationBaseline,
              cancellationBaseline,
              this.deps.takeEvents(),
              toolFacts,
              'interrupted'
            )
            evidence = collected.bundle
            this.saveEvidence(round.id, evidence)
          } catch {
            // Preserve the Result even when the final workspace observation fails.
          }
        }
        const terminal: LoopTerminalSummary = {
          status: 'interrupted',
          reason: '用户中止了当前 Loop；已保留中止时能够观察到的工作区结果。'
        }
        const document = this.deps.resultBuilder.build({
          finalResponse: '',
          evidence,
          outcome: 'interrupted',
          loopTerminal: terminal,
          round: {
            mode: 'loop',
            turns: [{ spec: plan.planMarkdown, outcome: 'interrupted', output: '' }]
          }
        })
        round.status = 'interrupted'
        round.loopPhase = 'terminal'
        round.updatedAt = new Date().toISOString()
        store.commitRoundTerminal(session.id, round, document)
        await this.deps.onRoundChanged?.()
        return { roundId: round.id, outcome: 'interrupted' }
      }

      const evidence = bundleFromRecords(store.listEvidence(round.id), 'failed')
      const document = this.deps.resultBuilder.build({
        finalResponse: '',
        evidence,
        outcome: 'failed',
        loopTerminal: { status: 'failed', reason: messageOf(error) },
        round: {
          mode: 'loop',
          turns: [{ spec: plan.planMarkdown, outcome: 'failed', output: '' }]
        }
      })
      round.status = 'failed'
      round.loopPhase = 'terminal'
      round.updatedAt = new Date().toISOString()
      store.commitRoundTerminal(session.id, round, document)
      await this.deps.onRoundChanged?.()
      throw error
    }
  }

  /** Finalize an open Plan/Vibe Round. The terminal page is committed
   *  atomically, and Vibe Changes are re-projected from the Round baseline so
   *  edit-then-revert activity does not masquerade as a final workspace delta. */
  private async finalize(session: SessionSummary, round: RoundSummary): Promise<void> {
    const { store } = this.deps
    let document: ReturnType<ResultBuilder['build']> | undefined

    if (round.mode === 'vibe') {
      const entries = store.listVibeEntries(round.id)
      const last = entries.at(-1)
      let evidence = bundleFromRecords(store.listEvidence(round.id), last?.executionOutcome ?? 'completed')
      const savedBaseline = store.getRoundBaseline(round.id)
      if (savedBaseline) {
        try {
          const baseline = deserializeEvidenceSnapshot(savedBaseline)
          const projected = await this.deps.evidence.collect(
            session.workspacePath,
            baseline,
            baseline,
            [],
            [],
            last?.executionOutcome ?? 'completed'
          )
          // Verification history remains factual across the Round; workspace
          // observations are replaced by the final baseline→current projection.
          projected.bundle.verification = evidence.verification
          evidence = projected.bundle
          store.deleteEvidenceKind(round.id, 'workspace')
          for (const record of this.deps.evidence.toRecords(evidence)) {
            if (record.kind === 'workspace') store.saveEvidence(round.id, record)
          }
        } catch {
          // Older or corrupt baselines fall back to the persisted evidence
          // projection rather than preventing the Round from closing.
        }
      }
      document = this.deps.resultBuilder.build({
        finalResponse: last?.assistantOutput ?? '',
        evidence,
        outcome: last?.executionOutcome ?? 'completed',
        round: {
          mode: 'vibe',
          turns: entries.map((entry) => ({ spec: entry.specMarkdown, outcome: entry.executionOutcome, output: entry.assistantOutput }))
        }
      })
    } else if (round.mode === 'plan') {
      const versions = store.listPlanVersions(round.id)
      if (versions.length > 0) {
        const evidence = bundleFromRecords(store.listEvidence(round.id))
        document = this.deps.resultBuilder.build({
          finalResponse: versions.at(-1)?.planMarkdown ?? '',
          evidence,
          outcome: 'completed',
          round: {
            mode: 'plan',
            turns: versions.map((version) => ({ spec: version.submittedSpec, outcome: 'completed' as const, output: version.planMarkdown }))
          }
        })
      }
    } else if (round.mode === 'loop') {
      const versions = store.listPlanVersions(round.id)
      const latest = versions.at(-1)
      const evidence = bundleFromRecords(store.listEvidence(round.id), 'interrupted')
      document = this.deps.resultBuilder.build({
        finalResponse: latest?.planMarkdown ?? '',
        evidence,
        outcome: 'interrupted',
        loopTerminal: {
          status: 'interrupted',
          reason: 'Loop 在 Planning 阶段结束，尚未启动自治执行。'
        },
        round: {
          mode: 'loop',
          turns: [{ spec: latest?.submittedSpec ?? round.title, outcome: 'interrupted', output: latest?.planMarkdown ?? '' }]
        }
      })
      round.status = 'interrupted'
      round.loopPhase = 'terminal'
      round.updatedAt = new Date().toISOString()
      store.commitRoundTerminal(session.id, round, document)
      await this.deps.onRoundChanged?.()
      return
    }

    round.status = 'completed'
    round.updatedAt = new Date().toISOString()
    store.commitRoundTerminal(session.id, round, document)
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
      bodyMarkdown: '',
      ...(mode === 'loop' ? { loopPhase: 'planning' as const } : {})
    }
    this.deps.store.saveRound(session.id, round)
    return round
  }

  private saveEvidence(roundId: string, evidence: EvidenceBundle): void {
    for (const record of this.deps.evidence.toRecords(evidence)) this.deps.store.saveEvidence(roundId, record)
  }
}

function serializeEvidenceSnapshot(snapshot: EvidenceWorkspaceSnapshot): string {
  return JSON.stringify({
    git: snapshot.git,
    preexisting: [...snapshot.preexisting],
    files: [...snapshot.files.entries()],
    dirty: [...snapshot.dirty.entries()],
    fileStates: [...snapshot.fileStates.entries()]
  })
}

function deserializeEvidenceSnapshot(raw: string): EvidenceWorkspaceSnapshot {
  const parsed = JSON.parse(raw) as {
    git: boolean
    preexisting: string[]
    files: Array<[string, { mtimeMs: number; size: number; hash?: string }]>
    dirty: Array<[string, string]>
    fileStates: Array<[string, { exists: boolean; mtimeMs: number; size: number; hash?: string }]>
  }
  return {
    git: parsed.git,
    preexisting: new Set(parsed.preexisting),
    files: new Map(parsed.files),
    dirty: new Map(parsed.dirty),
    fileStates: new Map(parsed.fileStates)
  }
}

function bundleFromRecords(records: EvidenceSummary[], outcome: ExecutionOutcome = 'completed'): EvidenceBundle {
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
    ...(gitDiffSummary ? { gitDiffSummary } : {}), toolFacts: [], verification, outcome
  }
}

function toRoundStatus(status: LoopTerminalSummary['status']): RoundStatus {
  return status
}

function toExecutionOutcome(status: LoopTerminalSummary['status']): ExecutionOutcome {
  return status === 'budget_exhausted' ? 'failed' : status
}

function loopAcceptanceSpec(planMarkdown: string): string {
  const sections = new Map<string, string[]>()
  let current = ''
  for (const line of planMarkdown.split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (heading) {
      current = heading[1].trim().toLowerCase()
      sections.set(current, [])
      continue
    }
    if (current) sections.get(current)?.push(line)
  }

  const acceptance = (sections.get('acceptance criteria') ?? []).join('\n').trim()
  const verificationLines = (sections.get('verification') ?? [])
    .map(line => /^\s*(?:[-*+] |\d+[.)]\s+)(.+)$/.exec(line)?.[1]?.trim())
    .filter((line): line is string => Boolean(line))
    .map(line => {
      const unquoted = line.replace(/^\`([^\`]+)\`$/, '$1')
      return /^(?:run|verify|check|exec|execute|运行|验证|执行|检查)\s*[:：]/i.test(unquoted)
        ? unquoted
        : `Verify: ${unquoted}`
    })

  return [
    acceptance || '- Satisfy every Acceptance Criteria item in the approved Plan.',
    ...verificationLines
  ].join('\n')
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


function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
