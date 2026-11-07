# 2026-11-07-nano-research-discipline 证据

## spec 期探针（§8.1）

验证 profile 补丁能否按 id 整段替换官方 `plan-mode.section`，以及 plan 未激活时是否为空。

前提：fresh worktree 先 `npm install`；再 `npm run build`（探针从 `dist/` 导入）。

命令：

```bash
npm install
npm run build
node docs/evidence/2026-11-07-nano-research-discipline/probe-plan-section.mjs
```

2026-11-07 在本机 `204dfeb` + `@deepseek-ai/dsh` 0.2.2-rc.1 上输出：

```text
inactive has marker: false
active has marker: true
active has official "Explore first.": false
spec probe passed
```

说明：

- `inactive`：plan 未激活时，`plan:policy` 不渲染 marker。
- `active`：`core.ctx.planMode.set(controller.agent, true)` 后，marker 出现，官方 `Explore first.` 不再出现——整段替换成立。
- boot 时可能打印 `session-projection-cache ... pending` 警告；这是官方核心的已知启动警告，与本探针断言无关。

## 实施期证据（§9.2，待实施）

- `prompt-evidence.mjs`：A1/A2/A3 的组装证据。
- `session-1.md` / `session-2.md` / `session-3.md`：B1–B3 的真实会话 transcript。
