import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorView, basicSetup } from 'codemirror'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { EvidenceSummary, ModelSettings, PermissionPreset, ResultSummary, RoundDetail, RoundMode, RunnerEvent, SessionSummary, WorkspaceSnapshot } from '../../shared/contracts'
import './styles.css'

const modeLabels: Record<RoundMode, string> = { plan: 'Plan', vibe: 'Vibe', loop: 'Loop' }
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
const runOutcomeLabels: Record<'completed' | 'failed' | 'blocked' | 'interrupted', string> = {
  completed: '完成', failed: '失败', blocked: '阻塞', interrupted: '中断'
}

function ResultView({ result }: { result: ResultSummary }): React.JSX.Element {
  return <div className="result-block">
    {result.summary && <p className="result-summary">{result.summary}</p>}
    {result.loopTerminal && <div className={`loop-terminal loop-${result.loopTerminal.status}`}><strong>Loop {statusLabels[result.loopTerminal.status] ?? result.loopTerminal.status}</strong><span>{result.loopTerminal.reason}</span></div>}
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

function RoundView({ round }: { round: RoundDetail }): React.JSX.Element {
  const latestVersionIndex = Math.max(round.planVersions.length - 1, 0)
  const [versionIndex, setVersionIndex] = useState(latestVersionIndex)
  const versionPinned = useRef(false)
  // When the user explicitly browses an older Plan version, keep that page
  // stable. New versions surface as a "查看最新" affordance instead of
  // moving history underneath the cursor.
  useEffect(() => {
    if (!versionPinned.current) setVersionIndex(latestVersionIndex)
  }, [latestVersionIndex])
  const header = <div className="document-header">
    <div className="eyebrow">ROUND {round.sequence} · {modeLabels[round.mode]}</div>
    <h1>{round.title}</h1>
    <div className="document-meta"><span className={`status status-${round.status}`}>{statusLabels[round.status]}</span><span>{new Date(round.updatedAt).toLocaleString()}</span></div>
  </div>

  if (round.mode === 'plan') {
    const version = round.planVersions[versionIndex]
    return <article className="document">
      {header}
      {round.planVersions.length > 1 && <div className="version-tabs" role="tablist" aria-label="Plan 版本">
        {round.planVersions.map((item, index) => <button key={item.id} role="tab" aria-selected={index === versionIndex} className={index === versionIndex ? 'active' : ''} onClick={() => { versionPinned.current = true; setVersionIndex(index) }}>v{item.ordinal}</button>)}
        {versionIndex !== latestVersionIndex && <button className="latest-version" onClick={() => { versionPinned.current = false; setVersionIndex(latestVersionIndex) }}>查看最新 v{round.planVersions[latestVersionIndex]?.ordinal}</button>}
      </div>}
      <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{version?.planMarkdown || round.bodyMarkdown || '本轮尚无计划。'}</ReactMarkdown></div>
      {version && version.submittedSpec.trim() && version.submittedSpec.trim() !== (version.planMarkdown ?? '').trim() && <details className="submitted-spec"><summary>本次提交的 Spec</summary><div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{version.submittedSpec}</ReactMarkdown></div></details>}
      <EvidenceList evidence={round.evidence} />
    </article>
  }

  if (round.mode === 'vibe') {
    return <article className="document">
      {header}
      {round.result ? <ResultView result={round.result} /> : <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{round.bodyMarkdown || '本轮尚无结果。'}</ReactMarkdown></div>}
      {round.vibeEntries.length > 0 && <section className="vibe-timeline"><h3>执行记录</h3>
        {round.vibeEntries.map(entry => <article className="vibe-entry" key={entry.id}>
          <div className="vibe-entry-head"><span>#{entry.ordinal}</span><span className="vibe-outcome">{entry.executionOutcome}</span><span className="vibe-time">{new Date(entry.createdAt).toLocaleString()}</span></div>
          <div className="vibe-entry-body">
            <div className="vibe-spec"><h4>Spec</h4><div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.specMarkdown}</ReactMarkdown></div></div>
            <div className="vibe-output"><h4>Output</h4><div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.assistantOutput || '（无输出）'}</ReactMarkdown></div></div>
          </div>
        </article>)}
      </section>}
      <EvidenceList evidence={round.evidence} />
    </article>
  }

  return <article className="document">
    {header}
    {round.result ? <ResultView result={round.result} /> : <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{round.bodyMarkdown || '本轮尚未产生终态结果。'}</ReactMarkdown></div>}
    <EvidenceList evidence={round.evidence} />
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
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.kind === 'error' && event.message.includes(' · failed · ')) return null
    if (event.kind !== 'tool') continue
    if (event.message.includes(' · completed · ') || event.message.includes(' · failed · ')) return null
    return event.id
  }
  return null
}

function renderRunnerMessage(event: RunnerEvent, activeToolId: string | null, now: number): string {
  if (event.id !== activeToolId) return event.message
  const elapsedMs = Math.max(0, now - new Date(event.at).getTime())
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
  const [mode, setMode] = useState<RoundMode>('plan')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [sourceView, setSourceView] = useState(true)
  const [runnerOpen, setRunnerOpen] = useState(false)
  const [runnerNow, setRunnerNow] = useState(() => Date.now())
  const [runnerHasNewEvents, setRunnerHasNewEvents] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(() => Number(window.localStorage.getItem('codey.sidebarWidth')) || 196)
  const [specWidth, setSpecWidth] = useState(() => Number(window.localStorage.getItem('codey.specWidth')) || 390)
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
  latest.current = { draft, mode }

  function applySnapshot(next: WorkspaceSnapshot): void {
    const previous = snapshotRef.current
    const sessionChanged = previous?.session?.id !== next.session?.id
    snapshotRef.current = next
    setSnapshot(next)
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
    if (next.running && !previous?.running) {
      runnerFollowLatest.current = true
      setRunnerHasNewEvents(false)
      setRunnerOpen(true)
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
    window.temporal.getSnapshot().then(next => {
      if (!active) return
      applySnapshot(next)
      setWorkspacePath(next.workspacePath)
    }).catch(e => { if (active) setError(messageOf(e)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false; unsubscribe() }
  }, [])

  useEffect(() => {
    window.localStorage.setItem('codey.sidebarWidth', String(sidebarWidth))
  }, [sidebarWidth])

  useEffect(() => {
    window.localStorage.setItem('codey.specWidth', String(specWidth))
  }, [specWidth])

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

  function queueDraft(nextDraft: string, nextMode: RoundMode): void {
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
    setRunnerOpen(true)
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
  const currentRound = activeRound ?? latestRound
  const selectedRound = snapshot?.rounds.find(round => round.id === selectedId)
  const viewingHistoricalRound = Boolean(selectedRound && currentRound && selectedRound.id !== currentRound.id)
  const continuesActiveRound = Boolean(activeRound && activeRound.mode === mode && !(snapshot?.running && activeRound.mode === 'loop'))
  const submitRoundSequence = continuesActiveRound ? activeRound!.sequence : (latestRound?.sequence ?? 0) + 1
  const runnerEvents = snapshot?.runnerEvents ?? []
  const runnerMode = activeRound?.mode ?? latestRound?.mode ?? mode
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
    selectionPinned.current = id !== currentRound?.id
    selectedIdRef.current = id
    setSelectedId(id)
  }

  function returnToCurrentRound(): void {
    selectionPinned.current = false
    const id = currentRound?.id ?? null
    selectedIdRef.current = id
    setSelectedId(id)
  }

  function beginPaneResize(kind: 'sidebar' | 'spec', event: React.PointerEvent<HTMLDivElement>): void {
    const host = workspaceHost.current
    if (!host) return
    event.preventDefault()
    const bounds = host.getBoundingClientRect()
    document.body.classList.add('resizing-panes')
    const onMove = (move: PointerEvent): void => {
      if (kind === 'sidebar') {
        const width = Math.max(150, Math.min(320, move.clientX - bounds.left))
        setSidebarWidth(Math.round(width))
      } else {
        const available = Math.max(320, bounds.width - (sidebarCollapsed ? 54 : sidebarWidth) - 360)
        const width = Math.max(320, Math.min(Math.min(720, available), bounds.right - move.clientX))
        setSpecWidth(Math.round(width))
      }
    }
    const onUp = (): void => {
      document.body.classList.remove('resizing-panes')
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
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
          onClick={() => { if (runnerEvents.length > 0) { runnerFollowLatest.current = true; setRunnerHasNewEvents(false); setRunnerOpen(true) } }}
          disabled={runnerEvents.length === 0}
          aria-live="polite"
          title={runnerEvents.length > 0 ? '打开 Runner' : '当前没有 Runner 事件'}
        ><span className="run-state-dot"/><span>{runStatusLabel}</span></button>}
        <button className="text-button settings-trigger" onClick={showSettings} aria-label="模型设置">模型设置</button>
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
                <span className="session-icon">＋</span><span className="session-row-copy"><strong>New Session</strong><small>创建后从 Plan 开始</small></span><span className="row-arrow">→</span>
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
          <div className="sidebar-header"><button className="icon-button sidebar-toggle" onClick={() => setSidebarCollapsed(!sidebarCollapsed)} aria-label={sidebarCollapsed ? '展开侧栏' : '折叠侧栏'} title={sidebarCollapsed ? '展开侧栏' : '折叠侧栏'}><span className="sidebar-toggle-glyph" aria-hidden="true"><i/></span></button><div className="sidebar-name"><strong>{snapshot.session.title}</strong><small title={snapshot.workspacePath ?? ''}>{snapshot.workspacePath}</small></div></div>
          <nav className="timeline" aria-label="Round 列表">
            {snapshot.rounds.map(round => <button key={round.id} className={`timeline-item ${selectedId === round.id ? 'selected' : ''} ${currentRound?.id === round.id ? 'current' : ''}`} onClick={() => selectRound(round.id)} title={`Round ${round.sequence} · ${modeLabels[round.mode]} · ${statusLabels[round.status]}`}>
              <span className="thumbnail-page" data-round={round.sequence}>
                <span className="thumbnail-eyebrow">{modeLabels[round.mode]} · Round {round.sequence}</span>
                <span className="thumbnail-title">{round.title || `Round ${round.sequence}`}</span>
                <span className="thumbnail-lines" aria-hidden="true"><i/><i/><i/><i/></span>
                {currentRound?.id === round.id && <span className="thumbnail-current">当前</span>}
                <span className={`thumbnail-state state-${round.status}`}>{statusLabels[round.status]}</span>
              </span>
              <span className="timeline-copy"><strong>{round.title || `Round ${round.sequence}`}</strong><small>{modeLabels[round.mode]}{currentRound?.id === round.id ? ' · 当前' : ''}</small></span>
            </button>)}
          </nav>
          <button className={`runner-mini ${runnerEvents.length > 0 && !runnerOpen ? 'visible' : ''}`} onClick={() => { runnerFollowLatest.current = true; setRunnerHasNewEvents(false); setRunnerOpen(true) }} aria-label="展开 Runner" tabIndex={runnerEvents.length > 0 && !runnerOpen ? 0 : -1}><span className={snapshot.running ? 'live-dot' : 'idle-dot'}/><span className="runner-mini-label">{cancelling ? '正在停止…' : snapshot.running ? '正在运行 · 查看过程' : '最近运行 · 查看过程'}</span></button>
        </aside>
        {!sidebarCollapsed && <div className="pane-resizer pane-resizer-sidebar" role="separator" aria-orientation="vertical" aria-label="调整 Round 侧栏宽度" onPointerDown={event => beginPaneResize('sidebar', event)} onDoubleClick={() => setSidebarWidth(196)} />}
        <section className="result-pane" aria-label="结果页面">
          <div className="result-scroll">
            {viewingHistoricalRound && currentRound && <div className="history-banner"><div><span>正在查看历史</span><strong>Round {selectedRound?.sequence} · {selectedRound ? modeLabels[selectedRound.mode] : ''}</strong></div><button onClick={returnToCurrentRound}>返回当前 Round {currentRound.sequence} →</button></div>}
            {selectedRound ? <RoundView key={selectedRound.id} round={selectedRound} />
              : snapshot.historyState === 'backend-unavailable' ? <article className="document"><div className="document-header"><div className="eyebrow">OPENCODE SESSION READY</div><h1>OpenCode runtime ready</h1><p>OpenCode Session 已在后台预热完成，但尚未产生 Temporal Round。第一次提交会沿用该 OpenCode Session 并创建 Round 1。</p></div></article>
              : <div className="blank-state"><div className="blank-symbol">⌁</div><h2>暂无结果</h2><p>在右侧写下目标，选择模式并提交。</p></div>}
          </div>
          <section className={`runner-panel ${runnerOpen ? 'open' : ''} ${cancelling ? 'stopping' : ''}`} aria-label="Runner 事件" aria-hidden={!runnerOpen}>
            <div className="runner-header">
              <div><span className={snapshot.runState.status === 'running' ? 'live-dot' : 'idle-dot'}/><strong>{snapshot.runState.status === 'running' ? '运行中' : snapshot.runState.status === 'stopping' ? '停止中' : snapshot.runState.outcome ? `已结束 · ${runOutcomeLabels[snapshot.runState.outcome]}` : 'Runner'}</strong><span>{modeLabels[runnerMode]}{runnerDuration ? ` · ${runnerDuration}` : ''}</span></div>
              <div className="runner-actions">{snapshot.running && <button className="runner-stop" onClick={() => void cancelRun()} disabled={cancelling} aria-label="停止当前运行">{cancelling ? '停止中…' : '停止'}</button>}<button onClick={() => setRunnerOpen(false)} aria-label="收起 Runner">收起</button></div>
            </div>
            <div className="runner-events" ref={runnerEventsHost} onScroll={handleRunnerScroll} role="log" aria-live="polite">{runnerEvents.length ? runnerEvents.map(event => <div className={`runner-event event-${event.kind}`} key={event.id}><span className="runner-prefix">{event.kind}</span><span className="runner-message">{renderRunnerMessage(event, activeRunnerToolId, runnerNow)}</span></div>) : <p className="runner-empty">等待运行事件…</p>}</div>
            {runnerHasNewEvents && <button className="runner-new-events" onClick={jumpRunnerToLatest}>↓ 有新事件 · 回到底部</button>}
          </section>
        </section>
        <div className="pane-resizer pane-resizer-spec" role="separator" aria-orientation="vertical" aria-label="调整 Spec 面板宽度" onPointerDown={event => beginPaneResize('spec', event)} onDoubleClick={() => setSpecWidth(390)} />
        <section className="spec-pane" aria-label="Spec 编辑器">
          <div className={`spec-context ${snapshot.running ? 'next-spec' : ''}`}>
            <span className="eyebrow">{snapshot.running ? 'NEXT SPEC' : 'SPEC'}</span>
            <strong>{continuesActiveRound ? `继续 Round ${activeRound?.sequence} · ${modeLabels[mode]}` : `下一次提交 · Round ${submitRoundSequence} · ${modeLabels[mode]}`}</strong>
            <small>{snapshot.running ? '当前任务正在执行；这里的内容只用于下一次提交，不会改变当前运行。' : continuesActiveRound ? '本次提交会继续当前 Round。' : activeRound ? `切换模式会结束 Round ${activeRound.sequence}，并创建新 Round。` : '本次提交会创建新的 Round。'}</small>
          </div>
          <div className="spec-toolbar"><div className="segmented" aria-label="下一次提交模式">{(['plan', 'vibe', 'loop'] as const).map(item => <button key={item} className={mode === item ? 'active' : ''} onClick={() => queueDraft(draft, item)} disabled={busy} aria-pressed={mode === item}>{modeLabels[item]}</button>)}</div><div className="segmented" aria-label="编辑器视图"><button className={sourceView ? 'active' : ''} onClick={() => setSourceView(true)} aria-pressed={sourceView}>Source</button><button className={!sourceView ? 'active' : ''} onClick={() => setSourceView(false)} aria-pressed={!sourceView}>MD</button></div></div>
          <div className="spec-body"><div className={`editor-container ${sourceView ? '' : 'hidden'}`}><CodeMirrorEditor key={snapshot.session.id} value={draft} onFocus={() => { editorFocused.current = true }} onBlur={() => { editorFocused.current = false }} onChange={value => queueDraft(value, mode)}/>{!draft && <span className="editor-placeholder" aria-hidden="true"># Spec<br/><br/>描述希望完成的工作…</span>}</div><div className={`spec-preview markdown-body ${sourceView ? 'hidden' : ''}`}>{draft.trim() ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{draft}</ReactMarkdown> : <p className="muted">Spec 预览会显示在这里。</p>}</div></div>
          <div className="spec-footer"><div className="footer-actions"><button className="secondary-button" onClick={endRound} disabled={busy || snapshot.running || !activeRound}>{activeRound ? `结束 Round ${activeRound.sequence}` : '无进行中 Round'}</button><button className="primary-button" onClick={submit} disabled={busy || snapshot.running || !draft.trim()}>{snapshot.running ? '当前任务运行中' : `提交到 Round ${submitRoundSequence}`}</button></div></div>
        </section>
      </main>}

    {settingsOpen && settings && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setSettingsOpen(false) }}><section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="dialog-header"><div><div className="eyebrow">PREFERENCES</div><h2 id="settings-title">模型设置</h2></div><button className="icon-button" onClick={() => setSettingsOpen(false)} aria-label="关闭设置">×</button></div>{error && <div className="dialog-error" role="alert">{error}</div>}<div className="settings-fields"><label>Provider<input value={settings.provider} onChange={event => setSettings({ ...settings, provider: event.target.value })} placeholder="deepseek-official"/></label><label>Model<input value={settings.model} onChange={event => setSettings({ ...settings, model: event.target.value })} placeholder="模型名称"/></label><label>Base URL <small>可选</small><input value={settings.baseUrl ?? ''} onChange={event => setSettings({ ...settings, baseUrl: event.target.value })} placeholder="https://…"/></label><label>会话权限 <small>OpenCode 工具权限；非操作系统级沙箱，运行中不可修改</small><select value={permission} onChange={event => void changePermission(event.target.value as PermissionPreset)} disabled={snapshot?.running || busy}>{(['read-only', 'workspace-write', 'danger-full-access'] as const).map(item => <option key={item} value={item}>{permissionLabels[item]}</option>)}</select></label><label>API 凭证 <small>{settings.hasCredential ? '已保存；留空则保持原凭证' : '尚未保存'}</small><input type="password" autoComplete="new-password" value={credential} onChange={event => setCredential(event.target.value)} placeholder={settings.hasCredential ? '输入新凭证以替换' : '输入 API 凭证'}/></label></div><div className="dialog-actions"><button className="secondary-button" onClick={() => setSettingsOpen(false)}>取消</button><button className="primary-button" onClick={saveSettings} disabled={busy || !settings.provider.trim() || !settings.model.trim()}>保存设置</button></div></section></div>}
  </div>
}

createRoot(document.getElementById('root')!).render(<App />)
