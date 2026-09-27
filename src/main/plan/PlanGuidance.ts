import type { PlanReadinessCheck, PlanReadinessSummary } from '../../shared/contracts'

const PLAN_SECTIONS = [
  ['goal', 'Goal'],
  ['scope', 'Scope'],
  ['current-state', 'Current State'],
  ['implementation', 'Implementation'],
  ['affected-files', 'Affected Files'],
  ['acceptance', 'Acceptance Criteria'],
  ['verification', 'Verification'],
  ['constraints', 'Constraints'],
  ['open-questions', 'Open Questions']
] as const

/**
 * Loop planning is a read-only contract-building phase. The planning agent may
 * inspect the workspace, but Codey owns the quality gate and the later switch
 * to the write-capable build agent.
 */
export function loopPlanGuidance(spec: string, previousPlan?: string): string {
  return [
    'You are preparing an execution contract for a product-managed autonomous coding loop.',
    'Do NOT implement the task. Do not create, modify, or delete files, and do not run build, test, install, migration, or other shell commands.',
    'Inspect the repository with read-only tools as needed, then return a COMPLETE revised plan document.',
    'The plan is not a conversation reply. It must be a stable work document that can be frozen and executed later.',
    '',
    'Use EXACTLY these top-level Markdown headings, in this order:',
    '# Goal',
    '# Scope',
    '# Current State',
    '# Implementation',
    '# Affected Files',
    '# Acceptance Criteria',
    '# Verification',
    '# Constraints',
    '# Open Questions',
    '',
    'Quality requirements:',
    '- Goal: state the final observable outcome.',
    '- Scope: state both what is included and what is explicitly excluded when relevant.',
    '- Current State: summarize repository facts discovered from inspection; do not guess.',
    '- Implementation: provide at least two concrete ordered steps, naming components/files where possible.',
    '- Affected Files: list expected workspace paths or clearly identified areas.',
    '- Acceptance Criteria: provide at least two independently judgeable bullet points. Avoid vague phrases such as "works correctly" without observable conditions.',
    '- Verification: list concrete checks that can actually be executed or observed. Prefer explicit Tests / Typecheck / Build items when the repository supports them; otherwise name an exact command or file/content check.',
    '- Constraints: record compatibility, safety, permission, migration, or non-goals. Write "None" only when there truly are none.',
    '- Open Questions: unresolved questions that block safe autonomous execution. Write exactly "None" when there are no blockers.',
    '- Do not claim a command has passed; planning is read-only and commands are not executed here.',
    '',
    previousPlan?.trim()
      ? 'Revise the previous plan using the user supplement below. Preserve still-valid details, but return the entire updated document rather than a patch.'
      : 'Create the first complete plan from the user requirement below.',
    ...(previousPlan?.trim() ? ['', '--- PREVIOUS PLAN ---', previousPlan.trim()] : []),
    '',
    '--- USER REQUIREMENT / SUPPLEMENT ---',
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
 */
export function evaluatePlanReadiness(markdown: string): PlanReadinessSummary {
  const sections = parseSections(markdown)
  const checks: PlanReadinessCheck[] = []

  for (const [key, label] of PLAN_SECTIONS) {
    const body = sections.get(normalizeHeading(label))?.trim() ?? ''
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
      const concrete = items.filter(item => /(`[^\`]+`|test|typecheck|build|lint|check|verify|file|content|pnpm|npm|yarn|pytest|cargo|go test|测试|构建|类型检查|文件|内容)/i.test(item))
      ready = concrete.length >= 1
      detail = ready ? `包含 ${concrete.length} 个具体验证方式。` : '至少需要 1 个可执行或可观察的具体验证方式。'
    } else if (key === 'constraints') {
      const normalized = body.replace(/[。.!！]/g, '').trim().toLowerCase()
      ready = body.length >= 8 || /^(none|n\/a|无|没有|暂无)$/.test(normalized)
      detail = ready ? '约束已明确。' : '请明确约束，或填写 None。'
    } else if (key === 'open-questions') {
      const normalized = body.replace(/[。.!！]/g, '').trim().toLowerCase()
      ready = /^(none|n\/a|无|没有|暂无|无阻塞项)$/.test(normalized)
      detail = ready ? '没有阻塞自治执行的问题。' : '仍有开放问题；解决后才能 Start Loop。'
    }

    checks.push({ key, label, ready, detail })
  }

  const missing = checks.filter(check => !check.ready).map(check => check.label)
  return { ready: missing.length === 0, checks, missing }
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
