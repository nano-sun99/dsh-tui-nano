# [2026-11-10-prompt-only-research] 调研只做常驻提示：撤回 plan 覆盖，升级影响面清单

- 组标识：`2026-11-10-prompt-only-research`
- 角色：单份 spec
- 状态：实施完成（PR #180）
- Issue：[#179](https://github.com/nano-sun99/dsh-tui-nano/issues/179)
- 结构：不拆——1 份 spec + 1 张执行 issue
- 机制范围：**2 处提示层改动**——① 改写根 agent 常驻段 `nano:research-discipline`；② 删除 `plan-mode` 的 `section` 覆盖，plan 回到官方引导。无运行时机制、无新依赖、不改工具目录
- 上游：用户 2026-11-10 原话「那大家都没有我也不折腾了，那我们就和 claude code一样只做提示词工程吧，然后撤回plan的我们继续做」；Claude Code 2.1.88、Codex `main`、ZCode `v3.17.2` 调研；[ADR-20261107-research-discipline](../../decisions/2026-11-07-research-discipline.md)（本次被取代）
- 替代关系：取代 [2026-11-07-nano-research-discipline](../2026-11-07-nano-research-discipline/README.md) 的 ②（plan 五阶段覆盖）；① 常驻段沿用位置与 order，文案重写
- ADR：新增 [ADR-20261110-prompt-only-research](../../decisions/2026-11-10-prompt-only-research.md)，取代 ADR-20261107
- 下游：[执行 issue #179](https://github.com/nano-sun99/dsh-tui-nano/issues/179)；[实施 PR #180](https://github.com/nano-sun99/dsh-tui-nano/pull/180)

## 1. 目标

把「先读完再下结论」写成一条**常驻、与模式无关**的纪律，位置从「进 plan 才生效」挪回「每轮都在」：

1. 非平凡需求先给**影响面清单**，固定五类面：改动落点 / 上游调用 / 下游依赖 / 数据层 / 验证方式。
2. 清单每项都带**读过的证据**（路径，必要时符号或行）；没读的必须写明「未读 + 为什么它不影响结论」。
3. 禁止把假设当发现：「没搜到」不等于「不存在」。
4. 常驻段不再推荐 `/plan`；plan 回到官方引导，恢复官方 `Explore first.` 等全部约束。

不承诺：模型 100% 遵守（提示词是软约束）；不保证清单没有漏项（没有运行时校验）；不覆盖 DB 行为证据（本仓没有数据库 fixture，见 §7.2）。

## 2. 当前事实与根因

调查基线：`origin/main` @ `affbc9c`；官方 `@deepseek-ai/dsh` 0.2.2-rc.1。

| 事实 | 证据 |
|---|---|
| 0.2.5 用一段自养文本整段替换官方 plan 引导（五阶段） | `src/sessions/boot-patches.ts:31-43`（常量）、`:64-67`（补丁项） |
| 常驻纪律已有「五项清单 + 路径 + 未读声明 + 不把假设当发现」；缺的是数据层、逐项绑定「实际读过」、以及有备选时的取舍 | `src/conversation/controller.ts:44-51`（`:47` 路径、`:49` 未读与假设） |
| 常驻纪律第 5 条（6 条中）教模型「非平凡就建议 `/plan`」 | `controller.ts:50` |
| 单测逐字钉住旧文本；证据脚本断言 plan 段含 `Phase 1 — Explore` | `tests/unit/conversation-delivery.test.ts:259-269`；`docs/evidence/2026-11-07-nano-research-discipline/prompt-evidence.mjs:89` |
| 0.2.5 的 B1–B3 证据只覆盖旧文案，且 B3 依赖用户主动进 `/plan` | `docs/evidence/2026-11-07-nano-research-discipline/README.md` |
| 主流 agent 都没有「影响面必读」机制：CC 靠 plan + Explore 子代理；Codex 的 plan 模板是三段对话式；ZCode 同样是 `EnterPlanMode` / `ExitPlanMode` + hooks | CC `utils/messages.ts:3235-3292`；Codex `codex-rs/collaboration-mode-templates/templates/plan.md`；ZCode `apps/zcode-cli/docs/usage/04-tools.md` |
| dsh 有可用的工具级拦截点（`ctx.tools.guard`），旧 ADR「没有可靠拦截点」的结论不成立 | API：`dsh-tools/lib/types/index.d.ts:136`；行为：2026-11-10 本地探针（未入库，不可在仓库复核）：守卫拦 `write` 返回自定义理由、`read` 放行 |

根因两条：

- 现有文案没有要求**数据层**，没有把每项绑定到「实际读过」，也没有要求在有备选时说明取舍；模型可以用「看了下」糊过去。
- 调研被绑进 plan 模式，而用户从不使用 `/plan`：收益≈0，维护成本>0（每次升 dsh 要人工对一次覆盖文本）。

## 3. 范围与边界

### 3.1 本次做

**① `src/conversation/controller.ts`**：替换 `RESEARCH_DISCIPLINE` 正文（§5.1），位置、段名、order 不变。

**② `src/sessions/boot-patches.ts`**：删除 `PLAN_GUIDANCE` 常量、`plan-mode` 补丁项与模块注释里对应的那一行；plan 段回到官方渲染。

**③ 测试与证据**：

- `tests/unit/conversation-delivery.test.ts`：三段顺序不变，逐字断言改新文本。
- `docs/evidence/2026-11-07-nano-research-discipline/prompt-evidence.mjs`（旧脚本，必须一起改，否则实施后必红）：
  - `:64` 的 `approved[0]` 改为从**本 spec §5.1** 的 `text` 块读取常驻正文，不再读旧 spec。
  - `:89`–`:91` 改为：命中官方 `Explore first.`、不命中 `Phase 1 — Explore`；**删除** `assert.equal(policy, approved[1])`（官方文本不归我们逐字钉）。
  - 同段 `constraints` 8 条是给旧覆盖写的，其中 `Call exit_plan_mode…` 等大小写/措辞只对旧文成立；**整块删除**，只保留 `Explore first.` 与「不含 Phase 标记」两条。
  - 日志文案同步（`five phases` → `official guidance`）；该 evidence README 记一句「0.2.5 的覆盖已被 2026-11-10 决定撤回，B1–B3 transcript 保留为历史」。
- 新增 `docs/evidence/2026-11-10-prompt-only-research/prompt-evidence.mjs`：真 boot + 真 `ConversationController.start()`，断言 A1/A2/A3。
- 新增 `docs/evidence/2026-11-10-prompt-only-research/README.md`：复跑命令与预期输出原文块（A5 的比对对象）。

**④ 文档**：新增本 spec、新 ADR；旧 ADR 只改状态与「被取代」链接，正文不动。旧 spec 正文冻结不回写，取代关系只在新 spec 与新 ADR 记录。

### 3.2 本次不做

- 不加 `ctx.tools.guard`（读后写守卫）、不加 `impact` 工具、不接 codemap / LSP / MCP / 数据库连接。
- 不删官方 `dsh-plan-mode`：`/plan`、`exit_plan_mode`、plan-review 卡片、activity 的 `plan-review` 状态全部保留。
- 不改 `exit_plan_mode` 语义、不改权限与沙箱、不动工具目录。
- 不新增 `EnterPlanMode` 工具（ADR-20261107 的批次 2 一并关闭）。
- 不为提示层加可观测指标。

## 4. 主路

| 步 | 触发 → 响应 | 失败 / 空态 | 落点 · 依据 · 证据 |
|---|---|---|---|
| 1 常驻段 | 根 agent `start()` → 注册 `nano:research-discipline`(10140)，正文为 §5.1 | 注册抛错 → `start()` 失败，不静默吞；agent 销毁 → disposer 解绑 | `controller.ts` `setup()`；证据 A1 |
| 2 撤覆盖 | 每次 boot → `featureBootPatches()` 不再返回 `plan-mode` 行；官方行按原配置渲染 | 补丁层缺省即恢复官方，无额外失败态；plan 未激活时 `plan:policy` 仍为空 | `src/sessions/boot-patches.ts`；证据 A3 |
| 3 行为 | 非平凡需求 → 模型先给五类面清单，再给方案；本仓无 storage 时 Data 行写不适用 | 模型跳过清单（软约束）→ 记入 B1/B2，修订提示，不新增机制 | 提示层；证据 B1/B2 |
| 4 回归 | 改完跑 `npm test` / `typecheck` / `lint` | 任一失败 → 不合并 | 仓库现有脚本；证据 A4 |

## 5. 定稿文本

### 5.1 常驻段（`RESEARCH_DISCIPLINE`，英文，逐字）

```text
# Research before proposing
When the user asks for a change, a feature, or a plan, map the impact surface in the repository before proposing anything. Conclusions come after reading, not before.
- Locate the change site and state its current behavior from the code, not from memory.
- Upstream: find what calls it — routes, commands, jobs, event handlers, other services.
- Downstream: find what it calls — services, tools, external APIs, queued work.
- Data: when storage is involved, read the schema, migrations, and models; name the tables, columns, indexes, and the read/write path.
- Verification: name the tests, typecheck, or commands that would prove the change works.
- Every item cites paths, and symbols or lines where they matter, that you actually read. Name anything you did not read as unread, with the reason it cannot change the conclusion.
- Never present an assumption as a finding; "I did not find it" is not "it does not exist".
- "Non-trivial" means a new feature, a behavior change, a multi-file change, an architectural choice, or unclear scope. For non-trivial work, write the map as five named lines — change site, upstream, downstream, data, verification — and answer every line before you propose. Mark a line not applicable only together with the reason it cannot apply. Name the trade-off you accepted when genuine alternatives exist, and do not start editing until the map is complete.
- Skip the full map only for a one-line or other small local fix, a pure fact lookup, or when the user says to start immediately; even then, read the files first.
```

字符数 1,579（旧模板展开后 1,171，+408 ≈ +102 tokens/请求；2026-11-10 按 B1 证据补「五类面逐行必答」后从 1,401 增至 1,579）。

### 5.2 plan 段

不提供文本：恢复官方 `dsh-plan-mode` 的 `section`。官方原文含 `Explore first.`、只读、`todo_write` 禁令、decision-complete 清单、只经 `exit_plan_mode` 交审。

## 6. 行为规则

1. 常驻段只注册在根 agent 作用域，子 agent 不继承（沿用 `setup` 语义）。
2. `order = 10140` 不变：先调研、再提问（10145）、再委派（10150）。
3. plan 段由官方持有：未激活为空，激活后为官方全文；nano 不再注入任何 plan 文本。
4. 两处都是提示层软约束；plan 模式不是安全边界（沙箱 / 审批不读 plan 状态；默认 `danger-full-access` + 审批 `never`，ADR-20261102）。
5. 例外三条不变：一行或局部小改、纯查事实、用户明说「直接干」；走例外也要先读要改的文件。
6. 写路径单一入口：常驻段只在 `setup()` 一处；plan 覆盖的删除只在 `featureBootPatches()` 一处；不新增第二份文本副本。

## 7. 验收

### 7.1 机械验收（合并前全绿）

- **A1** 根 agent 的 `nano:` 段按 order 依次为 `nano:research-discipline`(10140)、`nano:question-discipline`(10145)、`nano:delegation-responsiveness`(10150)，正文与 §5.1 逐字一致，且不含 `/plan`。
- **A2** 真实子 agent（`parentAgent` 创建）的 sections 不含 `nano:research-discipline`。
- **A3** plan 未激活：`plan:policy` 为空；激活后：命中官方 `Explore first.`、不命中 `Phase 1 — Explore`；关闭后再次为空。
- **A4** `npm test`、`npm run typecheck`、`npm run lint` 通过。
- **A5** `docs/evidence/2026-11-10-prompt-only-research/prompt-evidence.mjs` 可复跑，输出与该目录 `README.md` 记录的输出块一致；旧脚本改完后同样可复跑。

### 7.2 行为验收（真实会话，同单证据）

真实 TUI + 真实模型，transcript 存 `docs/evidence/2026-11-10-prompt-only-research/`；没有可用模型时标「未执行」，不得用假 transcript 代替。

| 场景 | 固定输入 | 通过判据 |
|---|---|---|
| B1 非平凡 | 「给 nano 加一个跨 2–3 个文件的功能，先别改代码」 | 给方案前出现五类面清单；每项带路径；没有「假设当发现」；不推荐 `/plan` |
| B2 小改 | 临时 worktree 固定一个 typo（文件 / 行写在 transcript 首行） | 不摆五类面仪式；仍先读该文件再改 |

DB 面：本仓没有数据库 fixture，**B1/B2 不覆盖 Data 行**；只由 A1 证明文本在。需要 DB 证据时在带 storage 的仓库另测，不在本 spec 承诺。

## 8. 风险与回退

- **纯提示，无强制**：模型仍可能跳过清单。这是用户 2026-11-10 明确接受的口径；不把一次失败解释成「软约束正常」，按 B1/B2 记录并改提示。
- **文本变长**：常驻段 1,171 → 1,401 字符（+230，约 +58 tokens/请求）。
- **失去的三条提醒**：撤覆盖后不再有「至少两个方案 / 复核关键文件 / 写验证命令」的分阶段提醒；新文案用「name the trade-off」与「Verification」两行承接，强度弱于原五阶段。
- **官方行为变化**：plan 文本回到上游，dsh 升级时自动跟随，不再需要人工对齐我们那段覆盖。
- **回退**：恢复 `PLAN_GUIDANCE` 与补丁项 + 旧文案，一次 revert 即可。

## 9. 备选与否决

- **工具守卫（写前必读）**：技术可行（`ctx.tools.guard` 实测可用），但只覆盖「动手前」，不覆盖「给结论」；用户 2026-11-10 决定不折腾，本次不做。
- **code map / LSP / 影响面工具**：市面上只有零件（codemap、Serena、RepoGraph、LocAgent），没有整机；接入与维护成本高于收益，本次不做。
- **保留五阶段覆盖**：用户从不使用 `/plan`，预期收益≈0、维护成本>0，撤回。
- **删除官方 plan 插件**：会连带拆掉 `exit_plan_mode`、plan-review 卡片与 activity 状态，收益为负，不做。

## 10. DoR 自查

| 条 | 结论 |
|---|---|
| 1 承重规则单一结论、无 TBD | 过：两处文本 / 删除范围写死 |
| 2 每步有触发 → 响应与失败 / 空态 | 过：§4 四行齐全 |
| 3 写路径单一入口；状态有承载与读侧 | 过：段在 `setup()` 一处；plan 态由官方持有，读侧为空 / 全文两种 |
| 4 验收可执行 | 过：A1–A5 为命令 / 断言；B1/B2 为固定输入 + transcript 判据 |
| 5 迁移 / 回填 / 回滚 / 兼容 | 不适用（纯提示层）；回退见 §8 |
| 6 外部合同影响 | 不适用：不对外暴露 API / 消息通道 |
| 7 ADR 取代链 | 过：新 ADR 取代 ADR-20261107，两端同 PR 更新 |

## 11. 自定细节

- 正文一律英文，与既有两段一致；界面语言不受影响。
- 清单写成五条具名行（改动落点 / 上游 / 下游 / 数据层 / 验证；表格或列表皆可），逐行必答；不适用也要写理由，不允许整行省略。证据与未读声明照旧。
- Data 行用 `when storage is involved` 限定，避免无数据库的仓库被迫编造数据层。
- 不提 `/plan`、不提子代理、不提工具名，避免把提示绑到具体实现。
- 不设“调研完成”的机械判据：没有运行时校验，写死判据只会制造假通过。

## 12. 审核修订记录

- **2026-11-10 轻审**（用户选档；1 个只读 agent，由实施方派出，不是用户发起的独立审核）：无阻断 / 高；1 中 2 低。
  - 中「B1/B2 未执行」：改用本仓 `tests/e2e/pty-start.py` 的无头真 PTY 跑通真实会话后关闭。
  - 低「新 spec 头部状态未回填」：同日回填状态 / Issue / 下游。
  - 低「删除 `plan-mode` 补丁没有自动化守卫」：**未处理**，留作开放项（`npm test` 目前拦不住把补丁加回去）。
- **2026-11-10 按 B1 证据改文案**（用户原话「现在就改文案」）：首场真实会话只给改动落点、漏了上游 / 下游 / 验证，
  按 §4 主路第 3 行把清单改成「五类具名面逐行必答、不适用也要写理由」，§5.1 正文 1,401 → 1,579 字符；
  同步 `controller.ts`、单测字面量、§5.1 字符数与 ADR 代价行。改后 A1–A5 复跑全绿，B1 同场景复跑通过
  （证据见 `docs/evidence/2026-11-10-prompt-only-research/`）。
