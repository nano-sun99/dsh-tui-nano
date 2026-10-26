# 统一间距架构 · 补充规格

- 日期：2026-10-26
- 状态：已合并；2026-10-26 实施后按用户实机反馈修订过程块间距（0 → 1 行），随修正 PR 合并。
- 用户确认：截图指出“思考 已完成”与“一句话：……”之间没有任何间距；用户要求从总体设计出发统一边距与排版，参照设计稿优化；用户选择“按设计稿收紧过程组（推荐）”；机制卡 5 项全要；规格载体选择“新开补充规格（推荐）”。实施后用户再次截图指出过程块仍粘在一起，选择“只留块间 1 行”；据此把过程块间距从 0 改为 1，卡内命令 / 输出保持紧贴。
- 交付边界：本次先交付补充规格，不把方案确认或审核档位当作实施、合并授权。

## 1. 上游与适用关系

- [输入、预览与排版规格](../2026-10-26-nano-input-preview-rendering/README.md)：本规格取代 §4.6 中“用户消息、助手回答、思考、工具、上下文、预览、diff 等同级主块之间保留一行空白”这一条、§6〈Composer 与布局〉中“同级主块之间一行空白”的对应验收，以及 §8.8 中“主块间距默认一行”的默认规则。替换后的完整口径是：过程块之间（思考头、工具卡）1 行，过程 → 回答 1 行，用户 / 上下文 / 通知 / 回显 / 回答之间 1 行；§8.8 后半句“块内工具 / diff 保持紧凑、高度不足先收紧空白和过程详情”继续生效。其余条款继续生效：2ch 外边距、标题→transcript 一行、Markdown 分组一行、工具内部顺序、底部高度降级顺序、60 列优先语义分组。
- [视觉与交互规格](../2026-10-25-nano-visual-interaction-alignment/README.md)：§4 最后一条的“2ch 边距、Markdown 处理、上下文合并、子代理 dock”保持；§3.4 的“Edit、路径、统计之间现有 1ch 间距”与 `push_two_column` 的 1ch 列间距保持不变；本规格只把它们收进共享 token，不改变布局结构或数值。diff 的“标题 → rule → 状态 → 代码”顺序与 4ch / 2ch 固定宽度不变。
- 设计稿 `docs/design/2026-10-17-dsh-tui-ux-research/preview/index.html`：`.process` 底 1 行与 `.answer` 顶 1 行是两条独立 margin，CSS 折叠后过程 → 回答 1 行；`--line` 是单行节奏；列表与详情缩进 2ch。设计稿 `.detail` 的上下 1 行 padding 本次不采用，工具 / diff / 思考展开详情按上游保持紧凑。
- ADR 检索：实际搜索 `docs/decisions/` 中 `spacing / 边距 / 间距 / margin / padding / 排版`，未命中既有间距决定；沿用 [ADR-20261022-independent-tui-theme](../../decisions/2026-10-22-independent-tui-theme.md) 的颜色所有权与透明背景边界；本次新增 [ADR-20261026-spacing-token-architecture](../../decisions/2026-10-26-spacing-token-architecture.md) 记录间距 token 与角色的长期归属，无取代 ADR。
- 历史规格正文不改；两份历史规格与本补充冲突时，仅上述明确列出的条款以本补充为准。

## 2. 已核实事实与参考

基线为主干提交 `a5b7303`。

### 2.1 设计稿的间距规则

`docs/design/2026-10-17-dsh-tui-ux-research/preview/index.html`：

- `--line:22px`，整页以一行高为基本节奏。
- `.process { margin: 0 0 var(--line); }`，`.answer { margin-top: var(--line); }`；相邻 margin 在 CSS 中折叠，过程与回答之间仍是一行。
- `.transcript { padding: 0 2ch var(--line); }` 与 `.answer li { padding-left: 2ch; }`，横向统一 2ch。
- `.detail { padding: var(--line) 0 var(--line) 2ch; }`，展开详情上下各一行。
- `.tool-note`、`.live-tail` 等次级内容统一 `margin-left: 2ch`。

### 2.2 当前代码的散落点

- `crates/nano-transcript/src/render.rs:451`：`render_entry` 在非空条目末尾追加一行空行；`:167` 的 context unit 也单独追加一行。
- `crates/nano-transcript/src/render.rs:363-366`：Assistant 的 `text` 与 `reasoning` 都为空时提前 `return output`，不追加空行；空 Assistant 目前不渲染。
- `crates/nano-transcript/src/render.rs:371-395`：有 reasoning 的 Assistant 在 `render_thinking` 之后立即接 Markdown 正文，没有空行，形成截图中的“思考 已完成”贴住“一句话”。
- `crates/nano-transcript/src/render.rs:1039-1085`：Preview 的状态、思考、正文之间同样没有 Section；现有顺序是状态 → 思考 → 正文 → 部分内容提示 → 工具参数行。
- `crates/nano-transcript/src/render.rs:130-152`：`units()` 只合并普通 context；工具条目各自是 Single，相邻工具之间靠各自末尾空行分隔。
- 其他间距产生点：`:1144-1146` 展开 context 组的段间空行（带 Toggle hit）；`:1236-1238`、`:1246-1247`、`:1259-1260` 是 Markdown 块间 / 表格前后的直接 `Line::default()`，不经过 `markdown_gap`。
- `crates/nano-transcript/src/render.rs:1321`：Markdown 的 `markdown_gap` 只做判定，不负责写行。
- 水平缩进散落：9 处 `format!("  …")`、7 处 `saturating_sub(2)`、1 处 `Span::raw("  ")`；具体分布在用户消息续行（466 / 485）、带前导空格的标签串（622 / 703 / 799 / 823 / 862）、工具嵌套四空格续行（751 / 937）、Thinking / 工具正文 / labeled context / Markdown 列表续行（533 / 617 / 630 / 645 / 761 / 792 / 1289）。
- `crates/nano-app/src/ui.rs:59`：`inset_horizontal(full, 2)`；`:103` 标题区 2 / 3 行；`:96-100` dock 高度 `+ 1`；`:214` `bottom_gaps` 直接返回 1 / 0。

### 2.3 截图场景

真实会话中，Bash 工具卡之后是“▸ 思考 已完成 · 2.8s”，再下一行就是“一句话：这是 DeepSeek Harness……”。两者之间 0 空行；用户指出“这两块内容之间没有任何的 padding”。这是 Assistant 条目内部的 section 缺失，不是条目与条目之间的间距问题。

## 3. 间距模型

### 3.1 唯一来源

在 `nano-theme` 新增 `spacing` 模块（不新建 crate）：

- `EDGE = 2`：主内容 / 面板左右外边距，单位 cell。
- `INDENT = 2`：详情、正文、列表续行缩进，单位 cell。
- `NESTED = 4`：工具嵌套正文的第二级缩进（`2 × INDENT`），单位 cell。
- `INLINE = 1`：摘要行内两列之间的间距，单位 cell。
- `CHROME_GAP = 1`：标题、输入区、状态栏、dock 之间的分隔行，单位 row。
- `Gap { None, Section, Block }`：垂直间距角色；`None = 0` 行，`Section = 1` 行，`Block = 1` 行；语义优先级 `None < Section < Block`，相邻间距取 `max`。

### 3.2 条目角色与相邻间距

每个 transcript unit 保留 `lead` / `trail` 两个角色；当前规则对所有可见 unit 之间统一留 1 行，角色分类只作为未来更密节奏的保留信息，不再改变间距。

| EntryKind | lead | trail |
|---|---|---|
| `User` | Turn | Turn |
| `Assistant`，只有 reasoning | Process | Process |
| `Assistant`，有正文（无论是否带 reasoning） | Process（带 reasoning）或 Answer | Answer |
| `Assistant`，text 与 reasoning 都为空 | 不渲染 | 不渲染（沿用提前返回） |
| `Notice` | Turn | Turn |
| `Context` | Turn | Turn |
| `Tool` | Process | Process |
| `Preview`，无正文 | Process | Process |
| `Preview`，有正文 | Process | Answer |
| `Echo` | Turn | Turn |

间距表：

| 前一个 trail \ 后一个 lead | Process | Answer | Turn |
|---|---|---|---|
| Process | `Block`（1 行） | `Block`（1 行） | `Block`（1 行） |
| Answer | `Block`（1 行） | `Block`（1 行） | `Block`（1 行） |
| Turn | `Block`（1 行） | `Block`（1 行） | `Block`（1 行） |

- 第一条 unit 没有前导间距；最后一条 unit 固定 `Block`（1 行），作为 transcript 底部留白。
- 结果：过程块之间（相邻工具卡、工具卡与思考头、思考头与后续工具卡）都留 1 行；过程 → 回答 1 行；用户、上下文、通知、本地回显四周各 1 行；回答之后一切主块 1 行。工具 / diff 内部与卡内命令 / 输出仍紧贴。

### 3.3 条目内 Section

- Assistant：思考块（标题 + 可选展开详情）结束后，如果还有正文或中断提示，插一个 `Section`（1 行）。
- Preview：状态行与思考行结束后、正文开始前插一个 `Section`（1 行）；正文之后的部分内容提示与工具参数行属于同一尝试的紧凑尾注，紧贴正文，不再加 Section，也不重排现有顺序。
- 其他条目内部不新增间距；context 组展开时，段与段之间的既有 1 行改为 `push_gap(Block)`，该行不再带 Toggle hit（组头和内容行仍可点）。
- `push_gap` 在写入前检查最后一行的所有 span 是否为空；已经是空行就跳过，避免 Section 与 Block 叠成两行。

### 3.4 水平间距

- `EDGE` 用于主内容与面板的左右 2ch；数值不变，只改为引用 token。
- `INDENT` 用于思考详情、工具正文、用户消息续行、带前导空格的标签串、Markdown 列表续行的 2ch 缩进；宽度计算使用 `width.saturating_sub(INDENT)`。
- `NESTED` 用于工具嵌套正文的 4ch 续行；宽度计算按 `NESTED`。
- context / group 展开当前没有缩进，本次不新增，保持全宽换行。
- `INLINE` 用于摘要行内两列之间 1ch 的间距；视觉规格 §3.4 的 Edit / 路径 / 统计 1ch 与 `push_two_column` 的 1ch 保持不变。diff 的 4ch 行号与 2ch 标记是 diff 自己的固定宽度，不并入通用缩进。
- 不新增第三套水平数值；60 列下仍按上游规则换行 / 截断。

### 3.5 Markdown

- `markdown_gap` 的语义矩阵保留：标题组、列表组、段落、表格之间 1 行；同一列表、同一表格内部 0 行。
- Markdown 的块间空行（含表格前 / 后）当前是直接 `Line::default()`（1236-1238、1246-1247、1259-1260），全部改经 `push_gap(Block)`；`markdown_gap` 只保留判定，不再自己写行。
- 这些 1 行间距与条目末尾间距不叠加。

### 3.6 UI chrome

- 标题区标题下的 1 行、输入区与状态栏之间、状态栏与 dock 之间、dock 顶部分隔，统一引用 `CHROME_GAP`。
- 主内容左右外边距引用 `EDGE`。
- 不改变布局结构、高度计算、feed 三行下限和降级顺序；只把已有的空白行与 2ch 数值换成 token。

### 3.7 缓存、滚动与命中

- gap 行写进缓存的 `RenderedEntry.lines` / `hits`（hit = `None`），所以 `EntryOffset.height == rendered.lines.len()`，窗口切片与 `top + lines.len() == total_height` 不变。
- `CacheKey` 从五元组扩为含 `gap_after` 的六元组；`ensure` / `height` / `retain` 同步扩参；`render()` 先用相邻角色算 `gap_after` 再查缓存。
- 间距行没有 hit target；点击空行不触发展开。
- 相邻角色变化导致 `gap_after` 变化时，缓存键失效并重新测量。

## 4. 改动面与不做事项

- `crates/nano-theme/src/lib.rs` 与新增 `spacing` 模块：token 与 `Gap`。
- `crates/nano-transcript/src/render.rs`：`Unit` 角色、`gap_after` 计算与六元组缓存键、`push_gap`、Assistant / Preview 的 Section、Markdown 块间与表格前后空行、`INDENT` / `NESTED` 水平缩进 token、删除条目末尾与 context 段间的裸空行。
- `crates/nano-app/src/ui.rs`：`EDGE` / `CHROME_GAP` 替换列出的空白行与 2ch 数值；不改布局结构。
- `docs/decisions/2026-10-26-spacing-token-architecture.md`：新增 ADR，记录间距 token 与角色的长期归属。
- 测试：间距表、条目角色、截图场景、过程块间 1 行、卡内紧贴、最后一条底部 1 行、Markdown 不叠行、缓存键与滚动高度、100 / 60 列与 dark / light 渲染。
- 证据：确定性 fixture 覆盖“工具卡 → 思考 → 回答”和“Preview 状态/思考 → 正文”，100 / 60 列、dark / light；优先扩现有 `evidence_frame` 入口；如能真实复现同形状会话，再补真实 PTY 帧。fixture 明确标为测试数据。
- 不改颜色、列宽、面板内部布局、diff 预算、Markdown 解析、工具状态语义、工具 / diff 内部顺序；不新增 crate、协议字段、状态来源或跨事件关联机制；不做 CSS 式盒模型或逐组件任意边距。
- 如最小范围无法满足本规格，先报告实际缺口；不能自行扩大协议、组件职责或新增机制。

## 5. 有限验收

- [ ] 截图场景：Bash 卡 → “思考 已完成” 1 空行；“思考 已完成” → 回答正文 1 空行。
- [ ] 相邻工具卡之间 1 空行；工具卡 → 思考头 1 空行；只有思考的 Assistant → 工具卡 1 空行；卡内命令 / 输出仍紧贴。
- [ ] 用户消息 → 过程 / 回答 1 空行；回答 → 下一轮 / 下一条主块 1 空行；context / notice / echo 四周各 1 空行。
- [ ] 不带 reasoning 的 Assistant 回答前 1 空行；最后一条 entry 底部 1 空行；第一条 unit 没有前导空行；空 Assistant（text 与 reasoning 都为空）不渲染、不占间距。
- [ ] Preview：状态 / 思考 → 正文 1 空行；正文后的部分内容提示与工具参数行紧贴正文；工具参数行顺序不重排。
- [ ] Edit / 路径 / 统计之间 1ch、`push_two_column` 1ch 保持不变。
- [ ] 展开工具 / diff 内部顺序不变；任何边界都不出现连续两行空白。
- [ ] Markdown 标题组 / 列表组 / 段落 / 表格之间 1 行；同一列表、同一表格内部 0 行。
- [ ] 100 / 60 列、dark / light 下无布局跳动；滚动、锚点、缓存高度测试通过。
- [ ] transcript 的间距空行（条目末尾、context 段间、Markdown 块间 / 表格前后、Section）只经 `push_gap` 产生；用户续行、标签前导、工具正文、嵌套续行、列表续行分别引用 `INDENT` / `NESTED`；diff 4ch / 2ch 保持专用宽度。
- [ ] 相关 Rust 定向测试及工作区回归通过，`cargo fmt --check`、`git diff --check` 通过；证据可定位且无未处理已知阻断。

完成仅指本规格约定功能、正常 / 异常 / 边界 / 回归及证据齐全；不包含上线后观察天数，不自动新开观察单。

## 6. 机制清单

| 机制 | 解决什么 | 没有会怎样 |
|---|---|---|
| `nano-theme::spacing` token | 把边距、缩进、分隔行收成唯一来源 | 数值继续散在 render 与 layout 两处，改一处漏一处 |
| `Gap` 角色与折叠规则 | 区分条目内 Section、条目间 Block、紧贴 None，相邻取大 | 每个渲染点自己决定空几行，双空行和缺空行反复出现 |
| 条目角色 `Process / Answer / Turn`，gap 计入高度与缓存键 | 保留分类与间距角色；当前所有可见 unit 统一 `Block`，未来可恢复 `None`；gap 计入高度与缓存键 | 间距行与缓存高度脱节；未来调整密度要改渲染点 |
| `push_gap` 去重助手 | 同一条目内不叠空行 | Markdown 段落间距与条目间距叠成两行 |
| UI chrome gap token | 标题、输入、状态、dock 的空白与内容共用一套节奏 | 布局算术继续写裸 `+ 1`，与内容侧漂移 |

## 7. 自定细节

- `EDGE = 2`、`INDENT = 2`、`NESTED = 4`、`INLINE = 1`、`CHROME_GAP = 1`；与现有视觉数值一致，本次不改变宽度或行高。
- `Section` 与 `Block` 当前都是 1 行，但保留两个角色：以后要调整条目内 / 条目间密度时，不必再改渲染点。
- `Context`、`Notice`、`Echo` 都按 `Turn` 处理，四周 1 行；普通 context 合并组作为一个 Turn unit。
- 最后一条 unit 固定 `Block`，承担 transcript 底部 1 行留白；第一条没有前导间距。
- 工具 / diff 内部保持上游紧凑顺序，不采用设计稿 `.detail` 的上下 padding；思考展开详情也紧贴标题，只在“思考块 → 正文”边界加 Section。
- Preview 的状态 / 思考行视为过程摘要，紧贴；正文前加 Section；正文之后的部分内容提示与工具参数行是同一尝试的紧凑尾注，紧贴正文，不重排现有顺序。
- context / group 展开保持全宽，不新增 2ch 缩进；展开组段间的既有空行改走 `push_gap`，不再带 Toggle hit，组头和内容行仍可点。
- 空 Assistant（text 与 reasoning 都为空）沿用现有提前返回，不渲染、不占间距；`interrupted` 标记在空内容下同样不显示。
- `push_gap` 通过“最后一行所有 span 为空”判断已有空行；不引入新的行类型。
- 缓存键扩为含 `gap_after` 的六元组；gap 行写进缓存的 lines / hits（hit = None），`EntryOffset.height` 与窗口切片一致。
- 视觉规格的 Edit / 路径 / 统计 1ch 与 push_two_column 1ch 保持不变；diff 4ch 行号与 2ch 标记保持专用。
- UI 只替换列出的空白行与 2ch 数值，不改布局算法、高度降级或面板结构。
- 体量评估与结构选择：单份补充规格 + 一份 ADR、一张执行 issue；不改协议、布局结构和面板内部结构，但新增跨 crate token 层与缓存键扩展，不拆。

## 8. 审核修订记录

2026-10-26 方案期轻审（1 个审核 agent，用户点选轻审）：发现 11 项（高 1 / 中 3 / 低 7）；用户选择“改”，已按以下处置修订。发现原文见 PR #74 评论。

| # | 严重度 | 发现 | 处置 |
|---|---|---|---|
| 1 | 高 | 漏掉上游 §8.8“主块间距默认一行” | §1 把 §8.8 列入取代，并写出替换后的完整口径（过程组 0 行、过程→回答 1 行、其余 1 行） |
| 2 | 中 | Preview 的 Section 顺序与代码相反，验收缺口 | §3.3 改为“状态/思考 → 正文前 Section；正文后的提示与工具参数行紧凑尾注，不重排”；§4 证据与 §5 补 Preview |
| 3 | 中 | 间距产生点清单不完整，context 空行带 hit | §2.2 补齐 context 段间、Markdown 块间/表格前后；§3.3/§3.5 全部改走 `push_gap`；context 分隔行改零 hit |
| 4 | 中 | §3.4 给 context/group 加了不存在的 2ch 缩进 | §3.4 移除 context 缩进，明确保持全宽；§7 记录不新增 |
| 5 | 低 | 水平缩进盘点不完整 | §2.2 补用户续行、标签前导、四空格嵌套、列表续行；§3.1 增 `NESTED = 4`；§3.4/§5 同步 |
| 6 | 低 | “无条件追加空行”不准确，空 Assistant/首条未定义 | §2.2 标注提前返回；角色表补空 Assistant；§5/§7 补首条无前导与空 Assistant 不占间距 |
| 7 | 低 | gap 行落在哪一层、缓存键扩展未写清 | §3.7 明确 gap 行入 cached lines/hits（hit=None）、六元组缓存键、切片与总高一致；§6 机制 3 补此职责 |
| 8 | 低 | 1ch inline 未明确保留/验收 | §1、§3.4、§5、§7 明确 Edit/路径/统计 1ch 与 `push_two_column` 1ch 不变 |
| 9 | 低 | 新增跨 crate token 的 ADR 依据不足 | 新增 `docs/decisions/2026-10-26-spacing-token-architecture.md`；§1 改为“新增 ADR、无取代”；§4 列入改动面 |
| 10 | 低 | “结构无实质变化”表述偏高 | §7 改为“不改协议、布局结构和面板内部结构，但新增跨 crate token 层与缓存键扩展” |
| 11 | 低 | §1 把 `.detail` padding 与 `.process`/`.answer` 折叠混为一谈 | §1 拆开：`.process` 底 + `.answer` 顶折叠出 1 行；`.detail` padding 本次不采用 |

### 2026-10-26 实施后修订

用户实机截图指出思考头与工具卡连续堆叠仍无呼吸感；用户在间距卡选择“只留块间 1 行”。据此把 `Process → Process` 从 `None` 改为 `Block`，并同步 §3.2 间距表、§5 验收、§6 机制与 ADR；卡内命令 / 输出、工具 / diff 内部与 Preview 尾注仍保持紧贴。

§8 历史审核记录第 1 行的“过程组 0 行”是当时处置记录，已被本节取代；现行口径以 §1 / §3.2 为准。
