# S02 β 证据 · 输入、会话与功能面

- 日期：2026-10-29（起步）
- 环境：macOS arm64（Darwin 27.0.0）、Node v24.18.0、官方 harness `0.2.1-rc.2`
- 数据根：`/tmp/nano-spike-0b`（每次运行前清空）
- 复现前提：`npm ci && npm run build`（探针导入 `dist/`，`dist/` 不进仓）

## 0. spike-0b（合入前提）

命令：

```text
DSH_HOME=/tmp/nano-spike-0b/home NANO_DATA_ROOT=/tmp/nano-spike-0b/data \
  node docs/evidence/2026-10-28-nano-ts/beta/tools/spike-0b.mjs
```

实测结果（2026-10-29）：

```json
{
  "bootMs": 439,
  "terminalController": true,
  "terminalList": 0,
  "pty": { "id": "spike0b-term-1", "shell": "/bin/zsh", "state": "running" },
  "probeDomain": {
    "file": "/tmp/nano-spike-0b/data/runtime-data/spike0b-root/schedule-storage/nano_probe.json",
    "exists": true
  },
  "sessionController": true,
  "schedule": {
    "catalogLength": 0,
    "created": { "kind": "after" },
    "file": "/tmp/nano-spike-0b/data/runtime-data/spike0b-root/schedule-storage/schedule.json",
    "exists": true
  }
}
```

逐项结论：

| 项 | 结果 | 依据 |
|---|---|---|
| `terminal-controller` 行 | 通过 | boot 后 `ctx.get('terminalController')` 为真；`create()` 真起 `/bin/zsh`（state=running），`close()` 成功 |
| 命名后端 + service key | 通过 | `JsonStorageBackend` 以 `nano-schedule-json` 名注册，`storageBackendServiceKey(name)` 供服务键 |
| `storage-domain` 路由 | 通过 | 探针域 `nano_probe` 写到 `<root>/schedule-storage/nano_probe.json`，不是默认 json 根 |
| 最小 `sessionController` | 通过 | 只实现 `resolveAgent(sessionId)`（`{agent}`/`{error}`），官方 schedule 挂起成功 |
| 挂载顺序 | 通过 | boot → 注册后端 + 服务键 → `storageDomain` 激活 → 探针通过 → boot 后挂 `dsh-schedule` → `create()` 落 `schedule.json` |

关键发现（写进实现约束）：

1. **路由会让 `storageDomain` 整体延后激活**。`storage-domain` 的 `routes` 指向命名后端时，官方 facility 会等该后端的 service key；boot 期间 `session-projection-cache` 报 `pending (waiting for service: storageDomain)`。所以后端注册 + 服务键必须在 boot 后**最靠前**完成，任一失败即启动失败——与 spec §3.5 的单一结论一致，且影响面比 schedule 本身更大。
2. 探针域路径就是 `<数据根>/runtime-data/<root>/schedule-storage/nano_probe.json`；schedule 任务表同目录 `schedule.json`，per-root 隔离由 root 本身提供。
3. 终端 `create` 需要 `AbortSignal` 第三参；`setup` 回调必须返回 `undefined`（否则 agent-loop 会把它当 `{commit}` 用）。

## 1. 终端附着（in-process Remote）

`terminalController.attach()` 要求 `ctx.invocation`，直接调方法会抛
「Terminal attachment requires a Remote invocation」。可行路径是自建 owner Peer，
经 `ctx.typertGateway.stream()` 打开：

```text
new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' })
ctx.get('typertGateway').stream({
  namespace: 'terminal', method: 'attach',
  args: { agentId: <根会话 id>, id: <WebTerminalId> },
  uplink, peer, signal,
})
```

证据（`beta/tools/terminal-attach-probe.mjs`）：

```json
{
  "created": { "id": "probe-term-1", "shell": "/bin/zsh", "state": "running" },
  "sawSnapshot": true,
  "snapshotHead": "",
  "frames": ["snapshot", "output"],
  "raw": ["{\"type\":\"snapshot\",\"sequence\":0,\"screen\":\"\",\"info\":{…}}",
          "{\"type\":\"output\",\"sequence\":1,\"data\":\"echo nano-terminal-probe\\r\\n\"}"],
  "echo": true,
  "closed": true
}
```

要点：

1. 附着后第一帧是 `snapshot`（`screen` 可能是空串），随后是 `output` 原始 VT 字节 —— 直接喂
   `CellGrid.feed()`。
2. 上行是 `TerminalInput`（`write` / `resize`，各自带连续 `sequence`）；用推送队列喂
   `uplink` 异步迭代器。
3. 真机驱动（`script` PTY，Ctrl+T 开面板 → 输入 `echo nano-pane-ok` → Ctrl+T 关 → Ctrl+C 退出）：
   屏幕出现 `nano-pane-ok`，退出码 0，关停七项全 `stopped`，中断不计为失败。

## 2. 自定细节

- 终端面板开关键位：`Ctrl+T`（owner `s02`，经 D01 keymap 注册）。
- 面板高度上限 20 行、宽度 = 终端宽 - 2；隐藏保留 PTY，`close()` 才释放。
- 诊断行（打开/关闭失败、流中断）写 stderr（即日志文件），不进 transcript。
- 功能面测试入口：根 `vitest.config.ts`（S01 拥有）只收 `tests/unit`，S02 的用例放 `tests/feature/` 并用自己的 `tests/feature/vitest.config.ts`：
  `npx vitest run --config tests/feature/vitest.config.ts`。
- 附件链：`@` 引用只在行首/空白后触发；图片按扩展名判定（png/jpg/jpeg/webp/gif），提交前
  `saveImages` → `admitPromptContent`，任何一张被拒整条消息失败并保留草稿；通用文件链待接。

## 3. 验收对照（spec §5）

状态口径：**覆盖** = 有真机或功能测试证据；**部分** = 主路径有证据、负向/边界未取；**未覆盖** = 尚未实现或未取证。

| §5 验收组 | 状态 | 证据 |
|---|---|---|
| 输入：多行/IME、`@` 语法、三类补全、补全打开 Enter 只接受、未知 `/name`、32 KiB 限 | 部分 | 补全真机 `@src` 出候选；未知 `/` 命令真机提示「未注入」；32 KiB 仍走 S01 既有路径（S02 附件链按引用字节计） |
| 附件：官方图片准入、超限/不支持、通用文件 >20MiB、回执复用拒绝 | 部分 | `tests/feature/attachments.test.ts`（5 例：引用识别、纯文本、图片顺序、准入失败、21 MiB 通用文件与新回执） |
| 会话：列表/恢复/not-found/损坏、冷改名走受控重启、四种失败路径 | 部分 | 列表真机可见；`requestRestart` + handoff 真机验证（切换后草稿恢复）；热改名真机通过；`tests/feature/handoff.test.ts`（轮转与坏版本）。冷改名四种失败路径尚未逐条取证 |
| 权限：走 `/permission <preset>`、失败保留原值并警告、`never` 后果、模型 changed-by-user | 部分 | `/permission read-only` 真机无报错（走官方命令路径）；失败回滚与警告未取证 |
| 模型/强度：`provider + model` 身份、只列官方 `efforts`、以官方回执为准 | 部分 | `InfoPanel.readModelIdentity` 单测（缺任一半即未知） |
| 技能/规矩：命令同名优先、`complete=false` 标注、发现失败保留目录、预览只读 | 部分 | 信息面板实现与 `complete` 标记；发现失败路径单测未覆盖 |
| 终端：创建/附着/输入/缩放/关闭、缺口/`inputFull`/背压、输出不进 transcript、工具表无 terminal | 部分 | `beta/tools/terminal-attach-probe.mjs`；真机 `Ctrl+T` 回显。缺口与背压未取证 |
| 任务：游标不推进、停止分类、裁剪/缺口 | 覆盖（逻辑） | `tests/feature/jobs.test.ts`（状态词与停止分类）；`readAt` 绝对偏移不改游标 |
| `!`：工作区外可写、输出不进 job 表、不构成授权、`!!` inject:false | 部分 | 真机 `!echo`、`!touch /tmp/...`；`tests/feature/bash-mode.test.ts`。inject 的 step boundary 时序未取证 |
| Monitor：quiet 不唤醒/不产生独立回合、随下次请求计费、初始偏移、settled 补齐、预算耗尽、切根停止 | 部分 | `tests/feature/monitor.test.ts`（初始偏移、预算、settled 补齐）；切根停止已实现未取证 |
| 调度：后端 + service key、routes/probe、探针后挂载、失败即启动失败、per-root 隔离、无暂停、非严格一次、CAS 冲突 | 部分 | §0（后端/服务键/路由/探针/挂载）与真机探针落盘；per-root 隔离、CAS 冲突未取证 |
| 子代理：one-shot/external/exact-parent-live/审批 never/fork seed/内容隔离/dock ADR | 部分 | dock 实现 + `tests/feature/subagents.test.ts`（状态词、外部排除由过滤实现；30 秒清理单测）；审批/续聊路径未取证 |
| 会话控制器：最小 `sessionController` 只暴露 `resolveAgent`、两种形状、能力快照、无重复注册 | 覆盖（逻辑） | §0；`Features.start` 能力快照断言 `sessionController.resolveAgent`；重复注册由 Cordis 拒绝 |
| 跨根：九个面逐面隔离、双窗口同根拒绝、双 root 并发 | 未覆盖 | 依赖 S01 的认领（已在 α 取证）；S02 九个面尚未逐面取证 |
| 键位：经 D01 注册表汇总并可被 S03 生成文档 | 覆盖 | 全部 S02 键位经 `registerKeybinding({owner:'s02'})`；`describeBindings()` 可读 |

已知未处理：冷改名的 rename 失败路径、Monitor 切根停止、跨根九面隔离取证；`requestRestart` 的 spec 修订在 PR #94。
