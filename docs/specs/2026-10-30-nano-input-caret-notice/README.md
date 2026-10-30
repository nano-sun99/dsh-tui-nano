# 输入区光标停靠与 notice 生命周期 · 规格

- 日期：2026-10-30
- 状态：已合入（PR #104）；执行 issue：#110；代码 PR #111 已合（merge `6e6c600`）。
- 用户确认：用户 2026-10-30 拍板——① 光标沿用 CC 做法（反色块 + 隐藏真光标暗中停靠）；② notice 有 TTL，最终选 8 秒；③ 显示时临时挤占状态行左侧 cwd，不新增行、不强行占一行；④ 草稿超过 4 行按 CC 做视口滚动；⑤ 机制清单「全要」。
- 交付边界：本次只交付本规格与两条 ADR；方案确认、审核档位与合并确认都不等于实施授权。

## 1. 上游与适用关系

- ADR 检索：2026-10-30 实际搜索 `docs/decisions/` 中 `输入 / 光标 / cursor / IME / 输入法 / notice / 提示 / 终端`，命中 8 份记录：[input-history](../../decisions/2026-10-22-input-history.md)、[process-display](../../decisions/2026-10-28-nano-process-display.md)、[independent-tui-theme](../../decisions/2026-10-22-independent-tui-theme.md)、[nano-theme-scope](../../decisions/2026-10-22-nano-theme-scope.md)、[spacing-token-architecture](../../decisions/2026-10-26-spacing-token-architecture.md)、[implementation-language-typescript](../../decisions/2026-10-28-implementation-language-typescript.md)、[s02-s01-seams](../../decisions/2026-10-29-s02-s01-seams.md)、[single-process-fd-guard](../../decisions/2026-10-29-single-process-fd-guard.md)。直接相关的是 seams（输入框访问与接缝扩展）与 input-history（草稿/光标只在受控切根时恢复），均不冲突；其余只出现「终端 / 提示 / 输入」字样，与本决定无关。无取代；本次新增 [ADR-20261030-input-caret-parking](../../decisions/2026-10-30-input-caret-parking.md) 与 [ADR-20261030-notice-lifecycle](../../decisions/2026-10-30-notice-lifecycle.md)。
- 行为参照：[nano-interaction §3.4.2](../../2026-10-24-nano-interaction/README.md) 只提供「notice 行不是草稿行、不参与点击定位」的分类依据，不规定显示位置；本规格把 notice 落到状态行，属于新的落点决定。该规格的文件与测试体例属于 Rust 实现，不直接映射到当前 TS 文件。
- 不修改任何历史规格正文；本规格只约束当前 TS 实现的主输入框与主界面 notice。

## 2. 已核实事实与参考

基线：`5bf9b4f`（origin/main，2026-10-30）。

### 2.1 现场症状与代码根因

- **提示常驻**：模型面板提交后 `setNotice('已选择 …')`（`src/controls/model-panel.ts:345`）；notice 被拼进输入行的 span 流（`src/app/App.tsx:176`），只有「提交成功」（`src/app/nano-app.ts:273`）或「重开面板」（`src/controls/model-panel.ts:145`）才清除，打字、删除都不清。
- **行尾光标消失**：视觉光标是反色空格（`src/app/App.tsx:169,173`）；`wrapSpans` 收尾用 `trimTrailing` 删除行尾空格，只对 `diffDel` 语气豁免、**不看 `reverse`**（`src/transcript/spans.ts:154-162`）。用 `node --experimental-strip-types` 直接对 `src/transcript/spans.ts` 实测：`hello` + 行尾 caret 包裹后只剩 `hello`，normal + reverse 的 caret 空格被裁掉；`diffDel` + reverse 的空格则保留。
- **IME 锚点漂移**：终端只在启动时隐藏真光标（`src/runtime/terminal.ts:56`）；diff 的每个脏 run 都有 CUP（`src/render/ansi.ts:120`），但帧末没有 caret 停靠 CUP，真光标因此停在这一帧最后一个脏 run 的末尾。流式更新、局部重绘、resize 时位置不固定。
- **4 行上限**：输入区高度取 `Math.min(4, Math.max(1, rows.length))`，渲染只取前 4 行（`src/app/App.tsx:182,245,255`）；插入点在第 5 行以后时既不可见，也没有窗口滚动。

### 2.2 Claude Code 参考实现（本机解包源码，仅作行为依据）

- 光标停靠：`src/ink/hooks/use-declared-cursor.ts` 把输入组件声明为 caret 宿主；`src/ink/ink.tsx:654-696` 在帧末把声明换算成屏幕绝对格并发出 CUP。视觉上仍是反色块（`src/components/TextInput.tsx:105` 的 `cursorChar = ' '`，`src/utils/Cursor.ts:204-291` 反转绘制）；alt-screen 下真光标保持隐藏（`src/ink/renderer.ts:174`）。
- 长输入：`src/utils/Cursor.ts:172-201` 的 `getViewportStartLine` 以插入点所在行居中取窗口；`render()` 只画窗口内行；`src/components/PromptInput/PromptInput.tsx:1999` 传入 `maxVisibleLines`。
- notice：命令结果走 `addNotification(..., priority: 'immediate')`（`src/utils/handlePromptSubmit.ts:272-287`）；默认超时 8000ms（`src/context/notifications.tsx:34`）；非全屏显示在 footer（`src/components/PromptInput/PromptInputFooter.tsx:145`）；全屏用绝对定位（零布局高度）、`height=1` + `overflow:hidden` 做单行截断，补全/自动模式弹层时 height 置 0（`src/components/PromptInput/PromptInput.tsx:2293`，注释 2277-2285）。模型切换文案为 `Set model to X`（`src/commands/model/model.tsx:198-213`）。

## 3. 目标行为

### 3.1 光标停靠

1. caret 的渲染条件是 `AppSnapshot.caretActive !== false`。该值由 `NanoApp` 从 `FeatureHost.inputActive?.()` 取得；`Features.inputActive()` 在模型面板打开、终端面板聚焦（`TerminalPane.focused`）、信息/会话/任务面板可见时返回 false；补全弹层与子代理 dock 不抢输入焦点，保持 true；没有 features 时默认 true。决策卡激活时输入区进入 disabled 分支，本身不渲染 caret。
2. `trimTrailing` 不得删除 `caret` span 及其之前的内容；行尾插入点必须可见。
3. 渲染器把 caret 换算成屏幕绝对格，在该帧写完后追加一次 CUP；真光标保持隐藏，不新增 `?25h`。
4. `caretActive === false` 或无 caret 时不发 CUP。
5. CUP 行列钳制在屏幕内；无写入且目标格未变化时允许省略（语义上光标已在正确格）。
6. 仅覆盖主输入框；会话改名、决策卡自定义输入、子代理输入不在本规格。

### 3.2 输入视口滚动

1. 输入区高度仍为 1–4 行：`min(4, rows.length)`。
2. 可见窗口以 caret 行为中心：`start = clamp(caretRow - floor(visible / 2), 0, max(0, rows.length - visible))`。
3. 只渲染窗口内行；caret 行随窗口滚动，始终可见。
4. 高度计算与渲染共用同一窗口函数，禁止两处各自计算。
5. 不改变现有换行与 CJK 宽度规则（`wrapSpans` / `graphemeWidth`）。

### 3.3 notice 生命周期与落点

1. notice 是单槽状态：`{ text, tone: 'info' | 'danger', expiresAt? }`；新通知覆盖旧通知并重置计时。
2. 信息类 8 秒后自动消失；错误类不自动过期，保留到下一次文本编辑或被新通知替换。
3. 任何文本编辑（输入字符、换行、Backspace / Delete / 删除词、清空、粘贴）立即清除；提交成功仍清除。
4. 显示位置：底部状态行左侧，临时顶替 cwd；不新增行、不改变布局高度。右侧快捷键提示在有空间时保留，否则让位；文本按可用宽度截断（省略号）。
5. notice 不再进入输入区 span 流；输入区只含草稿、光标与占位符。
6. 颜色：`info` 用 `theme.faint`，`danger` 用 `theme.danger`。
7. 计时器在替换、清除、退出/销毁时清理，不残留。
8. 语气由调用方显式传入，不允许按文案猜。以下路径必须传 `danger`：`src/controls/feature-host.ts:111`（改名失败）、`:258`（超过 32 KiB）、`:466`（附件提交失败）；`src/controls/model-panel.ts:109`（打开失败：没有可用的模型）、`:350`（模型切换失败）；`src/app/nano-app.ts` 的发送失败、超限、受控切换写入失败。其余状态提示传 `info`。
9. `FeatureContext.setNotice` 增加可选 `tone?: 'info' | 'danger'` 参数；`ModelPanelOptions.setNotice`（`src/controls/model-panel.ts:36`）与 `src/controls/feature-host.ts:156` 的转发必须同步透传。按 [ADR-20261029-s02-s01-seams](../../decisions/2026-10-29-s02-s01-seams.md)「接缝只加可选参数、可选钩子与新增方法」的约定：旧调用不传时按 `info`，调用方无需同步修改；`inputActive` 属新增可选方法，未提供时 `caretActive` 默认 true。本规格对主界面 notice 落点的调整属于 S01 自身 UI 变更，不在「不传 features 行为不变」的接缝承诺内。

## 4. 改动面与不做事项

- `src/app/App.tsx`：`buildInputSpans` 去掉 notice、加 caret 标记；`InputLine` 视口窗口与 caret 宿主；`StatusLine` 左槽显示 notice；`AppSnapshot` 增加可选 `caretActive`；高度与渲染共用窗口函数。
- `src/transcript/spans.ts`：`Span.caret` 的传递与合并规则；`trimTrailing` 保留 caret。
- `src/render/host.ts` / `src/render/renderer.ts`：`BoxProps.cursor` 标记；帧内记录绝对 cell，帧末追加 CUP。
- `src/app/nano-app.ts`：notice 变为带语气与过期时间的单槽状态；编辑即清；计时器生命周期；`FeatureContext.setNotice` 增加可选 `tone`；`FeatureHost` 增加可选 `inputActive?: () => boolean`，并写入 `AppSnapshot.caretActive`；自身错误路径按 `danger` 传递。
- `src/controls/feature-host.ts`：实现 `inputActive()`（模型面板/终端聚焦/信息/会话/任务面板）；`setNotice` 的 3 处错误调用传 `danger`；`:156` 转发透传 tone。
- `src/controls/model-panel.ts`：`setNotice` 签名增加可选 `tone`；打开失败（`:109`）与切换失败（`:350`）按 `danger` 传入。
- 测试：更新 `tests/unit/input-frame.test.ts` 的高度/边框假设与 `tests/unit/model-panel.test.ts` 的 notices 断言；新增 caret 停靠、视口窗口、notice 生命周期（TTL / 编辑清除 / 语气）的单元测试。
- 不做：会话改名输入、决策卡自定义输入、终端面板、剪贴板/选区、鼠标点击定位、IME preedit 绘制、notice 队列与优先级、ADR 制度改造。
- 若最小实现无法满足本规格，先报告实际缺口，不自行扩大协议或新增机制。

## 5. 有限验收

- [ ] 输入 `hello` 后反色 caret 停在末尾可见；左右移动时 caret 格跟随。
- [ ] 渲染输出在帧末出现 CUP，坐标等于 caret 格；运行期不出现 `?25h`（退出恢复除外）。
- [ ] 终端面板聚焦、信息/会话/任务面板可见、模型面板打开、决策卡激活时不渲染 caret、帧末无停靠 CUP；关闭后恢复；补全弹层与子代理 dock 不影响停靠。
- [ ] 8 行草稿只显示 4 行，caret 行始终在窗口内；上下移动光标时窗口跟随滚动。
- [ ] 切换模型/档位：提示出现在状态行左侧、cwd 让位；8 秒后 cwd 恢复；期间输入任意字符立即消失。
- [ ] 错误类提示（改名失败、超过 32 KiB、附件提交失败、发送失败、模型打开失败、模型切换失败、受控切换写入失败）按 `danger` 显示，超过 8 秒仍存在，文本编辑后消失；信息类提示 8 秒自动消失。
- [ ] notice 不再出现在输入框行文本中。
- [ ] 既有测试与新增测试通过；`npm run typecheck`、`npm run lint`、`npm run build` 通过。

完成仅指本规格约定功能、相关测试与证据齐全；不含上线后观察期。

## 6. 机制清单

- **M1 光标停靠**：输入区声明 caret 在输入框内的位置，渲染器换算成屏幕绝对格并在帧末停靠隐藏真光标。没有它：IME 候选窗继续漂移，行尾光标继续被裁掉。
- **M2 输入视口滚动**：固定 4 行高，按 caret 行居中取窗口。没有它：超长草稿的插入点不可见，IME 锚点越界。
- **M3 notice 状态机与落点**：notice 升级为「文本 + 语气 + 过期时间」单槽状态，编辑即清、信息类 8 秒过期、错误保留；显示在状态行左侧顶替 cwd，右侧提示有空间才保留，超宽截断，不新增行、不进入输入区。没有它：提示继续常驻并污染输入区。

## 7. 自定细节

- caret 宿主复用 `<Box>` 的新 `cursor` 标记，不新增 host 节点类型；标记零宽，不占字符格。
- 视口居中取 `floor(visible / 2)`，与 CC 一致；可见行上限维持 4。
- notice 单槽不排队：本仓 notice 均由用户操作触发，连续操作以最新一条为准；不搬 CC 的队列/优先级。
- `info` 8000ms；`danger` 无 TTL。
- 计时器用单个 `setTimeout`，不引入调度器。
- CUP 目标钳制在屏幕内；无 caret 或 `caretActive === false` 时不停靠；无写入且目标格未变时可省略。
- `caretActive` 缺省为 true；`Features.inputActive()` 只按已存在的面板可见/聚焦状态判断，不新增场景注册表。
- 截断复用现有 `truncateText`，不新写省略逻辑。
- 体量评估：单份规格、一张执行 issue，结构无实质变化，不拆。

## 8. 审核修订记录

2026-10-30 方案期轻审（1 个审核 agent，用户点选轻审）：发现 11 项（高 0 / 中 4 / 低 7）；用户选择「改」。发现原文见 PR #104 评论。

| # | 严重度 | 发现 | 处置 |
|---|---|---|---|
| 1 | 中 | ADR 适用范围写「所有可编辑文本输入」，超出 spec 覆盖的主输入框 | ADR 收窄为「主输入框；其他输入面沿用需另立 spec/ADR」 |
| 2 | 中 | notice 语气映射漏 feature-host 的 3 处错误与 nano-app 错误源；接缝签名变更未交代 | §3.3 增第 8/9 条点名全部 danger 路径与接缝可选参数；§4 补 feature-host 与 nano-app |
| 3 | 中 | 「面板占用」缺可落地状态源；dock 与终端面板无法区分 | §3.1 定义 `AppSnapshot.caretActive` ← `FeatureHost.inputActive()`；§4/§7 补实现落点 |
| 4 | 中 | ADR 检索记录写「未命中」，实际命中多份现行 ADR | §1 改为逐份列出；复核后又补齐为 8 份，见下一张表 |
| 5 | 低 | CC 参考行号与「零高度」描述不精确 | §2.2 与 ADR 改为 `notifications.tsx:34`；补 `height=1 + overflow:hidden` 与绝对定位说明 |
| 6 | 低 | 测试改动面误称 input-frame 有 notice 断言 | §4 改为 input-frame 高度/边框假设 + model-panel notices 断言 + 新增测试 |
| 7 | 低 | 4 行上限的 file:line 指错 | §2.1 改为 `App.tsx:182,245,255` |
| 8 | 低 | trimTrailing 看 tone、diff 逐 run 有 CUP、dist 证据不可复核 | §2.1 改写三点，改用 `node --experimental-strip-types` 实测 |
| 9 | 低 | ADR「每一帧」与 spec「可省略」字面冲突 | 统一为「有写入或目标格变化时停靠；无写入且格未变可省略」 |
| 10 | 低 | 机制清单 M3 未覆盖 notice 落点 | §6 M3 补状态行落点、右侧让位与截断 |
| 11 | 低 | 上游引用把鼠标节的 notice 条款当作显示位置依据 | §1 改为只取「notice 行不是草稿行」的分类依据，落点为本规格新增 |

2026-10-30 方案期轻审复核（同一审核 agent）：发现 4 项（高 0 / 中 2 / 低 2）；用户选择「改」。发现原文见 PR #104 评论。

| # | 严重度 | 发现 | 处置 |
|---|---|---|---|
| 1 | 中 | ADR 检索仍写「命中 3 份」，漏 seams / fd-guard / 实现语言 / 间距等命中 | §1 补齐 8 份命中清单；剔除 `root-resume` 的误匹配（`time` 里的 `ime`） |
| 2 | 中 | model-panel 的 tone 经 feature-host:156 转发会丢失；model-panel:109 打开失败未列为 danger | §3.3.8/9、§4、§5 补齐转发透传与打开失败路径 |
| 3 | 低 | seams 引文不全，「S01 既有行为不变」与 notice 落点变更矛盾 | §3.3.9 改为只承诺「旧调用无需同步修改」+「inputActive 可选」，并注明落点调整不属于接缝承诺 |
| 4 | 低 | §5 验收漏模型面板/决策卡的 caret 场景与两类 danger | §5 两条验收补齐 |
