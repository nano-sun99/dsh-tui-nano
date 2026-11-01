# 实施期重审修订记录

- 日期：2026-11-01。
- 审核基线：`ccac033`。来源：PR #127 评论 `issuecomment-6555081906`；A 为规格符合性，B 为对抗找 bug。审核为原主会话派出的两个 agent，不是第三方独立裁决。
- 用户本次授权：选择「修订（推荐）」；核实并修复行为缺陷、补测试与范围记录；遵循现行 ADR，冻结规格冲突单列，不擅改；合并仍须单独确认。
- 本次未重新派审核 agent，以下为实施方自查与实测处置，不冒充复审通过。

## 行为缺陷

| 发现 | 处置 | 验证 |
| --- | --- | --- |
| A1 / B1，高/中：模型面板隐藏卡片但接收答案 | 修复。问卷优先占输入位；高度、键盘、点击使用一致优先级。模型面板保持自身状态，问卷结束后恢复。补全/dock 暂让位，防止挤掉卡片；卡片点击不交给底层面板。 | feature 真实 Renderer 面板遮挡复现先红后绿；unit 真实 NanoApp 路由验证可见题目、点击推进、Esc 后恢复面板。 |
| B2，中：长描述 PageDown 被焦点拉回、翻页暗改答案目标 | 修复。显式翻页保留当前选项并在必要时固定其焦点行，正文独立滚动；↑↓/切题/编辑恢复自动跟随。不再寻找别的选项并移动焦点。 | 60×24、24 行描述，反复 PageDown 可见最后一行；原焦点始终为第 1 项，PageUp 可回滚，↓ 仅在显式按下时切到第 2 项。 |
| A10 / B3，低：矮终端固定头尾超过 cap | 修复。顶线、间隙、题签、标题、按钮、错误、页脚全部纳入同一 cap；空间不足先压缩装饰和标题。cap<4 时只显示增高窗口提示，不接收答案键，仅 Esc 取消，避免隐形作答。 | 6/8/10/12/16/18/24 行真实渲染；6–40 行提交页高度穷举；8 行 Enter/数字/Space/Alt+N 均不作答。 |
| B4，低：旧请求被替换后自己的 signal abort 不再结算 | 修复本次回归：旧 signal 仍拒绝它自己的 waiter，当前卡保持不动。未扩展为新的请求队列。 | 双请求+旧 AbortController 复现先 HANG 后 ASK_ABORTED；当前问题仍可正常提交。 |

## 规格、范围与细节

| 发现 | 处置 |
| --- | --- |
| A2：新增 question-card.ts 漏声明 | 在本文件、PR 范围对账、issue 改动面补齐。独立纯布局文件为获批滚动/题签机制的实现分拆；没有新增业务机制。不回写冻结 §5。 |
| A3：缺 decisionBody 槽位 | 已实现 `AppSnapshot.decisionBody`，由 NanoApp 挂载 QuestionCard；App 使用该槽位，保留直接快照渲染兼容。 |
| A4：类型搬移及新增 focus/error 未说明 | 记录为实现细节：QuestionDraft/QuestionPrompt 放 types.ts，manager 保留 type re-export；focusedOption 存逐题焦点、error 存校验文案，manualScroll 区分手动翻页，均服务获批机制。 |
| A5：parser/mock 范围及 CSI Z 修饰键 | 补齐范围。仅裸 CSI Z 补 shift:true；显式 modifiers 不覆盖；补 Ctrl+Tab 回归。mock 为独立 question-parity 测试模式，不影响原模式。 |
| A6：空 Other 聚焦后占位消失 | 修复：聚焦空值仍显示「其他：直接输入▏」，新增断言。 |
| A7 / A8：2 秒、中段与现行 ADR 冲突 | 不改实现。按 ADR-20261030-notice-lifecycle 保留信息类 8 秒和底栏左侧；旧规格的 2 秒/中段不优先于现行 ADR，冻结正文不回写。 |
| A9：题签末级退化非前 3 字 | 修复：退化到单个当前题签时显示标题前 3 个字素，提交题签仍可点击；8 题 × 60 列断言。 |
| A11：ADR 源码引用行号偏移 | 追溯更正写于本次证据：安装版 restoreUserQuestionError 在 lib/index.js:441–444，原 437–441 过期；语义和真实官方服务还原测试成立。不改已生效 ADR 正文。 |
| A12：旧调查把同名 description 都算 keymap | 更正事实：旧源码 completions/info-panel/feature-keys 也有同名字段；问卷选项的 description 旧版未渲染这一核心事实成立。不回写冻结调查正文。 |
| A13：Space 总表与多选专条矛盾 | 以获批 §3.5 专条和设计稿为准：单选 Space 选中前进；多选 Space 只切勾选，Enter 校验前进；Other 输入态 Space 是文本。原规格正文不擅改。 |
| A14：裸缩进与空行违反间距 ADR | 修复：回执缩进引用 NESTED；描述/按钮使用 NESTED+INLINE=5；chrome 使用 CHROME_GAP，题签间距使用 EDGE。无新增 token、无 ADR 例外。 |
| A15：冻结键位表缺回看键 | 在当前实施文档和契约末尾追加获批规格指针：Tab/Shift+Tab、非输入态 ←/→ 切题；Esc 取消、Alt+N 跳过；原冻结表不重写，Alt+T/倒计时不在本次实现。 |
| A16：历史单槽与地址字段未消费 | 作为已存在边界保留：本次只修 B4 取消回归，不新建并发问卷队列/跨地址路由，不宣称完整兑现历史 S03 全部能力。当前官方 ask_user_question 串行执行。需要扩展时另行明确范围；不伪称已修。 |
| A17：无调用包装函数/派生字段 | UI 改用 selectOption/nextQuestion/prevQuestion/scrollCard；移除无用 cardRowTotal 和 focusOption。planReview 为兼容已有 seam 类型与测试保留，实际渲染按逐题 intent 判定。 |
| A18：测试文件面比 §5 字面广 | issue 的 tests/unit 和 tests/feature 已覆盖；PR 明列新增和改动测试文件。不是新增功能或新机制。 |

## 当前键位

- ↑↓：移动选项焦点，包含 Other。1–9：单选直选前进、多选切勾选；Other 中为文本。
- Enter：单选选中前进；多选校验后前进；末题先到提交页，提交页再次 Enter 整体提交。
- Space：单选同选择；多选只切勾选；Other 输入态输入空格。
- Tab/Shift+Tab：双向切题（含 Other 输入态和提交页）；←/→：非输入态切题。
- PageUp/PageDown：±5 行正文翻页，原焦点行保持可见，不改变答案目标。
- Esc：取消整次提问（ASK_ABORTED）；Alt+N：显式跳过当前题（空 selected）。

## 改动面补充

- `src/app/question-card.ts`：从 App 拆出的纯行布局、题签/回执、滚动窗口和 cap。
- `src/app/App.tsx` / `src/app/nano-app.ts`：decisionBody 槽、面板优先级、键盘/点击、矮屏保护。
- `src/decisions/manager.ts` / `types.ts`：新增状态的归属与兼容导出、旧请求 abort 修复。
- `src/input/parser.ts`：裸反向 Tab 解析；`tests/e2e/mock-model.mjs`：本地问卷夹具。
- 测试：question-card / question-navigation / question-render / question-service；既有 decisions / fixes / notice-wiring / seams 的契约对齐。
- 文档：本次证据与逐项处置、规格末尾审核修订记录、design-contract 末尾键位变更来源（均不改冻结正文）。

## 已实测

修订全量：347 unit + 45 feature = 392 条通过；typecheck、lint、keymap-docs --check、build、git diff --check 均退出 0。lint 的 5 条存量警告位于未触碰文件。

尚未授权合并或发版。
