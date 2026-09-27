/**
 * Phase B/C/D automated acceptance probe: product domain invariants, evidence
 * cross-check, Result composition, Loop state machine and cross-process leases.
 *
 * Run under Electron's Node (`node:sqlite` is only available in Electron's
 * bundled Node, not the system Node):
 *   $env:ELECTRON_RUN_AS_NODE=1
 *   .\node_modules\electron\dist\electron.exe scripts/probes/temporal-domain.mjs
 *
 * No model or credential is used; DSH is replaced by a deterministic fake so the
 * state machine itself is under test.
 */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const require = createRequire(import.meta.url)
const esbuild = require(join(repoRoot, 'node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/lib/main.js'))

async function bundle(entry, outfile, external = []) {
  await esbuild.build({
    entryPoints: [join(repoRoot, entry)], bundle: true, platform: 'node', format: 'cjs',
    outfile, external, logLevel: 'silent'
  })
  return require(outfile)
}

const storePath = join(here, '.cache-domain-store.cjs')
const enginePath = join(here, '.cache-domain-engine.cjs')
const { ProductStore } = await bundle('src/main/persistence/ProductStore.ts', storePath)
const { RoundEngine } = await bundle('src/main/rounds/RoundEngine.ts', enginePath)
const { EvidenceCollector } = await bundle('src/main/evidence/EvidenceCollector.ts', join(here, '.cache-domain-evidence.cjs'))
const { VerificationExecutor } = await bundle('src/main/evidence/VerificationExecutor.ts', join(here, '.cache-domain-verify.cjs'))
const { ResultBuilder } = await bundle('src/main/result/ResultBuilder.ts', join(here, '.cache-domain-result.cjs'))
const { LoopController, DEFAULT_LOOP_BUDGET } = await bundle('src/main/loop/LoopController.ts', join(here, '.cache-domain-loop.cjs'))
const { TURN_DEADLINE_MESSAGE } = await bundle('src/main/runtime/AgentRuntime.ts', join(here, '.cache-domain-runtime.cjs'))

const checks = {}
const check = (name, value) => { checks[name] = Boolean(value) }

// ---------------------------------------------------------------------------
// Persistent store: migrations, drafts, rounds, projections.
// ---------------------------------------------------------------------------
const root = await mkdtemp(join(tmpdir(), 'temporal-domain-'))
const workspace = join(root, 'workspace')
const dbPath = join(root, 'product.sqlite')

const store = new ProductStore(dbPath)
const session = store.createSession(workspace, 'dsh-domain-1', 'Domain Session')
check('permission_defaults_workspace_write', store.getPermission(session.id) === 'workspace-write')
store.setPermission(session.id, 'danger-full-access')
check('permission_persists', store.getPermission(session.id) === 'danger-full-access')
store.setPermission(session.id, 'workspace-write')

store.saveDraft(session.id, 'draft one', 'plan')
store.saveDraft(session.id, 'draft two', 'plan')
const draft = store.getDraftWithRevision(session.id)
check('draft_revision_increments', draft.revision === 2 && draft.draft === 'draft two')
check('stale_revision_not_cleared', store.clearDraftIfRevision(session.id, 1) === false)
check('current_revision_cleared', store.clearDraftIfRevision(session.id, 2) === true && store.getDraft(session.id).draft === '')

const roundId = 'round-domain-1'
store.saveRound(session.id, { id: roundId, sequence: 1, mode: 'plan', status: 'active', title: 't', updatedAt: new Date().toISOString(), bodyMarkdown: '' })
store.markRoundExecutionStarted(session.id, roundId)
let refusedDoubleStart = false
try { store.markRoundExecutionStarted(session.id, roundId) } catch { refusedDoubleStart = true }
check('double_execution_refused', refusedDoubleStart)
store.markRoundExecutionFinished(session.id, roundId, 'active')
const finished = store.listRounds(session.id)[0]
check('execution_finished_keeps_round_active', finished.status === 'active')

store.appendPlanVersion(roundId, { id: 'pv1', submittedSpec: 's1', planMarkdown: 'plan one', createdAt: new Date().toISOString() })
store.appendPlanVersion(roundId, { id: 'pv2', submittedSpec: 's2', planMarkdown: 'plan two', createdAt: new Date().toISOString() })
check('plan_version_ordinals', store.listPlanVersions(roundId).map((v) => v.id).join(',') === 'pv1,pv2')

// A crashed execution (runtime_active = 1) is reconciled to interrupted, never completed.
const crashId = 'round-domain-crash'
store.saveRound(session.id, { id: crashId, sequence: 2, mode: 'vibe', status: 'active', title: 'crash', updatedAt: new Date().toISOString(), bodyMarkdown: '' })
store.markRoundExecutionStarted(session.id, crashId)
check('reconcile_marks_interrupted', store.reconcileInterruptedRounds(session.id) === 1)
const reconciled = store.listRounds(session.id).find((r) => r.id === crashId)
check('reconciled_status_interrupted', reconciled.status === 'interrupted')

store.saveEvidence(roundId, { id: 'ev1', kind: 'command', label: 'pnpm test', detail: 'ok', outcome: 'passed', provenance: 'tool', observedAt: new Date().toISOString() })
store.saveResult(roundId, { summary: 's', changes: [],
  verification: ['pnpm test — passed'], remaining: [], createdAt: new Date().toISOString() })
const details = store.listRoundDetails(session.id)
check('round_detail_projection', details[0].planVersions.length === 2 && details[0].evidence.length === 1 && details[0].result?.verification.length === 1)

// Same-process lease contention + release.
const leaseA = store.acquireSessionLease(session.id)
let sameProcessBlocked = false
try { store.acquireSessionLease(session.id) } catch { sameProcessBlocked = true }
check('same_process_lease_blocks', sameProcessBlocked)
leaseA.release()
const leaseB = store.acquireSessionLease(session.id)
check('lease_recoverable_after_release', leaseB.ownerToken !== leaseA.ownerToken)
leaseB.release()
store.close()

// ---------------------------------------------------------------------------
// Cross-process lease: a child Electron-Node process holds the lock.
// ---------------------------------------------------------------------------
const childScript = join(root, 'lease-child.cjs')
await writeFile(childScript, `
const { ProductStore } = require(${JSON.stringify(storePath)});
const store = new ProductStore(process.env.DOMAIN_DB);
const lease = store.acquireSessionLease(process.env.DOMAIN_SESSION);
process.stdout.write('HELD\\n');
process.stdin.on('data', () => { lease.release(); store.close(); process.exit(0); });
setInterval(() => {}, 1000);
`)
async function runLeaseChild(db, session, action) {
  const child = spawn(process.execPath, [childScript], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DOMAIN_DB: db, DOMAIN_SESSION: session },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve)
    child.once('error', reject)
    child.once('exit', (code) => reject(new Error(`lease child exited early: ${code}`)))
  })
  return child
}

const holder = await runLeaseChild(dbPath, session.id)
const parent = new ProductStore(dbPath)
let crossProcessBlocked = false
try { parent.acquireSessionLease(session.id) } catch { crossProcessBlocked = true }
check('cross_process_lease_blocks', crossProcessBlocked)
holder.stdin.write('release\n')
await new Promise((resolve) => holder.once('exit', resolve))
let crossProcessReleased = false
try { const l = parent.acquireSessionLease(session.id); l.release(); crossProcessReleased = true } catch { /* still held */ }
check('cross_process_lease_released_on_exit', crossProcessReleased)

const crashed = await runLeaseChild(dbPath, session.id)
crashed.kill()
await new Promise((resolve) => crashed.once('exit', resolve))
let stillBlockedAfterCrash = false
try { parent.acquireSessionLease(session.id) } catch { stillBlockedAfterCrash = true }
check('crash_keeps_lease_until_ttl', stillBlockedAfterCrash)
parent.close()

// ---------------------------------------------------------------------------
// Result builder cross-check: a model claim can never create verification.
// ---------------------------------------------------------------------------
const builder = new ResultBuilder()
const noEvidence = builder.build({
  finalResponse: 'Everything is done and all tests passed.',
  evidence: { changedFiles: ['a.ts'], newFiles: [], verification: [], outcome: 'completed' }
})
// A model claim can never create verification; with none run, the Verification
// section states so explicitly instead of silently hiding it.
check('no_evidence_no_passed_verification', noEvidence.verification.length === 1 && noEvidence.verification[0].includes('本轮未运行验证'))
const withEvidence = builder.build({
  finalResponse: 'Done.',
  evidence: { changedFiles: ['a.ts'], newFiles: ['a.ts'], verification: [{ label: 'pnpm test', detail: 'ok', outcome: 'passed', provenance: 'tool' }], outcome: 'completed' }
})
check('evidence_backs_verification', withEvidence.verification.length === 1 && withEvidence.changes[0].includes('created'))
const failed = builder.build({
  finalResponse: 'I could not finish.',
  evidence: { changedFiles: [], newFiles: [], verification: [], outcome: 'failed' },
  loopTerminal: { status: 'budget_exhausted', reason: '16 continuations' }
})
check('failed_result_has_reason', failed.remaining.some((line) => line.includes('16 continuations')))

// ---------------------------------------------------------------------------
// Loop state machine with a deterministic fake runtime and collector.
// ---------------------------------------------------------------------------
function emptySnapshot() {
  return { git: false, preexisting: new Set(), files: new Map(), dirty: new Map(), fileStates: new Map() }
}
function fakeLoop({ prompts, bundles }) {
  let turn = 0
  const decisionBlock = () => '```temporal-decision\n' + JSON.stringify({
    decision: 'incomplete', reason: 'work remains',
    coverage: [{ item: 'task', status: 'unmet', evidence: [] }],
    incomplete: ['work'], nextAction: 'keep going'
  }) + '\n```'
  const runtime = { prompt: async () => { const step = prompts[Math.min(turn, prompts.length - 1)]; turn += 1; if (step instanceof Error) throw step; return { text: `${step}\n\n${decisionBlock()}` } } }
  const collector = {
    baseline: async () => emptySnapshot(),
    collect: async () => ({ bundle: bundles[Math.min(turn - 1, bundles.length - 1)], snapshot: emptySnapshot() })
  }
  return { controller: new LoopController(runtime, collector), turns: () => turn }
}
function emptyBundle(extra = {}) {
  return { changedFiles: [], turnChangedFiles: [], newFiles: [], deletedFiles: [], preexistingChanges: [], toolFacts: [], verification: [], outcome: 'completed', ...extra }
}

const noProgressInput = { rootSpec: 'do something', workspacePath: root, permission: 'workspace-write', takeEvents: () => [] }
const noProgress = fakeLoop({ prompts: ['still working'], bundles: [emptyBundle()] })
const noProgressResult = await noProgress.controller.run(noProgressInput)
check('loop_no_progress_fails', noProgressResult.terminal.status === 'failed' && noProgressResult.terminal.reason.includes('No progress'))
// Turn 1 establishes the model's coverage state and counts as progress; the
// following maxNoProgress turns add nothing.
check('loop_no_progress_budget', noProgress.turns() === DEFAULT_LOOP_BUDGET.maxNoProgress + 1)

const error = fakeLoop({
  prompts: [new Error('boom'), new Error('boom'), 'unused'],
  bundles: [emptyBundle({ outcome: 'failed' })]
})
const errorResult = await error.controller.run(noProgressInput)
check('loop_same_error_retry_limit', errorResult.terminal.status === 'failed' && error.turns() === DEFAULT_LOOP_BUDGET.maxSameError)

let progressCounter = 0
const runtimeProgress = { prompt: async () => ({ text: 'still missing required item' }) }
const collectorProgress = {
  baseline: async () => emptySnapshot(),
  collect: async () => {
    const file = `file-${progressCounter++}.ts`
    return { bundle: emptyBundle({ changedFiles: [file], turnChangedFiles: [file] }), snapshot: emptySnapshot() }
  }
}
const budgetController = new LoopController(runtimeProgress, collectorProgress)
const budgetResult = await budgetController.run(noProgressInput)
check('loop_budget_exhausted', budgetResult.terminal.status === 'budget_exhausted' && progressCounter === DEFAULT_LOOP_BUDGET.maxContinuations + 1)

// Wall-clock budget with an injected clock: the real 2h boundary is exercised
// without waiting. A run reaching the boundary terminates as budget_exhausted
// with the wall-clock reason; a run just below it must keep going.
function progressCollector(counter) {
  return {
    baseline: async () => emptySnapshot(),
    collect: async () => {
      const file = `wall-${counter.n++}.ts`
      return { bundle: emptyBundle({ changedFiles: [file], turnChangedFiles: [file] }), snapshot: emptySnapshot() }
    }
  }
}
let atClock = 0
const atCounter = { n: 0 }
const atResult = await new LoopController(
  { prompt: async () => { atClock = DEFAULT_LOOP_BUDGET.maxElapsedMs; return { text: 'still missing required item' } } },
  progressCollector(atCounter),
  DEFAULT_LOOP_BUDGET,
  () => atClock
).run(noProgressInput)
check('loop_wall_clock_boundary', atResult.terminal.status === 'budget_exhausted' && atResult.terminal.reason.includes('2 hour') && atCounter.n === 1)

let belowClock = 0
let belowTurn = 0
const belowCounter = { n: 0 }
const decisionBlockText = () => '```temporal-decision\n' + JSON.stringify({ decision: 'incomplete', reason: 'r', coverage: [], incomplete: ['work'], nextAction: '' }) + '\n```'
const belowResult = await new LoopController(
  { prompt: async () => { belowTurn += 1; belowClock = belowTurn === 1 ? DEFAULT_LOOP_BUDGET.maxElapsedMs - 1 : DEFAULT_LOOP_BUDGET.maxElapsedMs; return { text: `still missing required item\n\n${decisionBlockText()}` } } },
  progressCollector(belowCounter),
  DEFAULT_LOOP_BUDGET,
  () => belowClock
).run(noProgressInput)
check('loop_wall_clock_just_below_then_cross', belowResult.terminal.status === 'budget_exhausted' && belowTurn === 2)

// Budget is checked BEFORE a turn starts: once the clock crosses the
// deadline (here: during turn 1's collection), no further model round is
// entered.
let overClock = 0
let overTurns = 0
const overResult = await new LoopController(
  { prompt: async () => { overTurns += 1; return { text: 'still working' } } },
  {
    baseline: async () => emptySnapshot(),
    collect: async () => {
      overClock = DEFAULT_LOOP_BUDGET.maxElapsedMs
      return { bundle: emptyBundle({ changedFiles: ['a.ts'], turnChangedFiles: ['a.ts'] }), snapshot: emptySnapshot() }
    }
  },
  DEFAULT_LOOP_BUDGET,
  () => overClock
).run(noProgressInput)
check('loop_no_turn_after_deadline', overResult.terminal.status === 'budget_exhausted' && overTurns === 1)

// A nominally complete state that arrives at/after the deadline is not
// accepted as completion: the full real gate (evaluator + executor) passes,
// but the clock says the budget is spent by the time completion is judged.
const gateRootLate = await mkdtemp(join(tmpdir(), 'temporal-gate-late-'))
let lateClock = 0
const lateRuntime = {
  prompt: async () => {
    lateClock = DEFAULT_LOOP_BUDGET.maxElapsedMs - 5_000
    await mkdir(join(gateRootLate, 'src'), { recursive: true })
    await writeFile(join(gateRootLate, 'src', 'answer.txt'), 'verify\n')
    return { text: `done\n\n\`\`\`temporal-decision\n${JSON.stringify({ decision: 'completed', reason: 'file created with required content', coverage: [{ item: 'src/answer.txt content', status: 'met', evidence: ['e1'] }], incomplete: [], nextAction: '' })}\n\`\`\`` }
  }
}
const lateExecutor = new VerificationExecutor()
const lateResult = await new LoopController(
  lateRuntime,
  new EvidenceCollector(),
  DEFAULT_LOOP_BUDGET,
  () => lateClock,
  async (request) => {
    lateClock = DEFAULT_LOOP_BUDGET.maxElapsedMs
    return lateExecutor.run(request)
  }
).run({ rootSpec: 'Create a file src/answer.txt whose contents are exactly: verify', workspacePath: gateRootLate, permission: 'workspace-write', takeEvents: () => [] })
check('loop_completed_after_deadline_not_accepted', lateResult.terminal.status === 'budget_exhausted' && lateResult.terminal.reason.includes('not accepted as completed'))

// A deadline termination of a prompt turn is budget exhaustion, classified
// before the repeated-error rule can rename it to 'failed'.
const deadlineResult = await new LoopController(
  { prompt: async () => { throw new Error(TURN_DEADLINE_MESSAGE) } },
  { baseline: async () => emptySnapshot(), collect: async () => ({ bundle: emptyBundle({ outcome: 'failed' }), snapshot: emptySnapshot() }) },
  DEFAULT_LOOP_BUDGET
).run(noProgressInput)
check('loop_deadline_failure_is_budget_exhausted', deadlineResult.terminal.status === 'budget_exhausted' && deadlineResult.terminal.reason.includes('wall-clock budget during a model turn'))

// Plain-text [BLOCKED] is honored only when no structured decision exists
// (the fallback path); a decision block saying blocked is covered in the
// decision-gate probe.
const blockedResult = await new LoopController(
  { prompt: async () => ({ text: '[BLOCKED] needs user approval' }) },
  { baseline: async () => emptySnapshot(), collect: async () => ({ bundle: emptyBundle(), snapshot: emptySnapshot() }) },
  { ...DEFAULT_LOOP_BUDGET, maxContinuations: 1 }
).run(noProgressInput)
check('loop_blocked', blockedResult.terminal.status === 'blocked')

// Positive path: completion only through the real collector, the real
// verification executor and the evaluator gate — never through a model claim.
// The requirement carries real acceptance semantics (file exists AND content
// matches); a bare empty file cannot satisfy it.
const gateRoot = await mkdtemp(join(tmpdir(), 'temporal-gate-'))
const gateRuntime = {
  prompt: async () => {
    await mkdir(join(gateRoot, 'src'), { recursive: true })
    await writeFile(join(gateRoot, 'src', 'answer.txt'), 'verify\n')
    return { text: `done\n\n\`\`\`temporal-decision\n${JSON.stringify({ decision: 'completed', reason: 'file created with required content', coverage: [{ item: 'src/answer.txt content', status: 'met', evidence: ['e1'] }], incomplete: [], nextAction: '' })}\n\`\`\`` }
  }
}
const gateEvidence = new EvidenceCollector()
const gateController = new LoopController(gateRuntime, gateEvidence, DEFAULT_LOOP_BUDGET, Date.now, new VerificationExecutor().run)
const gateSpec = 'Create a file src/answer.txt whose contents are exactly: verify'
const gateResult = await gateController.run({ rootSpec: gateSpec, workspacePath: gateRoot, permission: 'workspace-write', takeEvents: () => [] })
check('loop_completes_with_valid_evidence', gateResult.terminal.status === 'completed' && gateResult.terminal.reason.includes('validated the citations'))
check('loop_completed_evidence_is_builtin_content_fact', gateResult.evidence.verification.some(
  (run) => run.outcome === 'passed' && run.method === 'builtin' && run.facts.some((fact) => fact.kind === 'content-equals' && fact.matched)
))

// ---------------------------------------------------------------------------
// RoundEngine: Plan reuse/versioning, Plan→Vibe finalize, Vibe accumulation,
// Loop new-round terminal, and evidence persistence through the real collector.
// ---------------------------------------------------------------------------
const engineRoot = await mkdtemp(join(tmpdir(), 'temporal-engine-ws-'))
const engineSession = storeLike()
function storeLike() {
  const s = new ProductStore(join(engineRoot, 'engine.sqlite'))
  return s
}
const projectSession = engineSession.createSession(engineRoot, undefined, 'Engine')
let fileCounter = 0
let verification = false
const runtime = {
  prompt: async () => {
    fileCounter += 1
    await writeFile(join(engineRoot, `artifact-${fileCounter}.txt`), 'x')
    const decision = JSON.stringify({ decision: 'completed', reason: 'artifact written', coverage: [{ item: 'artifact', status: 'met', evidence: ['e1'] }], incomplete: [], nextAction: '' })
    return { text: `output ${fileCounter}\n\n\`\`\`temporal-decision\n${decision}\n\`\`\`` }
  }
}
const evidence = new EvidenceCollector()
const engine = new RoundEngine({
  store: engineSession,
  ensureRuntime: async () => runtime,
  evidence,
  resultBuilder: new ResultBuilder(),
  verify: new VerificationExecutor().run,
  takeEvents: () => (verification ? [{ id: 'v', at: new Date().toISOString(), kind: 'verification', message: 'pnpm test' }] : []),
  onRoundChanged: () => {}
})

await engine.submit({ session: projectSession, mode: 'plan', spec: 'plan spec one' })
await engine.submit({ session: projectSession, mode: 'plan', spec: 'plan spec two' })
let rounds = engineSession.listRounds(projectSession.id)
check('plan_reuses_single_round', rounds.length === 1 && rounds[0].mode === 'plan')
check('plan_two_versions', engineSession.listPlanVersions(rounds[0].id).length === 2)

await engine.submit({ session: projectSession, mode: 'vibe', spec: 'vibe spec one' })
rounds = engineSession.listRounds(projectSession.id)
check('plan_to_vibe_finalizes_plan', rounds.length === 2 && rounds[0].status === 'completed' && rounds[1].mode === 'vibe' && rounds[1].status === 'active')
await engine.submit({ session: projectSession, mode: 'vibe', spec: 'vibe spec two' })
rounds = engineSession.listRounds(projectSession.id)
check('vibe_reuses_round', rounds.length === 2 && engineSession.listVibeEntries(rounds[1].id).length === 2)
await engine.endCurrent(projectSession)
rounds = engineSession.listRounds(projectSession.id)
const vibeResult = engineSession.getResult(rounds[1].id)
check('vibe_finalize_builds_result', rounds[1].status === 'completed' && Boolean(vibeResult))

verification = true
// The loop round must complete through the real gate: the model writes the
// next artifact with the required content and the product's verification
// executor confirms content through the built-in read-only check.
const loopTarget = `artifact-${fileCounter + 1}.txt`
await engine.submit({ session: projectSession, mode: 'loop', spec: `Create a file ${loopTarget} whose contents are exactly: x` })
rounds = engineSession.listRounds(projectSession.id)
const loopRound = rounds[2]
const loopResult = engineSession.getResult(loopRound.id)
check('loop_creates_new_terminal_round', rounds.length === 3 && loopRound.mode === 'loop' && loopRound.status === 'completed')
check('loop_result_terminal', loopResult?.loopTerminal?.status === 'completed')
check('loop_result_requirement_coverage', Array.isArray(loopResult?.coverage) && loopResult.coverage.length >= 1 && loopResult.coverage.every((item) => item.status === 'satisfied'))
check('loop_result_saves_decision', loopResult?.decision?.decision === 'completed' && Array.isArray(loopResult.decision.validRunIds))
check('evidence_persisted', engineSession.listEvidence(loopRound.id).some((record) => record.kind === 'workspace'))

// A passed run that is no longer in the decision's validRunIds is marked as
// historical in the Result — it never poses as the current verification.
{
  const builder = new ResultBuilder()
  const runNow = { id: 'run-now', label: 'now', method: 'builtin', command: 'builtin:content-equals a.txt', exitCode: 0, signal: null, outputTail: '', scope: 'file', targets: ['a.txt'], facts: [], stamps: new Map(), outcome: 'passed', at: new Date().toISOString() }
  const runStale = { ...runNow, id: 'run-stale', label: 'stale' }
  const doc = builder.build({
    finalResponse: 'r', outcome: 'failed',
    evidence: { changedFiles: ['a.txt'], turnChangedFiles: ['a.txt'], newFiles: ['a.txt'], deletedFiles: [], preexistingChanges: [], toolFacts: [], verification: [runStale, runNow], outcome: 'failed' },
    loopTerminal: { status: 'failed', reason: 'no progress' },
    decision: { decision: 'continue', reason: 'r', items: [], incomplete: ['x'], knownIssues: ['k'], nextPrompt: '', nextChecks: [], sandboxScripts: [], validRunIds: ['run-now'] },
    round: { mode: 'loop', turns: [{ spec: 's', outcome: 'failed' }] }
  })
  check('result_marks_historical_passes', doc.verification.some((line) => line.includes('stale') && line.includes('历史')) && doc.verification.some((line) => line.includes('now') && !line.includes('历史')))
  check('result_decision_persisted_on_failure', doc.decision?.decision === 'continue' && doc.decision.knownIssues.includes('k'))
}

// ---------------------------------------------------------------------------
// TODO 7 §3 (B): the Result summarizes the WHOLE round, not the last request.
// Entered from RoundEngine's whole-round closing (vibe finalize) above.
// ---------------------------------------------------------------------------
{
  // Vibe with two requests: the summary covers BOTH, never just the last one,
  // and with no product verification it says so instead of inventing passes.
  const vibeDoc = engineSession.getResult(rounds[1].id)
  check('b_summary_covers_both_vibe_requests',
    vibeDoc?.summary.includes('请求#1') && vibeDoc?.summary.includes('请求#2')
    && vibeDoc?.summary.includes('vibe spec one') && vibeDoc?.summary.includes('vibe spec two')
    && vibeDoc?.summary.includes('output 3') && vibeDoc?.summary.includes('output 4')
    && !vibeDoc?.summary.includes('temporal-decision'))
  check('b_vibe_completion_is_request_ended_not_acceptance',
    vibeDoc?.summary.includes('不代表功能验收通过'))
  check('b_no_verification_stated_explicitly',
    vibeDoc?.verification.some((line) => line.includes('本轮未运行验证')))
  check('b_unconfirmed_when_no_verification',
    vibeDoc?.remaining.some((line) => line.includes('需求完成情况未独立确认')))

  // Plan: two versions → final plan + revisions, and the plan never claims
  // the implementation is done.
  const planDoc = engineSession.getResult(rounds[0].id)
  check('b_plan_final_version_and_revisions',
    planDoc?.summary.includes('最终计划为版本 2') && planDoc?.summary.includes('逐步修订') && planDoc?.summary.includes('output 2'))
  check('b_plan_does_not_claim_implementation',
    planDoc?.summary.includes('只产出计划'))

  // Loop: the terminal outcome + evidence coverage appear in the summary.
  check('b_loop_summary_terminal', loopResult?.summary.includes('Loop 轮次终态') && loopResult?.summary.includes('有效通过验证见 Verification') && /执行成果记录: output \d/.test(loopResult?.summary ?? ''))

  // Reopen: a fresh ProductStore on the same database sees the SAME four-part
  // Result (persisted whole-round summary), keeping historical/current and the
  // evidence source intact after restart.
  const reopenedStore = new ProductStore(join(engineRoot, 'engine.sqlite'))
  const reopenedVibe = reopenedStore.getResult(rounds[1].id)
  check('b_reopen_result_consistent',
    Boolean(reopenedVibe)
    && reopenedVibe.summary.includes('请求#1') && reopenedVibe.summary.includes('请求#2')
    && reopenedVibe.verification.some((line) => line.includes('本轮未运行验证'))
    && reopenedVibe.remaining.some((line) => line.includes('需求完成情况未独立确认'))
    && Array.isArray(reopenedVibe.changes) && Array.isArray(reopenedVibe.verification) && Array.isArray(reopenedVibe.remaining))
  const reopenedLoop = reopenedStore.getResult(loopRound.id)
  check('b_reopen_loop_terminal_preserved', reopenedLoop?.loopTerminal?.status === 'completed' && Boolean(reopenedLoop.summary.includes('有效通过验证见 Verification')))
  reopenedStore.close()

  // Summarization must never block saving: a pathological output value throws
  // inside the (deterministic) summarizer and the Result still saves with a
  // readable per-request fallback.
  const exceptionDoc = builder.build({
    finalResponse: 'r', outcome: 'completed',
    evidence: { changedFiles: ['a.ts'], turnChangedFiles: [], newFiles: ['a.ts'], deletedFiles: [], preexistingChanges: [], toolFacts: [], verification: [], outcome: 'completed' },
    round: { mode: 'plan', turns: [{ spec: 's', outcome: 'completed', output: 123 }] }
  })
  check('b_result_survives_summary_exception',
    exceptionDoc.summary.includes('实际输出见请求记录') && exceptionDoc.summary.length > 0)
}
engineSession.close()

const passed = Object.values(checks).every(Boolean)
console.log(JSON.stringify({ checks, passed }, null, 2))
if (!passed) process.exitCode = 1
