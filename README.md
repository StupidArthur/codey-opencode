# Codey — OpenCode Edition

Codey is an Electron + React desktop coding workspace focused on the interaction and presentation layer around coding agents: Temporal Rounds, Plan/Vibe/Loop modes, Result documents, a live Runner, evidence, and verification.

This repository is the standalone OpenCode-backed Codey product line. It uses a pinned, Codey-maintained build of **OpenCode v1.18.31** as the execution core while keeping Codey's Temporal UX and product model.

## Runtime architecture

```text
Temporal Workspace
├─ Electron / React UI
├─ Session → Round → Result product model
├─ Plan / Vibe / Loop behavior
├─ Runner event projection
├─ Evidence / verification / Result projection
└─ OpenCodeRuntime
   └─ bundled OpenCode CLI v1.18.31
      ├─ private Codey Plan agent
      ├─ private Codey Build agent
      ├─ OpenCode tools / MCP / compaction
      └─ OpenCode Session persistence
```

Mode mapping:

- **Plan** → a private OpenCode primary agent with edit, bash, task, and external-directory access denied. Codey adds only the plan-document formatting guidance.
- **Vibe** → a private OpenCode build agent.
- **Loop** → Codey's LoopController drives repeated turns through the same private OpenCode build agent, then applies Codey's evidence and completion gate.

All three modes reuse one OpenCode Session. OpenCode owns conversation context, tool execution, native compaction, and backend persistence. Codey's SQLite database stores only product projection data such as Rounds, drafts, Result documents, evidence, and the OpenCode Session id.

## Pinned backend

The backend is intentionally frozen at:

```text
OpenCode CLI: 1.18.31
```

`pnpm prepare:opencode` downloads Codey's pinned Windows x64 backend artifact from `StupidArthur/opencode-fork`, verifies both the archive and extracted executable SHA-256 values, checks that the binary reports `1.18.31`, and copies it into `vendor/opencode`.

Pinned backend provenance:

```text
OpenCode base: 1.18.31
Fork: StupidArthur/opencode-fork
Source commit: cf50cd4e9294aaf260e0742ffffefca9181fd64d
Patch lineage:
  93dbf6f64cbf6402549289cf2eb56ee4c2474c57  ShellTool / cross-spawn inherited-stdio fix
  cf50cd4e9294aaf260e0742ffffefca9181fd64d  public /session/:id/shell inherited-stdio fix
Binary SHA-256:
  03CA853EAAE717FA45A5E8BC180707F865E82F7DF6089816EBAA6988B67D259A
```

The patched build remains protocol- and version-compatible with OpenCode `1.18.31`; Codey does not use a system-installed OpenCode binary.

The Windows installer bundles that binary under:

```text
resources/opencode/opencode.exe
```

The application checks `/global/health` at runtime and rejects a backend whose reported version is not `1.18.31`.

## Runtime isolation and permissions

Each app runtime launches a local authenticated `opencode serve` process bound to `127.0.0.1`. OpenCode data/config/cache are isolated under Codey's Electron `userData` directory.

Requests are routed to the selected Workspace with OpenCode's public `x-opencode-directory` mechanism.

Codey creates private, randomized OpenCode primary-agent names for Plan and Build so project-level `agent.build` / `agent.plan` configuration cannot redefine Codey's execution agents. The Session permission preset is also re-applied through `OPENCODE_PERMISSION` after normal OpenCode config loading.

OpenCode permissions are an agent/tool permission system, **not an OS-level filesystem sandbox**. In particular, `workspace-write` should not be interpreted as the same security boundary as DSH's ACL sandbox. `read-only` denies edit and shell execution; `danger-full-access` permits external-directory access.

## Prewarming

OpenCode startup is paid while the user is editing rather than after Submit:

- Session open schedules a delayed warmup.
- The first draft save or mode change starts warmup immediately.
- Submit reuses the same in-flight startup Promise if warmup has not completed.
- Warmup failures are logged but do not block editing; Submit retries through the normal runtime path.

## Development

Requires Node 24 and pnpm 11.

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm probe:opencode
```

Prepare and smoke-test the pinned Windows backend:

```text
pnpm prepare:opencode
pnpm probe:opencode:smoke
```

Build the Windows x64 installer:

```text
pnpm dist:win
```

## Diagnostics

Per-Session diagnostic logs are written by default to:

```text
D:\codey-log\session-<product-session-id>.jsonl
```

Important OpenCode events include runtime startup, health/version checks, Session create/resume, prompt timing, SSE events, tool lifecycle, compaction, cancellation, evidence phases, and snapshot timing.

## Repository lineage

This repository was split from `StupidArthur/codey` after the OpenCode backend reached a validated Windows baseline. Its `main` branch preserves the full Git history of the former `backend/opencode-v1.18.31` branch.

Related repositories:

```text
StupidArthur/codey-opencode  → current OpenCode-backed Codey product line
StupidArthur/opencode-fork   → pinned OpenCode 1.18.31 backend patches
StupidArthur/codey           → earlier DSH lineage and historical development
```

Backend switching is intentionally not implemented at runtime. Codey treats the execution core as an edition-level architectural choice rather than a per-session toggle.
