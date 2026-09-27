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

const readyPlan = `# 目标与范围
完成用户要求的仓库修改，并产生可观察、可验证的最终结果。
- 包含用户要求的实现。
- 不包含无关重构。

# 实施计划
1. 检查相关实现和调用链，在 src/example.ts 中完成目标行为并保持现有接口兼容。
2. 调整相关测试覆盖目标行为与回归场景，再处理与本次修改直接相关的失败项。
3. 检查最终 diff，确保没有引入范围外重构。

# 验收标准
- src/example.ts 中实现用户要求的行为。
- 请求范围之外的既有行为保持不变。

# 验证方法
- 运行 \`pnpm test\`，必须全部通过。
- 运行 \`pnpm typecheck\`，必须 exit code = 0。
- 检查最终 diff 只包含目标范围内的文件和行为变化。`

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

// Normal start still respects readiness, while the user can explicitly force
// execution of the latest saved Plan without pretending that the Plan is Ready.
{
  const root = await mkdtemp(join(tmpdir(), 'codey-loop-plan-gate-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const store = new ProductStore(join(root, 'product.sqlite'))
  const session = store.createSession(workspace, undefined, 'Loop plan gate')
  const blockedDecision = {
    decision: 'blocked',
    reason: '缺少用户输入',
    coverage: [{ item: '关键输入', status: 'unmet', evidence: [] }],
    incomplete: ['关键输入'],
    nextAction: '等待用户补充'
  }
  const runtime = {
    prompt: async (_spec, options) => options?.agent === 'plan'
      ? ({ text: '# 目标\n先处理当前任务。\n\n# 待确认问题\n- 仍缺少关键输入。' })
      : ({ text: '信息不足，停止执行。\n\n\`\`\`temporal-decision\n' + JSON.stringify(blockedDecision) + '\n\`\`\`' })
  }
  const engine = engineFor(store, runtime)
  await engine.submit({ session, mode: 'loop', spec: '信息还不完整的自治任务' })
  const planned = store.listRounds(session.id)[0]
  let rejected = false
  try { await engine.startLoop(session) } catch { rejected = true }
  check('loop_incomplete_plan_stays_planning_before_force', planned.loopPhase === 'planning')
  check('loop_incomplete_plan_normal_start_rejected', rejected)

  const forced = await engine.startLoop(session, true)
  const round = store.listRounds(session.id)[0]
  check('loop_incomplete_plan_can_force_start', forced.outcome === 'blocked')
  check('loop_force_start_is_persisted', round.approvedPlanForced === true)
  check('loop_force_start_freezes_latest_plan', Boolean(round.approvedPlanVersionId))
  store.close()
}

// Chinese Plan headings are first-class input to the product-owned readiness
// gate, and a non-Chinese first reply is repaired before it is persisted.
{
  const root = await mkdtemp(join(tmpdir(), 'codey-chinese-plan-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const store = new ProductStore(join(root, 'product.sqlite'))
  const session = store.createSession(workspace, undefined, 'Chinese plan')
  let planPrompts = 0
  const englishPlan = '# Goal and Scope\nDo the requested work without unrelated refactors.\n\n# Implementation\n1. Update src/example.ts with the requested behavior.\n2. Adjust relevant tests and inspect the final diff.\n\n# Acceptance Criteria\n- Requested behavior exists.\n- Existing behavior remains.\n\n# Verification\n- `pnpm test`\n- `pnpm typecheck`'
  const runtime = {
    prompt: async () => {
      planPrompts += 1
      return { text: planPrompts === 1 ? englishPlan : readyPlan }
    }
  }
  const engine = engineFor(store, runtime)
  await engine.submit({ session, mode: 'loop', spec: '生成中文 Plan' })
  const round = store.listRounds(session.id)[0]
  const plan = store.listPlanVersions(round.id).at(-1)
  check('chinese_plan_reaches_ready', round.loopPhase === 'ready' && plan?.readiness?.ready === true)
  check('spec_plan_has_four_readiness_dimensions', plan?.readiness?.checks.length === 4)
  check('chinese_plan_readiness_labels_are_chinese', plan?.readiness?.checks[0]?.label === '目标与范围')
  check('non_chinese_plan_is_repaired_before_save', planPrompts === 2 && plan?.planMarkdown.startsWith('# 目标与范围'))
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
