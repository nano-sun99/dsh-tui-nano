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

2026-11-10 在本机实跑，**建模真实模型会话**：Node 24.18.0、官方 dsh 0.2.2-rc.1、本 PR 构建的 `dist/bin.js`；
真实 `deepseek-official/deepseek-flash`（effort `max`，取自本机真实 profile 的默认值）。
驱动走**本仓自己的 `tests/e2e/pty-start.py`**：无头真 PTY（48×120），不开窗口、不抢焦点、不动剪贴板；
临时 `NANO_DATA_ROOT` / `DSH_HOME` 与凭据临时副本，不写真实 profile 与会话，结束后删除临时副本。
两个场景都在 `origin/main`（`913d151`）的临时 detached worktree 里跑，工作区不含本次实现的改动。

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| B1 非平凡（首版 prompt，1,401 字符） | **部分满足**：研究真做了、路径与行号都有，但五类面缺上游 / 下游 / 数据层 / 验证 | [session-b1-first-run.md](session-b1-first-run.md) |
| B1 非平凡（改后 prompt，1,579 字符） | **通过**：五条具名面逐项带路径与行号，另写未读 / 未跑项与取舍 | [session-b1.md](session-b1.md) |
| B2 小改 | **通过**：先 `read` 再 `edit`，没有五类面仪式，不推荐 `/plan`，修完 `git status` 为空 | [session-b2.md](session-b2.md) |

### B1 首场（改文案前）

9 个 step / 16 次工具调用：先看 git 状态与仓库结构，读 `AGENTS.md` 与 `package.json`，再定位
`src/input/keymap.ts`、`src/controls/feature-host.ts`、`src/app/nano-app.ts` 的分发路径，最后用
`ask_user_question` 问「要加哪个功能」。可见正文（seq 105）给了三处改动落点并带行号
（`src/app/nano-app.ts:352`、`src/controls/feature-host.ts` 的 `dispatchAction` 与 `:346` 的斜杠命令入口），
符合「改动落点 + 路径 + 实际读过」，但**没有**逐条写出上游 / 下游 / 数据层 / 验证方式，所以按 spec §7.2
判**不算通过**。回合停在问卷卡上，PTY 到点 Ctrl+C 收尾，日志里没有 `turn/end`。

按 spec §4 主路第 3 行「记入 B1/B2，修订提示」，用户 2026-11-10 选了「现在就改文案」：把清单改成
**五类面逐行必答、不适用也要写理由**，§5.1 从 1,401 / 1,579 字符。改后同场景复跑见下一节。

### B1 复跑（改文案后）

32 个 step / 52 次工具调用，输出里出现一段标题为「影响面（逐项读过）」的清单，五条具名面逐条带路径与行号：

| 面 | 实际给出的证据（摘） |
| --- | --- |
| 改动位置 | `src/input/keymap.ts:217-232`、`src/app/input-model.ts:102-128`、`src/app/nano-app.ts:338-352` / `:442-454` |
| 上游 | `src/runtime/terminal.ts:211,228` → `src/main.ts:142` → `handleInput:300` → `handleKey:338`；`features.handleKey` 先截走（`:343-347`） |
| 下游 | 只改 `InputModel.text`；提交走 `nano-app.ts:354-366` → `conversation.submit`，历史由 `controller.ts:587` 追加 |
| 数据 | `<dataRoot>/history.jsonl` 字段与读写路径（`history.ts:9-80`），不改 schema、不迁移 |
| 验证方式 | `tests/unit/composer-submit.test.ts:25-107`、`fixes.test.ts:256`、`input.test.ts:280`；`npm test` / `typecheck` / `lint` / `keymap:docs -- --check` |

另外两处也对上了规矩：**未读 / 未跑**单列（官方 dsh 包、旧 spec 正文、测试未跑及原因），**取舍**单列
（独立结果列表要改 scene，超出 3 个源文件）。全程不推荐 `/plan`，没有把假设当发现，`git status` 干净。
回合停在「下一步：你选择入口」，PTY 到点 Ctrl+C 收尾，日志里没有 `turn/end`（问卷在等输入）。

### B2 细节

5 个 step / 4 次工具调用，顺序是 `read README.en.md` → `grep termianl`（确认全仓范围）→ `edit` 改那一行 →
复读 `sed` + `grep` 核验。`turn/end` 为 `completed`；运行后 `git status` 空、第 3 行是
`**A minimal, restrained terminal interface for DeepSeek Harness.**`，没有动其他文件。

DB 面：本仓没有数据库 fixture，**B1/B2 本来就不覆盖 Data 行**；只由 A1 证明文本在。需要 DB 证据时在带 storage 的仓库另测，
不在本 spec 承诺。

### 复跑

```bash
npm ci && npm run build
mkdir -p <root>/data <root>/home/.dsh
cp -R ~/.dsh-tui-nano/profile <root>/data/profile
cp ~/.dsh/.credentials.yaml <root>/home/.dsh/.credentials.yaml
git worktree add --detach /tmp/nano-b1-tree origin/main
NANO_DATA_ROOT=<root>/data DSH_HOME=<root>/home/.dsh \
  python3 tests/e2e/pty-start.py --out <root>/screen.raw --rows 48 --cols 120 \
  --cwd /tmp/nano-b1-tree --wait 25 --send "<场景输入>" --send-wait 420 --exit-wait 15 \
  -- node "$PWD/dist/bin.js"
zstd -dc <root>/data/sessions/*/*/session.v4.jsonl.zstd > <root>/session.jsonl
```

B2 先把 `README.en.md` 第 3 行的 `terminal` 改成 `termianl`，跑完核对 `git -C /tmp/nano-b2-tree status` 应为空。
临时目录与凭据副本用完即删，不要提交进仓库。

> 过程记录：本轮早前用 `expect` 驱动时，研究类请求出现过两次「请求已受理但长时间无任何流式返回」（420 秒 / 900 秒都停在 1 个 step），
> 同一环境短问答正常；改用本仓 `pty-start.py` 后两个场景都正常跑完。那两次失败不作为「软约束正常」的证据，也不计入本节判定。
