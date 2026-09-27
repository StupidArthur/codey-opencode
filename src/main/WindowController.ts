import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import type { BrowserWindow } from 'electron'
import type {
  HistoryState, ModelSettings, PermissionPreset, RoundMode, RunnerEvent,
  SessionListResult, SessionSummary, WorkspaceSnapshot
} from '../shared/contracts'
import { IPC } from '../shared/contracts'
import { EvidenceCollector } from './evidence/EvidenceCollector'
import { VerificationExecutor } from './evidence/VerificationExecutor'
import { SessionLogger } from './logging/SessionLogger'
import { OpenCodeRuntime } from './opencode/OpenCodeRuntime'
import { ProductStore, type SessionLease } from './persistence/ProductStore'
import { ResultBuilder } from './result/ResultBuilder'
import { RoundEngine } from './rounds/RoundEngine'
import { CredentialVault } from './settings/CredentialVault'

/** Owns exactly one workspace, Codey Session, and OpenCode Session per BrowserWindow. */
export class WindowController {
  private workspacePath: string | null = null
  private session: SessionSummary | null = null
  private runtime: OpenCodeRuntime | null = null
  private runtimeStart: Promise<OpenCodeRuntime> | null = null
  private lease: SessionLease | null = null
  private running = false
  private cancelRequested = false
  private runnerEvents: RunnerEvent[] = []
  private pendingEvidenceEvents: RunnerEvent[] = []
  private error: string | undefined
  private logger: SessionLogger | null = null
  private activeRunId: string | undefined
  private activeRunStartedAt: number | undefined
  private lastRunStartedAt: string | undefined
  private lastRunFinishedAt: string | undefined
  private lastRunOutcome: 'completed' | 'failed' | 'blocked' | 'interrupted' | undefined
  private runnerSnapshotTimer: ReturnType<typeof setTimeout> | undefined
  private runtimePrewarmTimer: ReturnType<typeof setTimeout> | undefined
  private readonly evidence = new EvidenceCollector()
  private readonly resultBuilder = new ResultBuilder()
  private readonly verificationExecutor = new VerificationExecutor()
  private readonly engine: RoundEngine

  constructor(
    private readonly window: BrowserWindow,
    private readonly store: ProductStore,
    private readonly vault: CredentialVault,
    private readonly runtimeStorageRoot: string
  ) {
    this.engine = new RoundEngine({
      store,
      ensureRuntime: (mode) => this.ensureRuntime(mode),
      evidence: this.evidence,
      resultBuilder: this.resultBuilder,
      verify: async (request) => {
        const startedAt = Date.now()
        this.log('verification.start', request)
        try {
          const result = await this.verificationExecutor.run(request)
          this.log('verification.end', { durationMs: Date.now() - startedAt, result })
          return result
        } catch (error) {
          this.log('verification.error', { durationMs: Date.now() - startedAt, error: messageOf(error) })
          throw error
        }
      },
      isCancellationRequested: () => this.cancelRequested,
      takeEvents: () => {
        const events = this.pendingEvidenceEvents
        this.pendingEvidenceEvents = []
        return events
      },
      onDiagnostic: (type, payload) => this.log(type, payload),
      onRoundChanged: async () => { await this.emitSnapshot() }
    })
  }

  /** OpenCode-native sessions are deliberately not discovered in V1.
   *  The launcher is instant and lists only Codey product sessions. */
  async listSessions(path: string): Promise<SessionListResult> {
    const workspacePath = await realpath(path)
    return { sessions: this.store.listSessions(workspacePath) }
  }

  async openSession(path: string, sessionId?: string): Promise<WorkspaceSnapshot> {
    if (this.running) throw new Error('当前 Session 正在运行，不能切换。')
    const workspacePath = await realpath(path)
    let nextSession: SessionSummary
    if (sessionId) {
      const saved = this.store.getSession(sessionId)
      if (!saved) throw new Error('未找到该 Codey Session。')
      if (saved.workspacePath !== workspacePath) throw new Error('Session 不属于这个 Workspace。')
      nextSession = saved
    } else {
      nextSession = this.store.createSession(workspacePath)
    }

    if (this.session?.id === nextSession.id) return this.getSnapshot()

    const nextLease = this.store.acquireSessionLease(nextSession.id, () => {
      this.error = 'Session 的独占锁已丢失，请重新打开。'
      void this.closeRuntime()
      void this.emitSnapshot()
    })
    try {
      this.store.reconcileInterruptedRounds(nextSession.id)
      await this.releaseCurrent()
      this.lease = nextLease
      this.workspacePath = workspacePath
      this.session = nextSession
      this.logger = new SessionLogger(nextSession.id)
      this.log('session.open', {
        backend: 'opencode',
        title: nextSession.title,
        workspacePath,
        backendSessionId: nextSession.backendSessionId,
        permission: nextSession.permission,
        logFile: this.logger.filePath
      })
      if (this.runnerSnapshotTimer) {
        clearTimeout(this.runnerSnapshotTimer)
        this.runnerSnapshotTimer = undefined
      }
      this.runnerEvents = []
      this.pendingEvidenceEvents = []
      this.lastRunStartedAt = undefined
      this.lastRunFinishedAt = undefined
      this.lastRunOutcome = undefined
      this.error = undefined
      const snapshot = await this.emitSnapshot()
      this.scheduleRuntimePrewarm(snapshot.mode, 'session.open', 800)
      return snapshot
    } catch (error) {
      try { nextLease.release() } catch { /* best effort */ }
      throw error
    }
  }

  async getSnapshot(): Promise<WorkspaceSnapshot> {
    if (this.session) this.session = this.store.getSession(this.session.id) ?? this.session
    const settings = await this.getModelSettings()
    const draft = this.session ? this.store.getDraft(this.session.id) : { draft: '', mode: 'plan' as RoundMode }
    const rounds = this.session ? this.store.listRoundDetails(this.session.id) : []
    return {
      workspacePath: this.workspacePath,
      session: this.session,
      rounds,
      historyState: historyStateFor(this.session, rounds.length),
      draft: draft.draft,
      mode: draft.mode,
      running: this.running,
      runState: this.running
        ? {
            status: this.cancelRequested ? 'stopping' : 'running',
            ...(this.activeRunStartedAt !== undefined ? { startedAt: new Date(this.activeRunStartedAt).toISOString() } : {})
          }
        : {
            status: 'idle',
            ...(this.lastRunStartedAt ? { startedAt: this.lastRunStartedAt } : {}),
            ...(this.lastRunFinishedAt ? { finishedAt: this.lastRunFinishedAt } : {}),
            ...(this.lastRunOutcome ? { outcome: this.lastRunOutcome } : {})
          },
      runnerEvents: [...this.runnerEvents],
      settings,
      permission: this.session?.permission ?? 'workspace-write',
      ...(this.error ? { error: this.error } : {})
    }
  }

  async saveDraft(draft: string, mode: RoundMode): Promise<void> {
    this.assertOwnership()
    const session = this.requireSession()
    this.store.saveDraft(session.id, draft, mode)
    this.cancelScheduledPrewarm()
    this.prewarmRuntime(mode, 'draft.save')
    await this.emitSnapshot()
  }

  async getModelSettings(): Promise<ModelSettings> {
    return { ...this.store.getModelSettings(), hasCredential: await this.vault.hasCredential() }
  }

  async saveModelSettings(settings: Omit<ModelSettings, 'hasCredential'> & { credential?: string }): Promise<ModelSettings> {
    if (this.running) throw new Error('运行期间不能修改模型设置。')
    if (!settings.provider.trim() || !settings.model.trim()) throw new Error('请填写 Provider 和 Model。')
    if (settings.credential) await this.vault.setCredential(settings.credential)
    this.store.saveModelSettings(settings)
    await this.closeRuntime()
    const saved = await this.getModelSettings()
    const snapshot = await this.emitSnapshot()
    this.prewarmRuntime(snapshot.mode, 'settings.changed')
    return saved
  }

  async setPermission(preset: PermissionPreset): Promise<void> {
    this.assertOwnership()
    const session = this.requireSession()
    if (this.running) throw new Error('运行期间不能修改权限。')
    this.store.setPermission(session.id, preset)
    this.session = { ...session, permission: preset }
    await this.closeRuntime()
    const snapshot = await this.emitSnapshot()
    this.prewarmRuntime(snapshot.mode, 'permission.changed')
  }

  async submit(spec: string, mode: RoundMode): Promise<void> {
    this.assertOwnership()
    const session = this.requireSession()
    if (this.running) throw new Error('当前已有执行任务。')
    if (!spec.trim()) throw new Error('Spec 不能为空。')
    const settings = await this.getModelSettings()
    if (!settings.provider || !settings.model) throw new Error('请先配置模型 Provider 和 Model。')

    this.cancelScheduledPrewarm()
    const submittedRevision = this.store.getDraftWithRevision(session.id).revision
    const submitStartedAt = Date.now()
    this.activeRunId = randomUUID()
    this.activeRunStartedAt = submitStartedAt
    this.log('submit.start', {
      backend: 'opencode',
      mode,
      spec,
      provider: settings.provider,
      model: settings.model,
      baseUrl: settings.baseUrl,
      permission: session.permission,
      backendSessionId: session.backendSessionId
    })
    this.cancelRequested = false
    this.running = true
    this.lastRunStartedAt = new Date(submitStartedAt).toISOString()
    this.lastRunFinishedAt = undefined
    this.lastRunOutcome = undefined
    this.error = undefined
    this.runnerEvents = []
    this.pendingEvidenceEvents = []
    await this.emitSnapshot()

    let finalOutcome: 'completed' | 'failed' | 'blocked' | 'interrupted' | undefined
    try {
      const result = await this.engine.submit({ session, mode, spec })
      finalOutcome = result.outcome
      this.log('submit.end', { mode, outcome: result.outcome, roundId: result.roundId, durationMs: Date.now() - submitStartedAt })
      if (result.outcome !== 'interrupted') this.store.clearDraftIfRevision(session.id, submittedRevision)
    } catch (error) {
      this.log('submit.error', { mode, durationMs: Date.now() - submitStartedAt, cancelled: this.cancelRequested, error: messageOf(error) })
      if (!this.cancelRequested) {
        finalOutcome = 'failed'
        this.error = messageOf(error)
        await this.closeRuntime()
        throw error
      }
      finalOutcome = 'interrupted'
      this.error = undefined
    } finally {
      this.log('submit.finalize', { mode, durationMs: Date.now() - submitStartedAt, cancelRequested: this.cancelRequested })
      this.running = false
      this.lastRunFinishedAt = new Date().toISOString()
      this.lastRunOutcome = finalOutcome ?? (this.cancelRequested ? 'interrupted' : 'failed')
      this.cancelRequested = false
      this.activeRunId = undefined
      this.activeRunStartedAt = undefined
      this.pendingEvidenceEvents = []
      await this.emitSnapshot()
    }
  }

  async cancelRun(): Promise<boolean> {
    this.assertOwnership()
    if (!this.running) return false
    if (this.cancelRequested) return true
    this.cancelRequested = true
    this.log('cancel.requested', { backendSessionId: this.session?.backendSessionId })
    const delivered = this.runtime ? await this.runtime.cancelTurn() : false
    this.log('cancel.result', { delivered, backendSessionId: this.session?.backendSessionId })
    await this.emitSnapshot()
    return true
  }

  async endRound(): Promise<void> {
    this.assertOwnership()
    const session = this.requireSession()
    if (this.running) throw new Error('运行期间不能结束当前轮次。')
    await this.engine.endCurrent(session)
    await this.emitSnapshot()
  }

  async dispose(): Promise<void> {
    await this.releaseCurrent()
  }

  private requireSession(): SessionSummary {
    if (!this.session) throw new Error('请先选择 Workspace 和 Session。')
    return this.session
  }

  private assertOwnership(): void {
    if (!this.lease) throw new Error('请先选择 Workspace 和 Session。')
    this.lease.assertHeld()
  }

  private scheduleRuntimePrewarm(mode: RoundMode, reason: string, delayMs: number): void {
    this.cancelScheduledPrewarm()
    this.runtimePrewarmTimer = setTimeout(() => {
      this.runtimePrewarmTimer = undefined
      this.prewarmRuntime(mode, reason)
    }, delayMs)
    this.runtimePrewarmTimer.unref?.()
  }

  private cancelScheduledPrewarm(): void {
    if (!this.runtimePrewarmTimer) return
    clearTimeout(this.runtimePrewarmTimer)
    this.runtimePrewarmTimer = undefined
  }

  /** Best-effort OpenCode warmup while the user is editing. */
  private prewarmRuntime(mode: RoundMode, reason: string): void {
    if (!this.session || !this.lease || this.running || this.runtime || this.runtimeStart) return
    this.log('runtime.prewarm.start', { backend: 'opencode', mode, reason })
    void this.ensureRuntime(mode)
      .then(runtime => {
        if (this.runtime === runtime) {
          this.log('runtime.prewarm.end', {
            backend: 'opencode',
            mode,
            reason,
            backendSessionId: this.session?.backendSessionId
          })
        }
      })
      .catch(error => this.log('runtime.prewarm.error', { backend: 'opencode', mode, reason, error: messageOf(error) }))
  }

  /** All product modes share one OpenCode runtime/session. The mode only selects
   *  the agent at prompt time (Plan=plan, Vibe/Loop=build). */
  private async ensureRuntime(mode: RoundMode): Promise<OpenCodeRuntime> {
    this.assertOwnership()
    if (this.runtime) return this.runtime
    if (this.runtimeStart) return this.runtimeStart

    const promise = this.startRuntime(mode)
    this.runtimeStart = promise
    try {
      return await promise
    } finally {
      if (this.runtimeStart === promise) this.runtimeStart = null
    }
  }

  private async startRuntime(mode: RoundMode): Promise<OpenCodeRuntime> {
    const session = this.requireSession()
    const settings = await this.getModelSettings()
    const runtime = new OpenCodeRuntime({
      workspacePath: session.workspacePath,
      storageRoot: this.runtimeStorageRoot,
      settings,
      credential: await this.vault.getCredential(),
      permission: session.permission,
      onEvent: (event) => this.appendRunnerEvent(event),
      onDebug: (type, payload) => this.log(type, payload)
    })
    const existing = this.store.getBackendSessionId(session.id)
    this.log('runtime.ensure', {
      backend: 'opencode',
      mode,
      existingBackendSessionId: existing,
      provider: settings.provider,
      model: settings.model,
      baseUrl: settings.baseUrl
    })
    try {
      const started = await runtime.start(existing)
      if (!existing) {
        this.store.setBackendSessionId(session.id, started.sessionId)
        this.session = { ...session, backendSessionId: started.sessionId, kind: session.kind === 'new' ? 'backend' : session.kind }
      }
      this.runtime = runtime
      this.log('runtime.ready', { backend: 'opencode', mode, backendSessionId: started.sessionId })
      return runtime
    } catch (error) {
      try { await runtime.close() } catch { /* best effort */ }
      throw error
    }
  }

  private async closeRuntime(): Promise<void> {
    const starting = this.runtimeStart
    if (starting) {
      try { await starting } catch { /* failed starts clean themselves up */ }
    }
    const runtime = this.runtime
    this.runtime = null
    if (runtime) {
      this.log('runtime.dispose', { backend: 'opencode' })
      await runtime.close()
    }
  }

  private async releaseCurrent(): Promise<void> {
    this.cancelScheduledPrewarm()
    if (this.runnerSnapshotTimer) {
      clearTimeout(this.runnerSnapshotTimer)
      this.runnerSnapshotTimer = undefined
    }
    await this.closeRuntime()
    await this.logger?.flush()
    this.logger = null
    const lease = this.lease
    this.lease = null
    if (lease) {
      try { lease.assertHeld() } catch { /* already lost */ }
      lease.release()
    }
  }

  private appendRunnerEvent(event: RunnerEvent): void {
    this.log('runner.event', event)
    this.runnerEvents.push(event)
    if (this.runnerEvents.length > 200) this.runnerEvents.shift()
    this.pendingEvidenceEvents.push(event)
    if (this.pendingEvidenceEvents.length > 1000) this.pendingEvidenceEvents.shift()
    this.scheduleRunnerSnapshot()
  }

  private scheduleRunnerSnapshot(): void {
    if (this.runnerSnapshotTimer) return
    this.runnerSnapshotTimer = setTimeout(() => {
      this.runnerSnapshotTimer = undefined
      void this.emitSnapshot()
    }, 100)
    this.runnerSnapshotTimer.unref?.()
  }

  private log(type: string, payload?: unknown): void {
    this.logger?.write(type, payload, {
      ...(this.activeRunId ? { runId: this.activeRunId } : {}),
      ...(this.activeRunStartedAt !== undefined ? { runElapsedMs: Date.now() - this.activeRunStartedAt } : {})
    })
  }

  private async emitSnapshot(): Promise<WorkspaceSnapshot> {
    const startedAt = Date.now()
    const snapshot = await this.getSnapshot()
    const durationMs = Date.now() - startedAt
    if (this.activeRunId) {
      this.log('snapshot.build', {
        durationMs,
        rounds: snapshot.rounds.length,
        runnerEvents: snapshot.runnerEvents.length,
        vibeEntries: snapshot.rounds.reduce((total, round) => total + round.vibeEntries.length, 0),
        evidence: snapshot.rounds.reduce((total, round) => total + round.evidence.length, 0)
      })
    }
    if (!this.window.isDestroyed()) this.window.webContents.send(IPC.snapshotChanged, snapshot)
    return snapshot
  }
}

function historyStateFor(session: SessionSummary | null, roundCount: number): HistoryState {
  if (!session || session.kind !== 'backend' || roundCount > 0) return 'none'
  return 'backend-unavailable'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
