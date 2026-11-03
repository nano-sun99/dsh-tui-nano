# ADR-20261103-question-trigger-discipline：模型先按最佳判断行动，只在真岔路开问卷卡

- 状态：生效中
- 日期：2026-11-03
- 决策人：用户
- 适用范围：模型提问行为与 `ask_user_question` 的触发纪律；不适用于官方工具 schema、问卷卡形态、审批卡
- 取代：无
- 被取代：无
- 决策来源：用户 2026-11-03 原话「主动触发选项卡不好，参考claude code什么时候会触发」与「抄一下claude code」；Claude Code 2.1.88 `constants/prompts.ts:892-898`（Bias toward action）、`utils/messages.ts:3290`（AskUserQuestion 只用于澄清需求 / 选方案，不用于计划批准）；官方 [Handle approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input)
- 相关：[spec](../../specs/2026-11-03-nano-harness-feel/README.md)

## 决定

1. nano 给根 agent 注册一条 `nano:question-discipline` 系统提示段，明确：**按最佳判断先做**；读文件、搜索、跑测试、查类型、跑 lint 都不需要问；两个合理方案之间不确定时选一个先做，之后可以纠正。
2. `ask_user_question` **只在答案会改变什么被做出来、且无法从代码 / 配置 / 默认值判断时**使用。
3. 不用于：确认（「要不要继续」）、计划批准、琐碎的实现细节（命名、格式等 linter 能管的）；已经问过且用户未回应时不重复问。
4. 不新增每回合限一次的硬闸、不自动代答、不把卡片改成内联卡、不修改官方 `ask_user_question` 的工具描述。
5. 例外：如果不理解用户为什么拒绝了一次工具调用，可以用 `ask_user_question` 问清楚。

## 依据

- Claude Code 的主提示有「Bias toward action」：`Act on your best judgment rather than asking for confirmation.`、`If you're unsure between two reasonable approaches, pick one and go. You can always course-correct.`（`constants/prompts.ts:892-898`）。
- Claude Code 在 plan mode 明确 `AskUserQuestion` 只用于「clarify requirements or choose between approaches」，计划批准必须走计划工具（`utils/messages.ts:3290`）。
- nano 目前只注册了 `nano:delegation-responsiveness`（`src/conversation/controller.ts:135-140`），没有提问纪律；官方 legacy `dsh-tool-ask-user` 的描述鼓励在 `confirmation, a choice, or missing information` 时提问（`node_modules/@deepseek-ai/dsh-tool-ask-user/lib/index.js:217`），缺少反向约束。
- 用户 2026-11-03 明确选择「抄一下 Claude Code」，而不是加硬闸或改内联卡。

## 否决了什么

- **每回合限一次的手机卡式硬闸**：会挡住合理的连续追问，且与 Claude Code 不一致。
- **把问卷卡改成不抢输入区的内联卡**：改动最大，仍不解决「问得太频繁」。
- **自动代答推荐项**：会替用户做决定，越权。
- **修改官方工具描述 / fork `dsh-tool-ask-user`**：引入维护分叉，且官方描述本身不坏。
- **给模型加「禁止提问」的绝对规则**：真正的岔路仍然需要用户拍板。

## 接受的代价

- 这是软约束，模型仍可能在不必要的时候提问；本决定不承诺行为 100% 改变。
- 提示段是英文，与 UI 语言无关；用户看到的中文界面不受影响。
- 不新增可观测的「提问频率」指标；效果靠真实会话观察，不在本单硬验收。

## 允许重开的条件

- 真实会话证据表明模型仍然频繁提出无效问题，且提示段无法收敛；届时再评估硬闸或 UI 降级。
- 官方 `dsh-tool-ask-user` 的工具描述或 schema 改变，使提示段的语义不再成立。
- 用户明确要求恢复「模型主动提问」的默认行为。

## 关联

- [本次 spec](../../specs/2026-11-03-nano-harness-feel/README.md)
- Claude Code 2.1.88：`constants/prompts.ts:892-898`、`utils/messages.ts:3290`
- [ADR-20261101-question-card-cancel](2026-11-01-question-card-cancel.md)：卡片上的 Esc 语义不变
