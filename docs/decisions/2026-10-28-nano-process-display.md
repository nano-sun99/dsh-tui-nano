# ADR-20261028-nano-process-display：过程块默认只留一行摘要，展开只有原位点击

- 状态：生效中
- 日期：2026-10-28
- 决策人：用户
- 适用范围：Nano transcript 的过程块默认显示、结果行预算、思考可见性与展开入口
- 取代：无
- 被取代：无
- 决策来源：2026-10-28 用户看完交互稿后原话「ok 完全采纳，请你出spec」；交互稿见 `docs/design/2026-10-17-dsh-tui-ux-research/preview/index.html`，spec 见 `docs/specs/2026-10-28-nano-process-display/README.md`

## 决定

Nano 的默认屏幕只留「结论 + 一行过程摘要 + 可点开的入口」：

1. 连续的 Read / Grep / Glob / List 合并为一行，显示计数；单次调用显示目标。
2. 成功的 Bash 与通用工具默认 0 行结果；失败仍保留摘要，不隐藏。
3. 思考在流式生成时默认只显示一行标题，点击展开正文；提交后整行消失，不保留入口。
4. 每个可展开的过程行右侧固定显示「点击展开 / 点击收起」。
5. 不提供全局展开 / 收起，也不新增相关快捷键；展开入口只有原位点击。

## 依据

- 2026-10-28 对照本机归档的 Claude Code 2.1.88 源码（`/Users/sunchongsheng/Downloads/归档/06-软件与安装包/ClaudeCode/`）：
  - `src/components/Message.tsx` 的 `thinking` 分支在非 transcript、非 verbose 时直接返回 null；`src/components/messages/AssistantThinkingMessage.tsx` 只在流式渲染时被调用。
  - `src/utils/collapseReadSearch.ts` 与 `src/components/messages/CollapsedReadSearchContent.tsx` 把连续读取 / 搜索折成一行计数，默认不显示结果正文。
  - `src/components/messages/AssistantToolUseMessage.tsx` 与各工具的 `renderToolResultMessage` 决定结果展示；默认只留一行工具标题与状态。
- 用户先看交互稿（100 / 60 列、深浅主题、完成 / 执行中 / 失败场景），确认后明确「完全采纳」。
- 2026-10-28 用户实机试用后要求流式思考默认收起，改为默认一行、点击展开。
- 交互稿浏览器验证 131 项全绿，覆盖分组展开、默认不露结果、流式思考、60 列不溢出。

## 否决了什么

- 否决「全局展开 / 收起」：用户明确说「除了全局展开收起我不要」。
- 否决「思考完成后保留一行摘要」：该行为被本轮修订取代。
- 否决「成功结果默认露出 2 行」：默认屏幕不再显示结果正文。

## 接受的代价

- 完成后思考正文不可回看；没有全局入口，也没有点击入口。
- 想确认工具结果需要多一次点击。
- 组行只显示整体状态，单次调用的细节要展开才看得到。
- 「点击展开 / 点击收起」占用行尾宽度；60 列可完整显示，更窄宽度会省略提示。
- 流式思考默认只占一行；想看正文多一次点击。

## 允许重开的条件

- 用户要求恢复思考回看或引入全局展开 / 收起。
- 真实长会话证据表明「默认 0 行结果」导致核对成本明显高于收益。
- 需要在不增加点击的前提下展示过程状态，且现有规则无法容纳。

## 修订记录

- 2026-10-28：用户试用后要求流式思考默认收起；决定第 3 条改为「默认一行、点击展开」，提交后仍整行消失；代价更新为「看正文多一次点击」。

## 关联

- Spec：`docs/specs/2026-10-28-nano-process-display/README.md`
- 上游：`docs/specs/2026-10-20-nano-v1/S03-reading-decisions.md`
- 间距：`docs/decisions/2026-10-26-spacing-token-architecture.md`（正交，不取代）
