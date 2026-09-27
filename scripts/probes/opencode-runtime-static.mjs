import fs from 'node:fs'
import assert from 'node:assert/strict'

const runtime = fs.readFileSync('src/main/opencode/OpenCodeRuntime.ts', 'utf8')
const controller = fs.readFileSync('src/main/WindowController.ts', 'utf8')
const rounds = fs.readFileSync('src/main/rounds/RoundEngine.ts', 'utf8')
const loop = fs.readFileSync('src/main/loop/LoopController.ts', 'utf8')
const builder = fs.readFileSync('electron-builder.yml', 'utf8')
const prepare = fs.readFileSync('scripts/prepare-opencode.ps1', 'utf8')
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))

const checks = [
  ['runtime pins OpenCode 1.18.31', runtime.includes("OPENCODE_VERSION = '1.18.31'")],
  ['runtime launches headless serve', runtime.includes("['serve', '--hostname=127.0.0.1', '--port=0'")],
  ['runtime authenticates local server', runtime.includes('OPENCODE_SERVER_PASSWORD') && runtime.includes('Authorization: this.requireServerAuth()')],
  ['runtime routes every request to workspace', runtime.includes("'x-opencode-directory': encodeURIComponent(this.options.workspacePath)")],
  ['runtime locks permissions after config merge', runtime.includes('OPENCODE_PERMISSION: JSON.stringify(permissionConfig(')],
  ['runtime isolates private Codey agents', runtime.includes('codey-build-${randomUUID()}') && runtime.includes('codey-plan-${randomUUID()}') && runtime.includes('agent: backendAgent')],
  ['runtime verifies bundled version', runtime.includes('Bundled OpenCode version mismatch')],
  ['runtime supports session resume/create', runtime.includes('opencode.session.resume.start') && runtime.includes('opencode.session.create.start')],
  ['runtime supports public abort', runtime.includes('/abort') && runtime.includes('cancelTurn()')],
  ['runtime projects event stream', runtime.includes('/event') && runtime.includes("type === 'message.part.updated'")],
  ['runtime projects compaction', runtime.includes("type === 'session.compacted'")],
  ['runtime projects tool lifecycle', runtime.includes("partType === 'tool'") && runtime.includes('handleToolPart')],
  ['Loop planning uses native OpenCode plan agent', rounds.includes("runtime.prompt(prompt, { agent: 'plan' })")],
  ['Loop execution uses OpenCode build agent', rounds.includes("ensureRuntime('loop')") && loop.includes("agent: 'build'")],
  ['runtime prewarms while editing', controller.includes("prewarmRuntime(mode, 'draft.save')") && controller.includes("scheduleRuntimePrewarm(snapshot.mode, 'session.open', 800)")],
  ['Vibe and Loop share one backend runtime/session', controller.includes('Vibe and Loop share one OpenCode runtime/session')],
  ['installer bundles opencode.exe', builder.includes('vendor/opencode/opencode.exe') && builder.includes('to: opencode/opencode.exe')],
  ['prepare script pins patched Codey backend', prepare.includes("$Version = '1.18.31'") && prepare.includes('StupidArthur/opencode-fork') && prepare.includes('codey-opencode-v1.18.31-p1') && prepare.includes('03CA853EAAE717FA45A5E8BC180707F865E82F7DF6089816EBAA6988B67D259A')],
  ['runtime has no PATH fallback', runtime.includes('must not use a system OpenCode') && !runtime.includes("return 'opencode.exe'")],
  ['runtime records backend identity', runtime.includes("opencode.backend.identity") && runtime.includes('StupidArthur/opencode-fork') && runtime.includes('03CA853EAAE717FA45A5E8BC180707F865E82F7DF6089816EBAA6988B67D259A')],
  ['package identifies OpenCode edition', pkg.name === 'temporal-workspace-opencode' && pkg.description.includes('OpenCode 1.18.31')],
]

let failed = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failed += 1
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
if (failed) process.exit(1)
