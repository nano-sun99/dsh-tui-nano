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
