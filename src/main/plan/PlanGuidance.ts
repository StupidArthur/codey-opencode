import type { PlanReadinessCheck, PlanReadinessSummary } from '../../shared/contracts'

const PLAN_SECTIONS = [
  ['goal', '目标', ['目标', 'goal']],
  ['scope', '范围', ['范围', 'scope']],
  ['current-state', '当前状态', ['当前状态', 'current state']],
  ['implementation', '实施方案', ['实施方案', '实现方案', 'implementation']],
  ['affected-files', '影响文件', ['影响文件', '受影响文件', 'affected files']],
  ['acceptance', '验收标准', ['验收标准', 'acceptance criteria']],
  ['verification', '验证', ['验证', 'verification']],
  ['constraints', '约束', ['约束', 'constraints']],
  ['open-questions', '待确认问题', ['待确认问题', '开放问题', 'open questions']]
] as const

/**
 * Loop planning is a read-only contract-building phase. The planning agent may
 * inspect the workspace, but Codey owns the quality gate and the later switch
 * to the write-capable build agent.
 */
export function loopPlanGuidance(spec: string, previousPlan?: string): string {
  return [
    '你正在为 Codey 管理的自治编程 Loop 准备一份可执行的计划合同。',
    '不要实现任务。不要创建、修改或删除文件，也不要运行 build、test、install、migration 或其他 shell 命令。',
    '可以使用只读工具检查仓库；检查后返回一份完整、可独立阅读的修订版 Plan。',
    'Plan 不是聊天回复，而是之后可以冻结并交给 Loop 执行的稳定工作文档。',
    '除代码、文件路径、命令、API 名称和必要的技术标识外，Plan 必须使用中文撰写。',
    '',
    '必须严格使用以下一级 Markdown 标题，并保持这个顺序：',
    '# 目标',
    '# 范围',
    '# 当前状态',
    '# 实施方案',
    '# 影响文件',
    '# 验收标准',
    '# 验证',
    '# 约束',
    '# 待确认问题',
    '',
    '质量要求：',
    '- 目标：说明最终可观察到的结果。',
    '- 范围：明确包含什么；必要时明确不包含什么。',
    '- 当前状态：只写通过仓库检查得到的事实，不要猜测。',
    '- 实施方案：至少给出 2 个具体、有顺序的实施步骤，尽量指出涉及的组件或文件。',
    '- 影响文件：列出预计会创建或修改的 Workspace 路径；尚不能确定时列出明确的代码区域。',
    '- 验收标准：至少 2 条可以独立判断是否满足的条目，避免只写“正常工作”“完成”等模糊描述。',
    '- 验证：列出可以实际执行或观察的检查。仓库支持时优先写“测试 / 类型检查 / 构建”；否则写精确命令或文件/内容检查。',
    '- 约束：记录兼容性、安全、权限、迁移要求或明确的非目标。确实没有时写“无”。',
    '- 待确认问题：只列出会影响安全执行或方案选择的未决问题；没有阻塞项时必须写“无”。',
    '- Planning 阶段没有执行命令，因此不要声称某个测试、类型检查或构建已经通过。',
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

/** Legacy entry point kept for old probes/imports. New work uses Loop planning. */
export function planGuidance(spec: string): string {
  return loopPlanGuidance(spec)
}

/**
 * Deterministic product-owned gate. The model may help author the plan, but it
 * cannot declare itself ready; Codey checks the resulting artifact.
 *
 * English headings remain accepted so previously stored Plan versions keep
 * their readiness semantics after the UI switches to Chinese.
 */
export function evaluatePlanReadiness(markdown: string): PlanReadinessSummary {
  const sections = parseSections(markdown)
  const checks: PlanReadinessCheck[] = []

  for (const [key, label, aliases] of PLAN_SECTIONS) {
    const body = sectionBody(sections, aliases)
    let ready = body.length >= 8
    let detail = ready ? '已填写。' : '缺少有效内容。'

    if (key === 'implementation') {
      const count = listItemCount(body)
      ready = count >= 2
      detail = ready ? `包含 ${count} 个实施步骤。` : '至少需要 2 个具体实施步骤。'
    } else if (key === 'affected-files') {
      const count = listItemCount(body)
      ready = count >= 1
      detail = ready ? `列出 ${count} 个预计影响项。` : '至少列出 1 个预计影响的文件或代码区域。'
    } else if (key === 'acceptance') {
      const count = listItemCount(body)
      const vagueOnly = count > 0 && listItems(body).every(item => /^(works?|correct|正常|正确|可用|完成)[。.!！]?$/i.test(item.trim()))
      ready = count >= 2 && !vagueOnly
      detail = ready ? `包含 ${count} 条可判断验收标准。` : '至少需要 2 条可独立判断、非模糊的验收标准。'
    } else if (key === 'verification') {
      const items = listItems(body)
      const concrete = items.filter(item => /(`[^`]+`|test|typecheck|build|lint|check|verify|file|content|pnpm|npm|yarn|pytest|cargo|go test|测试|构建|类型检查|文件|内容)/i.test(item))
      ready = concrete.length >= 1
      detail = ready ? `包含 ${concrete.length} 个具体验证方式。` : '至少需要 1 个可执行或可观察的具体验证方式。'
    } else if (key === 'constraints') {
      const normalized = body.replace(/[。.!！]/g, '').trim().toLowerCase()
      ready = body.length >= 8 || /^(none|n\/a|无|没有|暂无)$/.test(normalized)
      detail = ready ? '约束已明确。' : '请明确约束，确实没有时填写“无”。'
    } else if (key === 'open-questions') {
      const normalized = body.replace(/[。.!！]/g, '').trim().toLowerCase()
      ready = /^(none|n\/a|无|没有|暂无|无阻塞项|无需确认)$/.test(normalized)
      detail = ready ? '没有阻塞自治执行的问题。' : '仍有待确认问题；可以继续完善 Plan，或由用户选择强制开始。'
    }

    checks.push({ key, label, ready, detail })
  }

  const missing = checks.filter(check => !check.ready).map(check => check.label)
  return { ready: missing.length === 0, checks, missing }
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
