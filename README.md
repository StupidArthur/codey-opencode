# Codey — OpenCode 版

Codey 是一个基于 Electron + React 的桌面编程工作区。它把重点放在 coding agent 的交互方式和结果呈现上，而不是重新实现一套通用 agent harness。

当前主线使用经过固定和补丁维护的 **OpenCode 1.18.31** 作为执行核心，并在其上实现 Codey 自己的 Temporal 产品模型：

- Session
- Round
- Vibe / Loop
- Result
- Runner
- Evidence
- Verification

目前主要验证平台是 **Windows x64**。

## 核心结构

```text
Codey
├─ Electron / React UI
├─ Workspace / Session
├─ Temporal Round
│  ├─ Vibe
│  └─ Loop
│     ├─ Planning / Plan versions
│     ├─ Plan quality gate
│     └─ Autonomous execution
├─ Result
├─ Runner
├─ Evidence / Verification
└─ OpenCodeRuntime
   └─ bundled OpenCode 1.18.31
      ├─ Codey 私有 Plan agent
      ├─ Codey 私有 Build agent
      ├─ OpenCode tools / MCP
      ├─ context / compaction
      └─ OpenCode Session persistence
```

Codey 负责产品层语义；OpenCode 负责底层 agent 执行。

### Codey 负责

- Workspace / Session 管理
- Round 生命周期
- Loop Plan 版本与质量门槛
- Vibe 连续对话
- LoopController
- Evidence
- Verification
- Result
- Runner 展示
- 产品权限预设
- SQLite 产品投影数据

### OpenCode 负责

- agent Session
- 模型与 provider
- 上下文
- compaction
- 文件 / 搜索 / 编辑 / shell 工具
- MCP
- subagent
- 工具生命周期
- backend persistence

## 两种模式

### Vibe

用于人主导的连续 coding。

同一个 Vibe Round 中的多次提交：

- 复用同一个 OpenCode Session
- 使用 Codey 私有 Build agent
- 每次输入 / 输出追加为 Vibe Entry
- 默认聚焦最新迭代，也可切换为“全部迭代”
- 直到 End Round 或切换模式

### Loop

Loop 是 Plan 驱动的自治执行，不再把 Plan 作为独立模式。

一个新的 Loop Round 先进入只读 Planning：

```text
planning → ready → running → terminal
```

Planning 阶段使用 Codey 私有 Plan agent，并禁止 edit / bash / task / external directory。每次补充要求都会生成新的 Plan version。

标准 Plan 包含：

- Goal
- Scope
- Current State
- Implementation
- Affected Files
- Acceptance Criteria
- Verification
- Constraints
- Open Questions

Codey 使用产品自己的 Plan quality gate 判断 Plan 是否 Ready；模型不能自行宣告可以执行。只有最新 Plan 满足质量门槛且不存在未提交的 Plan 输入时，用户才能显式点击 **Start Loop**。

Start Loop 后：

- 当前 Plan version 被冻结为 `approvedPlanVersionId`
- OpenCode 切换到 Build agent
- 完整 Plan 作为执行上下文
- Acceptance Criteria + Verification 被投影为 LoopEvaluator 的验收 Spec
- Codey 的 LoopController 负责 continuation、Evidence、Verification 和 completion gate

执行期间不会悄悄修改 Plan。发现 Plan 假设失效或需要用户输入时，Loop 应进入 blocked / terminal，再由用户重新规划。

旧版本中的独立 Plan Round 仍然可以读取，但不会再用于创建新的工作。

## Result

Round 结束后，Codey 使用统一的结果结构：

```text
Result

Summary
Changes
Verification
Remaining
```

Loop 还会记录 terminal 状态，用来区分真正完成、被阻塞、达到预算或被用户中止。

## Runner

Runner 用于展示执行过程中的可观察信息，例如：

- OpenCode 启动状态
- 等待模型
- Analyzing…
- tool pending / running / completed / error
- tool 输入输出摘要
- tool duration
- token 使用
- retry
- compaction
- cancellation
- backend error

Runner 不展示模型的私有 chain-of-thought。

## OpenCode backend

Codey 不依赖机器上安装的 OpenCode。

开发环境使用：

```text
vendor/opencode/opencode.exe
```

打包后的程序使用：

```text
resources/opencode/opencode.exe
```

如果对应文件不存在，Codey 会直接报错，不会回退到系统 PATH。

当前固定 backend：

```text
OpenCode base: 1.18.31

Fork:
StupidArthur/opencode-fork

Source commit:
cf50cd4e9294aaf260e0742ffffefca9181fd64d

Patch lineage:
93dbf6f64cbf6402549289cf2eb56ee4c2474c57
  ShellTool / cross-spawn inherited-stdio fix

cf50cd4e9294aaf260e0742ffffefca9181fd64d
  POST /session/:id/shell inherited-stdio fix

opencode.exe SHA-256:
03CA853EAAE717FA45A5E8BC180707F865E82F7DF6089816EBAA6988B67D259A
```

Windows 下 inherited-stdio shell hang 已经同时覆盖：

- agent ShellTool
- public `/session/:id/shell`

并有 CI regression probe。

## 权限

Codey 当前提供三种权限预设：

### Read-only

- 禁止 edit
- 禁止 bash
- 禁止 external directory

适合只读分析。

### Workspace-write

- 允许 edit
- 允许 bash
- 禁止 external directory

适合正常项目开发。

### Danger full access

- 允许外部目录访问
- 允许更完整的工具能力

需要注意：

> OpenCode permission 是 agent / tool authorization，不是操作系统级 ACL sandbox。

因此 `workspace-write` 不应被理解为和系统级文件隔离完全等价。

## Runtime 隔离

Codey 每个运行时会：

- 启动自己的 `opencode serve`
- 绑定 `127.0.0.1`
- 使用随机 Basic Auth 密码
- 使用当前 Workspace 路由
- 把 OpenCode data / config / cache 放到 Codey 自己的 userData 下
- 禁止 OpenCode 自动更新

项目中的普通 `opencode.json` 不能替换 Codey 私有 Plan / Build agent，也不能放宽 Codey 最终施加的权限预设。

## Prewarm

为了减少点击 Submit 后的等待，Codey 会提前启动 OpenCode：

- 打开 Session 后延迟预热
- 第一次编辑 draft 时立即预热
- 切换模式时可触发预热
- Submit 复用同一个启动 Promise

在已经预热的情况下，Submit 到真正模型请求之间的 Codey 启动开销很小。

## 开发环境

要求：

```text
Node 24
pnpm 11
Windows x64
```

安装依赖：

```powershell
pnpm install --frozen-lockfile
```

类型检查和构建：

```powershell
pnpm typecheck
pnpm build
```

准备固定 OpenCode backend：

```powershell
pnpm prepare:opencode
```

backend smoke test：

```powershell
pnpm probe:opencode
pnpm probe:opencode:smoke
pnpm probe:opencode:shell-hang
```

开发运行：

```powershell
pnpm dev
```

## 直接可用的 Windows 包

当前个人使用场景不需要安装包，推荐直接生成解压即用的 Windows 目录：

```powershell
pnpm prepare:electron
pnpm prepare:opencode
pnpm build
pnpm exec electron-builder --win --x64 --dir
```

输出：

```text
release\win-unpacked\
```

直接运行其中的：

```text
Temporal Workspace OpenCode.exe
```

即可。

如果需要在机器之间复制，可以直接把整个 `win-unpacked` 目录压成 zip：

```powershell
Compress-Archive -Path release\win-unpacked\* -DestinationPath release\Codey-win-x64.zip -Force
```

Codey 的 patched OpenCode 位于：

```text
release\win-unpacked\resources\opencode\opencode.exe
```

Windows CI 会检查最终打包目录中的 OpenCode 版本和 SHA-256。

## 数据与日志

Codey 产品数据默认放在 Electron userData：

```text
%APPDATA%\Temporal Workspace OpenCode
```

其中包括：

- SQLite 产品数据库
- 模型凭据
- OpenCode runtime data / config / cache

诊断日志默认写到：

```text
D:\codey-log\session-<product-session-id>.jsonl
```

日志包含：

- runtime startup
- backend identity
- Session create / resume
- prompt timing
- SSE events
- tool lifecycle
- cancellation
- evidence
- verification
- snapshot timing

## CI

Windows CI 当前覆盖：

- frozen dependency install
- typecheck
- build
- static OpenCode contract probe
- pinned backend 下载与 SHA 校验
- server smoke
- inherited-stdio regression
- Electron runtime preparation
- Windows unpacked packaging
- 最终 bundled OpenCode version / SHA 校验

## 仓库关系

```text
StupidArthur/codey-opencode
→ 当前 Codey OpenCode 主线

StupidArthur/opencode-fork
→ Codey 使用的 OpenCode 1.18.31 patched backend

StupidArthur/codey
→ 早期 DSH 版本和历史开发 lineage
```

当前仓库的 `main` 保留了原 `StupidArthur/codey` 中 OpenCode 分支的完整 Git 历史。

后续开发和 issue 管理都应以本仓库为准。
