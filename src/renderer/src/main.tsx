import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorView, basicSetup } from 'codemirror'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { EvidenceSummary, InteractiveMode, ModelSettings, PermissionPreset, ResultSummary, RoundDetail, RoundMode, RunOutcome, RunnerEvent, SessionSummary, UiPreferences, WorkspaceSnapshot } from '../../shared/contracts'
import './styles.css'

const modeLabels: Record<RoundMode, string> = { plan: 'Plan', vibe: 'VIBE', loop: 'SPEC' }
const loopPhaseLabels: Record<NonNullable<RoundDetail['loopPhase']>, string> = {
  planning: 'Planning', ready: 'Ready', running: 'Running', terminal: 'Terminal'
}
const statusLabels: Record<string, string> = {
  active: '进行中', completed: '已完成', blocked: '已阻塞', budget_exhausted: '预算已耗尽', failed: '失败', interrupted: '已中断'
}
const kindLabels: Record<SessionSummary['kind'], string> = {
  new: '尚无 Temporal Round',
  temporal: 'Temporal Session',
  backend: 'OpenCode Session · 无 Temporal Round'
}
const permissionLabels: Record<PermissionPreset, string> = {
  'read-only': 'Read-only（禁止编辑和命令）',
  'workspace-write': 'Workspace-write（OpenCode 工具权限，非系统沙箱）',
  'danger-full-access': 'Danger full access（允许外部目录）'
}
const evidenceKindLabels: Record<EvidenceSummary['kind'], string> = {
  command: '验证', workspace: '工作区', artifact: '产物', manual: '人工', runtime: '运行时'
}
const evidenceOutcomeLabels: Record<EvidenceSummary['outcome'], string> = {
  passed: '通过', failed: '失败', observed: '已观察'
}
const runOutcomeLabels: Record<RunOutcome, string> = {
  completed: '完成', failed: '失败', blocked: '阻塞', budget_exhausted: '预算耗尽', interrupted: '中断'
}
const defaultUiPreferences: UiPreferences = { sidebarCollapsed: false, runnerOpen: false, specPaneRatio: 0.42 }

function ResultView({ result }: { result: ResultSummary }): React.JSX.Element {
  return <div className="result-block">
    {result.summary && <p className="result-summary">{result.summary}</p>}
    {result.loopTerminal && <div className={`loop-terminal loop-${result.loopTerminal.status}`}><strong>SPEC {statusLabels[result.loopTerminal.status] ?? result.loopTerminal.status}</strong><span>{result.loopTerminal.reason}</span></div>}
    {result.changes.length > 0 && <section className="result-section"><h3>Changes</h3><ul>{result.changes.map(change => <li key={change}><code>{change}</code></li>)}</ul></section>}
    {result.verification.length > 0 && <section className="result-section"><h3>Verification</h3><ul>{result.verification.map(line => <li key={line}>{line}</li>)}</ul></section>}
    {result.remaining.length > 0 && <section className="result-section remaining"><h3>Remaining</h3><ul>{result.remaining.map(line => <li key={line}>{line}</li>)}</ul></section>}
  </div>
}

function EvidenceList({ evidence }: { evidence: EvidenceSummary[] }): React.JSX.Element | null {
  // Runtime tool telemetry belongs in Runner. Keep compatibility with existing
  // Sessions that already persisted those rows, but never present them as
  // evidence. Also collapse repeated workspace observations from long Vibe rounds.
  const meaningful = evidence.filter(item => item.kind !== 'runtime')
  const deduped = [...new Map(meaningful.map(item => [
    item.kind === 'workspace' ? `${item.kind}:${item.label}` : item.id,
    item
  ])).values()]
  if (deduped.length === 0) return null
  return <section className="evidence-block"><h3>验证证据</h3>
    <div className="evidence-rows">{deduped.map(item => <div className={`evidence-row evidence-${item.outcome}`} key={item.id}>
      <span className="evidence-kind">{evidenceKindLabels[item.kind]}</span>
      <span className="evidence-copy">
        <span className="evidence-label">{item.label}</span>
        {item.detail && <small>{item.detail}</small>}
      </span>
      <span className="evidence-outcome">{evidenceOutcomeLabels[item.outcome]}</span>
    </div>)}</div>
  </section>
}

function RoundView({ round, onStartLoop, busy, pendingPlanInput }: {
  round: RoundDetail
  onStartLoop: (force: boolean) => void
  busy: boolean
  pendingPlanInput: boolean
}): React.JSX.Element {
  const latestVersionIndex = Math.max(round.planVersions.length - 1, 0)
  const [versionIndex, setVersionIndex] = useState(latestVersionIndex)
  const versionPinned = useRef(false)
  const [vibeView, setVibeView] = useState<'focused' | 'all'>('focused')
  const [vibeEntryIndex, setVibeEntryIndex] = useState(Math.max(round.vibeEntries.length - 1, 0))

  useEffect(() => {
    if (!versionPinned.current) setVersionIndex(latestVersionIndex)
  }, [latestVersionIndex])

  useEffect(() => {
    setVibeEntryIndex(Math.max(round.vibeEntries.length - 1, 0))
  }, [round.vibeEntries.length])

  const header = <div className="document-header">
    <div className="eyebrow">ROUND {round.sequence} · {modeLabels[round.mode]}{round.mode === 'loop' && round.loopPhase ? ` · ${loopPhaseLabels[round.loopPhase]}` : ''}</div>
    <h1>{round.title}</h1>
    <div className="document-meta"><span className={`status status-${round.status}`}>{statusLabels[round.status]}</span><span>{new Date(round.updatedAt).toLocaleString()}</span></div>
  </div>

  const renderPlan = (execution = false): React.JSX.Element => {
    const version = round.planVersions[versionIndex]
    const readiness = version?.readiness
    const readyCount = readiness?.checks.filter(check => check.ready).length ?? 0
    const totalCount = readiness?.checks.length ?? 0
    const isReadyPhase = round.loopPhase === 'ready'
    return <>
      {round.planVersions.length > 1 && <div className="version-tabs" role="tablist" aria-label="Plan 版本">
        {round.planVersions.map((item, index) => <button key={item.id} role="tab" aria-selected={index === versionIndex} className={index === versionIndex ? 'active' : ''} onClick={() => { versionPinned.current = true; setVersionIndex(index) }}>v{item.ordinal}</button>)}
        {versionIndex !== latestVersionIndex && <button className="latest-version" onClick={() => { versionPinned.current = false; setVersionIndex(latestVersionIndex) }}>查看最新 v{round.planVersions[latestVersionIndex]?.ordinal}</button>}
      </div>}
      {!execution && round.mode === 'loop' && <section className={`plan-readiness ${isReadyPhase ? 'ready' : ''}`}>
        <div className="plan-readiness-head">
          <div><span className="eyebrow">PLAN 质量门槛</span><strong>{readiness?.ready ? '可以开始执行' : 'SPEC 信息尚不完整'}</strong></div>
          <span>{readyCount}/{totalCount || 4}</span>
        </div>
        {readiness ? <div className="plan-checks">{readiness.checks.map(check => <div className={`plan-check ${check.ready ? 'ready' : 'missing'}`} key={check.key}><span>{check.ready ? '✓' : '○'}</span><div><strong>{check.label}</strong><small>{check.detail}</small></div></div>)}</div>
          : <p className="muted">先生成第一版 SPEC Plan。</p>}
        <div className="plan-start-actions">
          <button className="primary-button start-loop-button" onClick={() => onStartLoop(false)} disabled={busy || pendingPlanInput || round.status !== 'active' || round.loopPhase !== 'ready' || !readiness?.ready || versionIndex !== latestVersionIndex}>开始执行</button>
          {!readiness?.ready && version && <button className="force-loop-button" onClick={() => onStartLoop(true)} disabled={busy || pendingPlanInput || round.status !== 'active' || (round.loopPhase !== 'planning' && round.loopPhase !== 'ready') || versionIndex !== latestVersionIndex}>强制开始</button>}
        </div>
        {!readiness?.ready && version && <small className="plan-force-note">强制开始会冻结当前 Plan 并立即进入自治执行。未满足项：{readiness?.missing.join('、') || '质量门槛未完整确认'}。SPEC 仍会基于实际 Evidence / Verification 判断完成或阻塞。</small>}
        {readiness?.ready && versionIndex !== latestVersionIndex && <small className="plan-gate-note">开始执行只会冻结并执行最新 Ready Plan。</small>}
        {pendingPlanInput && <small className="plan-gate-note">右侧还有未提交的 Plan 输入；先提交或清空后再启动。</small>}
      </section>}
      {execution && <div className={`execution-plan-banner ${round.approvedPlanForced ? 'forced' : ''}`}><span className="eyebrow">{round.approvedPlanForced ? '强制执行 PLAN' : '已批准 PLAN'}</span><strong>{round.approvedPlanVersionId ? `${round.approvedPlanForced ? '强制执行' : '执行'}已冻结 Plan v${round.planVersions.find(item => item.id === round.approvedPlanVersionId)?.ordinal ?? ''}` : '执行 SPEC Plan'}</strong>{round.approvedPlanForced && <small>此 Plan 未通过全部质量门槛；执行和完成判断仍以实际证据为准。</small>}</div>}
      <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{version?.planMarkdown || round.bodyMarkdown || '尚未生成 Plan。'}</ReactMarkdown></div>
      {version && version.submittedSpec.trim() && version.submittedSpec.trim() !== (version.planMarkdown ?? '').trim() && <details className="submitted-spec"><summary>本次用于完善 Plan 的输入</summary><div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{version.submittedSpec}</ReactMarkdown></div></details>}
    </>
  }

  if (round.mode === 'plan') {
    return <article className="document">
      {header}
      <div className="legacy-plan-notice">Legacy Plan Round · 新版本中 Plan 已合并进 SPEC Planning。</div>
      {renderPlan(false)}
      <EvidenceList evidence={round.evidence} />
    </article>
  }

  if (round.mode === 'vibe') {
    const focused = round.vibeEntries[vibeEntryIndex]
    return <article className="document">
      {header}
      {round.result && <ResultView result={round.result} />}
      {round.vibeEntries.length > 0 ? <section className="vibe-timeline">
        <div className="vibe-view-toolbar">
          <h3>执行记录</h3>
          <div className="segmented" aria-label="VIBE 阅读方式">
            <button className={vibeView === 'focused' ? 'active' : ''} onClick={() => { setVibeView('focused'); setVibeEntryIndex(Math.max(round.vibeEntries.length - 1, 0)) }}>当前迭代</button>
            <button className={vibeView === 'all' ? 'active' : ''} onClick={() => setVibeView('all')}>全部迭代</button>
          </div>
        </div>
        {vibeView === 'focused' && focused ? <>
          <div className="vibe-entry-nav">
            <button onClick={() => setVibeEntryIndex(index => Math.max(0, index - 1))} disabled={vibeEntryIndex <= 0}>←</button>
            <span>#{focused.ordinal} / {round.vibeEntries.length}</span>
            <button onClick={() => setVibeEntryIndex(index => Math.min(round.vibeEntries.length - 1, index + 1))} disabled={vibeEntryIndex >= round.vibeEntries.length - 1}>→</button>
          </div>
          <VibeEntryView entry={focused} />
        </> : round.vibeEntries.map(entry => <VibeEntryView entry={entry} key={entry.id} />)}
      </section> : !round.result && <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{round.bodyMarkdown || '本轮尚无结果。'}</ReactMarkdown></div>}
      <EvidenceList evidence={round.evidence} />
    </article>
  }

  if (round.loopPhase === 'planning' || round.loopPhase === 'ready') {
    return <article className="document">
      {header}
      {renderPlan(false)}
      <EvidenceList evidence={round.evidence} />
    </article>
  }

  if (round.loopPhase === 'running') {
    return <article className="document">
      {header}
      {renderPlan(true)}
      <EvidenceList evidence={round.evidence} />
    </article>
  }

  return <article className="document">
    {header}
    {round.result ? <ResultView result={round.result} /> : <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{round.bodyMarkdown || '本轮尚未产生终态结果。'}</ReactMarkdown></div>}
    {round.planVersions.length > 0 && <details className="approved-plan-archive"><summary>查看本轮 Plan</summary>{renderPlan(true)}</details>}
    <EvidenceList evidence={round.evidence} />
  </article>
}

function VibeEntryView({ entry }: { entry: RoundDetail['vibeEntries'][number] }): React.JSX.Element {
  return <article className="vibe-entry" key={entry.id}>
    <div className="vibe-entry-head"><span>#{entry.ordinal}</span><span className="vibe-outcome">{entry.executionOutcome}</span><span className="vibe-time">{new Date(entry.createdAt).toLocaleString()}</span></div>
    <div className="vibe-entry-body">
      <div className="vibe-spec"><h4>Spec</h4><div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.specMarkdown}</ReactMarkdown></div></div>
      <div className="vibe-output"><h4>Output</h4><div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.assistantOutput || '（无输出）'}</ReactMarkdown></div></div>
    </div>
  </article>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function CodeMirrorEditor({ value, onChange, onFocus, onBlur }: {
  value: string
  onChange: (value: string) => void
  onFocus: () => void
  onBlur: () => void
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const applyingExternalValue = useRef(false)
  const callbacks = useRef({ onChange, onFocus, onBlur })
  callbacks.current = { onChange, onFocus, onBlur }

  useEffect(() => {
    if (!host.current) return
    const editor = new EditorView({
      doc: value,
      parent: host.current,
      extensions: [
        basicSetup,
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ 'aria-label': 'Spec Markdown' }),
        EditorView.updateListener.of(update => {
          if (update.docChanged && !applyingExternalValue.current) callbacks.current.onChange(update.state.doc.toString())
        }),
        EditorView.domEventHandlers({
          focus: () => callbacks.current.onFocus(),
          blur: () => callbacks.current.onBlur()
        })
      ]
    })
    view.current = editor
    return () => { editor.destroy(); view.current = null }
  }, [])

  useEffect(() => {
    const editor = view.current
    if (!editor || editor.state.doc.toString() === value) return
    applyingExternalValue.current = true
    try { editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } }) }
    finally { applyingExternalValue.current = false }
  }, [value])

  return <div className="code-editor" ref={host} />
}

function findActiveRunnerToolId(events: RunnerEvent[], running: boolean): string | null {
  if (!running) return null
  const terminal = new Set<string>()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    const tool = event.tool
    if (!tool) continue
    if (tool.status === 'completed' || tool.status === 'failed') {
      terminal.add(tool.callId)
      continue
    }
    if (tool.status === 'running' && !terminal.has(tool.callId)) return event.id
  }
  return null
}

function renderRunnerMessage(event: RunnerEvent, activeToolId: string | null, now: number): string {
  if (event.id !== activeToolId) return event.message
  const elapsedMs = Math.max(0, now - new Date(event.tool?.startedAt ?? event.at).getTime())
  const newline = event.message.indexOf('\n')
  const elapsed = formatRunnerDuration(elapsedMs)
  return newline < 0
    ? `${event.message} · running ${elapsed}`
    : `${event.message.slice(0, newline)} · running ${elapsed}${event.message.slice(newline)}`
}

function formatRunnerDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes}m ${rest.toString().padStart(2, '0')}s`
}

function App(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [workspacePath, setWorkspacePath] = useState<string | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [discoveryError, setDiscoveryError] = useState('')
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<InteractiveMode>('vibe')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [sourceView, setSourceView] = useState(true)
  const [runnerOpen, setRunnerOpen] = useState(defaultUiPreferences.runnerOpen)
  const [runnerEvents, setRunnerEvents] = useState<RunnerEvent[]>([])
  const [runnerNow, setRunnerNow] = useState(() => Date.now())
  const [runnerHasNewEvents, setRunnerHasNewEvents] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(defaultUiPreferences.sidebarCollapsed)
  const [sidebarWidth, setSidebarWidth] = useState(() => Number(window.localStorage.getItem('codey.sidebarWidth')) || 196)
  const [specPaneRatio, setSpecPaneRatio] = useState(defaultUiPreferences.specPaneRatio)
  const [workspaceWidth, setWorkspaceWidth] = useState(() => window.innerWidth)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settings, setSettings] = useState<ModelSettings | null>(null)
  const [permission, setPermission] = useState<PermissionPreset>('workspace-write')
  const [credential, setCredential] = useState('')
  const editorFocused = useRef(false)
  const localDraftDirty = useRef(false)
  const snapshotRef = useRef<WorkspaceSnapshot | null>(null)
  const selectedIdRef = useRef<string | null>(null)
  const selectionPinned = useRef(false)
  const workspaceHost = useRef<HTMLElement>(null)
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const runnerEventsHost = useRef<HTMLDivElement>(null)
  const runnerFollowLatest = useRef(true)
  const previousRunnerEventCount = useRef(0)
  const latest = useRef({ draft, mode })
  const uiPreferencesRef = useRef<UiPreferences>(defaultUiPreferences)
  latest.current = { draft, mode }
  uiPreferencesRef.current = { sidebarCollapsed, runnerOpen, specPaneRatio }

  function persistUiPreferences(next: UiPreferences): void {
    uiPreferencesRef.current = next
    void window.temporal.saveUiPreferences(next).catch(e => setError(`界面偏好保存失败：${messageOf(e)}`))
  }

  function setSidebarCollapsedByUser(next: boolean): void {
    setSidebarCollapsed(next)
    persistUiPreferences({ ...uiPreferencesRef.current, sidebarCollapsed: next })
  }

  function setRunnerOpenByUser(next: boolean): void {
    setRunnerOpen(next)
    persistUiPreferences({ ...uiPreferencesRef.current, runnerOpen: next })
  }

  function setSpecPaneRatioByUser(next: number): void {
    const ratio = Math.max(0.25, Math.min(0.7, next))
    setSpecPaneRatio(ratio)
    persistUiPreferences({ ...uiPreferencesRef.current, specPaneRatio: ratio })
  }

  function applySnapshot(next: WorkspaceSnapshot): void {
    const previous = snapshotRef.current
    const sessionChanged = previous?.session?.id !== next.session?.id
    snapshotRef.current = next
    setSnapshot(next)
    const startingNewRun = next.running && !previous?.running
    if (sessionChanged || startingNewRun) {
      setRunnerEvents(next.runnerEvents)
    } else {
      // Snapshot and Runner IPC share one renderer but are produced by
      // different projections. Merge by id so an in-flight snapshot cannot
      // erase an event that arrived while the snapshot was being built.
      setRunnerEvents(current => {
        const merged = new Map<string, RunnerEvent>()
        for (const event of next.runnerEvents) merged.set(event.id, event)
        for (const event of current) merged.set(event.id, event)
        return [...merged.values()].slice(-200)
      })
    }
    if (sessionChanged) localDraftDirty.current = false
    if (sessionChanged || (!editorFocused.current && !localDraftDirty.current)) {
      setDraft(next.draft)
      setMode(next.mode)
    }
    if (sessionChanged) {
      selectionPinned.current = false
      const id = next.rounds.at(-1)?.id ?? null
      selectedIdRef.current = id
      setSelectedId(id)
    } else if (previous && next.rounds.length > previous.rounds.length && !selectionPinned.current) {
      const id = next.rounds.at(-1)?.id ?? null
      selectedIdRef.current = id
      setSelectedId(id)
    }
    if (next.running && !previous?.running && !selectionPinned.current) {
      runnerFollowLatest.current = true
      setRunnerHasNewEvents(false)
    }
    if (previous?.running && !next.running) {
      // Keep the completed Runner visible so the final tool/verification/error
      // events do not disappear at the moment they become most useful.
      setCancelling(false)
    }
  }

  useEffect(() => {
    let active = true
    const unsubscribe = window.temporal.onSnapshot(next => { if (active) applySnapshot(next) })
    const unsubscribeRunner = window.temporal.onRunnerEvent(event => {
      if (!active) return
      setRunnerEvents(previous => [...previous, event].slice(-200))
    })
    void window.temporal.getUiPreferences().then(preferences => {
      if (!active) return
      uiPreferencesRef.current = preferences
      setSidebarCollapsed(preferences.sidebarCollapsed)
      setRunnerOpen(preferences.runnerOpen)
      setSpecPaneRatio(preferences.specPaneRatio)
    }).catch(e => { if (active) setError(`界面偏好读取失败：${messageOf(e)}`) })
    window.temporal.getSnapshot().then(next => {
      if (!active) return
      applySnapshot(next)
      setWorkspacePath(next.workspacePath)
    }).catch(e => { if (active) setError(messageOf(e)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false; unsubscribe(); unsubscribeRunner() }
  }, [])

  useEffect(() => {
    window.localStorage.setItem('codey.sidebarWidth', String(sidebarWidth))
  }, [sidebarWidth])

  useEffect(() => {
    if (!workspacePath || snapshot?.session) return
    let active = true
    setBusy(true)
    window.temporal.listSessions(workspacePath).then(result => {
      if (!active) return
      setSessions(result.sessions)
      setDiscoveryError(result.discoveryError ?? '')
    })
      .catch(e => { if (active) setError(messageOf(e)) })
      .finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [workspacePath, snapshot?.session?.id])

  function queueDraft(nextDraft: string, nextMode: InteractiveMode): void {
    localDraftDirty.current = true
    setDraft(nextDraft)
    setMode(nextMode)
    if (draftTimer.current) clearTimeout(draftTimer.current)
    draftTimer.current = setTimeout(() => {
      window.temporal.saveDraft(nextDraft, nextMode).catch(e => setError(`草稿保存失败：${messageOf(e)}`))
    }, 450)
  }

  async function chooseWorkspace(): Promise<void> {
    try {
      setError('')
      const path = await window.temporal.chooseWorkspace()
      if (path) { setWorkspacePath(path); setSessions([]); setDiscoveryError('') }
    } catch (e) { setError(messageOf(e)) }
  }

  async function openSession(sessionId?: string): Promise<void> {
    if (!workspacePath) return
    setBusy(true)
    setError('')
    try {
      const next = await window.temporal.openSession(workspacePath, sessionId)
      editorFocused.current = false
      applySnapshot(next)
    } catch (e) { setError(messageOf(e)) }
    finally { setBusy(false) }
  }

  async function submit(): Promise<void> {
    const spec = latest.current.draft.trim()
    if (!spec || !snapshot?.session || snapshot.running) return
    if (draftTimer.current) clearTimeout(draftTimer.current)
    setBusy(true)
    setError('')
    setCancelling(false)
    try {
      await window.temporal.saveDraft(latest.current.draft, latest.current.mode)
      await window.temporal.submit(spec, latest.current.mode)
      // The product owns the draft after a submit (it clears/replaces it);
      // stop treating the local editor as the source of truth so incoming
      // snapshots refresh the editor again.
      localDraftDirty.current = false
      applySnapshot(await window.temporal.getSnapshot())
    } catch (e) { setError(messageOf(e)) }
    finally { setBusy(false) }
  }

  async function cancelRun(): Promise<void> {
    if (!snapshot?.running || cancelling) return
    setCancelling(true)
    setError('')
    try {
      const accepted = await window.temporal.cancelRun()
      if (!accepted) setCancelling(false)
    } catch (e) {
      setCancelling(false)
      setError(messageOf(e))
    }
  }

  async function startLoop(force = false): Promise<void> {
    if (!snapshot?.session || snapshot.running || busy) return
    setBusy(true)
    setError('')
    setCancelling(false)
    try {
      await window.temporal.startLoop(force)
      applySnapshot(await window.temporal.getSnapshot())
    } catch (e) { setError(messageOf(e)) }
    finally { setBusy(false) }
  }

  async function endRound(): Promise<void> {
    if (!snapshot?.session || snapshot.running) return
    setBusy(true)
    setError('')
    try { await window.temporal.endRound(); applySnapshot(await window.temporal.getSnapshot()) }
    catch (e) { setError(messageOf(e)) }
    finally { setBusy(false) }
  }

  async function showSettings(): Promise<void> {
    setError('')
    try {
      setSettings(await window.temporal.getModelSettings())
      setPermission(snapshotRef.current?.permission ?? 'workspace-write')
      setCredential('')
      setSettingsOpen(true)
    }
    catch (e) { setError(messageOf(e)) }
  }

  async function changePermission(next: PermissionPreset): Promise<void> {
    setError('')
    try {
      await window.temporal.setPermission(next)
      setPermission(next)
    } catch (e) { setError(messageOf(e)) }
  }

  async function saveSettings(): Promise<void> {
    if (!settings) return
    setBusy(true)
    setError('')
    try {
      const saved = await window.temporal.saveModelSettings({
        provider: settings.provider.trim(), model: settings.model.trim(), baseUrl: settings.baseUrl?.trim() || undefined,
        ...(credential ? { credential } : {})
      })
      setSettings(saved)
      setCredential('')
      setSettingsOpen(false)
    } catch (e) { setError(messageOf(e)) }
    finally { setBusy(false) }
  }

  const activeRound = snapshot?.rounds.find(round => round.status === 'active') ?? null
  const latestRound = snapshot?.rounds.at(-1) ?? null
  const navigationRound = activeRound ?? latestRound
  const selectedRound = snapshot?.rounds.find(round => round.id === selectedId)
  const viewingHistoricalRound = Boolean(selectedRound && navigationRound && selectedRound.id !== navigationRound.id)
  const continuesActiveRound = Boolean(
    activeRound
    && activeRound.mode === mode
    && !(snapshot?.running && activeRound.mode === 'loop')
    && !(activeRound.mode === 'loop' && activeRound.loopPhase === 'running')
  )
  const loopPlanning = Boolean(activeRound?.mode === 'loop' && (activeRound.loopPhase === 'planning' || activeRound.loopPhase === 'ready') && mode === 'loop')
  const activeSpecPlan = activeRound?.mode === 'loop' ? activeRound.planVersions.at(-1) : undefined
  const activeSpecReady = activeSpecPlan?.readiness?.ready === true && activeRound?.loopPhase === 'ready'
  const submitRoundSequence = continuesActiveRound ? activeRound!.sequence : (latestRound?.sequence ?? 0) + 1
  const runnerMode = activeRound?.mode ?? latestRound?.mode ?? mode
  const effectiveSidebarWidth = sidebarCollapsed ? 54 : sidebarWidth
  const availablePaneWidth = Math.max(680, workspaceWidth - effectiveSidebarWidth)
  const specWidth = Math.max(320, Math.min(Math.min(720, availablePaneWidth - 360), Math.round(availablePaneWidth * specPaneRatio)))
  const runStartedAt = snapshot?.runState.startedAt ? new Date(snapshot.runState.startedAt).getTime() : null
  const runFinishedAt = snapshot?.runState.finishedAt ? new Date(snapshot.runState.finishedAt).getTime() : null
  const runElapsed = runStartedAt !== null
    ? formatRunnerDuration(Math.max(0, (snapshot?.runState.status === 'idle' && runFinishedAt !== null ? runFinishedAt : runnerNow) - runStartedAt))
    : null
  const runStatusLabel = snapshot?.runState.status === 'running'
    ? `运行中${runElapsed ? ` · ${runElapsed}` : ''}`
    : snapshot?.runState.status === 'stopping'
      ? `停止中${runElapsed ? ` · ${runElapsed}` : ''}`
      : snapshot?.runState.outcome
        ? `已结束 · ${runOutcomeLabels[snapshot.runState.outcome]}${runElapsed ? ` · ${runElapsed}` : ''}`
        : '空闲'
  const runnerDuration = runElapsed
  const activeRunnerToolId = findActiveRunnerToolId(runnerEvents, snapshot?.running === true)

  useEffect(() => {
    const host = workspaceHost.current
    if (!host) return
    const update = (): void => setWorkspaceWidth(host.getBoundingClientRect().width)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(host)
    return () => observer.disconnect()
  }, [snapshot?.session?.id])

  useEffect(() => {
    if (snapshot?.runState.status === 'idle') return
    setRunnerNow(Date.now())
    const timer = window.setInterval(() => setRunnerNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [snapshot?.runState.status])

  useEffect(() => {
    const previousCount = previousRunnerEventCount.current
    previousRunnerEventCount.current = runnerEvents.length
    if (!runnerOpen) return
    if (!runnerFollowLatest.current) {
      if (runnerEvents.length > previousCount) setRunnerHasNewEvents(true)
      return
    }
    const host = runnerEventsHost.current
    if (!host) return
    const frame = requestAnimationFrame(() => {
      host.scrollTo({ top: host.scrollHeight, behavior: 'smooth' })
      setRunnerHasNewEvents(false)
    })
    return () => cancelAnimationFrame(frame)
  }, [runnerEvents.length, runnerOpen])

  function handleRunnerScroll(): void {
    const host = runnerEventsHost.current
    if (!host) return
    const distanceFromBottom = host.scrollHeight - host.scrollTop - host.clientHeight
    runnerFollowLatest.current = distanceFromBottom < 48
    if (runnerFollowLatest.current) setRunnerHasNewEvents(false)
  }

  function jumpRunnerToLatest(): void {
    runnerFollowLatest.current = true
    setRunnerHasNewEvents(false)
    const host = runnerEventsHost.current
    if (host) host.scrollTo({ top: host.scrollHeight, behavior: 'smooth' })
  }

  function selectRound(id: string): void {
    // Clicking the current page means "follow current" again; explicitly
    // choosing any older page pins history until the user returns.
    selectionPinned.current = id !== navigationRound?.id
    selectedIdRef.current = id
    setSelectedId(id)
  }

  function returnToCurrentRound(): void {
    selectionPinned.current = false
    const id = navigationRound?.id ?? null
    selectedIdRef.current = id
    setSelectedId(id)
  }

  function beginPaneResize(kind: 'sidebar' | 'spec', event: React.PointerEvent<HTMLDivElement>): void {
    const host = workspaceHost.current
    if (!host) return
    event.preventDefault()
    const bounds = host.getBoundingClientRect()
    let pendingSpecRatio = specPaneRatio
    document.body.classList.add('resizing-panes')
    const onMove = (move: PointerEvent): void => {
      if (kind === 'sidebar') {
        const width = Math.max(150, Math.min(320, move.clientX - bounds.left))
        setSidebarWidth(Math.round(width))
      } else {
        const paneSpace = Math.max(680, bounds.width - (sidebarCollapsed ? 54 : sidebarWidth))
        const maxWidth = Math.max(320, Math.min(720, paneSpace - 360))
        const width = Math.max(320, Math.min(maxWidth, bounds.right - move.clientX))
        pendingSpecRatio = Math.max(0.25, Math.min(0.7, width / paneSpace))
        setSpecPaneRatio(pendingSpecRatio)
      }
    }
    const onUp = (): void => {
      document.body.classList.remove('resizing-panes')
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (kind === 'spec') persistUiPreferences({ ...uiPreferencesRef.current, specPaneRatio: pendingSpecRatio })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return <div className="app-shell">
    <header className="titlebar">
      <div className="brand"><span className="brand-mark">T</span><span>Temporal Workspace</span></div>
      <span className="title-context">{snapshot?.session?.title ?? 'Workspace'}</span>
      <div className="title-actions">
        {snapshot?.session && <button
          className={`run-state-chip run-${snapshot.runState.status} ${snapshot.runState.outcome ? `outcome-${snapshot.runState.outcome}` : ''}`}
          onClick={() => { if (runnerEvents.length > 0) { runnerFollowLatest.current = true; setRunnerHasNewEvents(false); setRunnerOpenByUser(true) } }}
          disabled={runnerEvents.length === 0}
          aria-live="polite"
          title={runnerEvents.length > 0 ? '打开 Runner' : '当前没有 Runner 事件'}
        ><span className="run-state-dot"/><span>{runStatusLabel}</span></button>}
        <button className="icon-button settings-trigger" onClick={showSettings} aria-label="模型设置" title="模型设置"><span className="settings-glyph" aria-hidden="true">⚙</span></button>
      </div>
    </header>
    {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="关闭错误">×</button></div>}
    {snapshot?.error && snapshot.error !== error && <div className="error-banner" role="alert">{snapshot.error}</div>}

    {loading ? <main className="center-stage"><p>正在加载工作区…</p></main> : !snapshot?.session ?
      <main className="launcher center-stage">
        <div className="launcher-content">
          <div className="eyebrow">TEMPORAL WORKSPACE</div>
          <h1>{workspacePath ? '选择一个 Session' : '打开一个 Workspace'}</h1>
          <p className="muted">{workspacePath ? '继续本产品已记录的 Session，或在此目录中开始新工作。' : '先选择项目目录，再继续已有 Session 或创建新的 Session。'}</p>
          <div className="launch-card">
            <div className="launch-card-head"><div><strong>Workspace</strong><span>{workspacePath ?? '尚未选择目录'}</span></div><button className="secondary-button" onClick={chooseWorkspace} disabled={busy}>{workspacePath ? '更换目录' : '选择目录'}</button></div>
            {workspacePath && <div className="session-list">
              {sessions.map(item => <button className="session-row" key={item.id} onClick={() => openSession(item.id)} disabled={busy}>
                <span className="session-icon">{item.title.slice(0, 1).toUpperCase()}</span><span className="session-row-copy"><strong>{item.title}</strong><small>{item.updatedAt ? `${new Date(item.updatedAt).toLocaleString()} · ` : ''}{kindLabels[item.kind]}</small></span><span className="row-arrow">→</span>
              </button>)}
              {sessions.length === 0 && !busy && <p className="empty-sessions">该目录暂无已有 Session；可直接新建。</p>}
              {discoveryError && <p className="empty-sessions" role="alert">Session 发现失败：{discoveryError}</p>}
              <button className="session-row new-session" onClick={() => openSession()} disabled={busy}>
                <span className="session-icon">＋</span><span className="session-row-copy"><strong>New Session</strong><small>创建后从 VIBE 开始</small></span><span className="row-arrow">→</span>
              </button>
            </div>}
          </div>
          {busy && <p className="muted loading-caption">正在读取 Session…</p>}
        </div>
      </main> :
      <main
        ref={workspaceHost}
        className={`workspace ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}
        style={{ '--sidebar-width': `${sidebarWidth}px`, '--spec-width': `${specWidth}px` } as React.CSSProperties}
      >
        <aside className="sidebar" aria-label="Session 时间线">
          <div className="sidebar-header"><button className="icon-button sidebar-toggle" onClick={() => setSidebarCollapsedByUser(!sidebarCollapsed)} aria-label={sidebarCollapsed ? '展开侧栏' : '折叠侧栏'} title={sidebarCollapsed ? '展开侧栏' : '折叠侧栏'}><span className="sidebar-toggle-glyph" aria-hidden="true"><i/></span></button><div className="sidebar-name"><strong>{snapshot.session.title}</strong><small title={snapshot.workspacePath ?? ''}>{snapshot.workspacePath}</small></div></div>
          <nav className="timeline" aria-label="Round 列表">
            {snapshot.rounds.map(round => <button key={round.id} className={`timeline-item ${selectedId === round.id ? 'selected' : ''} ${activeRound?.id === round.id ? 'current' : ''}`} onClick={() => selectRound(round.id)} title={`Round ${round.sequence} · ${modeLabels[round.mode]} · ${statusLabels[round.status]}`}>
              <span className="thumbnail-page" data-round={round.sequence}>
                <span className="thumbnail-eyebrow">{modeLabels[round.mode]}{round.mode === 'loop' && round.loopPhase ? ` · ${loopPhaseLabels[round.loopPhase]}` : ''} · Round {round.sequence}</span>
                <span className="thumbnail-title">{round.title || `Round ${round.sequence}`}</span>
                <span className="thumbnail-lines" aria-hidden="true"><i/><i/><i/><i/></span>
                {activeRound?.id === round.id && <span className="thumbnail-current">当前</span>}
                <span className={`thumbnail-state state-${round.status}`}>{statusLabels[round.status]}</span>
              </span>
              <span className="timeline-copy"><strong>{round.title || `Round ${round.sequence}`}</strong><small>{modeLabels[round.mode]}{round.mode === 'loop' && round.loopPhase ? ` · ${loopPhaseLabels[round.loopPhase]}` : ''}{activeRound?.id === round.id ? ' · 当前' : ''}</small></span>
            </button>)}
          </nav>
          <button
            className={`runner-mini ${snapshot.running || runnerEvents.length > 0 ? 'visible' : ''} ${snapshot.runState.status !== 'idle' ? 'running' : 'idle'} ${runnerOpen ? 'expanded' : ''}`}
            onClick={() => {
              if (runnerOpen) {
                setRunnerOpenByUser(false)
                return
              }
              runnerFollowLatest.current = true
              setRunnerHasNewEvents(false)
              setRunnerOpenByUser(true)
            }}
            aria-label={runnerOpen ? '收起 Runner' : '展开 Runner'}
            aria-expanded={runnerOpen}
            tabIndex={snapshot.running || runnerEvents.length > 0 ? 0 : -1}
          ><span className={snapshot.running ? 'live-dot' : 'idle-dot'}/><span className="runner-mini-label">{runnerOpen ? '收起控制台' : cancelling ? '正在停止…' : snapshot.running ? '正在运行 · 查看过程' : '最近运行 · 查看过程'}</span></button>
        </aside>
        {!sidebarCollapsed && <div className="pane-resizer pane-resizer-sidebar" role="separator" aria-orientation="vertical" aria-label="调整 Round 侧栏宽度" onPointerDown={event => beginPaneResize('sidebar', event)} onDoubleClick={() => setSidebarWidth(196)} />}
        <section className="result-pane" aria-label="结果页面">
          <div className="result-scroll">
            {viewingHistoricalRound && navigationRound && <div className="history-banner"><div><span>正在查看历史</span><strong>Round {selectedRound?.sequence} · {selectedRound ? modeLabels[selectedRound.mode] : ''}</strong></div><button onClick={returnToCurrentRound}>{activeRound ? '返回当前' : '返回最新'} Round {navigationRound.sequence} →</button></div>}
            {selectedRound ? <RoundView key={selectedRound.id} round={selectedRound} onStartLoop={force => void startLoop(force)} busy={busy || snapshot.running} pendingPlanInput={mode === 'loop' && Boolean(draft.trim())} />
              : snapshot.historyState === 'backend-unavailable' ? <article className="document"><div className="document-header"><div className="eyebrow">OPENCODE SESSION READY</div><h1>OpenCode runtime ready</h1><p>OpenCode Session 已在后台预热完成，但尚未产生 Temporal Round。第一次提交会沿用该 OpenCode Session 并创建 Round 1。</p></div></article>
              : <div className="blank-state"><div className="blank-symbol">⌁</div><h2>暂无结果</h2><p>在右侧写下目标，选择模式并提交。</p></div>}
          </div>
          <section className={`runner-panel ${runnerOpen ? 'open' : ''} ${snapshot.runState.status !== 'idle' ? 'running' : 'idle'} ${cancelling ? 'stopping' : ''}`} aria-label="Runner 事件" aria-hidden={!runnerOpen}>
            <div className="runner-header">
              <div><span className={snapshot.runState.status === 'running' ? 'live-dot' : 'idle-dot'}/><strong>{snapshot.runState.status === 'running' ? '运行中' : snapshot.runState.status === 'stopping' ? '停止中' : snapshot.runState.outcome ? `已结束 · ${runOutcomeLabels[snapshot.runState.outcome]}` : 'Runner'}</strong><span>{modeLabels[runnerMode]}{runnerDuration ? ` · ${runnerDuration}` : ''}</span></div>
              <div className="runner-actions">{snapshot.running && <button className="runner-stop" onClick={() => void cancelRun()} disabled={cancelling} aria-label="停止当前运行">{cancelling ? '停止中…' : '停止'}</button>}<button onClick={() => setRunnerOpenByUser(false)} aria-label="收起 Runner">收起</button></div>
            </div>
            <div className="runner-events" ref={runnerEventsHost} onScroll={handleRunnerScroll} role="log" aria-live="polite">{runnerEvents.length ? runnerEvents.map(event => <div className={`runner-event event-${event.kind}`} key={event.id}><span className="runner-prefix">{event.kind}</span><span className="runner-message">{renderRunnerMessage(event, activeRunnerToolId, runnerNow)}</span></div>) : <p className="runner-empty">等待运行事件…</p>}</div>
            {runnerHasNewEvents && <button className="runner-new-events" onClick={jumpRunnerToLatest}>↓ 有新事件 · 回到底部</button>}
          </section>
        </section>
        <div className="pane-resizer pane-resizer-spec" role="separator" aria-orientation="vertical" aria-label="调整 Spec 面板宽度" onPointerDown={event => beginPaneResize('spec', event)} onDoubleClick={() => setSpecPaneRatioByUser(defaultUiPreferences.specPaneRatio)} />
        <section className="spec-pane" aria-label="Spec 编辑器">
          <div className={`spec-context ${snapshot.running ? 'next-spec' : ''} ${loopPlanning ? 'loop-planning' : ''}`}>
            <span className="eyebrow">{snapshot.running ? 'NEXT SPEC' : loopPlanning ? 'SPEC INPUT' : mode === 'loop' ? 'SPEC' : 'VIBE'}</span>
            <strong>{loopPlanning
              ? `完善 Round ${activeRound?.sequence} · SPEC Plan`
              : continuesActiveRound
                ? `继续 Round ${activeRound?.sequence} · ${modeLabels[mode]}`
                : `下一次提交 · Round ${submitRoundSequence} · ${modeLabels[mode]}`}</strong>
            <small>{snapshot.running
              ? '当前任务正在执行；这里的内容只用于下一次提交，不会改变当前运行。'
              : loopPlanning
                ? '本次输入只会让只读 Planning Agent 生成新的中文 SPEC Plan，不会修改 Workspace。Ready 后可以开始执行；信息不足时也可以显式强制开始。'
                : continuesActiveRound
                  ? '本次提交会继续当前 Round。'
                  : activeRound
                    ? `切换模式会结束 Round ${activeRound.sequence}，并创建新 Round。`
                    : mode === 'loop'
                      ? '先生成 SPEC Plan；Plan Ready 后由你显式开始自治执行。'
                      : '本次提交会创建新的 VIBE Round。'}</small>
          </div>
          <div className="spec-toolbar"><div className="segmented" aria-label="下一次提交模式">{(['vibe', 'loop'] as const).map(item => <button key={item} className={mode === item ? 'active' : ''} onClick={() => queueDraft(draft, item)} disabled={busy} aria-pressed={mode === item}>{modeLabels[item]}</button>)}</div><div className="segmented" aria-label="编辑器视图"><button className={sourceView ? 'active' : ''} onClick={() => setSourceView(true)} aria-pressed={sourceView}>Source</button><button className={!sourceView ? 'active' : ''} onClick={() => setSourceView(false)} aria-pressed={!sourceView}>MD</button></div></div>
          <div className="spec-body"><div className={`editor-container ${sourceView ? '' : 'hidden'}`}><CodeMirrorEditor key={snapshot.session.id} value={draft} onFocus={() => { editorFocused.current = true }} onBlur={() => { editorFocused.current = false }} onChange={value => queueDraft(value, mode)}/>{!draft && <span className="editor-placeholder" aria-hidden="true">{loopPlanning ? <># SPEC Input<br/><br/>补充目标范围、实施细节、验收标准或验证方法…</> : mode === 'loop' ? <># SPEC Goal<br/><br/>描述目标；Codey 会先生成 Plan，再由你确认开始执行…</> : <># VIBE<br/><br/>描述希望完成的工作…</>}</span>}</div><div className={`spec-preview markdown-body ${sourceView ? 'hidden' : ''}`}>{draft.trim() ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{draft}</ReactMarkdown> : <p className="muted">Spec 预览会显示在这里。</p>}</div></div>
          <div className="spec-footer">
            {mode === 'loop'
              ? snapshot.running
                ? <div className="footer-actions single"><button className="primary-button" disabled>SPEC 执行中</button></div>
                : loopPlanning && activeSpecPlan
                  ? <div className="footer-actions">
                      <button className={activeSpecReady ? 'primary-button' : 'force-loop-button'} onClick={() => void startLoop(!activeSpecReady)} disabled={busy || Boolean(draft.trim())}>{activeSpecReady ? '开始执行' : '强制开始'}</button>
                      <button className="secondary-button" onClick={submit} disabled={busy || !draft.trim()}>完善 SPEC</button>
                    </div>
                  : <div className="footer-actions">
                      <button className="secondary-button" onClick={() => queueDraft(draft, 'vibe')} disabled={busy}>取消 SPEC</button>
                      <button className="primary-button" onClick={submit} disabled={busy || !draft.trim()}>生成 SPEC</button>
                    </div>
              : <div className="footer-actions">
                  <button className="secondary-button" onClick={endRound} disabled={busy || snapshot.running || !activeRound}>{activeRound?.mode === 'vibe' ? '结束 VIBE' : activeRound ? `结束 Round ${activeRound.sequence}` : '无进行中工作'}</button>
                  <button className="primary-button" onClick={submit} disabled={busy || snapshot.running || !draft.trim()}>{snapshot.running ? '当前任务运行中' : continuesActiveRound ? '继续 VIBE' : `开始 VIBE · Round ${submitRoundSequence}`}</button>
                </div>}
          </div>
        </section>
      </main>}

    {settingsOpen && settings && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setSettingsOpen(false) }}><section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="dialog-header"><div><div className="eyebrow">PREFERENCES</div><h2 id="settings-title">模型设置</h2></div><button className="icon-button" onClick={() => setSettingsOpen(false)} aria-label="关闭设置">×</button></div>{error && <div className="dialog-error" role="alert">{error}</div>}<div className="settings-fields"><label>Provider<input value={settings.provider} onChange={event => setSettings({ ...settings, provider: event.target.value })} placeholder="deepseek-official"/></label><label>Model<input value={settings.model} onChange={event => setSettings({ ...settings, model: event.target.value })} placeholder="模型名称"/></label><label>Base URL <small>可选</small><input value={settings.baseUrl ?? ''} onChange={event => setSettings({ ...settings, baseUrl: event.target.value })} placeholder="https://…"/></label><label>会话权限 <small>OpenCode 工具权限；非操作系统级沙箱，运行中不可修改</small><select value={permission} onChange={event => void changePermission(event.target.value as PermissionPreset)} disabled={snapshot?.running || busy}>{(['read-only', 'workspace-write', 'danger-full-access'] as const).map(item => <option key={item} value={item}>{permissionLabels[item]}</option>)}</select></label><label>API 凭证 <small>{settings.hasCredential ? '已保存；留空则保持原凭证' : '尚未保存'}</small><input type="password" autoComplete="new-password" value={credential} onChange={event => setCredential(event.target.value)} placeholder={settings.hasCredential ? '输入新凭证以替换' : '输入 API 凭证'}/></label></div><div className="dialog-actions"><button className="secondary-button" onClick={() => setSettingsOpen(false)}>取消</button><button className="primary-button" onClick={saveSettings} disabled={busy || !settings.provider.trim() || !settings.model.trim()}>保存设置</button></div></section></div>}
  </div>
}

createRoot(document.getElementById('root')!).render(<App />)
