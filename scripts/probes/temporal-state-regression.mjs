/**
 * Regression probe for Temporal state integrity. No real model/backend is used.
 * Run under Electron's Node because ProductStore uses node:sqlite.
 */
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const require = createRequire(import.meta.url)
const esbuild = require(join(repoRoot, 'node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/lib/main.js'))

async function bundle(entry, outfile) {
  await esbuild.build({
    entryPoints: [join(repoRoot, entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    logLevel: 'silent'
  })
  return require(outfile)
}

const { ProductStore } = await bundle('src/main/persistence/ProductStore.ts', join(here, '.cache-state-store.cjs'))
const { RoundEngine } = await bundle('src/main/rounds/RoundEngine.ts', join(here, '.cache-state-engine.cjs'))
const { EvidenceCollector } = await bundle('src/main/evidence/EvidenceCollector.ts', join(here, '.cache-state-evidence.cjs'))
const { ResultBuilder } = await bundle('src/main/result/ResultBuilder.ts', join(here, '.cache-state-result.cjs'))
const { TURN_CANCELLED_MESSAGE } = await bundle('src/main/runtime/AgentRuntime.ts', join(here, '.cache-state-runtime.cjs'))

const checks = {}
const check = (name, value) => { checks[name] = Boolean(value) }

const readyPlan = `# Goal
Deliver the requested repository change with an observable final result.

# Scope
- Include the requested implementation.
- Exclude unrelated refactors.

# Current State
The relevant workspace area has been inspected and the requested behavior is not yet implemented.

# Implementation
1. Update the target implementation in the relevant source file.
2. Verify the change and address any failing checks.

# Affected Files
- src/example.ts

# Acceptance Criteria
- The requested behavior is implemented in src/example.ts.
- Existing behavior outside the requested scope remains unchanged.

# Verification
- \`pnpm test\`
- \`pnpm typecheck\`

# Constraints
None

# Open Questions
None`

function engineFor(store, runtime, cancellation = () => false) {
  return new RoundEngine({
    store,
    ensureRuntime: async () => runtime,
    evidence: new EvidenceCollector(),
    resultBuilder: new ResultBuilder(),
    takeEvents: () => [],
    isCancellationRequested: cancellation,
    onRoundChanged: () => {}
  })
}

// New work defaults to Vibe; legacy Plan drafts are normalized into Loop planning.
{
  const root = await mkdtemp(join(tmpdir(), 'codey-default-mode-'))
  const store = new ProductStore(join(root, 'product.sqlite'))
  const session = store.createSession(root, undefined, 'Default mode')
  check('new_session_defaults_to_vibe', store.getDraft(session.id).mode === 'vibe')
  store.close()
}

// Vibe request failure is a turn failure, not a terminal Round.
{
  const root = await mkdtemp(join(tmpdir(), 'codey-vibe-failure-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const store = new ProductStore(join(root, 'product.sqlite'))
  const session = store.createSession(workspace, undefined, 'Vibe failure')
  const runtime = { prompt: async () => { throw new Error('temporary backend failure') } }
  const engine = engineFor(store, runtime)
  let failed = false
  try { await engine.submit({ session, mode: 'vibe', spec: 'try work' }) } catch { failed = true }
  const round = store.listRounds(session.id)[0]
  const entries = store.listVibeEntries(round.id)
  check('vibe_failure_surfaces_error', failed)
  check('vibe_failure_keeps_round_active', round.status === 'active')
  check('vibe_failure_records_failed_entry', entries.length === 1 && entries[0].executionOutcome === 'failed')
  store.close()
}

// Vibe Result Changes is the net Round delta, not the union of intermediate edits.
{
  const root = await mkdtemp(join(tmpdir(), 'codey-vibe-net-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  await writeFile(join(workspace, 'same.txt'), 'original')
  const store = new ProductStore(join(root, 'product.sqlite'))
  const session = store.createSession(workspace, undefined, 'Vibe net')
  const runtime = {
    prompt: async (spec) => {
      await writeFile(join(workspace, 'same.txt'), spec === 'revert' ? 'original' : 'changed')
      return { text: spec }
    }
  }
  const engine = engineFor(store, runtime)
  await engine.submit({ session, mode: 'vibe', spec: 'change' })
  await engine.submit({ session, mode: 'vibe', spec: 'revert' })
  await engine.endCurrent(session)
  const round = store.listRounds(session.id)[0]
  const result = store.getResult(round.id)
  check('vibe_revert_has_no_final_change', Boolean(result) && !result.changes.some((line) => line.includes('same.txt')))
  check('vibe_final_evidence_drops_reverted_file', !store.listEvidence(round.id).some((row) => row.kind === 'workspace' && row.label === 'same.txt'))
  store.close()
}

// Loop cannot start until the product-owned Plan gate is ready.
{
  const root = await mkdtemp(join(tmpdir(), 'codey-loop-plan-gate-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const store = new ProductStore(join(root, 'product.sqlite'))
  const session = store.createSession(workspace, undefined, 'Loop plan gate')
  const runtime = {
    prompt: async () => ({ text: '# Goal\nDo the task.\n\n# Open Questions\nNeed user input.' })
  }
  const engine = engineFor(store, runtime)
  await engine.submit({ session, mode: 'loop', spec: 'ambiguous autonomous task' })
  const round = store.listRounds(session.id)[0]
  let rejected = false
  try { await engine.startLoop(session) } catch { rejected = true }
  check('loop_incomplete_plan_stays_planning', round.loopPhase === 'planning')
  check('loop_incomplete_plan_cannot_start', rejected)
  store.close()
}

// Loop terminal outcome is preserved all the way to the Run-facing return value.
{
  const root = await mkdtemp(join(tmpdir(), 'codey-loop-blocked-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const store = new ProductStore(join(root, 'product.sqlite'))
  const session = store.createSession(workspace, undefined, 'Loop blocked')
  const decision = {
    decision: 'blocked',
    reason: 'needs user approval',
    coverage: [{ item: 'approval', status: 'unmet', evidence: [] }],
    incomplete: ['approval'],
    nextAction: 'ask user'
  }
  const runtime = {
    prompt: async (_spec, options) => options?.agent === 'plan'
      ? ({ text: readyPlan })
      : ({ text: 'blocked\n\n\`\`\`temporal-decision\n' + JSON.stringify(decision) + '\n\`\`\`' })
  }
  const engine = engineFor(store, runtime)
  await engine.submit({ session, mode: 'loop', spec: 'Continue only after user approval' })
  const planned = store.listRounds(session.id)[0]
  check('loop_requires_ready_plan_before_start', planned.loopPhase === 'ready' && store.listPlanVersions(planned.id).at(-1)?.readiness?.ready === true)
  const submitted = await engine.startLoop(session)
  const round = store.listRounds(session.id)[0]
  const result = store.getResult(round.id)
  check('loop_blocked_run_outcome_preserved', submitted.outcome === 'blocked')
  check('loop_blocked_round_status_preserved', round.status === 'blocked')
  check('loop_blocked_result_preserved', result?.loopTerminal?.status === 'blocked')
  store.close()
}

// Crash recovery terminalizes the Loop phase as well as the Round status.
{
  const root = await mkdtemp(join(tmpdir(), 'codey-loop-crash-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const store = new ProductStore(join(root, 'product.sqlite'))
  const session = store.createSession(workspace, undefined, 'Loop crash')
  const round = {
    id: 'crash-loop-round',
    sequence: 1,
    mode: 'loop',
    status: 'active',
    title: 'crashed loop',
    updatedAt: new Date().toISOString(),
    bodyMarkdown: 'partial output',
    loopPhase: 'running'
  }
  store.saveRound(session.id, round)
  store.markRoundExecutionStarted(session.id, round.id)
  const runtime = { prompt: async () => ({ text: '' }) }
  const engine = engineFor(store, runtime)
  await engine.reconcileInterrupted(session)
  const recovered = store.listRounds(session.id)[0]
  const result = store.getResult(round.id)
  check('loop_crash_status_interrupted', recovered.status === 'interrupted')
  check('loop_crash_phase_terminal', recovered.loopPhase === 'terminal')
  check('loop_crash_saves_interrupted_result', result?.loopTerminal?.status === 'interrupted')
  store.close()
}

// Cancellation always leaves a terminal Result rather than a bare interrupted Round.
{
  const root = await mkdtemp(join(tmpdir(), 'codey-loop-cancel-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const store = new ProductStore(join(root, 'product.sqlite'))
  const session = store.createSession(workspace, undefined, 'Loop cancel')
  const runtime = {
    prompt: async (_spec, options) => {
      if (options?.agent === 'plan') return { text: readyPlan }
      await writeFile(join(workspace, 'partial.txt'), 'partial')
      throw new Error(TURN_CANCELLED_MESSAGE)
    },
    takeToolFacts: () => []
  }
  const engine = engineFor(store, runtime)
  await engine.submit({ session, mode: 'loop', spec: 'long task' })
  const submitted = await engine.startLoop(session)
  const round = store.listRounds(session.id)[0]
  const result = store.getResult(round.id)
  check('loop_cancel_outcome_interrupted', submitted.outcome === 'interrupted' && round.status === 'interrupted')
  check('loop_cancel_saves_result', result?.loopTerminal?.status === 'interrupted')
  check('loop_cancel_result_keeps_partial_change', result?.changes.some((line) => line.includes('partial.txt')))
  store.close()
}

const passed = Object.values(checks).every(Boolean)
console.log(JSON.stringify({ checks, passed }, null, 2))
if (!passed) process.exitCode = 1
