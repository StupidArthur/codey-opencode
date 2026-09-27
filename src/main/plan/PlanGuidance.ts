import type { PlanReadinessCheck, PlanReadinessSummary } from '../../shared/contracts'

const PLAN_SECTIONS = [
  ['goal-scope', '目标与范围', ['目标与范围', '目标', 'goal and scope', 'goal']],
  ['implementation', '实施计划', ['实施计划', '实施方案', '实现方案', 'implementation']],
  ['acceptance', '验收标准', ['验收标准', 'acceptance criteria']],
  ['verification', '验证方法', ['验证方法', '验证', 'verification']]
] as const

/**
 * SPEC planning is a read-only contract-building phase. The planning agent may
 * inspect the workspace, but Codey owns the quality gate and the later switch
 * to the write-capable build agent.
 */
export function loopPlanGuidance(spec: string, previousPlan?: string): string {
  return [
    '你正在为 Codey 的 SPEC 模式准备一份可执行计划。',
    '不要实现任务。不要创建、修改或删除文件，也不要运行 build、test、install、migration 或其他 shell 命令。',
    '可以使用只读工具检查仓库；检查后返回一份完整、可独立阅读的修订版 Plan。',
    'Plan 不是聊天回复，而是之后可以冻结并交给自治执行阶段的稳定工作文档。',
    '除代码、文件路径、命令、API 名称和必要技术标识外，Plan 必须使用中文撰写。',
    '',
    '必须严格使用以下一级 Markdown 标题，并保持这个顺序：',
    '# 目标与范围',
    '# 实施计划',
    '# 验收标准',
    '# 验证方法',
    '',
    '质量要求：',
    '- 目标与范围：简洁说明最终可观察结果、包含范围，以及必要时明确不包含什么。重要约束和未决假设也放在这里，不要另建章节。',
    '- 实施计划：这是 Plan 的主体。给出具体、有顺序的实施步骤；尽量指出涉及的模块/文件、关键行为变化、兼容性要求、步骤依赖，以及需要新增或调整的测试。至少 2 个具体步骤。',
    '- 验收标准：提供至少 2 条可以独立判断是否满足的条目。避免“正常工作”“代码质量良好”等无法客观判定的描述。',
    '- 验证方法：这是 Plan 的另一重点。详细说明如何证明任务完成，包括可执行的测试、类型检查、构建、精确命令，以及必要的行为验证或文件/内容检查。',
    '- Planning 阶段没有执行命令，因此不要声称某项验证已经通过。',
    '- 不要为了凑结构单独输出“当前状态 / 影响文件 / 约束 / 待确认问题”等章节；相关信息融入上述 4 个章节。',
    '',
    previousPlan?.trim()
      ? '根据下面的用户补充修订上一版 Plan。保留仍然有效的内容，但必须返回完整的新版本，而不是补丁或差异。'
      : '根据下面的用户需求生成第一版完整 Plan。',
    ...(previousPlan?.trim() ? ['', '--- 上一版 PLAN ---', previousPlan.trim()] : []),
    '',
    '--- 用户需求 / 补充 ---',
    spec
  ].join('\n')
}

/** Legacy entry point kept for old probes/imports. New work uses SPEC planning. */
export function planGuidance(spec: string): string {
  return loopPlanGuidance(spec)
}

/**
 * Deterministic product-owned gate. Only four user-facing dimensions are
 * required. Older English/9-section documents remain readable by aliasing
 * their relevant sections into the new gate.
 */
export function evaluatePlanReadiness(markdown: string): PlanReadinessSummary {
  const sections = parseSections(markdown)
  const checks: PlanReadinessCheck[] = []

  for (const [key, label, aliases] of PLAN_SECTIONS) {
    let body = sectionBody(sections, aliases)
    if (key === 'goal-scope') {
      body = combineLegacyGoalScope(sections, body)
    }

    let ready = body.length >= 12
    let detail = ready ? '已明确。' : '缺少有效内容。'

    if (key === 'implementation') {
      const count = listItemCount(body)
      ready = count >= 2 && body.length >= 40
      detail = ready
        ? `包含 ${count} 个实施步骤，并有具体执行信息。`
        : '至少需要 2 个具体实施步骤，并说明涉及区域或关键行为变化。'
    } else if (key === 'acceptance') {
      const items = listItems(body)
      const vagueOnly = items.length > 0 && items.every(item => /^(works?|correct|正常|正确|可用|完成|质量良好)[。.!！]?$/i.test(item.trim()))
      ready = items.length >= 2 && !vagueOnly
      detail = ready
        ? `包含 ${items.length} 条可判断验收标准。`
        : '至少需要 2 条可独立判断、非模糊的验收标准。'
    } else if (key === 'verification') {
      const items = listItems(body)
      const concrete = items.filter(item => /(`[^`]+`|test|typecheck|build|lint|check|verify|file|content|pnpm|npm|yarn|pytest|cargo|go test|测试|构建|类型检查|文件|内容|行为验证|检查)/i.test(item))
      ready = concrete.length >= 1 && body.length >= 24
      detail = ready
        ? `包含 ${concrete.length} 个具体验证方式。`
        : '至少需要 1 个可执行或可观察的具体验证方式，并说明如何判断结果。'
    }

    checks.push({ key, label, ready, detail })
  }

  const missing = checks.filter(check => !check.ready).map(check => check.label)
  return { ready: missing.length === 0, checks, missing }
}

function combineLegacyGoalScope(sections: Map<string, string>, primary: string): string {
  if (sections.has(normalizeHeading('目标与范围')) || sections.has(normalizeHeading('goal and scope'))) return primary
  const goal = sectionBody(sections, ['目标', 'goal'])
  const scope = sectionBody(sections, ['范围', 'scope'])
  return [goal, scope].filter(Boolean).join('\n')
}

function sectionBody(sections: Map<string, string>, aliases: readonly string[]): string {
  for (const alias of aliases) {
    const body = sections.get(normalizeHeading(alias))
    if (body?.trim()) return body.trim()
  }
  return ''
}

function parseSections(markdown: string): Map<string, string> {
  const result = new Map<string, string>()
  let current: string | undefined
  let buffer: string[] = []

  const flush = (): void => {
    if (!current) return
    result.set(current, buffer.join('\n').trim())
  }

  for (const line of markdown.split(/\r?\n/)) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (match) {
      flush()
      current = normalizeHeading(match[1])
      buffer = []
    } else if (current) {
      buffer.push(line)
    }
  }
  flush()
  return result
}

function normalizeHeading(value: string): string {
  return value
    .toLowerCase()
    .replace(/^\d+[.)]\s*/, '')
    .replace(/[*_:：]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function listItems(body: string): string[] {
  return body.split(/\r?\n/)
    .map(line => /^\s*(?:[-*+] |\d+[.)]\s+)(.+)$/.exec(line)?.[1]?.trim())
    .filter((value): value is string => Boolean(value))
}

function listItemCount(body: string): number {
  return listItems(body).length
}
