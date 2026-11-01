# 终端提问卡片调研笔记（以 Claude Code AskUserQuestion 为主）

可信度标注：**权威**＝官方文档/源码/规范；**参考**＝成熟工具文档或行业研究；**传闻**＝个人博客/论坛。

## 一、Claude Code：官方说法与社区反馈

**官方（权威）**

- 结构硬约束：一次 1–4 题，每题 2–4 个选项，`header` ≤12 字符，`multiSelect` 区分单选/多选，`Other` 永远自动追加。[官方 tool 行为](https://code.claude.com/docs/en/tools-reference#askuserquestion-tool-behavior)、[官方 plugin 参考](https://github.com/anthropics/claude-code/blob/main/plugins/plugin-dev/skills/command-development/references/interactive-commands.md)
- 空选：文档明说多选可以是「none, some, or all」；但 VS Code 版曾要求每题都答完才可提交，按钮禁用却无提示，用户读成卡死（[#81790](https://github.com/anthropics/claude-code/issues/81790)，参考）。
- Esc＝取消整题，不是跳过：`select:cancel` 绑定 Esc；vim 模式要先退 NORMAL 再按一次；在 Other 输入框里 Esc 只回到选项层；键位表里没有「跳过本题」动作。[键位表](https://code.claude.com/docs/en/keybindings#select-actions)、[vim 说明](https://code.claude.com/docs/en/interactive-mode#cancel-a-question-in-vim-mode)（权威）
- 计划确认为三选一卡片（自动模式／逐条确认／继续规划），Ctrl+G 可直接改计划文本。[permission-modes](https://code.claude.com/docs/en/permission-modes#review-and-approve-a-plan)（权威）
- 变更史（[CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)，权威）：2.0.55 单选自答即提交、砍掉 review 屏；2.1.144 Esc 分层；2.1.181 修「多选里输入的 Other 被丢弃」；2.1.200 把 60 秒自动继续改为 opt-in；2.1.301 修 vim 下 Esc 误丢答案。

**社区（参考／传闻）**

- 多题导航：题目排成 tab；有 agent 面板照搬该模式后，用户吐槽 X/N 从 5/5 递减、看不懂（[HN](https://news.ycombinator.com/item?id=49400749)，传闻）。
- Other：数字键会直接选走选项、打不进数字（[#22300](https://github.com/anthropics/claude-code/issues/22300)，已修）；日文 IME 下输入异常（[#27764](https://github.com/anthropics/claude-code/issues/27764)）。
- Esc：被当成「拒绝工具调用」，vi 用户误按就丢答案（[#56890](https://github.com/anthropics/claude-code/issues/56890)，已修）。
- 遮挡上下文：模态盖住上文，用户只能凭选项摘要做决定（[#89644](https://github.com/anthropics/claude-code/issues/89644)、[#87807](https://github.com/anthropics/claude-code/issues/87807)）；作者本人在 HN 道歉，承认该默认值应 opt-in（[HN](https://news.ycombinator.com/item?id=48947776)，权威发言/论坛载体）。Reddit 未检索到可稳定引用的讨论串，社区证据以 HN 与 GitHub issue 为主。个人体验另见 [Anatomy of a Misfeature](https://www.olafalders.com/2026/07/17/claude-code-anatomy-of-a-misfeature/)、[三选项陷阱](https://jamiewatters.work/journey/the-three-options-trap)（传闻）。

## 二、同类工具的成熟范式（参考～权威）

| 工具 | 焦点 vs 选中 | Esc / 空选 |
|---|---|---|
| fzf | 指针 `▌` 与多选标记 `┃` 分列；Tab/Shift-Tab 增删选 | Esc 退出码 130；Enter 取当前行 |
| Inquirer | `❯` 指针 + `◉/◯` 勾选；space 切换、a 全选、i 反选、数字键直选 | 空选默认放行（返回 `[]`），校验交给 `validate` |
| gh | survey 风格：方向键 + 输入即过滤 | Esc 中断 |
| lazygit | 光标 + space 暂存；a 全选、v 范围选、Enter 下钻到 hunk/行 | Esc 返回上一层，不是取消 |
| k9s | 单光标 + 快捷键动词；未找到多选键位 | —（未找到多选） |

来源：[fzf man](https://github.com/junegunn/fzf/blob/master/man/man1/fzf.1)、[Inquirer 源码](https://unpkg.com/inquirer@9.3.8/lib/prompts/checkbox.js)、[go-gh prompter](https://github.com/cli/go-gh/blob/trunk/pkg/prompter/prompter.go)、[lazygit 键位](https://github.com/jesseduffield/lazygit/blob/master/docs/keybindings/Keybindings_en.md)、[k9s key.go](https://github.com/derailed/k9s/blob/master/internal/ui/key.go)。

三点共识：焦点永远独立成列，选中另用一列符号；数字直选常见，但必须让位给自由输入；Esc 在「选择器」里是取消，在「面板导航」里才是返回。

## 三、表单研究：能证到哪一步

- **一题一屏 vs 一屏多题**：GOV.UK 明确「从一页一件事开始」，允许研究后合并相关问题（[form structure](https://www.gov.uk/service-manual/design/form-structure)、[question pages](https://design-system.service.gov.uk/patterns/question-pages/)，权威）；NN/g 说 wizard 适合低频、不熟悉的流程，熟手会嫌慢（[wizards](https://www.nngroup.com/articles/wizards/)，参考）。**没找到公开的完成率对照实验**，别引用不存在的数字。
- **校验时机**：Baymard 实测，提交才报错会逼用户停下找错甚至放弃，实时 inline 明显加快纠错（[inline validation](https://baymard.com/research-articles/inline-form-validation)，参考）；NN/g 补一条：不要在输入完成前校验（[errors](https://www.nngroup.com/articles/errors-forms-design-guidelines/)，参考）。→ 失焦时校验，不要每键。
- **错误放置**：紧贴字段，摘要不能是唯一提示（NN/g 第 3、8 条）。
- **回看已答项**：GOV.UK 的 Check your answers，每行一个 Change 链接（[check answers](https://design-system.service.gov.uk/patterns/check-answers/)，权威）；NN/g 指出 wizard 不标已完成步骤，用户就得凭记忆。

## 四、可访问性与窄屏

- WCAG 2.2 可借四条：焦点可见 [2.4.7](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html)、焦点不被遮挡 [2.4.11](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html)、320px 重排 [1.4.10](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html)、非文本对比 3:1 [1.4.11](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)。WCAG 本身针对 Web，TUI 只能借原则。
- Claude Code 屏幕阅读器模式把菜单变成编号列表、提示「Select with numbers」（[accessibility](https://code.claude.com/docs/en/accessibility)，权威）——数字直选也是无障碍兜底。
- **60 列没有成文规范**：能引的基线是 80×24 终端传统；60 列比 WCAG 的 320px 更宽松，属自定约束。这条查不到权威出处。

## 五、对我们的 5 条直接建议

1. 焦点用独立指针列（`❯`），选中用另一列符号（`◉`），禁止只靠整行底色区分。
2. 允许「每题必答」，但按钮禁用时必须写「还差 N 题」，并给未答 tab 打标记。
3. 数字直选默认关闭；Other 输入框获得焦点后，所有可打印键归输入框。
4. Esc 分层：输入框 → 选项层 → 取消整题；取消前保留已输入文本。
5. 60 列下先保不折行：按词换行、超长加省略号、每屏 ≤7 项分页，底部常驻键位提示。
