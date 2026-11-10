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

## 实施期组装证据（spec §8.2；A1/A2/A3/A5）

> **2026-11-10 更新**：0.2.5 的 plan 五阶段覆盖已被 [ADR-20261110-prompt-only-research](../../decisions/2026-11-10-prompt-only-research.md) 撤回，plan 段回到官方引导；常驻段改为影响面清单（现行文本见 [新 spec §5.1](../../specs/2026-11-10-prompt-only-research/README.md)）。本目录的 B1–B3 transcript 只覆盖旧文案，**保留为历史**，不再代表当前行为；当前证据在 [2026-11-10-prompt-only-research](../2026-11-10-prompt-only-research/README.md)。下面的输出块与口径已按撤回后的真实行为更新。

2026-11-07，基线 `3d29687` + #174 实施工作区；Node 24.18.0、官方 dsh 0.2.2-rc.1。先 `npm ci`、`npm run build`；下面两个脚本都是真 boot + 真 `ConversationController.start()`，使用临时 HOME / DSH_HOME / 数据根，不调用模型，不修改真实用户配置。

```bash
node docs/evidence/2026-11-07-nano-research-discipline/probe-plan-section.mjs
node docs/evidence/2026-11-07-nano-research-discipline/prompt-evidence.mjs
```

spec 期探针复跑输出与上节一致。实施期脚本输出原文（已知 boot 警告不计入标准输出；2026-11-10 撤回覆盖后复跑）：

```text
A1 root nano sections: research -> question -> delegation; approved text matches
A2 real child (parentAgent=root) has research discipline: false
A3 inactive plan:policy is empty: true
A3 active plan: official guidance; no Phase marker; registered tool view unchanged
A3 deactivated plan:policy is empty: true
implementation prompt evidence passed
```

核验口径：

- A1：单测逐字断言注册正文与 order `10140 / 10145 / 10150`；脚本再检查真实组装顺序，并从现行 spec §5.1 的 `text` 代码块读取独立预期，逐字核对实际常驻段。
- A2：用 `core.ctx.agents.create({ parentAgent: controller.agent, ... })` 创建真实子 agent，检查其真实组装结果；不是另建无 setup 的根 agent 冒充子 agent。
- A3：检查 `plan:policy` 未激活为空、激活后为官方引导（命中 `Explore first.`、不含我们的 `Phase 1 — Explore`）、关闭后恢复为空，并比较模式切换前后的已注册工具视图。这里的 `assemble()` 没有传入本步 `toolSet`，因此不证明实际请求工具目录不变。官方 plan 正文不归我们逐字钉：撤回覆盖后脚本不再比对覆盖文本，也不再逐条核对旧覆盖里的八项约束。
- A5：两个脚本均已在实施工作区复跑；脚本失败会以非零退出，不用 stdout 文字冒充成功。

## 回归（A4）

2026-11-07 的实际命令与结果：

| 命令 | 结果 |
| --- | --- |
| `npm test` | 55 个测试文件、600 项通过（544 unit + 56 feature） |
| `npm run typecheck` | 退出 0 |
| `npm run lint` | 退出 0；5 条既有警告，未自动修复范围外代码 |
| `node --test --test-concurrency=1 tests/e2e/capability.test.mjs tests/e2e/schedule-surface.test.mjs` | 2 项真实 boot / 调度隔离回归通过 |
| `node scripts/keymap-docs.mjs --check` | 两个 README 均为最新 |

环境与已知输出：

- lint 警告所在文件未被本次改动：`src/controls/completions.ts`、`src/controls/model-panel.ts`、`tests/e2e/cross-surface.test.mjs`、`tests/unit/model-panel.test.ts`（后者两处）。
- 全量单测打印 `nano render error: RuntimeError: memory access out of bounds`，测试仍为 600/600、退出 0。另在未修改的 `main@3d29687` 实跑 `npm test`，同样打印这条诊断且 544 unit + 56 feature 全过；确认是基线已有输出，本次未改 renderer，也不宣称已修复。
- `npm ci` 报告现有依赖树 216 项安全公告（13 moderate / 201 high / 2 critical）；`package.json` 与 lockfile 均未改动，本单没有执行范围外的 `npm audit fix`。
- 该仓没有 `scripts/check-docs.sh` / `scripts/check-doc-links.sh`，项目指令也未声明其他通用文档检查入口；键位文档专项检查不冒充通用文档检查。

## 真实 TUI 行为证据（B1–B3）

模型统一为真实 `deepseek-official/deepseek-flash`，reasoning effort `max`；运行构建后的 nano TUI，自动化 PTY 提供实际控制终端，独立数据根与凭据临时副本。不是 fake agent、headless 改写提示或人工补写回复。没有开启额外的硬只读权限来掩盖模型写入行为。

| 场景 | 判定与证据 |
| --- | --- |
| B1 非平凡需求 | 通过；[session-1.md](session-1.md) 记录五项清单、`/plan` 建议及零文件改动 |
| B2 小改 | 通过；[session-2.md](session-2.md) 首行固定 `README.en.md:3` 的 typo，先读后改，没有五项清单仪式 |
| B3 plan | 通过；[session-3.md](session-3.md) 保留真实调研调用与完整计划，最终 step 只有 `exit_plan_mode`，无文件改动 |

B3 首轮在测试驱动的 300 秒时限内仍在只读调研，因此被驱动中断；保留同一个 `research-b3` 会话恢复，用户输入「继续完成刚才的计划，不要实施。」后提交真实审核卡。首轮中断和恢复均保留在 transcript，不把超时藏成首轮通过；测试驱动未代用户批准计划。spec 未设置完成耗时上限，这里不作速度或长期稳定性的统计承诺。

记录保留用户输入、assistant 可见原文、全部工具调用参数、真实结果状态和内容散列；不收录系统提示、注入上下文或模型思考。B2 额外保留三个工具返回的全文。工具读取的源码不重复整段抄入其他 transcript，本机路径以占位符替换。

### 手工复跑 B1–B3

1. `npm ci && npm run build`；在临时目录建立独立 `DSH_HOME` 与 `NANO_DATA_ROOT`，只把自己的凭据复制进临时 `DSH_HOME`，不复制真实会话。使用真实终端运行 `<repo>/dist/bin.js`；在 `/model` 选择与本次记录一致的模型和 effort。不要把凭据副本提交进仓库，结束后删除临时副本。
2. B1 在本仓目录启动新 root，输入「给 nano 加一个跨 2–3 个文件的功能，先别改代码」。对照 transcript 判定清单、建议与文件散列，不额外提示模型“应该输出什么”。
3. B2 另开临时 detached worktree：`git worktree add --detach <typo-worktree> origin/main`。把 `README.en.md:3` 的 `terminal` 植入为 `termianl`；在该目录运行本 PR 构建出的 nano，输入「把这个 typo 修掉：README.en.md 第 3 行的 termianl 应为 terminal。」。核对先读后改，修复后 git status 应为空；随后正常移除临时 worktree。
4. B3 新 root 先输入 `/plan`，再输入「给 nano 的会话列表增加按会话标题关键词筛选的功能，跨列表状态与界面等多个文件。请完成计划，先不要实施。」。等待真实 Plan review 卡；不要批准，核对末次模型 step 仅一个 `exit_plan_mode` 且文件未变，再退出。若驱动中断，复用同一个数据根和 root 恢复，不重复输入会切换状态的 `/plan`。

两段提示仍是软约束，plan 模式不是权限或沙箱安全边界；本次三场证据只证明这些真实场景，不保证所有模型或所有后续回合都遵守。

## 实施重审 R1 修订

用户选择重审后，规格符合性与对抗两个分身各给一项发现（1 中、1 低，无阻断 / 高），原文见 PR #175 评论。用户随后选择「全改」并单独允许纠正已合并规格的失败态事实：

- 旧 spec 的“section 缺失 / 为空会使整个 boot 失败”改为“plan 插件激活失败并告警，但非必需项失败不必阻断 boot”；旧审核记录对应结论标注被本次更正取代。没有新增运行时硬闸。
- 组装证据输出改为 `registered tool view unchanged`，明确没有传入 step `toolSet`，不再把注册工具视图一致误说成实际请求目录一致。

两段定稿提示、生产代码、A/B 验收承诺均未改变；无需伪造或重写 B1–B3 的真实模型输出。
