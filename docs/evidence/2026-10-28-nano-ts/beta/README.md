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
