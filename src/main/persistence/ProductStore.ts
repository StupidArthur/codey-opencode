import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { CheckFact, InteractiveMode, ModelSettings, PlanReadinessSummary, RoundDetail, RoundMode, RoundSummary, SessionSummary } from '../../shared/contracts'

type SessionRow = {
  id: string
  backend_session_id: string | null
  title: string
  workspace_path: string
  updated_at: string
  has_temporal_history: number
  permission: string
}

type RoundRow = {
  id: string
  sequence: number
  mode: RoundSummary['mode']
  status: RoundSummary['status']
  title: string
  updated_at: string
  body_markdown: string
  loop_phase: RoundSummary['loopPhase'] | null
  approved_plan_version_id: string | null
}

type DraftRow = { draft: string; mode: RoundMode; revision: number }
type SettingsRow = { provider: string; model: string; base_url: string | null }

export interface PlanVersion {
  id: string
  submittedSpec: string
  planMarkdown: string
  createdAt: string
  backendActivityRef?: string
  readiness?: PlanReadinessSummary
}

export interface VibeEntry {
  id: string
  specMarkdown: string
  assistantOutput: string
  executionOutcome: 'completed' | 'blocked' | 'failed' | 'interrupted'
  createdAt: string
}

export interface EvidenceRecord {
  id: string
  kind: 'command' | 'workspace' | 'artifact' | 'manual' | 'runtime'
  label: string
  detail: string
  outcome: 'passed' | 'failed' | 'observed'
  provenance: 'tool' | 'user' | 'model'
  observedAt: string
  command?: string
  exitCode?: number | null
  targets?: string[]
  /** What the check factually verified (recorded by the executor). */
  facts?: CheckFact[]
  /** Present when the executor refused to run the check. */
  denial?: string
  covers?: string[]
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

export interface ResultDocument {
  summary: string
  changes: string[]
  verification: string[]
  remaining: string[]
  createdAt: string
  loopTerminal?: {
    status: 'completed' | 'blocked' | 'budget_exhausted' | 'failed' | 'interrupted'
    reason: string
  }
  coverage?: Array<{
    id: string
    original: string
    status: 'satisfied' | 'pending' | 'unknown'
    evidenceIds: string[]
  }>
}

export interface SessionLease {
  readonly sessionId: string
  readonly ownerToken: string
  assertHeld(): void
  release(): void
}

export type SavedSession = SessionSummary & { backendSessionId?: string }
export type SavedModelSettings = Omit<ModelSettings, 'hasCredential'>

const migrations = [
  `
    CREATE TABLE product_sessions (
      id TEXT PRIMARY KEY,
      backend_session_id TEXT UNIQUE,
      workspace_path TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX product_sessions_workspace_recent
      ON product_sessions(workspace_path, updated_at DESC);

    CREATE TABLE rounds (
      id TEXT PRIMARY KEY,
      product_session_id TEXT NOT NULL REFERENCES product_sessions(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      mode TEXT NOT NULL CHECK (mode IN ('plan', 'vibe', 'loop')),
      status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'blocked', 'budget_exhausted', 'failed', 'interrupted')),
      title TEXT NOT NULL,
      body_markdown TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(product_session_id, sequence)
    );
    CREATE INDEX rounds_session_sequence ON rounds(product_session_id, sequence);

    CREATE TABLE drafts (
      product_session_id TEXT PRIMARY KEY REFERENCES product_sessions(id) ON DELETE CASCADE,
      draft TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT 'plan' CHECK (mode IN ('plan', 'vibe', 'loop')),
      revision INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE model_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      base_url TEXT
    );
  `,
  `
    ALTER TABLE rounds ADD COLUMN runtime_active INTEGER NOT NULL DEFAULT 0 CHECK (runtime_active IN (0, 1));
    ALTER TABLE rounds ADD COLUMN closed_at TEXT;

    CREATE TABLE plan_versions (
      id TEXT PRIMARY KEY,
      round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK (ordinal > 0),
      submitted_spec TEXT NOT NULL,
      plan_markdown TEXT NOT NULL,
      created_at TEXT NOT NULL,
      backend_activity_ref TEXT,
      UNIQUE(round_id, ordinal)
    );

    CREATE TABLE vibe_entries (
      id TEXT PRIMARY KEY,
      round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK (ordinal > 0),
      spec_markdown TEXT NOT NULL,
      assistant_output TEXT NOT NULL,
      execution_outcome TEXT NOT NULL CHECK (execution_outcome IN ('completed', 'blocked', 'failed', 'interrupted')),
      created_at TEXT NOT NULL,
      UNIQUE(round_id, ordinal)
    );

    CREATE TABLE round_evidence (
      id TEXT PRIMARY KEY,
      round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('command', 'workspace', 'artifact', 'manual', 'runtime')),
      label TEXT NOT NULL,
      detail TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('passed', 'failed', 'observed')),
      provenance TEXT NOT NULL CHECK (provenance IN ('tool', 'user', 'model')),
      observed_at TEXT NOT NULL
    );
    CREATE INDEX round_evidence_round ON round_evidence(round_id, observed_at);

    CREATE TABLE round_results (
      round_id TEXT PRIMARY KEY REFERENCES rounds(id) ON DELETE CASCADE,
      document_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE session_leases (
      product_session_id TEXT PRIMARY KEY REFERENCES product_sessions(id) ON DELETE CASCADE,
      owner_token TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL
    );
  `,
  `
    ALTER TABLE product_sessions ADD COLUMN permission TEXT NOT NULL DEFAULT 'workspace-write'
      CHECK (permission IN ('read-only', 'workspace-write', 'danger-full-access'));
  `,
  `
    ALTER TABLE round_evidence ADD COLUMN command TEXT;
    ALTER TABLE round_evidence ADD COLUMN exit_code INTEGER;
    ALTER TABLE round_evidence ADD COLUMN targets TEXT;
    ALTER TABLE round_evidence ADD COLUMN covers TEXT;
    ALTER TABLE round_evidence ADD COLUMN valid INTEGER;
    ALTER TABLE round_evidence ADD COLUMN turn INTEGER;
    ALTER TABLE round_evidence ADD COLUMN tool_call_id TEXT;
  `,
  `
    ALTER TABLE round_evidence ADD COLUMN facts TEXT;
    ALTER TABLE round_evidence ADD COLUMN denial TEXT;
  `,
  `
    ALTER TABLE round_evidence ADD COLUMN request_id TEXT;
    ALTER TABLE round_evidence ADD COLUMN input_fingerprint TEXT;
    ALTER TABLE round_evidence ADD COLUMN check_object TEXT;
  `,
  `
    CREATE TABLE round_baselines (
      round_id TEXT PRIMARY KEY REFERENCES rounds(id) ON DELETE CASCADE,
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `,
  `
    ALTER TABLE rounds ADD COLUMN loop_phase TEXT
      CHECK (loop_phase IS NULL OR loop_phase IN ('planning', 'ready', 'running', 'terminal'));
    ALTER TABLE rounds ADD COLUMN approved_plan_version_id TEXT;
    ALTER TABLE plan_versions ADD COLUMN readiness_json TEXT;
  `
] as const

/** Product projection only. OpenCode remains authoritative for its conversation and runtime state. */
export class ProductStore {
  private readonly db: DatabaseSync
  private readonly leases = new Set<SessionLease>()
  private readonly statements = new Map<string, StatementSync>()
  private transactionDepth = 0

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA busy_timeout = 5000')
    if (dbPath !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL')
    this.migrate()
  }

  /**
   * Prepared statements are cached and kept alive for the lifetime of the
   * store. Creating hundreds of short-lived statements (one per snapshot
   * projection) while an agent turn streamed events caused GC to finalize the
   * native Statement handles mid-turn, which aborted the Electron main process.
   */
  private stmt(sql: string): StatementSync {
    let statement = this.statements.get(sql)
    if (!statement) {
      statement = this.db.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }

  /**
   * BEGIN/COMMIT/ROLLBACK with savepoint nesting. Kept local so the store does
   * not depend on driver-specific transaction helpers; nested calls reuse a
   * savepoint like the previous driver did.
   */
  private transaction<T>(fn: () => T): T {
    const nested = this.transactionDepth > 0
    this.db.exec(nested ? 'SAVEPOINT temporal_nested' : 'BEGIN')
    this.transactionDepth += 1
    try {
      const result = fn()
      this.db.exec(nested ? 'RELEASE temporal_nested' : 'COMMIT')
      return result
    } catch (error) {
      if (nested) {
        try {
          this.db.exec('ROLLBACK TO temporal_nested')
          this.db.exec('RELEASE temporal_nested')
        } catch { /* savepoint already gone */ }
      } else {
        try { this.db.exec('ROLLBACK') } catch { /* transaction already gone */ }
      }
      throw error
    } finally {
      this.transactionDepth -= 1
    }
  }

  private migrate(): void {
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (version > migrations.length) {
      throw new Error(`Product database version ${version} is newer than this app supports`)
    }
    for (let index = version; index < migrations.length; index += 1) {
      this.transaction(() => {
        this.db.exec(migrations[index])
        this.db.exec(`PRAGMA user_version = ${index + 1}`)
      })
    }
  }

  listSessions(workspacePath: string): SessionSummary[] {
    const rows = this.stmt(`
      SELECT s.*, EXISTS(SELECT 1 FROM rounds r WHERE r.product_session_id = s.id) AS has_temporal_history
      FROM product_sessions s WHERE s.workspace_path = ? ORDER BY s.updated_at DESC
    `).all(workspacePath) as SessionRow[]
    return rows.map(toSessionSummary)
  }

  getSession(id: string): SessionSummary | undefined {
    const row = this.stmt(`
      SELECT s.*, EXISTS(SELECT 1 FROM rounds r WHERE r.product_session_id = s.id) AS has_temporal_history
      FROM product_sessions s WHERE s.id = ?
    `).get(id) as SessionRow | undefined
    return row && toSessionSummary(row)
  }

  getSessionByBackendId(backendSessionId: string): SessionSummary | undefined {
    const row = this.stmt(`
      SELECT s.*, EXISTS(SELECT 1 FROM rounds r WHERE r.product_session_id = s.id) AS has_temporal_history
      FROM product_sessions s WHERE s.backend_session_id = ?
    `).get(backendSessionId) as SessionRow | undefined
    return row && toSessionSummary(row)
  }

  createSession(workspacePath: string, backendSessionId?: string, title?: string): SessionSummary {
    if (backendSessionId) {
      const existing = this.getSessionByBackendId(backendSessionId)
      if (existing) {
        if (existing.workspacePath !== workspacePath) {
          throw new Error('backend session is already associated with another workspace')
        }
        return existing
      }
    }
    const id = randomUUID()
    const now = new Date().toISOString()
    this.stmt(`
      INSERT INTO product_sessions(id, backend_session_id, workspace_path, title, created_at, updated_at, permission)
      VALUES (?, ?, ?, ?, ?, ?, 'workspace-write')
    `).run(id, backendSessionId ?? null, workspacePath, title?.trim() || 'New Session', now, now)
    return this.getSession(id)!
  }

  saveSession(session: SavedSession): void {
    const current = this.getSession(session.id)
    if (!current) throw new Error(`Unknown product session: ${session.id}`)
    if (current.workspacePath !== session.workspacePath) {
      throw new Error('A product session cannot change workspace')
    }
    this.stmt(`
      UPDATE product_sessions SET title = ?, backend_session_id = COALESCE(?, backend_session_id), updated_at = ?
      WHERE id = ?
    `).run(session.title, session.backendSessionId ?? null, new Date().toISOString(), session.id)
  }

  getBackendSessionId(productSessionId: string): string | undefined {
    const row = this.stmt('SELECT backend_session_id FROM product_sessions WHERE id = ?')
      .get(productSessionId) as { backend_session_id: string | null } | undefined
    return row?.backend_session_id ?? undefined
  }

  setBackendSessionId(productSessionId: string, backendSessionId: string): void {
    const changed = this.stmt(`
      UPDATE product_sessions SET backend_session_id = ?, updated_at = ?
      WHERE id = ? AND (backend_session_id IS NULL OR backend_session_id = ?)
    `).run(backendSessionId, new Date().toISOString(), productSessionId, backendSessionId)
    if (changed.changes !== 1) throw new Error('Product session is missing or bound to another backend session')
  }

  getPermission(productSessionId: string): SessionSummary['permission'] {
    const row = this.stmt('SELECT permission FROM product_sessions WHERE id = ?')
      .get(productSessionId) as { permission: SessionSummary['permission'] } | undefined
    if (!row) throw new Error(`Unknown product session: ${productSessionId}`)
    return row.permission
  }

  setPermission(productSessionId: string, permission: SessionSummary['permission']): void {
    const changed = this.stmt('UPDATE product_sessions SET permission = ?, updated_at = ? WHERE id = ?')
      .run(permission, new Date().toISOString(), productSessionId)
    if (changed.changes !== 1) throw new Error(`Unknown product session: ${productSessionId}`)
  }

  /** Full per-Round projection for the renderer: versions, entries, evidence and result. */
  listRoundDetails(sessionId: string): RoundDetail[] {
    return this.listRounds(sessionId).map((round) => {
      const result = this.getResult(round.id)
      return {
        ...round,
        planVersions: this.listPlanVersions(round.id).map((version, index) => ({
          id: version.id, ordinal: index + 1, submittedSpec: version.submittedSpec,
          planMarkdown: version.planMarkdown, createdAt: version.createdAt,
          ...(version.readiness ? { readiness: version.readiness } : {})
        })),
        vibeEntries: this.listVibeEntries(round.id).map((entry, index) => ({
          id: entry.id, ordinal: index + 1, specMarkdown: entry.specMarkdown,
          assistantOutput: entry.assistantOutput, executionOutcome: entry.executionOutcome,
          createdAt: entry.createdAt
        })),
        evidence: this.listEvidence(round.id),
        ...(result ? { result } : {})
      }
    })
  }

  listRounds(sessionId: string): RoundSummary[] {
    const rows = this.stmt(`
      SELECT id, sequence, mode, status, title, updated_at, body_markdown, loop_phase, approved_plan_version_id
      FROM rounds WHERE product_session_id = ? ORDER BY sequence ASC
    `).all(sessionId) as RoundRow[]
    return rows.map((row) => ({
      id: row.id,
      sequence: row.sequence,
      mode: row.mode,
      status: row.status,
      title: row.title,
      updatedAt: row.updated_at,
      bodyMarkdown: row.body_markdown,
      ...(row.loop_phase ? { loopPhase: row.loop_phase } : {}),
      ...(row.approved_plan_version_id ? { approvedPlanVersionId: row.approved_plan_version_id } : {})
    }))
  }

  saveRound(sessionId: string, round: RoundSummary): void {
    this.transaction(() => {
      const now = new Date().toISOString()
      const saved = this.stmt(`
        INSERT INTO rounds(id, product_session_id, sequence, mode, status, title, body_markdown, created_at, updated_at, loop_phase, approved_plan_version_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          title = excluded.title,
          body_markdown = excluded.body_markdown,
          updated_at = excluded.updated_at,
          loop_phase = excluded.loop_phase,
          approved_plan_version_id = excluded.approved_plan_version_id
        WHERE rounds.product_session_id = excluded.product_session_id
          AND rounds.sequence = excluded.sequence
          AND rounds.mode = excluded.mode
      `).run(round.id, sessionId, round.sequence, round.mode, round.status,
        round.title, round.bodyMarkdown, now, round.updatedAt, round.loopPhase ?? null, round.approvedPlanVersionId ?? null)
      if (saved.changes !== 1) {
        throw new Error('Round identity, sequence, or mode cannot change')
      }
      this.stmt('UPDATE product_sessions SET updated_at = ? WHERE id = ?')
        .run(now, sessionId)
    })
  }

  /** Commit a mode boundary and its next Round as a single database transition. */
  transitionRound(sessionId: string, currentRoundId: string, next: RoundSummary): void {
    this.transaction(() => {
      const current = this.stmt(`
        SELECT sequence, mode, status FROM rounds WHERE id = ? AND product_session_id = ?
      `).get(currentRoundId, sessionId) as { sequence: number; mode: RoundMode; status: string } | undefined
      if (!current || current.status !== 'active') throw new Error('No active Round to transition')
      if (current.mode === next.mode || next.sequence !== current.sequence + 1) {
        throw new Error('Mode transition requires a different mode and consecutive sequence')
      }
      const now = new Date().toISOString()
      this.stmt(`
        UPDATE rounds SET status = 'completed', runtime_active = 0, closed_at = ?, updated_at = ?
        WHERE id = ? AND product_session_id = ?
      `).run(now, now, currentRoundId, sessionId)
      this.saveRound(sessionId, next)
    })
  }

  markRoundExecutionStarted(sessionId: string, roundId: string): void {
    const result = this.stmt(`
      UPDATE rounds SET runtime_active = 1, updated_at = ?
      WHERE id = ? AND product_session_id = ? AND status = 'active' AND runtime_active = 0
    `).run(new Date().toISOString(), roundId, sessionId)
    if (result.changes !== 1) throw new Error('Round is not available for execution')
  }

  markRoundExecutionFinished(sessionId: string, roundId: string, status: RoundSummary['status']): void {
    const now = new Date().toISOString()
    const terminal = status !== 'active'
    const result = this.stmt(`
      UPDATE rounds SET runtime_active = 0, status = ?, closed_at = CASE WHEN ? THEN ? ELSE closed_at END, updated_at = ?
      WHERE id = ? AND product_session_id = ? AND status = 'active' AND runtime_active = 1
    `).run(status, terminal ? 1 : 0, now, now, roundId, sessionId)
    if (result.changes !== 1) throw new Error('Round has no active execution')
  }

  /** Called after restart, before restoring a Session projection. Idle Plan/Vibe Rounds remain active. */
  reconcileInterruptedRounds(sessionId: string): number {
    const now = new Date().toISOString()
    const result = this.stmt(`
      UPDATE rounds SET status = 'interrupted', runtime_active = 0, closed_at = ?, updated_at = ?
      WHERE product_session_id = ? AND status = 'active' AND runtime_active = 1
    `).run(now, now, sessionId)
    return Number(result.changes)
  }

  appendPlanVersion(roundId: string, version: PlanVersion): void {
    this.transaction(() => {
      const row = this.stmt('SELECT mode FROM rounds WHERE id = ?').get(roundId) as { mode: RoundMode } | undefined
      if (!row || (row.mode !== 'plan' && row.mode !== 'loop')) throw new Error('Round is missing or cannot contain a Plan')
      const ordinal = this.nextOrdinal('plan_versions', roundId)
      this.stmt(`
        INSERT INTO plan_versions(id, round_id, ordinal, submitted_spec, plan_markdown, created_at, backend_activity_ref, readiness_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(version.id, roundId, ordinal, version.submittedSpec, version.planMarkdown,
        version.createdAt, version.backendActivityRef ?? null,
        version.readiness ? JSON.stringify(version.readiness) : null)
    })
  }

  listPlanVersions(roundId: string): PlanVersion[] {
    const rows = this.stmt(`
      SELECT id, submitted_spec, plan_markdown, created_at, backend_activity_ref, readiness_json
      FROM plan_versions WHERE round_id = ? ORDER BY ordinal
    `).all(roundId) as Array<{ id: string; submitted_spec: string; plan_markdown: string; created_at: string; backend_activity_ref: string | null; readiness_json: string | null }>
    return rows.map((row) => ({ id: row.id, submittedSpec: row.submitted_spec,
      planMarkdown: row.plan_markdown, createdAt: row.created_at,
      ...(row.backend_activity_ref ? { backendActivityRef: row.backend_activity_ref } : {}),
      ...(row.readiness_json ? { readiness: JSON.parse(row.readiness_json) as PlanReadinessSummary } : {}) }))
  }

  appendVibeEntry(roundId: string, entry: VibeEntry): void {
    this.transaction(() => {
      this.requireRoundMode(roundId, 'vibe')
      const ordinal = this.nextOrdinal('vibe_entries', roundId)
      this.stmt(`
        INSERT INTO vibe_entries(id, round_id, ordinal, spec_markdown, assistant_output, execution_outcome, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(entry.id, roundId, ordinal, entry.specMarkdown, entry.assistantOutput,
        entry.executionOutcome, entry.createdAt)
    })
  }

  listVibeEntries(roundId: string): VibeEntry[] {
    const rows = this.stmt(`
      SELECT id, spec_markdown, assistant_output, execution_outcome, created_at
      FROM vibe_entries WHERE round_id = ? ORDER BY ordinal
    `).all(roundId) as Array<{ id: string; spec_markdown: string; assistant_output: string; execution_outcome: VibeEntry['executionOutcome']; created_at: string }>
    return rows.map((row) => ({ id: row.id, specMarkdown: row.spec_markdown,
      assistantOutput: row.assistant_output, executionOutcome: row.execution_outcome,
      createdAt: row.created_at }))
  }

  saveEvidence(roundId: string, evidence: EvidenceRecord): void {
    this.stmt(`
      INSERT INTO round_evidence(id, round_id, kind, label, detail, outcome, provenance, observed_at, command, exit_code, targets, covers, valid, turn, tool_call_id, facts, denial, request_id, input_fingerprint, check_object)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET round_id = excluded.round_id, label = excluded.label,
        detail = excluded.detail, outcome = excluded.outcome, provenance = excluded.provenance,
        observed_at = excluded.observed_at, command = excluded.command, exit_code = excluded.exit_code,
        targets = excluded.targets, covers = excluded.covers, valid = excluded.valid,
        turn = excluded.turn, tool_call_id = excluded.tool_call_id, facts = excluded.facts, denial = excluded.denial,
        request_id = excluded.request_id, input_fingerprint = excluded.input_fingerprint, check_object = excluded.check_object
    `).run(evidence.id, roundId, evidence.kind, evidence.label, evidence.detail,
      evidence.outcome, evidence.provenance, evidence.observedAt,
      evidence.command ?? null, evidence.exitCode ?? null,
      evidence.targets ? JSON.stringify(evidence.targets) : null,
      evidence.covers ? JSON.stringify(evidence.covers) : null,
      evidence.valid === undefined ? null : (evidence.valid ? 1 : 0),
      evidence.turn ?? null, evidence.toolCallId ?? null,
      evidence.facts ? JSON.stringify(evidence.facts) : null,
      evidence.denial ?? null,
      evidence.requestId ?? null, evidence.inputFingerprint ?? null, evidence.checkObject ?? null)
  }

  listEvidence(roundId: string): EvidenceRecord[] {
    const rows = this.stmt(`
      SELECT id, kind, label, detail, outcome, provenance, observed_at, command, exit_code, targets, covers, valid, turn, tool_call_id, facts, denial, request_id, input_fingerprint, check_object
      FROM round_evidence WHERE round_id = ? ORDER BY observed_at, id
    `).all(roundId) as Array<{ id: string; kind: EvidenceRecord['kind']; label: string; detail: string;
      outcome: EvidenceRecord['outcome']; provenance: EvidenceRecord['provenance']; observed_at: string;
      command: string | null; exit_code: number | null; targets: string | null; covers: string | null;
      valid: number | null; turn: number | null; tool_call_id: string | null; facts: string | null; denial: string | null;
      request_id: string | null; input_fingerprint: string | null; check_object: string | null }>
    return rows.map((row) => {
      const record: EvidenceRecord = {
        id: row.id, kind: row.kind, label: row.label,
        detail: row.detail, outcome: row.outcome, provenance: row.provenance,
        observedAt: row.observed_at
      }
      if (row.command !== null) record.command = row.command
      if (row.exit_code !== null) record.exitCode = row.exit_code
      if (row.targets !== null) record.targets = JSON.parse(row.targets) as string[]
      if (row.covers !== null) record.covers = JSON.parse(row.covers) as string[]
      if (row.facts !== null) record.facts = JSON.parse(row.facts) as CheckFact[]
      if (row.denial !== null) record.denial = row.denial
      if (row.valid !== null) record.valid = row.valid === 1
      if (row.turn !== null) record.turn = row.turn
      if (row.tool_call_id !== null) record.toolCallId = row.tool_call_id
      if (row.request_id !== null) record.requestId = row.request_id
      if (row.input_fingerprint !== null) record.inputFingerprint = row.input_fingerprint
      if (row.check_object !== null) record.checkObject = row.check_object
      return record
    })
  }

  deleteEvidenceKind(roundId: string, kind: EvidenceRecord['kind']): void {
    this.stmt('DELETE FROM round_evidence WHERE round_id = ? AND kind = ?').run(roundId, kind)
  }

  /** First-write-wins Round baseline used to project final net workspace changes. */
  saveRoundBaseline(roundId: string, snapshotJson: string): void {
    this.stmt(`
      INSERT OR IGNORE INTO round_baselines(round_id, snapshot_json, created_at)
      VALUES (?, ?, ?)
    `).run(roundId, snapshotJson, new Date().toISOString())
  }

  getRoundBaseline(roundId: string): string | undefined {
    const row = this.stmt('SELECT snapshot_json FROM round_baselines WHERE round_id = ?')
      .get(roundId) as { snapshot_json: string } | undefined
    return row?.snapshot_json
  }


  saveResult(roundId: string, document: ResultDocument): void {
    const now = new Date().toISOString()
    this.stmt(`
      INSERT INTO round_results(round_id, document_json, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(round_id) DO UPDATE SET document_json = excluded.document_json,
        updated_at = excluded.updated_at
    `).run(roundId, JSON.stringify(document), now, now)
  }

  /** Persist a stable historical page atomically: Result and terminal Round
   *  status become visible together, never one without the other. */
  commitRoundTerminal(sessionId: string, round: RoundSummary, document?: ResultDocument): void {
    this.transaction(() => {
      const now = new Date().toISOString()
      if (document) this.saveResult(round.id, document)
      const changed = this.stmt(`
        UPDATE rounds SET status = ?, title = ?, body_markdown = ?, runtime_active = 0,
          loop_phase = CASE WHEN mode = 'loop' THEN 'terminal' ELSE loop_phase END,
          closed_at = ?, updated_at = ?
        WHERE id = ? AND product_session_id = ? AND sequence = ? AND mode = ? AND status = 'active'
      `).run(round.status, round.title, round.bodyMarkdown, now, round.updatedAt || now,
        round.id, sessionId, round.sequence, round.mode)
      if (changed.changes !== 1) throw new Error('Round is not active or its identity changed')
      this.stmt('UPDATE product_sessions SET updated_at = ? WHERE id = ?').run(now, sessionId)
    })
  }

  /** Freeze the latest ready plan before handing control to the build agent. */
  approveLoopPlan(sessionId: string, roundId: string, planVersionId: string): void {
    this.transaction(() => {
      const round = this.stmt(`
        SELECT status, mode, loop_phase FROM rounds WHERE id = ? AND product_session_id = ?
      `).get(roundId, sessionId) as { status: string; mode: RoundMode; loop_phase: string | null } | undefined
      if (!round || round.mode !== 'loop' || round.status !== 'active' || round.loop_phase !== 'ready') {
        throw new Error('Loop Plan is not ready to start')
      }
      const plan = this.stmt('SELECT readiness_json FROM plan_versions WHERE id = ? AND round_id = ?')
        .get(planVersionId, roundId) as { readiness_json: string | null } | undefined
      const readiness = plan?.readiness_json ? JSON.parse(plan.readiness_json) as PlanReadinessSummary : undefined
      if (!plan || readiness?.ready !== true) throw new Error('Only a ready Plan version can start Loop')
      this.stmt(`
        UPDATE rounds SET loop_phase = 'running', approved_plan_version_id = ?, updated_at = ?
        WHERE id = ? AND product_session_id = ?
      `).run(planVersionId, new Date().toISOString(), roundId, sessionId)
    })
  }

  getResult(roundId: string): ResultDocument | undefined {
    const row = this.stmt('SELECT document_json FROM round_results WHERE round_id = ?')
      .get(roundId) as { document_json: string } | undefined
    return row ? JSON.parse(row.document_json) as ResultDocument : undefined
  }

  /** SQLite write transaction serializes contenders in different Electron processes. */
  acquireSessionLease(sessionId: string, onLost?: () => void): SessionLease {
    if (!this.getSession(sessionId)) throw new Error(`Unknown product session: ${sessionId}`)
    const ownerToken = randomUUID()
    const durationMs = 15_000
    const acquired = this.transaction(() => {
      const now = Date.now()
      const changed = this.stmt(`
        INSERT INTO session_leases(product_session_id, owner_token, expires_at_ms)
        VALUES (?, ?, ?)
        ON CONFLICT(product_session_id) DO UPDATE SET
          owner_token = excluded.owner_token, expires_at_ms = excluded.expires_at_ms
        WHERE session_leases.expires_at_ms < ?
      `).run(sessionId, ownerToken, now + durationMs, now)
      return changed.changes === 1
    })
    if (!acquired) throw new Error('Session is already open in another window or process')

    let released = false
    const assertHeld = (): void => {
      if (released) throw new Error('Session lease has been released or lost')
      const row = this.stmt('SELECT owner_token, expires_at_ms FROM session_leases WHERE product_session_id = ?')
        .get(sessionId) as { owner_token: string; expires_at_ms: number } | undefined
      if (!row || row.owner_token !== ownerToken || row.expires_at_ms <= Date.now()) {
        released = true
        clearInterval(timer)
        this.leases.delete(lease)
        onLost?.()
        throw new Error('Session lease has been lost')
      }
    }
    const renew = (): void => {
      if (released) return
      try {
        const now = Date.now()
        const result = this.stmt(`
          UPDATE session_leases SET expires_at_ms = ?
          WHERE product_session_id = ? AND owner_token = ? AND expires_at_ms > ?
        `).run(now + durationMs, sessionId, ownerToken, now)
        if (result.changes !== 1) assertHeld()
      } catch {
        if (!released) {
          released = true
          clearInterval(timer)
          this.leases.delete(lease)
          onLost?.()
        }
      }
    }
    const timer = setInterval(renew, 3_000)
    timer.unref()
    const lease: SessionLease = {
      sessionId,
      ownerToken,
      assertHeld,
      release: () => {
        if (released) return
        released = true
        clearInterval(timer)
        this.stmt('DELETE FROM session_leases WHERE product_session_id = ? AND owner_token = ?')
          .run(sessionId, ownerToken)
        this.leases.delete(lease)
      }
    }
    this.leases.add(lease)
    return lease
  }

  private requireRoundMode(roundId: string, mode: RoundMode): void {
    const row = this.stmt('SELECT mode FROM rounds WHERE id = ?')
      .get(roundId) as { mode: RoundMode } | undefined
    if (!row || row.mode !== mode) throw new Error(`Round is missing or is not ${mode}`)
  }

  private nextOrdinal(table: 'plan_versions' | 'vibe_entries', roundId: string): number {
    const row = this.stmt(`SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM ${table} WHERE round_id = ?`)
      .get(roundId) as { next: number }
    return row.next
  }

  getDraft(sessionId: string): { draft: string; mode: InteractiveMode } {
    const row = this.stmt('SELECT draft, mode, revision FROM drafts WHERE product_session_id = ?')
      .get(sessionId) as DraftRow | undefined
    return row ? { draft: row.draft, mode: normalizeInteractiveMode(row.mode) } : { draft: '', mode: 'vibe' }
  }

  getDraftWithRevision(sessionId: string): { draft: string; mode: InteractiveMode; revision: number } {
    const row = this.stmt('SELECT draft, mode, revision FROM drafts WHERE product_session_id = ?')
      .get(sessionId) as DraftRow | undefined
    return row ? { draft: row.draft, mode: normalizeInteractiveMode(row.mode), revision: row.revision } : { draft: '', mode: 'vibe', revision: 0 }
  }

  saveDraft(sessionId: string, draft: string, mode: InteractiveMode): void {
    this.stmt(`
      INSERT INTO drafts(product_session_id, draft, mode, revision, updated_at)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(product_session_id) DO UPDATE SET
        draft = excluded.draft,
        mode = excluded.mode,
        revision = drafts.revision + 1,
        updated_at = excluded.updated_at
    `).run(sessionId, draft, mode, new Date().toISOString())
  }

  /** Clear only the draft that was submitted, preserving edits made while the runtime was busy. */
  clearDraftIfRevision(sessionId: string, revision: number): boolean {
    const result = this.stmt(`
      UPDATE drafts SET draft = '', revision = revision + 1, updated_at = ?
      WHERE product_session_id = ? AND revision = ?
    `).run(new Date().toISOString(), sessionId, revision)
    return result.changes === 1
  }

  getModelSettings(): ModelSettings {
    const row = this.stmt('SELECT provider, model, base_url FROM model_settings WHERE id = 1')
      .get() as SettingsRow | undefined
    return {
      provider: row?.provider ?? '',
      model: row?.model ?? '',
      ...(row?.base_url ? { baseUrl: row.base_url } : {}),
      hasCredential: false
    }
  }

  saveModelSettings(settings: SavedModelSettings): ModelSettings {
    this.stmt(`
      INSERT INTO model_settings(id, provider, model, base_url) VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        provider = excluded.provider,
        model = excluded.model,
        base_url = excluded.base_url
    `).run(settings.provider, settings.model, settings.baseUrl ?? null)
    return this.getModelSettings()
  }

  close(): void {
    for (const lease of [...this.leases]) lease.release()
    this.statements.clear()
    this.db.close()
  }
}

function toSessionSummary(row: SessionRow): SessionSummary {
  const hasTemporalHistory = Boolean(row.has_temporal_history)
  return {
    id: row.id,
    ...(row.backend_session_id ? { backendSessionId: row.backend_session_id } : {}),
    title: row.title,
    workspacePath: row.workspace_path,
    updatedAt: row.updated_at,
    hasTemporalHistory,
    kind: hasTemporalHistory ? 'temporal' : row.backend_session_id ? 'backend' : 'new',
    permission: (row.permission as SessionSummary['permission']) ?? 'workspace-write'
  }
}


function normalizeInteractiveMode(mode: RoundMode): InteractiveMode {
  return mode === 'loop' || mode === 'plan' ? 'loop' : 'vibe'
}
