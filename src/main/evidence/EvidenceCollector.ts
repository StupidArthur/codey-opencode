import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { EvidenceSummary, ExecutionOutcome, RunnerEvent } from '../../shared/contracts'
import type {
  CollectResult, EvidenceBundle, FileState, FileStateMap, ToolCallFact, VerificationRun, WorkspaceSnapshot
} from './evidence'
import { VERIFY_DIR } from './evidence'

const run = promisify(execFile)
const MAX_DIFF = 4_000
const MAX_FILES = 200
const MAX_WALK = 4_000
/** Content hashes are computed for files up to this size (same-size/same-mtime detection). */
const HASH_CAP_BYTES = 1_000_000
const SNAPSHOT_IO_CONCURRENCY = 24
const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', 'build', 'out', 'release', 'coverage', 'target', '__pycache__', 'venv'])

interface FileStamp {
  mtimeMs: number
  size: number
  hash?: string
}

/**
 * Reads the real workspace before and after an execution; never trusts model
 * claims. Verification verdicts are never derived from Runner events or tool
 * titles: the loop feeds this collector with `ToolCallFact`s (observed facts
 * only) and the product's verification executor runs (the only source of
 * `passed`/`failed`).
 */
export class EvidenceCollector {
  /** Capture the state before the round starts (records pre-existing changes). */
  async baseline(workspacePath: string): Promise<WorkspaceSnapshot> {
    const git = await isGitRepo(workspacePath)
    const files = await snapshotFiles(workspacePath)
    const dirty = git ? await gitStatus(workspacePath) : new Map<string, string>()
    const preexisting = new Set(dirty.keys())
    return {
      git,
      preexisting,
      files,
      dirty,
      fileStates: toFileStates(files, null)
    }
  }

  /**
   * Diff the workspace against both the round-start snapshot (round-so-far
   * changes) and the previous turn's snapshot (this turn's delta).
   */
  async collect(
    workspacePath: string,
    startSnapshot: WorkspaceSnapshot,
    prevSnapshot: WorkspaceSnapshot,
    _events: RunnerEvent[],
    toolFacts: ToolCallFact[],
    outcome: ExecutionOutcome
  ): Promise<CollectResult> {
    const isGit = await isGitRepo(workspacePath)
    const files = await snapshotFiles(workspacePath)
    const dirty = isGit ? await gitStatus(workspacePath) : new Map<string, string>()

    // Content-first delta: a file counts as changed when its content hash
    // differs from the comparison snapshot (mtime-only touches do not count);
    // mtime/size are the fallback when no hash is available. This detects
    // additional modifications to a file that was already dirty before, in
    // both the round-so-far and the per-turn view.
    const contentDeltaFromStart = changedSinceFiles(startSnapshot.files, files)
    const contentDeltaFromPrev = changedSinceFiles(prevSnapshot.files, files)
    const deleted = [...startSnapshot.files.keys()].filter((file) => !files.has(file))

    const dirtyOrGone = new Set<string>([...dirty.keys(), ...deleted])
    const changedFiles = isGit
      ? contentDeltaFromStart.filter((file) => dirtyOrGone.has(file))
      : contentDeltaFromStart
    // The turn delta is content-based for git and non-git workspaces alike,
    // so two continuations that modify the same file each register their own
    // delta instead of the second one disappearing behind the first.
    const turnChangedFiles = contentDeltaFromPrev
    const newFiles = changedFiles.filter((file) =>
      isGit ? (dirty.get(file) ?? '').startsWith('?') : !startSnapshot.files.has(file)
    )
    const deletedFiles = deleted.filter((file) =>
      isGit ? (dirty.get(file) ?? '').includes('D') || !dirty.has(file) : true
    )
    // The product's verification artifacts (`temporal-verify`, including the
    // model-run wrappers and the exit/log files they produce) are product
    // material, not user task work: they must never count as task changes,
    // progress, or Result artifacts, and their own writes must never invalidate
    // a check's input fingerprint.
    const userWork = (file: string): boolean => !file.startsWith(`${VERIFY_DIR}/`)
    const changedFilesFiltered = changedFiles.filter(userWork)
    const turnChangedFilesFiltered = turnChangedFiles.filter(userWork)
    const newFilesFiltered = newFiles.filter(userWork)
    const deletedFilesFiltered = deletedFiles.filter(userWork)

    let gitDiffSummary: string | undefined
    if (isGit) {
      const diff = await git(workspacePath, ['diff', '--stat'])
      if (diff?.trim()) gitDiffSummary = diff.trim().slice(0, MAX_DIFF)
    }

    const bundle: EvidenceBundle = {
      changedFiles: dedupe(changedFilesFiltered).slice(0, MAX_FILES),
      turnChangedFiles: dedupe(turnChangedFilesFiltered).slice(0, MAX_FILES),
      newFiles: dedupe(newFilesFiltered).slice(0, MAX_FILES),
      deletedFiles: dedupe(deletedFilesFiltered).slice(0, MAX_FILES),
      preexistingChanges: [...startSnapshot.preexisting].slice(0, MAX_FILES),
      ...(isGit ? { fileStatus: new Map(dirty) } : {}),
      ...(gitDiffSummary ? { gitDiffSummary } : {}),
      toolFacts,
      verification: [],
      outcome
    }

    const snapshot: WorkspaceSnapshot = { git: isGit, preexisting: startSnapshot.preexisting, files, dirty, fileStates: toFileStates(files, startSnapshot.files) }
    return { bundle, snapshot }
  }

  /** Current file states (including deletions relative to the baseline). */
  currentFileStates(workspacePath: string, baseline: WorkspaceSnapshot): Promise<FileStateMap> {
    return snapshotFiles(workspacePath).then((files) => toFileStates(files, baseline.files))
  }

  toRecords(bundle: EvidenceBundle): EvidenceSummary[] {
    const at = (offset: number): string => new Date(Date.now() + offset).toISOString()
    const records: EvidenceSummary[] = []
    bundle.changedFiles.forEach((file, index) => {
      records.push({
        id: randomUUID(), kind: 'workspace', label: file,
        detail: describeChange(bundle, file), outcome: 'observed',
        provenance: 'tool', observedAt: at(index)
      })
    })
    if (bundle.gitDiffSummary) {
      records.push({ id: randomUUID(), kind: 'workspace', label: 'git diff --stat', detail: bundle.gitDiffSummary, outcome: 'observed', provenance: 'tool', observedAt: at(records.length) })
    }
    // Tool-call telemetry (read/edit/bash/etc.) is execution history, not
    // evidence. It stays in Runner/toolFacts for progress policy and diagnostics
    // but is deliberately not persisted into the user-facing Evidence section.
    for (const run of bundle.verification) {
      records.push({
        id: run.id, kind: 'command', label: run.label, detail: runDetail(run),
        // The DB outcome domain is passed/failed/observed; a denial is stored
        // as observed plus its structured reason and reconstructed on read.
        outcome: run.outcome === 'denied' ? 'observed' : run.outcome,
        provenance: 'tool', observedAt: run.at, command: run.command, exitCode: run.exitCode,
        targets: run.targets, facts: run.facts,
        ...(run.denial ? { denial: run.denial } : {}),
        turn: run.turn,
        ...(run.requestId ? { requestId: run.requestId } : {}),
        ...(run.inputFingerprint ? { inputFingerprint: run.inputFingerprint } : {}),
        ...(run.checkObject ? { checkObject: run.checkObject } : {})
      })
    }
    return records
  }
}

/** Accurate per-file change description: created / deleted / modified, with a
 *  staged marker for paths whose git index column is set. */
function describeChange(bundle: EvidenceBundle, file: string): string {
  if (bundle.newFiles.includes(file)) return 'created'
  if (bundle.deletedFiles.includes(file)) return 'deleted'
  const status = bundle.fileStatus?.get(file) ?? ''
  const staged = status.length >= 1 && status[0] !== ' ' && status[0] !== '?'
  return staged ? 'modified (staged)' : 'modified'
}

function runDetail(run: VerificationRun): string {
  if (run.outcome === 'denied') return `denied — ${run.denial ?? 'executor refused the check'}`
  // Sandbox checks: the product reads artifacts the model produced through the active agent backend's
  // own confined execution. The product factually verified the result artifact
  // (and the input snapshot it was requested against) — it did not directly
  // capture a child-process exit. The source is stated as such, never as a
  // directly-observed process exit.
  const source = run.requestId ? '模型执行检查报告；产品核实结果产物及输入快照 — ' : ''
  if (run.method === 'builtin') {
    const fact = run.facts[0]
    if (fact?.kind === 'file-exists') return `${source}${fact.matched ? 'file exists' : fact.isFile ? 'missing' : 'path exists but is not a regular file'}`
    if (fact?.kind === 'content-equals') {
      return fact.matched
        ? `${source}content match (sha1 ${fact.actualHash})`
        : `${source}content mismatch (expected sha1 ${fact.expectedHash}, actual ${fact.actualHash ?? 'n/a'})`
    }
    if (fact?.kind === 'field-equals') {
      return fact.matched
        ? `${source}field '${fact.key}' = '${fact.expected}'`
        : `${source}field '${fact.key}' is ${fact.actual === null ? 'missing' : `'${fact.actual}'`}, expected '${fact.expected}'`
    }
    return `${source}${run.outputTail || 'builtin check'}`
  }
  const tail = run.outputTail ? ` — ${run.outputTail}` : ''
  return `exit ${run.exitCode === null ? 'n/a' : run.exitCode}${tail}`
}

async function isGitRepo(workspacePath: string): Promise<boolean> {
  return (await git(workspacePath, ['rev-parse', '--is-inside-work-tree']))?.trim() === 'true'
}

async function gitStatus(workspacePath: string): Promise<Map<string, string>> {
  const out = await git(workspacePath, ['status', '--porcelain'])
  const dirty = new Map<string, string>()
  for (const line of (out ?? '').split('\n')) {
    const path = line.slice(3).trim()
    if (path) dirty.set(path, line.slice(0, 2))
  }
  return dirty
}

async function git(workspacePath: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['-C', workspacePath, ...args], { maxBuffer: 8 * 1024 * 1024, windowsHide: true })
    return stdout
  } catch {
    return null
  }
}

/** Relative path → stamp for every ordinary file reachable within depth 3. */
async function snapshotFiles(root: string): Promise<Map<string, FileStamp>> {
  const found = new Map<string, FileStamp>()
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  const candidates: Array<{ full: string; relativePath: string }> = []
  let visited = 0

  // Enumerate first, then stat/hash in bounded parallel batches. Dependency
  // and generated-output directories are not task inputs and can be enormous
  // on Windows, so do not walk them at all.
  while (queue.length > 0 && visited < MAX_WALK && candidates.length < MAX_FILES) {
    const { dir, depth } = queue.shift()!
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      visited += 1
      if (entry.isDirectory()) {
        if (depth < 3 && !SKIP_DIR_NAMES.has(entry.name)) queue.push({ dir: full, depth: depth + 1 })
        continue
      }
      if (!entry.isFile()) continue
      candidates.push({ full, relativePath: relative(root, full).replace(/\\/g, '/') })
      if (candidates.length >= MAX_FILES || visited >= MAX_WALK) break
    }
  }

  for (let offset = 0; offset < candidates.length; offset += SNAPSHOT_IO_CONCURRENCY) {
    const batch = candidates.slice(offset, offset + SNAPSHOT_IO_CONCURRENCY)
    const stamped = await Promise.all(batch.map(async ({ full, relativePath }) => {
      try {
        const info = await stat(full)
        const stamp: FileStamp = { mtimeMs: info.mtimeMs, size: info.size }
        if (info.size <= HASH_CAP_BYTES) {
          try {
            stamp.hash = createHash('sha1').update(await readFile(full)).digest('hex')
          } catch { /* unreadable: fall back to mtime/size only */ }
        }
        return { relativePath, stamp }
      } catch {
        return undefined
      }
    }))
    for (const item of stamped) {
      if (item) found.set(item.relativePath, item.stamp)
    }
  }
  return found
}

/** Files that appeared, were touched, or disappeared between two snapshots.
 *  When both sides carry a content hash, only a hash difference counts —
 *  mtime-only touches (checkout, status refresh) are not changes. */
function changedSinceFiles(before: Map<string, FileStamp>, after: Map<string, FileStamp>): string[] {
  const changed: string[] = []
  for (const [file, stamp] of after) {
    const prev = before.get(file)
    if (prev === undefined) { changed.push(file); continue }
    if (prev.hash !== undefined && stamp.hash !== undefined) {
      if (prev.hash !== stamp.hash) changed.push(file)
      continue
    }
    if (prev.mtimeMs !== stamp.mtimeMs || prev.size !== stamp.size) changed.push(file)
  }
  for (const file of before.keys()) {
    if (!after.has(file)) changed.push(file)
  }
  return changed
}

function toFileStates(files: Map<string, FileStamp>, baseline: Map<string, FileStamp> | null): FileStateMap {
  const states: FileStateMap = new Map()
  for (const [file, stamp] of files) {
    states.set(file, { exists: true, mtimeMs: stamp.mtimeMs, size: stamp.size, ...(stamp.hash ? { hash: stamp.hash } : {}) })
  }
  if (baseline) {
    for (const file of baseline.keys()) {
      if (!states.has(file)) states.set(file, { exists: false, mtimeMs: 0, size: 0 })
    }
  }
  return states
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

export type { FileState, FileStateMap }
