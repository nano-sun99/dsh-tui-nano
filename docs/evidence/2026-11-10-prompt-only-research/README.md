# 2026-11-10-prompt-only-research 证据

本目录对应 [spec](../../specs/2026-11-10-prompt-only-research/README.md) 与
[ADR-20261110-prompt-only-research](../../decisions/2026-11-10-prompt-only-research.md)：
常驻段改写为影响面清单、撤回 `plan-mode` 的五阶段覆盖。

## 机械验收（A1 / A2 / A3 / A5）

前提：`npm ci` 后 `npm run build`（脚本从 `dist/` 导入）。脚本用临时 HOME / DSH_HOME / 数据根，
不调用模型，不读写真实用户 profile 与会话。

```bash
npm ci
npm run build
node docs/evidence/2026-11-10-prompt-only-research/prompt-evidence.mjs
```

2026-11-10 在 #179 实施工作区（基线 `913d151`，Node 24.18.0、官方 dsh 0.2.2-rc.1）上的输出原文
（已知 boot 警告 `session-projection-cache ... pending` 走 stderr，不计入标准输出）：

```text
A1 root nano sections in order: research -> question -> delegation
A1 research text matches spec §5.1: true; contains "/plan": false
A2 real child (parentAgent=root) has research discipline: false
A3 inactive plan:policy is empty: true
A3 active plan:policy has official "Explore first.": true; has "Phase 1 — Explore": false
A3 mode switch keeps registered tool view unchanged: true
A3 deactivated plan:policy is empty: true
prompt-only research evidence passed
```

### 旧脚本同批改完复跑（A5）

`docs/evidence/2026-11-07-nano-research-discipline/prompt-evidence.mjs` 已改为读现行 spec §5.1、
plan 只验「命中官方 `Explore first.`、不含 `Phase 1 — Explore`」。同环境复跑输出：

```text
A1 root nano sections: research -> question -> delegation; approved text matches
A2 real child (parentAgent=root) has research discipline: false
A3 inactive plan:policy is empty: true
A3 active plan: official guidance; no Phase marker; registered tool view unchanged
A3 deactivated plan:policy is empty: true
implementation prompt evidence passed
```

旧目录的 spec 期探针 `probe-plan-section.mjs` 不变（它自带 marker 覆盖，验证的是「补丁能整段替换」这个能力），
复跑输出与旧 README 记录一致。

核验口径：

- **A1**：脚本从获批 spec §5.1 唯一的 `text` 代码块读出预期，逐字比对真实组装出来的
  `nano:research-discipline` 正文，并断言正文不含 `/plan`；三段组装顺序为
  research → question → delegation。组装视图只暴露 `name` / `text` / `interpolate`，
  **order 数值 `10140 / 10145 / 10150` 由 `tests/unit/conversation-delivery.test.ts` 的逐字断言钉住**，
  脚本只证明真实顺序与正文。
- **A2**：用 `core.ctx.agents.create({ parentAgent: controller.agent, ... })` 创建真实子 agent，
  检查其真实组装结果不含该段；不是另建一个没有 `setup` 的根 agent 冒充子 agent。
- **A3**：`plan:policy` 未激活为空 → 激活后是官方引导（命中 `Explore first.`、不含 `Phase 1 — Explore`）
  → 关闭后再次为空；并比较模式切换前后的已注册工具视图。这里的 `assemble()` 没有传入本步 `toolSet`，
  因此只证明注册视图不变，不证明实际请求的工具目录不变。官方 plan 正文不归我们逐字钉，脚本不做文本等值比对。

## 回归（A4）

2026-11-10 的实际命令与结果：

| 命令 | 结果 |
| --- | --- |
| `npm test` | 43 个测试文件 / 547 项通过（unit），12 个 / 56 项通过（feature） |
| `npm run typecheck` | 退出 0 |
| `npm run lint` | 退出 0；5 条既有警告，全部在本次未改动的文件里 |
| `node --test --test-concurrency=1 tests/e2e/capability.test.mjs tests/e2e/schedule-surface.test.mjs` | 2 项真实 boot / 调度隔离回归通过（`featureBootPatches` 被本次改动，单独补跑） |

环境与已知输出：

- 首轮 `npm test` 在并行跑 `typecheck` / `lint` 时 `tests/unit/perf.test.ts` 的
  「resizes within p95 80ms」失败（109.95ms）；单独复跑该文件与随后串行全量 `npm test` 均通过。
  这是负载相关的既有性能阈值抖动，本次没有改渲染器或 transcript。
- 5 条 lint 警告与 `docs/evidence/2026-11-07-nano-research-discipline/README.md` 记录的基线一致：
  `src/controls/completions.ts`、`src/controls/model-panel.ts`、`tests/e2e/cross-surface.test.mjs`、
  `tests/unit/model-panel.test.ts`（两处），均不在本次改动面内，未顺手修。
- 该仓没有 `scripts/check-docs.sh` / `scripts/check-doc-links.sh`，项目指令也未声明通用文档检查入口；
  键位文档专项检查不冒充通用文档检查。

## 真实 TUI 行为证据（B1 / B2）

**结论：B1 / B2 本次「未执行」**，没有可判读的 transcript。按 spec §7.2 的规矩，没有真会话就标未执行，不拿假 transcript 代替。

### 跑过什么

2026-11-10 在本机实跑，环境：Node 24.18.0、官方 dsh 0.2.2-rc.1、本 PR 构建的 `dist/bin.js`；
真实模型 `deepseek-official/deepseek-flash`（effort `max`，取自本机真实 profile 的默认值）；
驱动方式是真 nano TUI + 自动化 PTY（`expect`，控制终端 48×120），临时 `NANO_DATA_ROOT` / `DSH_HOME`
与凭据临时副本，不写真实 profile 与会话。

| 次数 | 场景 | 结果 |
| --- | --- | --- |
| 1 | B1 输入，cwd = 本 PR 工作区 | 跑到 step 12 / 22 个工具调用后被固定等待的 Ctrl+C 打断（`turn/end reason: aborted by user`），没有最终正文；且工作区带着本次未提交的实现改动，不构成 B1 证据 |
| 2 | B1 输入，cwd = `origin/main` 的临时 detached worktree，上限 900 秒 | 会话日志只有 `turn/start` + 1 个 `step/start`：**0 条 assistant 消息、0 个工具调用**；900 秒到点收尾（`turn/end`: `aborted by user`，+904s） |
| 3 | 对照组「只回一句 ok」 | 拿到 assistant 正文 `ok`，说明 TUI、凭据与模型通道本身可用 |
| 4 | 对照组：一句中等调研请求（读一个文件并回列表） | 184 秒内 0 条 assistant 消息、0 个工具调用 |

第 2/4 次说明：需要读文件的研究类请求在本次运行期间没有返回任何流式内容（连推理增量都没有），
而同一环境下的短问答正常。**这是环境侧的失败，不是「软约束正常」的证据，也不能反过来说新提示无效。**
另外三次运行里都没观察到 `turn/end` 自行出现，所以判定回合结束用的是「事件流静默 N 秒 + 到点 Ctrl+C」，
不是官方回合结束事件；这条偏差一并记在这里。

### 手工复跑步骤（B1 / B2 的判定仍待真实会话）

1. `npm ci && npm run build`；在临时目录建立独立 `DSH_HOME`、`NANO_DATA_ROOT`，只把凭据复制进临时 `DSH_HOME`
   （`~/.dsh/.credentials.yaml` 与 `~/.dsh-tui-nano/profile`），不复制真实会话；结束后删除临时副本，别把凭据提交进仓库。
2. 用真实终端运行 `<repo>/dist/bin.js`；`/model` 选与本次记录一致的模型与 effort。
3. **B1**：在一个干净的 `origin/main` 检出目录里开新 root，输入「给 nano 加一个跨 2–3 个文件的功能，先别改代码」。
   判据见 spec §7.2：给方案前出现五类面清单、每项带路径、没有「假设当发现」、不推荐 `/plan`。
4. **B2**：另开临时 detached worktree，把 `README.en.md` 第 3 行的 `terminal` 植入为 `termianl`；在该目录运行同一构建，
   输入「把这个 typo 修掉：README.en.md 第 3 行的 termianl 应为 terminal。」。判据：不摆五类面仪式，仍先读该文件再改，
   修完 `git status` 为空。

DB 面：本仓没有数据库 fixture，**B1/B2 本来就不覆盖 Data 行**；只由 A1 证明文本在。需要 DB 证据时在带 storage 的仓库另测，
不在本 spec 承诺。
