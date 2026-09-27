import { createHash, randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type { ModelSettings, PermissionPreset, RunnerEvent } from '../../shared/contracts'
import type { ToolCallFact } from '../evidence/evidence'
import {
  TURN_CANCELLED_MESSAGE, TURN_DEADLINE_MESSAGE,
  type AgentRuntime, type RuntimePromptOptions
} from '../runtime/AgentRuntime'

export const OPENCODE_VERSION = '1.18.31'
/** Pinned provenance of the bundled backend binary: Codey's own patched OpenCode build. */
export const OPENCODE_BACKEND = {
  source: 'StupidArthur/opencode-fork',
  commit: 'cf50cd4e9294aaf260e0742ffffefca9181fd64d',
  basePatchCommit: '93dbf6f64cbf6402549289cf2eb56ee4c2474c57',
  patch: 'windows-shell-inherited-stdio',
  binarySha256: '03CA853EAAE717FA45A5E8BC180707F865E82F7DF6089816EBAA6988B67D259A'
} as const
const SERVER_START_TIMEOUT_MS = 30_000
const CLOSE_TIMEOUT_MS = 5_000

export interface OpenCodeRuntimeOptions {
  workspacePath: string
  storageRoot: string
  settings: ModelSettings
  credential?: string
  permission?: PermissionPreset
  onEvent?: (event: RunnerEvent) => void
  onDebug?: (type: string, payload?: unknown) => void
  opencodeBin?: string
}

type Json = Record<string, unknown>
type OpenCodeEvent = { type?: string; properties?: unknown }

interface ToolProjection {
  callId: string
  name: string
  status: ToolCallFact['status']
  startedAt?: number
  emittedRunning: boolean
}

export class OpenCodeRuntime implements AgentRuntime {
  private child?: ChildProcessWithoutNullStreams
  private serverUrl?: string
  private serverAuth?: string
  private sessionId?: string
  private closed = false
  private busy = false
  private cancelRequested = false
  private eventAbort?: AbortController
  private eventTask?: Promise<void>
  private promptSequence = 0
  private turnToolFacts: ToolCallFact[] = []
  private tools = new Map<string, ToolProjection>()
  private reasoningParts = new Set<string>()
  private readonly agentNames = {
    build: `codey-build-${randomUUID()}`,
    plan: `codey-plan-${randomUUID()}`
  }

  constructor(private readonly options: OpenCodeRuntimeOptions) {}

  async start(sessionId?: string): Promise<{ sessionId: string }> {
    if (this.closed) throw new Error('OpenCode runtime has been closed')
    if (this.sessionId) {
      if (sessionId && sessionId !== this.sessionId) throw new Error('An OpenCode runtime can own only one session')
      return { sessionId: this.sessionId }
    }

    const provider = this.options.settings.provider.trim()
    const model = this.options.settings.model.trim()
    if (!provider || !model) throw new Error('Configure a model provider and model before starting OpenCode')

    const providerId = normalizeProviderId(provider)
    const modelRef = `${providerId}/${model}`
    const baseUrl = this.options.settings.baseUrl?.trim()
    const bin = this.options.opencodeBin ?? resolveOpenCodeBinary()
    const binarySha256 = binarySha256Of(bin)

    await mkdir(this.options.storageRoot, { recursive: true })
    await mkdir(join(this.options.storageRoot, 'data'), { recursive: true })
    await mkdir(join(this.options.storageRoot, 'config'), { recursive: true })
    await mkdir(join(this.options.storageRoot, 'cache'), { recursive: true })

    const config = buildOpenCodeConfig({
      provider,
      providerId,
      model,
      modelRef,
      baseUrl,
      credential: this.options.credential,
      permission: this.options.permission ?? 'workspace-write',
      agentNames: this.agentNames
    })
    const serverPassword = randomUUID()
    this.serverAuth = `Basic ${Buffer.from(`codey:${serverPassword}`).toString('base64')}`
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OPENCODE_SERVER_USERNAME: 'codey',
      OPENCODE_SERVER_PASSWORD: serverPassword,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      // OpenCode applies OPENCODE_PERMISSION after project/global/managed config.
      // Re-assert Codey's Session permission boundary at the final permission merge.
      OPENCODE_PERMISSION: JSON.stringify(permissionConfig(this.options.permission ?? 'workspace-write')),
      XDG_DATA_HOME: join(this.options.storageRoot, 'data'),
      XDG_CONFIG_HOME: join(this.options.storageRoot, 'config'),
      XDG_CACHE_HOME: join(this.options.storageRoot, 'cache'),
      OPENCODE_DISABLE_AUTOUPDATE: '1'
    }

    this.emit({ kind: 'status', message: `Starting OpenCode ${OPENCODE_VERSION}…` })
    this.debug('runtime.start.begin', {
      backend: 'opencode',
      version: OPENCODE_VERSION,
      backendSource: OPENCODE_BACKEND.source,
      backendCommit: OPENCODE_BACKEND.commit,
      backendPatch: OPENCODE_BACKEND.patch,
      provider: providerId,
      model,
      modelRef,
      workspacePath: this.options.workspacePath,
      resumeSessionId: sessionId,
      bin
    })

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(bin, ['serve', '--hostname=127.0.0.1', '--port=0', '--log-level=WARN'], {
        cwd: this.options.workspacePath,
        env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (error) {
      throw new Error(`Failed to launch OpenCode ${OPENCODE_VERSION}: ${messageOf(error)}`)
    }
    this.child = child
    this.debug('runtime.process.spawned', { pid: child.pid, bin })

    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderr = (stderr + text).slice(-12_000)
      this.debug('runtime.stderr', { text })
    })
    child.once('exit', (code, signal) => this.debug('runtime.process.exit', { pid: child.pid, code, signal }))
    child.once('error', (error) => this.debug('runtime.process.error', { pid: child.pid, error: messageOf(error) }))

    try {
      this.serverUrl = await waitForServer(child)
      this.emit({ kind: 'status', message: 'OpenCode server ready' })
      this.debug('opencode.server.ready', { url: this.serverUrl })

      const health = await this.request<Json>('/global/health')
      const version = typeof health.version === 'string' ? health.version : ''
      if (version && version !== OPENCODE_VERSION) {
        throw new Error(`Bundled OpenCode version mismatch: expected ${OPENCODE_VERSION}, got ${version}`)
      }
      this.debug('opencode.health', health)

      const actualSha256 = await binarySha256.catch(() => undefined)
      this.debug('opencode.backend.identity', {
        backend: 'opencode',
        backendVersion: OPENCODE_VERSION,
        backendSource: OPENCODE_BACKEND.source,
        backendCommit: OPENCODE_BACKEND.commit,
        backendPatch: OPENCODE_BACKEND.patch,
        backendBinaryPath: bin,
        backendBinarySha256: actualSha256 ?? OPENCODE_BACKEND.binarySha256,
        backendBinarySha256Pinned: OPENCODE_BACKEND.binarySha256,
        backendBinarySha256MatchesPin: actualSha256 ? actualSha256 === OPENCODE_BACKEND.binarySha256 : null
      })

      this.startEventStream()

      if (sessionId) {
        this.emit({ kind: 'status', message: 'Resuming OpenCode session…' })
        this.debug('opencode.session.resume.start', { sessionId })
        const existing = await this.request<Json>(`/session/${encodeURIComponent(sessionId)}`)
        const directory = typeof existing.directory === 'string' ? existing.directory : undefined
        if (directory && !samePath(directory, this.options.workspacePath)) {
          throw new Error(`OpenCode session belongs to another workspace: ${directory}`)
        }
        this.sessionId = sessionId
        this.debug('opencode.session.resume.end', { sessionId })
      } else {
        this.emit({ kind: 'status', message: 'Creating OpenCode session…' })
        this.debug('opencode.session.create.start', { workspacePath: this.options.workspacePath })
        const created = await this.request<Json>('/session', {
          method: 'POST',
          body: JSON.stringify({ title: 'Temporal Workspace' })
        })
        const createdId = typeof created.id === 'string' ? created.id : ''
        if (!createdId) throw new Error('OpenCode session/create returned no session id')
        this.sessionId = createdId
        this.debug('opencode.session.create.end', { sessionId: createdId })
      }

      this.emit({ kind: 'status', message: 'OpenCode runtime ready' })
      this.debug('runtime.start.end', { sessionId: this.sessionId })
      return { sessionId: this.sessionId }
    } catch (error) {
      this.debug('runtime.start.error', { error: messageOf(error), stderrTail: stderr.trim() })
      await this.close()
      throw new Error(`OpenCode start failed: ${messageOf(error)}${stderr.trim() ? ` (stderr: ${stderr.trim()})` : ''}`)
    }
  }

  async prompt(spec: string, options: RuntimePromptOptions = {}): Promise<{ text: string }> {
    if (this.closed) throw new Error('OpenCode runtime has been closed')
    if (!spec.trim()) throw new Error('Spec must not be empty')
    if (this.busy) throw new Error('OpenCode session is already running')
    const sessionId = this.sessionId
    if (!sessionId) throw new Error('Start OpenCode before submitting a Spec')

    const providerID = normalizeProviderId(this.options.settings.provider)
    const modelID = this.options.settings.model.trim()
    const agent = options.agent ?? 'build'
    const backendAgent = this.agentNames[agent]
    const timeoutMs = options.timeoutMs ?? 0
    const promptSequence = ++this.promptSequence
    const startedAt = Date.now()

    this.busy = true
    this.cancelRequested = false
    this.turnToolFacts = []
    this.tools.clear()
    this.reasoningParts.clear()
    this.emit({ kind: 'status', message: `Waiting for model · ${agent}` })
    this.debug('prompt.start', { promptSequence, timeoutMs, agent, backendAgent, chars: spec.length, text: spec })

    const controller = new AbortController()
    let deadlineHit = false
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          deadlineHit = true
          controller.abort(new Error(TURN_DEADLINE_MESSAGE))
          void this.cancelTurn()
        }, timeoutMs)
      : undefined
    timer?.unref?.()

    try {
      const result = await this.request<Json>(`/session/${encodeURIComponent(sessionId)}/message`, {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          model: { providerID, modelID },
          agent: backendAgent,
          parts: [{ type: 'text', text: spec }]
        })
      })
      if (deadlineHit) throw new Error(TURN_DEADLINE_MESSAGE)
      if (this.cancelRequested) throw new Error(TURN_CANCELLED_MESSAGE)
      const text = assistantText(result)
      this.debug('prompt.response', { promptSequence, durationMs: Date.now() - startedAt, agent, backendAgent, assistantChars: text.length })
      return { text }
    } catch (error) {
      if (deadlineHit) {
        this.debug('prompt.error', { promptSequence, durationMs: Date.now() - startedAt, error: TURN_DEADLINE_MESSAGE })
        this.emit({ kind: 'error', message: TURN_DEADLINE_MESSAGE })
        throw new Error(TURN_DEADLINE_MESSAGE)
      }
      if (this.cancelRequested || isAbort(error)) {
        this.debug('prompt.error', { promptSequence, durationMs: Date.now() - startedAt, error: TURN_CANCELLED_MESSAGE })
        this.emit({ kind: 'status', message: 'run cancelled by user' })
        throw new Error(TURN_CANCELLED_MESSAGE)
      }
      this.debug('prompt.error', { promptSequence, durationMs: Date.now() - startedAt, error: messageOf(error) })
      this.emit({ kind: 'error', message: messageOf(error) })
      throw error
    } finally {
      if (timer) clearTimeout(timer)
      this.debug('prompt.finalize', {
        promptSequence,
        durationMs: Date.now() - startedAt,
        toolFacts: this.turnToolFacts
      })
      this.busy = false
      this.cancelRequested = false
    }
  }

  async cancelTurn(): Promise<boolean> {
    if (!this.busy || !this.sessionId || this.closed || !this.serverUrl) return false
    const sessionId = this.sessionId
    this.cancelRequested = true
    this.debug('opencode.session.abort.start', { sessionId })
    try {
      const result = await this.request<unknown>(`/session/${encodeURIComponent(sessionId)}/abort`, { method: 'POST' })
      this.debug('opencode.session.abort.end', { sessionId, result })
      return result !== false
    } catch (error) {
      this.cancelRequested = false
      this.debug('opencode.session.abort.error', { sessionId, error: messageOf(error) })
      return false
    }
  }

  takeToolFacts(): ToolCallFact[] {
    const facts = this.turnToolFacts
    this.turnToolFacts = []
    return facts
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.debug('runtime.close.begin', { sessionId: this.sessionId, busy: this.busy })
    if (this.busy) {
      try { await this.cancelTurn() } catch { /* best effort */ }
    }
    this.closed = true
    this.eventAbort?.abort()
    this.eventAbort = undefined
    await Promise.race([this.eventTask ?? Promise.resolve(), delay(500)]).catch(() => {})
    this.eventTask = undefined

    const child = this.child
    this.child = undefined
    this.serverUrl = undefined
    this.serverAuth = undefined
    this.sessionId = undefined
    if (child && child.exitCode === null) {
      try { child.stdin.end() } catch { /* already closed */ }
      try { child.kill() } catch { /* already gone */ }
      const exited = new Promise<void>((resolve) => {
        child.once('exit', () => resolve())
        child.once('error', () => resolve())
      })
      const done = await Promise.race([exited.then(() => true), delay(CLOSE_TIMEOUT_MS).then(() => false)])
      if (!done) {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }
    }
    this.debug('runtime.close.end')
  }

  private startEventStream(): void {
    const abort = new AbortController()
    this.eventAbort = abort
    this.eventTask = this.consumeEvents(abort.signal).catch((error) => {
      if (!abort.signal.aborted && !this.closed) {
        this.debug('opencode.event.error', { error: messageOf(error) })
        this.emit({ kind: 'error', message: `OpenCode event stream: ${messageOf(error)}` })
      }
    })
  }

  private async consumeEvents(signal: AbortSignal): Promise<void> {
    const response = await fetch(`${this.requireServerUrl()}/event`, {
      headers: { Accept: 'text/event-stream', Authorization: this.requireServerAuth(), 'x-opencode-directory': encodeURIComponent(this.options.workspacePath) },
      signal
    })
    if (!response.ok || !response.body) {
      throw new Error(`OpenCode event stream failed: HTTP ${response.status}`)
    }
    this.debug('opencode.event.connected', { status: response.status })
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
        for (;;) {
          const boundary = buffer.indexOf('\n\n')
          if (boundary < 0) break
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const data = block.split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n')
          if (!data) continue
          try {
            const event = JSON.parse(data) as OpenCodeEvent
            this.handleEvent(event)
          } catch (error) {
            this.debug('opencode.event.parse_error', { data: data.slice(0, 2000), error: messageOf(error) })
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  private handleEvent(event: OpenCodeEvent): void {
    this.debug('opencode.event', event)
    const type = event.type
    if (!type) return

    if (type === 'message.part.updated') {
      const properties = asRecord(event.properties)
      const part = asRecord(properties.part)
      if (!this.isOurSession(part.sessionID)) return
      const partType = stringOf(part.type)

      if (partType === 'reasoning') {
        const id = stringOf(part.id)
        if (id && !this.reasoningParts.has(id)) {
          this.reasoningParts.add(id)
          this.emit({ kind: 'thinking', message: 'Analyzing…' })
        }
        return
      }

      if (partType === 'compaction') {
        this.emit({ kind: 'status', message: 'Compacting context…' })
        return
      }

      if (partType === 'step-finish') {
        const tokens = asRecord(part.tokens)
        const cache = asRecord(tokens.cache)
        const input = numberOf(tokens.input)
        const output = numberOf(tokens.output)
        const reasoning = numberOf(tokens.reasoning)
        const cacheRead = numberOf(cache.read)
        const pieces = [
          input !== undefined ? `input ${formatNumber(input)}` : '',
          output !== undefined ? `output ${formatNumber(output)}` : '',
          reasoning ? `reasoning ${formatNumber(reasoning)}` : '',
          cacheRead ? `cache ${formatNumber(cacheRead)}` : ''
        ].filter(Boolean)
        if (pieces.length) this.emit({ kind: 'status', message: `step · ${pieces.join(' · ')}` })
        return
      }

      if (partType === 'tool') this.handleToolPart(part)
      return
    }

    if (type === 'session.compacted') {
      const p = asRecord(event.properties)
      if (this.isOurSession(p.sessionID)) this.emit({ kind: 'status', message: 'Context compacted' })
      return
    }

    if (type === 'session.status') {
      const p = asRecord(event.properties)
      if (!this.isOurSession(p.sessionID)) return
      const status = asRecord(p.status)
      if (status.type === 'retry') {
        const attempt = numberOf(status.attempt)
        const message = stringOf(status.message)
        this.emit({ kind: 'status', message: `retry${attempt !== undefined ? ` #${attempt}` : ''}${message ? ` · ${message}` : ''}` })
      }
      return
    }

    if (type === 'session.error') {
      const p = asRecord(event.properties)
      if (p.sessionID && !this.isOurSession(p.sessionID)) return
      this.emit({ kind: 'error', message: compactJson(p.error ?? 'OpenCode session error', 500) })
      return
    }

    if (type === 'permission.updated') {
      const p = asRecord(event.properties)
      if (!this.isOurSession(p.sessionID)) return
      const permissionId = stringOf(p.id)
      if (!permissionId || !this.sessionId) return
      const title = stringOf(p.title) || stringOf(p.type) || 'permission'
      this.emit({ kind: 'status', message: `permission denied · ${title}` })
      void this.request(`/session/${encodeURIComponent(this.sessionId)}/permissions/${encodeURIComponent(permissionId)}`, {
        method: 'POST',
        body: JSON.stringify({ response: 'reject' })
      }).catch((error) => this.debug('opencode.permission.reject.error', { permissionId, error: messageOf(error) }))
    }
  }

  private handleToolPart(part: Json): void {
    const callId = stringOf(part.callID) || stringOf(part.id)
    if (!callId) return
    const name = stringOf(part.tool) || 'tool'
    const state = asRecord(part.state)
    const rawStatus = stringOf(state.status)
    const status: ToolCallFact['status'] =
      rawStatus === 'completed' ? 'completed' :
      rawStatus === 'error' ? 'failed' :
      rawStatus === 'running' ? 'in_progress' : 'pending'

    const previous = this.tools.get(callId)
    const startedAt = numberOf(asRecord(state.time).start) ?? previous?.startedAt
    const projection: ToolProjection = {
      callId,
      name,
      status,
      startedAt,
      emittedRunning: previous?.emittedRunning ?? false
    }

    if ((status === 'pending' || status === 'in_progress') && !projection.emittedRunning) {
      projection.emittedRunning = true
      this.emit({
        kind: 'tool',
        message: `${name}\n↳ ${summarizeInput(asRecord(state.input))}`,
        tool: {
          callId,
          name,
          status: 'running',
          ...(startedAt !== undefined ? { startedAt: new Date(startedAt).toISOString() } : {})
        }
      })
    }

    if ((status === 'completed' || status === 'failed') && previous?.status !== status) {
      const time = asRecord(state.time)
      const endedAt = numberOf(time.end) ?? Date.now()
      const durationMs = startedAt !== undefined ? Math.max(0, endedAt - startedAt) : undefined
      const duration = durationMs !== undefined ? formatDuration(durationMs) : ''
      const output = status === 'completed' ? stringOf(state.output) : stringOf(state.error)
      const title = stringOf(state.title)
      const summary = [
        `${name} · ${status === 'completed' ? 'completed' : 'failed'}${duration ? ` · ${duration}` : ''}`,
        `↳ input: ${summarizeInput(asRecord(state.input))}`,
        output ? `↳ output: ${summarizeOutput(output)}` : title ? `↳ ${title}` : ''
      ].filter(Boolean).join('\n')
      this.emit({
        kind: status === 'completed' ? 'tool' : 'error',
        message: summary,
        tool: {
          callId,
          name,
          status,
          ...(startedAt !== undefined ? { startedAt: new Date(startedAt).toISOString() } : {}),
          finishedAt: new Date(endedAt).toISOString(),
          ...(durationMs !== undefined ? { durationMs } : {})
        }
      })
      this.upsertToolFact({
        toolCallId: callId,
        turn: 0,
        title: name,
        kind: 'other',
        status,
        at: new Date().toISOString()
      })
    }

    this.tools.set(callId, projection)
  }

  private upsertToolFact(fact: ToolCallFact): void {
    const index = this.turnToolFacts.findIndex((item) => item.toolCallId === fact.toolCallId)
    if (index >= 0) this.turnToolFacts[index] = fact
    else this.turnToolFacts.push(fact)
  }

  private isOurSession(value: unknown): boolean {
    return typeof value === 'string' && value === this.sessionId
  }

  private async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.requireServerUrl()}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: this.requireServerAuth(),
        'x-opencode-directory': encodeURIComponent(this.options.workspacePath),
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {})
      }
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`OpenCode HTTP ${response.status} ${response.statusText}: ${text.slice(0, 2000)}`)
    }
    if (!text.trim()) return undefined as T
    try { return JSON.parse(text) as T }
    catch { return text as T }
  }

  private requireServerUrl(): string {
    if (!this.serverUrl) throw new Error('OpenCode server is not ready')
    return this.serverUrl
  }

  private requireServerAuth(): string {
    if (!this.serverAuth) throw new Error('OpenCode server authentication is not ready')
    return this.serverAuth
  }

  private emit(event: Omit<RunnerEvent, 'id' | 'at'>): void {
    this.options.onEvent?.({ id: randomUUID(), at: new Date().toISOString(), ...event })
  }

  private debug(type: string, payload?: unknown): void {
    this.options.onDebug?.(type, payload)
  }
}

function buildOpenCodeConfig(input: {
  provider: string
  providerId: string
  model: string
  modelRef: string
  baseUrl?: string
  credential?: string
  permission: PermissionPreset
  agentNames: { build: string; plan: string }
}): Json {
  const providerOptions: Json = {}
  if (input.baseUrl) providerOptions.baseURL = input.baseUrl
  if (input.credential) providerOptions.apiKey = input.credential

  const providerConfig: Json = {
    name: input.provider,
    ...(input.baseUrl ? { npm: '@ai-sdk/openai-compatible' } : {}),
    ...(Object.keys(providerOptions).length ? { options: providerOptions } : {}),
    models: {
      [input.model]: { name: input.model }
    }
  }

  const globalPermission = permissionConfig(input.permission)
  return {
    autoupdate: false,
    share: 'disabled',
    model: input.modelRef,
    provider: { [input.providerId]: providerConfig },
    permission: globalPermission,
    agent: {
      [input.agentNames.build]: {
        description: 'Codey private build agent. Executes the active Temporal Vibe or Loop turn.',
        mode: 'primary',
        model: input.modelRef,
        permission: globalPermission
      },
      [input.agentNames.plan]: {
        description: 'Codey private planning agent. Analyzes the workspace without changing it.',
        mode: 'primary',
        model: input.modelRef,
        permission: {
          ...globalPermission,
          edit: 'deny',
          bash: 'deny',
          task: 'deny',
          external_directory: 'deny'
        }
      }
    }
  }
}

function permissionConfig(preset: PermissionPreset): Json {
  if (preset === 'read-only') {
    return {
      '*': 'allow',
      edit: 'deny',
      bash: 'deny',
      external_directory: 'deny',
      question: 'deny',
      doom_loop: 'allow'
    }
  }
  if (preset === 'danger-full-access') {
    return {
      '*': 'allow',
      external_directory: 'allow',
      question: 'deny',
      doom_loop: 'allow'
    }
  }
  return {
    '*': 'allow',
    edit: 'allow',
    bash: 'allow',
    external_directory: 'deny',
    question: 'deny',
    doom_loop: 'allow'
  }
}

export function resolveOpenCodeBinary(): string {
  const explicit = process.env.CODEY_OPENCODE_BIN?.trim()
  if (explicit) return explicit

  if (process.platform !== 'win32') return 'opencode'

  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const packaged = resourcesPath ? join(resourcesPath, 'opencode', 'opencode.exe') : undefined
  const vendored = join(process.cwd(), 'vendor', 'opencode', 'opencode.exe')

  if (packaged && existsSync(packaged)) return packaged
  if (existsSync(vendored)) return vendored

  // Never fall back to a PATH lookup: the user's machine may have another
  // OpenCode (official, nightly, or a different fork) installed globally.
  if (app.isPackaged) {
    throw new Error(
      `Bundled OpenCode runtime is missing: expected ${packaged ?? 'resources\\opencode\\opencode.exe'}. ` +
      'This installation is incomplete and must not use a system OpenCode.'
    )
  }
  throw new Error(
    `OpenCode runtime is missing: expected ${vendored}. Run \`pnpm prepare:opencode\` first.`
  )
}

const binaryShaCache = new Map<string, Promise<string>>()

/** SHA-256 of the backend binary, computed once per resolved path. */
function binarySha256Of(path: string): Promise<string> {
  const cached = binaryShaCache.get(path)
  if (cached) return cached
  const promise = new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex').toUpperCase()))
  })
  binaryShaCache.set(path, promise)
  return promise
}

async function waitForServer(child: ChildProcessWithoutNullStreams): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let output = ''
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const parse = (chunk: Buffer): void => {
      output += chunk.toString()
      for (const line of output.split(/\r?\n/)) {
        const match = /opencode server listening on (https?:\/\/[^\s]+)/.exec(line.trim())
        if (match?.[1]) {
          finish(() => resolve(match[1]))
          return
        }
      }
      output = output.slice(-12_000)
    }
    child.stdout.on('data', parse)
    child.stderr.on('data', parse)
    child.once('error', (error) => finish(() => reject(error)))
    child.once('exit', (code, signal) => finish(() => reject(
      new Error(`OpenCode server exited before ready (code=${code}, signal=${signal})${output.trim() ? `: ${output.trim()}` : ''}`)
    )))
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`Timed out waiting for OpenCode server after ${SERVER_START_TIMEOUT_MS}ms`)))
    }, SERVER_START_TIMEOUT_MS)
    timer.unref?.()
  })
}

function assistantText(response: Json): string {
  const parts = Array.isArray(response.parts) ? response.parts : []
  return parts
    .map((part) => asRecord(part))
    .filter((part) => part.type === 'text' && part.synthetic !== true)
    .map((part) => stringOf(part.text))
    .filter(Boolean)
    .join('')
}

function summarizeInput(input: Json): string {
  const entries = Object.entries(input)
  if (!entries.length) return '(no input)'
  return entries.slice(0, 5).map(([key, value]) => `${key}=${compactValue(value, 260)}`).join(' · ')
}

function summarizeOutput(output: string): string {
  const flat = output.replace(/\s+/g, ' ').trim()
  const lines = output ? output.split(/\r?\n/).length : 0
  const prefix = `${formatNumber(output.length)} chars · ${formatNumber(lines)} lines`
  if (!flat) return prefix
  return `${prefix} · ${flat.slice(0, 360)}${flat.length > 360 ? '…' : ''}`
}

function compactValue(value: unknown, max: number): string {
  if (typeof value === 'string') {
    const flat = value.replace(/\s+/g, ' ').trim()
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
  }
  return compactJson(value, max)
}

function compactJson(value: unknown, max: number): string {
  let text: string
  try { text = JSON.stringify(value) }
  catch { text = String(value) }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function normalizeProviderId(provider: string): string {
  return provider === 'deepseek-official' ? 'deepseek' : provider
}

function samePath(a: string, b: string): boolean {
  const normalize = (value: string): string => value.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
  return normalize(a) === normalize(b)
}

function asRecord(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value)
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || /aborted/i.test(error.message))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
