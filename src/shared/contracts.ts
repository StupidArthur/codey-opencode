export type RoundMode = 'plan' | 'vibe' | 'loop'
/** Modes available for new work. `plan` remains only for reading legacy history. */
export type InteractiveMode = 'vibe' | 'loop'
export type LoopPhase = 'planning' | 'ready' | 'running' | 'terminal'
export type RoundStatus = 'active' | 'completed' | 'blocked' | 'budget_exhausted' | 'failed' | 'interrupted'
export type ExecutionOutcome = 'completed' | 'failed' | 'blocked' | 'interrupted'
export type RunOutcome = Exclude<RoundStatus, 'active'>

/** Session-level permission preset. Plan/Vibe/Loop never escalate it. */
export type PermissionPreset = 'read-only' | 'workspace-write' | 'danger-full-access'

/**
 * `new` — a Temporal Session with no backend identity yet.
 * `temporal` — has at least one Temporal Round.
 * `backend` — already owns an OpenCode Session but has no Temporal Round yet
 * (typically because runtime prewarming completed while the user was editing).
 */
export type SessionKind = 'new' | 'temporal' | 'backend'

export interface SessionSummary {
  id: string
  /** Present once the session is bound to an OpenCode Session. */
  backendSessionId?: string
  title: string
  workspacePath: string
  updatedAt: string
  hasTemporalHistory: boolean
  kind: SessionKind
  permission: PermissionPreset
}

/** Result of a workspace listing: product records merged with ACP discovery. */
export interface SessionListResult {
  sessions: SessionSummary[]
  /** Set when public ACP discovery failed; product records are still returned. */
  discoveryError?: string
}

/** Backend-native history is owned by OpenCode; Temporal structure starts in Codey. */
export type HistoryState = 'none' | 'backend-unavailable'

export interface RoundSummary {
  id: string
  sequence: number
  mode: RoundMode
  status: RoundStatus
  title: string
  updatedAt: string
  bodyMarkdown: string
  /** Present for new Loop Rounds. Legacy Loop history may omit it. */
  loopPhase?: LoopPhase
  /** Frozen plan version used by the autonomous execution. */
  approvedPlanVersionId?: string
}

export interface PlanReadinessCheck {
  key: 'goal' | 'scope' | 'current-state' | 'implementation' | 'affected-files' | 'acceptance' | 'verification' | 'constraints' | 'open-questions'
  label: string
  ready: boolean
  detail: string
}

export interface PlanReadinessSummary {
  ready: boolean
  checks: PlanReadinessCheck[]
  missing: string[]
}

export interface PlanVersionSummary {
  id: string
  ordinal: number
  submittedSpec: string
  planMarkdown: string
  createdAt: string
  readiness?: PlanReadinessSummary
}

export interface VibeEntrySummary {
  id: string
  ordinal: number
  specMarkdown: string
  assistantOutput: string
  executionOutcome: ExecutionOutcome
  createdAt: string
}

/**
 * What a verification check factually verified, recorded by the product's own
 * executor. Facts describe what was actually checked and what was observed —
 * they never claim which requirement they satisfy; that assessment is a
 * separate, programmatic step in the evaluator.
 */
export type CheckFact =
  | { kind: 'file-exists'; target: string; isFile: boolean; matched: boolean }
  | { kind: 'content-equals'; target: string; expectedHash: string; actualHash: string | null; matched: boolean }
  | { kind: 'field-equals'; target: string; key: string; expected: string; actual: string | null; matched: boolean }
  | { kind: 'command-exit'; command: string; exitCode: number | null; matched: boolean }

export interface EvidenceSummary {
  id: string
  kind: 'command' | 'workspace' | 'artifact' | 'manual' | 'runtime'
  label: string
  detail: string
  outcome: 'passed' | 'failed' | 'observed'
  provenance: 'tool' | 'user' | 'model'
  observedAt: string
  /** Command evidence: the real command that ran and its exit code. */
  command?: string
  exitCode?: number | null
  /** Files the check verified (relative); empty means workspace-scoped. */
  targets?: string[]
  /** What the check factually verified (recorded by the executor, not the requester). */
  facts?: CheckFact[]
  /** Present when the executor refused to run the check (permission boundary). */
  denial?: string
  /** Deprecated: generator-written coverage claims; kept only for old rows. */
  covers?: string[]
  /** False once a target changed or the artifact disappeared after the run. */
  valid?: boolean
  turn?: number
  toolCallId?: string
  /** Sandbox checks only: the nonce of the request that produced this run. */
  requestId?: string
  /** Sandbox checks only: the input fingerprint the run was requested against. */
  inputFingerprint?: string
  /** Stable check-object identity (`sandbox:<kind>`) across re-runs. */
  checkObject?: string
}

export interface LoopTerminalSummary {
  status: RunOutcome
  reason: string
}

export interface RequirementCoverageSummary {
  id: string
  original: string
  status: 'satisfied' | 'pending' | 'unknown'
  evidenceIds: string[]
  /** The objective acceptance conditions parsed from the requirement. */
  conditions?: string[]
  /** Which conditions are not yet covered, when the item is not satisfied. */
  uncovered?: string[]
  note?: string
}

export interface ResultSummary {
  summary: string
  changes: string[]
  verification: string[]
  remaining: string[]
  loopTerminal?: LoopTerminalSummary
  /** The loop's final decision state (every terminal saves it, so the
   *  remaining work is always explainable). */
  decision?: LoopDecisionSummary
  /** Per-requirement coverage when the round ran through the Loop gate. */
  coverage?: RequirementCoverageSummary[]
  createdAt: string
}

/** Serializable subset of the loop decision that is persisted with the Result. */
export interface LoopDecisionSummary {
  decision: 'completed' | 'continue' | 'blocked' | 'failed'
  reason: string
  incomplete: string[]
  knownIssues: string[]
  validRunIds: string[]
}

/** A Round plus its mode-specific projection. */
export interface RoundDetail extends RoundSummary {
  planVersions: PlanVersionSummary[]
  vibeEntries: VibeEntrySummary[]
  evidence: EvidenceSummary[]
  result?: ResultSummary
}

export interface RunnerEvent {
  id: string
  at: string
  kind: 'thinking' | 'tool' | 'verification' | 'error' | 'status'
  message: string
  /** Structured tool lifecycle. Rendering must not infer lifecycle from message text. */
  tool?: {
    callId: string
    name: string
    status: 'pending' | 'running' | 'completed' | 'failed'
    startedAt?: string
    finishedAt?: string
    durationMs?: number
  }
}

export interface RunStateSummary {
  /** Authoritative product execution state; never inferred from Runner output cadence. */
  status: 'idle' | 'running' | 'stopping'
  startedAt?: string
  finishedAt?: string
  outcome?: RunOutcome
}

export interface ModelSettings {
  provider: string
  model: string
  baseUrl?: string
  hasCredential: boolean
}

export interface WorkspaceSnapshot {
  workspacePath: string | null
  session: SessionSummary | null
  rounds: RoundDetail[]
  /** Explicit state for the legacy-history placeholder; never fakes a History document. */
  historyState: HistoryState
  draft: string
  mode: InteractiveMode
  running: boolean
  /** Fixed execution status for UI chrome; updated independently of Runner event output. */
  runState: RunStateSummary
  runnerEvents: RunnerEvent[]
  settings: ModelSettings
  permission: PermissionPreset
  error?: string
}

export interface TemporalApi {
  chooseWorkspace(): Promise<string | null>
  listSessions(workspacePath: string): Promise<SessionListResult>
  openSession(workspacePath: string, sessionId?: string): Promise<WorkspaceSnapshot>
  getSnapshot(): Promise<WorkspaceSnapshot>
  saveDraft(draft: string, mode: InteractiveMode): Promise<void>
  submit(spec: string, mode: InteractiveMode): Promise<void>
  startLoop(): Promise<void>
  cancelRun(): Promise<boolean>
  endRound(): Promise<void>
  setPermission(preset: PermissionPreset): Promise<void>
  getModelSettings(): Promise<ModelSettings>
  saveModelSettings(settings: Omit<ModelSettings, 'hasCredential'> & { credential?: string }): Promise<ModelSettings>
  onSnapshot(listener: (snapshot: WorkspaceSnapshot) => void): () => void
  onRunnerEvent(listener: (event: RunnerEvent) => void): () => void
}

export const IPC = {
  chooseWorkspace: 'workspace:choose',
  listSessions: 'session:list',
  openSession: 'session:open',
  getSnapshot: 'workspace:snapshot',
  saveDraft: 'workspace:save-draft',
  submit: 'round:submit',
  startLoop: 'round:loop:start',
  cancelRun: 'round:cancel',
  endRound: 'round:end',
  setPermission: 'settings:permission:set',
  getModelSettings: 'settings:model:get',
  saveModelSettings: 'settings:model:save',
  snapshotChanged: 'workspace:changed',
  runnerEvent: 'runner:event'
} as const
