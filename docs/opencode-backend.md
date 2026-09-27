# OpenCode backend integration

This document records the implementation contract for the OpenCode edition of Temporal Workspace.

## Frozen backend

- OpenCode base version: `1.18.31`
- Fork: `StupidArthur/opencode-fork`
- Backend source commit: `cf50cd4e9294aaf260e0742ffffefca9181fd64d`
- Base shell/process patch: `93dbf6f64cbf6402549289cf2eb56ee4c2474c57`
- Release tag: `codey-opencode-v1.18.31-p1`
- Windows runtime asset: `opencode-windows-x64-codey.zip`
- Archive SHA-256: `7e311d2afaa775f705cb251524f48a57fe0d1336d7ea0261e8e9c4c48f272aa5`
- Extracted `opencode.exe` SHA-256: `03ca853eaae717fa45a5e8bc180707f865e82f7df6089816ebaa6988b67d259a`
- Runtime transport: authenticated loopback HTTP + SSE
- Server command: `opencode serve`

The fork remains on the upstream `1.18.31` protocol/version surface. The two Codey patches fix Windows inherited-stdio hangs in both the agent ShellTool path and the public `POST /session/:id/shell` path. No ArthurCode Simple/Loop/TUI product changes are part of the pinned backend artifact.

The packaged runtime is checked through `GET /global/health`; a version other than `1.18.31` is rejected.

## Product/runtime boundary

Codey owns:

- Workspace and product Session selection
- Temporal Round semantics
- Plan versioning
- Vibe entries
- LoopController policy and budgets
- Evidence collection and product verification
- Result documents
- Runner presentation
- Session-level product permission preset
- app-local SQLite projection and lease

OpenCode owns:

- backend Session history
- model/provider adapter
- model context
- compaction
- file/search/edit/shell tools
- MCP
- subagents
- tool execution lifecycle
- backend persistence

Codey does not parse or mutate OpenCode's private persistence format.

## Session lifecycle

One Codey Session is bound to one OpenCode Session id.

```text
open Codey Session
  → prewarm OpenCode server
  → resume stored OpenCode Session id
     or create one and persist the id
  → reuse the same OpenCode Session for Plan, Vibe and Loop
```

A single Electron window owns one active product Session. Codey's existing SQLite lease prevents the same product Session from being owned concurrently by two windows.

OpenCode-native Sessions that have never been opened by Codey are not discovered in this edition. The launcher lists Codey product Sessions only. This keeps launcher latency deterministic and avoids reconstructing foreign history.

## Mode mapping

### Plan

Codey calls the semantic `plan` runtime agent. OpenCodeRuntime resolves that to a randomized private primary agent created for this process.

The private Plan agent:

- uses the configured model
- denies edit
- denies bash
- denies task/subagent delegation
- denies external-directory access

Codey's `planGuidance()` shapes the returned artifact but does not implement the execution boundary.

### Vibe

Codey calls the semantic `build` runtime agent. OpenCodeRuntime resolves it to a randomized private Build primary agent.

Each submit appends one Vibe entry to the current Vibe Round. The Round remains active until End Round or a mode switch.

### Loop

Codey's existing LoopController remains the product-level controller. Each continuation is an OpenCode Build turn in the same backend Session. Evidence collection, verification and terminal decision remain Codey responsibilities.

## Private Codey agents

The runtime does not send turns to the user-configurable built-in names `build` and `plan`.

For every runtime process it creates randomized primary agents similar to:

```text
codey-build-<uuid>
codey-plan-<uuid>
```

This avoids a project `opencode.json` redefining the behavior or permissions of the agents Codey invokes.

## Configuration precedence

Codey passes its model/provider configuration through `OPENCODE_CONFIG_CONTENT`.

OpenCode v1.18.31 loads project configuration before `OPENCODE_CONFIG_CONTENT`, so Codey's provider/model and private-agent definitions override ordinary project configuration where they overlap.

Codey additionally sets `OPENCODE_PERMISSION`. OpenCode applies that permission overlay late in its config-loading pipeline, which reasserts the product Session permission after normal project/global configuration.

## Permission semantics

The three product presets are mapped as follows.

### read-only

- edit: deny
- bash: deny
- external directory: deny
- private Plan additionally denies task
- approval-question UI is denied because Codey does not expose an interactive permission dialog

### workspace-write

- edit: allow
- bash: allow
- external directory: deny
- approval-question UI is denied

### danger-full-access

- tool access allowed
- external directory allowed
- approval-question UI is denied

Important: OpenCode's permission system is a tool authorization layer, not a kernel/ACL filesystem sandbox. `workspace-write` in this edition is therefore not security-equivalent to DSH's Windows ACL sandbox. This distinction must remain visible in documentation and future security claims.

## Local server security

Every runtime creates a random server password and launches OpenCode on `127.0.0.1`.

Every HTTP/SSE request includes Basic authentication.

Every instance-scoped request includes `x-opencode-directory` for the selected Workspace.

The OpenCode data/config/cache roots are redirected into the OpenCode edition's Electron userData directory rather than the user's ordinary OpenCode installation.

## Runner projection

The SSE stream is projected into Codey's existing Runner.

Projected events include:

- reasoning start → `Analyzing…`
- tool pending/running/completed/error
- per-tool input/output summary and duration
- step token usage
- retry status
- compaction start/completed
- session error
- permission request rejection
- startup phases and model wait status

Raw private chain-of-thought text is not shown.

## Cancellation

Stop uses OpenCode's public session abort endpoint.

Codey turn deadlines abort both the HTTP request and the OpenCode Session turn.

Closing a runtime attempts to abort an active turn before terminating the local server process.

## Prewarming

Session open schedules warmup after 800 ms.

Draft save or mode intent starts warmup immediately.

`ensureRuntime()` deduplicates warmup and Submit through one in-flight Promise, so a fast Submit waits only for the remainder of an already-started boot.

## Packaging

`scripts/prepare-opencode.ps1`:

1. downloads the exact Codey backend release asset from the pinned fork tag;
2. verifies the frozen archive SHA-256;
3. extracts `opencode.exe`;
4. verifies the frozen executable SHA-256;
5. checks `opencode --version` is exactly `1.18.31`;
6. places it under `vendor/opencode`.

There is no fallback to a system `opencode.exe`. Development fails with an explicit `pnpm prepare:opencode` instruction if the vendored binary is missing; packaged builds require `resources/opencode/opencode.exe`.

electron-builder copies the binary into `resources/opencode/opencode.exe`. Windows CI also packages an unpacked application and verifies the final bundled binary's version and SHA-256.

## Verification available without a model

`pnpm probe:opencode` statically checks the integration contract.

`pnpm probe:opencode:smoke` launches the pinned binary in an isolated temporary OpenCode home and verifies:

- reported version
- authenticated health endpoint
- Session create
- Session get
- Session abort

A real-model Windows packaged run is still required to verify provider credentials, agent/tool execution, installer resource lookup, and end-to-end Runner behavior in the final distribution.
