/**
 * Model-participated loop assessment. The model — not a regex parser — is the
 * authority on semantic coverage of the spec; the product validates the
 * STRUCTURE of the model's decision, the EXISTENCE and VALIDITY of the
 * evidence it cites, counter-evidence, and budget. A malformed or missing
 * decision can never yield `completed`.
 *
 * The model emits its decision at the end of every turn reply as a fenced
 * block:
 *
 *   ```temporal-decision
 *   {"decision":"completed","reason":"...","coverage":[
 *     {"item":"...","status":"met","evidence":["e3"]}],"incomplete":[],
 *    "nextAction":""}
 *   ```
 */
export interface ModelDecisionCoverageItem {
  item: string
  status: 'met' | 'unmet' | 'uncertain'
  evidence: string[]
}

export interface ModelDecisionShape {
  decision: 'completed' | 'incomplete' | 'blocked'
  reason: string
  coverage: ModelDecisionCoverageItem[]
  incomplete: string[]
  nextAction?: string
}

export type DecisionParseResult =
  | { ok: true; decision: ModelDecisionShape }
  | { ok: false; error: string }

export const DECISION_FENCE = 'temporal-decision'

/** The contract the loop presents to the model on every turn. */
export function decisionInstruction(rootSpec: string, executionContext?: string): string {
  return [
    'You are working inside a product-managed execution loop on the task below.',
    'Work on the task with your tools as usual.',
    'End EVERY reply with a fenced block that contains exactly one JSON object and nothing else:',
    '```temporal-decision',
    '{"decision":"completed|incomplete|blocked","reason":"short justification","coverage":[{"item":"requirement text","status":"met|unmet|uncertain","evidence":["e1"]}],"incomplete":["remaining work"],"nextAction":"what to do next"}',
    '```',
    'Rules for the decision object:',
    '- decision is "completed" only when every requirement of the task is genuinely done; "incomplete" while work remains; "blocked" only when you need input the product cannot provide.',
    '- coverage lists every requirement you can identify in the task with an honest status; "uncertain" never counts as done.',
    '- evidence cites ids from the evidence inventory provided in the conversation: "e3" for a verification run, "w2" for a workspace artifact you produced. Use [] when none applies. Cite only evidence that actually exists and supports the item.',
    '- When the loop asks you to run a verification script (temporal-verify/*.cmd), run exactly that command before claiming the related item is met.',
    ...(executionContext?.trim() ? [
      '',
      '--- APPROVED EXECUTION PLAN ---',
      executionContext.trim(),
      '',
      '--- ACCEPTANCE SPEC ---'
    ] : ['', '---']),
    '',
    rootSpec
  ].join('\n')
}

/** Strict re-ask used once when a reply lacks a valid decision block. */
export function decisionReAskPrompt(error: string): string {
  return [
    'Your previous reply did not contain a valid decision block.',
    `Problem: ${error}`,
    'Reply NOW with ONLY the fenced block:',
    '```temporal-decision',
    '{"decision":"completed|incomplete|blocked","reason":"...","coverage":[{"item":"...","status":"met|unmet|uncertain","evidence":["e1"]}],"incomplete":["..."],"nextAction":"..."}',
    '```',
    'No other text, no tool calls.'
  ].join('\n')
}

/** Extract and validate the LAST decision block of a reply. */
export function extractDecision(text: string): DecisionParseResult {
  const openTag = '```' + DECISION_FENCE
  const lastOpen = text.lastIndexOf(openTag)
  if (lastOpen < 0) return { ok: false, error: `no ${DECISION_FENCE} fenced block found` }
  const rest = text.slice(lastOpen + openTag.length)
  const closingIndex = rest.indexOf('```')
  const body = (closingIndex >= 0 ? rest.slice(0, closingIndex) : rest).trim()
  if (!body) return { ok: false, error: 'empty decision block' }

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    return { ok: false, error: `decision block is not valid JSON: ${String((error as Error)?.message ?? error).slice(0, 160)}` }
  }
  return validateDecision(parsed)
}

export function validateDecision(parsed: unknown): DecisionParseResult {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'decision must be a JSON object' }
  }
  const record = parsed as Record<string, unknown>
  const decision = record.decision
  if (decision !== 'completed' && decision !== 'incomplete' && decision !== 'blocked') {
    return { ok: false, error: 'decision must be "completed", "incomplete" or "blocked"' }
  }
  if (typeof record.reason !== 'string' || !record.reason.trim()) {
    return { ok: false, error: 'reason must be a non-empty string' }
  }
  const coverage: ModelDecisionCoverageItem[] = []
  if (record.coverage !== undefined) {
    if (!Array.isArray(record.coverage)) return { ok: false, error: 'coverage must be an array' }
    for (const entry of record.coverage) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        return { ok: false, error: 'coverage entries must be objects' }
      }
      const item = entry as Record<string, unknown>
      if (typeof item.item !== 'string' || !item.item.trim()) {
        return { ok: false, error: 'coverage entry item must be a non-empty string' }
      }
      if (item.status !== 'met' && item.status !== 'unmet' && item.status !== 'uncertain') {
        return { ok: false, error: 'coverage entry status must be met|unmet|uncertain' }
      }
      let evidence: string[] = []
      if (item.evidence !== undefined) {
        if (!Array.isArray(item.evidence) || item.evidence.some((id) => typeof id !== 'string')) {
          return { ok: false, error: 'coverage entry evidence must be an array of strings' }
        }
        evidence = item.evidence as string[]
      }
      coverage.push({ item: item.item, status: item.status, evidence })
    }
  }
  if (record.incomplete !== undefined && (!Array.isArray(record.incomplete) || record.incomplete.some((line) => typeof line !== 'string'))) {
    return { ok: false, error: 'incomplete must be an array of strings' }
  }
  if (record.nextAction !== undefined && typeof record.nextAction !== 'string') {
    return { ok: false, error: 'nextAction must be a string' }
  }
  return {
    ok: true,
    decision: {
      decision,
      reason: record.reason,
      coverage,
      incomplete: Array.isArray(record.incomplete) ? record.incomplete as string[] : [],
      ...(typeof record.nextAction === 'string' ? { nextAction: record.nextAction } : {})
    }
  }
}

/** One evidence inventory entry the model can cite. */
export interface EvidenceInventoryEntry {
  id: string
  kind: 'verification' | 'workspace'
  /** Human-readable description shown to the model. */
  description: string
  /** False for runs whose targets changed after the check (stale). */
  valid: boolean
  /** True when the run is relevant to the current round's changes. */
  relevant: boolean
  outcome: string
}

/** Short, stable labels for the model to cite: e1, e2, … for the product's
 *  verification runs (append order, stable across turns), w1, w2, … for this
 *  round's workspace artifacts (product-verified through the file snapshot). */
export function buildInventory(
  runs: Array<{ id: string; label: string; outcome: string; command?: string }>,
  validByRun: Map<string, boolean>,
  relevantByRun: Map<string, boolean>,
  changedFiles: string[] = [],
  fileStates?: Map<string, { exists?: boolean }>
): EvidenceInventoryEntry[] {
  const entries: EvidenceInventoryEntry[] = runs.map((run, index) => ({
    id: `e${index + 1}`,
    kind: 'verification' as const,
    description: `${run.label} — ${run.outcome}${run.command ? ` (${run.command})` : ''}${validByRun.get(run.id) === false ? ' [stale: its targets changed after the check]' : ''}`,
    valid: validByRun.get(run.id) !== false,
    relevant: relevantByRun.get(run.id) === true,
    outcome: run.outcome
  }))
  for (const [index, file] of changedFiles.entries()) {
    // Strict when a snapshot is provided (a deleted artifact can no longer be
    // cited); permissive when the caller has no snapshot at all.
    const exists = fileStates === undefined || fileStates.get(file)?.exists === true
    const kind = 'workspace' as const
    entries.push({
      id: `w${index + 1}`,
      kind,
      description: `workspace artifact: ${file} (observed by the product's file snapshot${exists ? '' : ', currently missing'})`,
      valid: exists,
      relevant: true,
      outcome: 'observed'
    })
  }
  return entries
}
