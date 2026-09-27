import type { ExecutionOutcome, LoopTerminalSummary, RoundMode, RequirementCoverageSummary, ResultSummary } from '../../shared/contracts'
import type { EvidenceBundle, VerificationRun } from '../evidence/evidence'
import type { LoopDecision } from '../loop/LoopEvaluator'
import type { RequirementCondition } from '../loop/RequiredSpec'

export interface ResultBuildInput {
  finalResponse: string
  evidence: EvidenceBundle
  outcome: ExecutionOutcome
  loopTerminal?: LoopTerminalSummary
  decision?: LoopDecision
  /** The whole work phase the Result summarizes (Plan/Vibe turns, Loop root). */
  round?: {
    mode: RoundMode
    /** Every turn of the round in order: the user's spec, its outcome and the
     *  actual produced output (assistant reply / plan markdown / loop final
     *  response). */
    turns: Array<{ spec: string; outcome: ExecutionOutcome; output?: string }>
  }
}

/**
 * Composes a ResultDocument as a projection of facts over the whole round,
 * not a summary of the last reply. Verification lines are taken only from
 * collected evidence (the product's own executor runs); a model sentence
 * claiming a check passed can never create one. `observed`/`unknown` is never
 * shown as passed, stale passes are shown as history instead of current
 * validity, and completion reason and remaining gaps come from the evaluator's
 * actual decision. Deterministic.
 */
export class ResultBuilder {
  build(input: ResultBuildInput): ResultSummary {
    const changes = input.evidence.changedFiles.slice(0, 20).map((file) => describeChange(input.evidence, file))
    if (input.evidence.preexistingChanges?.length > 0) {
      changes.push(`用户执行前已改动（归属保留，未计入本轮）: ${input.evidence.preexistingChanges.slice(0, 10).join(', ')}`)
    }

    const verificationRuns = input.evidence.verification
    const validRunIds = new Set(input.decision?.validRunIds ?? verificationRuns.map((run) => run.id))
    const current = verificationRuns.filter((run) => run.outcome === 'passed' && validRunIds.has(run.id))
    const historical = verificationRuns.filter((run) => run.outcome === 'passed' && !validRunIds.has(run.id))
    const verification = current.map((run) => `${run.label} — ${passedDetail(run)}`)
    for (const run of historical) {
      verification.push(`${run.label} — 历史:曾通过，但其目标此后已变化，不再是当前有效验证`)
    }
    // When no product verification ran at all this round, the Verification
    // section says so explicitly instead of silently hiding the section.
    if (verificationRuns.length === 0) verification.push('本轮未运行验证。')
    const failed = verificationRuns.filter((run) => run.outcome === 'failed')
    const denied = verificationRuns.filter((run) => run.outcome === 'denied')

    const terminal = input.loopTerminal
    const completed = input.outcome === 'completed' && (terminal === undefined || terminal.status === 'completed')
    // A Loop Round's completion is gated by the evaluator (decision present):
    // it may legitimately complete with zero verification runs when the model
    // cites product-observed workspace artifacts only. Plan/Vibe rounds have
    // no gate: their Result always states the independent-confirmation status
    // explicitly when no product verification ran this round.
    const loopGated = Boolean(input.decision)
    const remaining: string[] = []
    if (!completed || (!loopGated && verificationRuns.length === 0)) {
      if (input.decision?.incomplete.length) {
        remaining.push(...input.decision.incomplete.map((line) => `未覆盖要求: ${line}`))
      } else if (terminal) {
        remaining.push(terminal.reason)
      }
      // With no product verification the product cannot independently confirm
      // the requirements; it never invents defects from the model's claims.
      if (verificationRuns.length === 0) {
        remaining.push('本轮未运行产品验证；需求完成情况未独立确认。')
      } else if (current.length === 0) {
        remaining.push('本轮没有当前有效的通过验证；需求完成情况未独立确认。')
      }
      for (const run of failed) remaining.push(`${run.label} failed — ${failedDetail(run)}`)
      for (const run of denied) remaining.push(`${run.label} denied — ${run.denial ?? 'executor refused the check'}`)
      if (input.decision?.knownIssues.length) remaining.push(...input.decision.knownIssues.map((issue) => `已知问题: ${issue}`))
    }

    const coverage = input.decision
      ? input.decision.items.map<RequirementCoverageSummary>((item) => ({
          id: item.id,
          original: item.original,
          status: item.status,
          evidenceIds: item.evidenceIds,
          conditions: item.conditions.map((condition) => describeConditionText(condition)),
          ...(item.uncovered && item.uncovered.length > 0 ? { uncovered: item.uncovered } : {}),
          ...(item.note ? { note: item.note } : {})
        }))
      : undefined

    return {
      summary: summarizeRoundSafe(input),
      changes,
      verification,
      remaining,
      ...(terminal ? { loopTerminal: terminal } : {}),
      ...(input.decision ? {
        decision: {
          decision: input.decision.decision,
          reason: input.decision.reason,
          incomplete: input.decision.incomplete,
          knownIssues: input.decision.knownIssues,
          validRunIds: input.decision.validRunIds
        }
      } : {}),
      ...(coverage && coverage.length > 0 ? { coverage } : {}),
      createdAt: new Date().toISOString()
    }
  }
}

/** Summarization must never block saving the Result or ending the Round: on an
 *  unexpected error the Result still saves with a readable per-request
 *  fallback instead of losing the document. Deterministic summarization cannot
 *  throw in practice, so the fallback exists as a hard boundary, not a path
 *  the normal flow exercises. */
function summarizeRoundSafe(input: ResultBuildInput): string {
  try {
    return summarizeRound(input)
  } catch {
    const count = input.round?.turns.length ?? 0
    return count > 0
      ? `整轮摘要未能整理；本轮 ${count} 个请求的实际输出见请求记录，整轮工作区状态见 Changes。`
      : '本轮输出已记录；整轮工作区状态见 Changes。'
  }
}

/** Accurate per-file change description: created / deleted / modified. */
function describeChange(evidence: EvidenceBundle, file: string): string {
  if (evidence.newFiles.includes(file)) return `${file} (created)`
  if (evidence.deletedFiles?.includes(file)) return `${file} (deleted)`
  return `${file} (modified)`
}

/** The summary describes the whole phase: mode, per-request actual outcomes
 *  with the outputs the requests really produced, and honest framing — Vibe
 *  request completion is not functional acceptance, Plan produces plans, not
 *  implementations, and Loop outcomes come from the product's terminal. The
 *  final workspace state always points at the Changes section, so an
 *  adjustment made by a later request is presented as the final state, never
 *  as mechanically listed contradictions. Deterministic: no model call, no
 *  workspace write, no visible Round. */
function summarizeRound(input: ResultBuildInput): string {
  const round = input.round
  if (!round || round.turns.length === 0) {
    const lead = firstParagraph(input.finalResponse)
    return lead ? `最近输出摘要: ${lead}` : ''
  }
  const parts: string[] = []
  const changes = input.evidence.changedFiles.length
  if (round.mode === 'plan') {
    const last = round.turns[round.turns.length - 1]
    parts.push(`Plan 轮共 ${round.turns.length} 个计划版本，最终计划为版本 ${round.turns.length}`)
    if (last?.output) parts.push(`最终计划摘要: ${firstParagraph(last.output)}`)
    if (round.turns.length > 1) parts.push('各版本为逐步修订，最终版本表述以最新版本为准')
    parts.push('本阶段只产出计划，未验证实现')
  } else if (round.mode === 'vibe') {
    const completed = round.turns.filter((t) => t.outcome === 'completed').length
    const failedTurns = round.turns.filter((t) => t.outcome === 'failed').length
    const blockedTurns = round.turns.filter((t) => t.outcome === 'blocked').length
    parts.push(`Vibe 轮共 ${round.turns.length} 个请求`)
    if (round.turns.length > 1) {
      const bits = [`${completed} 个执行结束`]
      if (failedTurns > 0) bits.push(`${failedTurns} 个失败`)
      if (blockedTurns > 0) bits.push(`${blockedTurns} 个阻塞`)
      parts.push(`其中 ${bits.join('、')}`)
    }
    for (const [index, turn] of round.turns.entries()) {
      const spec = truncateSpec(turn.spec, 48)
      const output = turn.output ? firstParagraph(turn.output) : ''
      parts.push(`请求#${index + 1} "${spec}" → ${outcomeLabel(turn.outcome)}${output ? `（${output}）` : ''}`)
    }
    // "执行结束" states the request ended, not that it passed functional
    // acceptance; the product's actual conclusions live in Changes.
    parts.push('以上按请求顺序记录，后续调整以最后相关请求为准；请求执行结束不代表功能验收通过；整轮最终工作区状态见 Changes')
  } else {
    const status = input.loopTerminal?.status ?? (input.outcome === 'completed' ? 'completed' : 'failed')
    parts.push(`Loop 轮次终态: ${loopStatusLabel(status)}`)
    const output = firstParagraph(input.finalResponse)
    if (output) parts.push(`执行成果记录: ${output}`)
    if (input.loopTerminal?.reason) parts.push(`停止原因: ${truncateSpec(input.loopTerminal.reason, 240)}`)
    const passes = input.evidence.verification.filter((run) => run.outcome === 'passed').length
    if (status === 'completed') {
      parts.push('有效通过验证见 Verification')
    } else if (passes > 0) {
      parts.push('已完成部分见 Changes 与 Verification；未覆盖要求见 Remaining')
    } else {
      parts.push('已完成部分见 Changes；未覆盖要求见 Remaining')
    }
  }
  if (changes > 0) parts.push(`整轮共 ${changes} 个文件变更`)
  return parts.join('；')
}

function outcomeLabel(outcome: ExecutionOutcome): string {
  switch (outcome) {
    case 'completed': return '执行结束'
    case 'failed': return '失败'
    case 'blocked': return '阻塞'
    case 'interrupted': return '中断'
  }
}

function loopStatusLabel(status: LoopTerminalSummary['status']): string {
  switch (status) {
    case 'completed': return '已完成'
    case 'blocked': return '阻塞'
    case 'budget_exhausted': return '预算耗尽'
    case 'failed': return '失败'
    case 'interrupted': return '中断'
  }
}

function truncateSpec(spec: string, max: number): string {
  const flat = spec.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function firstParagraph(text: string): string {
  const body = text.replace(/```temporal-decision[\s\S]*?(?:```|$)/g, '').trim()
  const paragraphs = body.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean)
  const summary = paragraphs.slice(0, 3).join('\n\n')
  return summary.length > 600 ? `${summary.slice(0, 599)}…` : summary
}

/** Passed verification lines state what was actually verified, never just an
 *  exit code: built-in checks report the fact, shell checks report exit 0.
 *  Sandbox runs state their true source — the product verified the result
 *  artifacts (and the input snapshot the check was requested against) that the
 *  model produced inside the active agent backend's tool execution; it never presents reading
 *  a `0` from the exit file as a directly observed child-process exit. */
function passedDetail(run: VerificationRun): string {
  if (run.requestId) return 'passed (模型执行检查报告；产品核实结果产物及输入快照)'
  if (run.method === 'builtin') {
    const fact = run.facts[0]
    if (fact?.kind === 'file-exists') return 'passed (file exists)'
    if (fact?.kind === 'content-equals') return `passed (content match, sha1 ${fact.actualHash ?? 'n/a'})`
    if (fact?.kind === 'field-equals') return `passed (field '${fact.key}' = '${fact.expected}')`
  }
  return `passed (exit ${run.exitCode ?? 'n/a'})`
}

function failedDetail(run: VerificationRun): string {
  if (run.method === 'builtin') return run.outputTail || 'check did not pass'
  return `exit ${run.exitCode ?? 'n/a'}${run.outputTail ? ` — ${run.outputTail}` : ''}`
}

/** Human-readable form of one parsed acceptance condition. */
function describeConditionText(condition: RequirementCondition): string {
  switch (condition.kind) {
    case 'file': return `file exists as a regular file: ${condition.target}`
    case 'content': return `content of ${condition.target} matches the required text`
    case 'field': return `field ${condition.key} of ${condition.target} equals '${condition.expected}'`
    case 'command': return `acceptance command exits 0: ${condition.expected}`
    case 'tests': return 'tests pass'
    case 'typecheck': return 'typecheck passes'
    case 'build': return 'build passes'
  }
}
