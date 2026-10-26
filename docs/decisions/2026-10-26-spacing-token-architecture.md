# ADR-20261026-spacing-token-architecture：间距由共享 token 与角色统一

- 状态：生效中
- 日期：2026-10-26
- 决策人：用户
- 适用范围：Nano 自有界面的横向边距 / 缩进、transcript 垂直间距、UI chrome 分隔
- 取代：无
- 被取代：无
- 决策来源：2026-10-26 本次会话。用户截图指出“思考 已完成”与正文之间没有间距，要求“总体设计出发……一套统一的边距架构，而不是每个地方零零散散地写”；间距档位卡选择“按设计稿收紧过程组（推荐）”；机制卡 5 项选择“全要（推荐）”。实施后用户再次截图指出过程块仍无呼吸感，选择“只留块间 1 行”。

## 决定

- `nano-theme::spacing` 是 Nano 间距 token 的唯一来源：`EDGE = 2`、`INDENT = 2`、`NESTED = 4`、`INLINE = 1`、`CHROME_GAP = 1`；垂直 `Gap` 角色 `None / Section / Block`，相邻取 `max`。
- transcript 条目用 `Process / Answer / Turn` 角色计算相邻间距：过程块之间 1 行，过程 → 回答 1 行，其他主块 1 行；条目内只在 Assistant / Preview 的过程 → 正文边界加 `Section`。卡内命令 / 输出、工具 / diff 内部保持紧贴。
- 渲染器不再各自写裸空行或裸 2ch / 4ch 缩进；UI chrome 的空白行引用 token。
- 工具 / diff 内部保持既有紧凑顺序；设计稿 `.detail` 的上下 padding 本决定不采用。

## 依据

- 截图：Bash 卡 → 思考 → 回答，思考与正文 0 行；上游 §4.6 / §8.8 又要求同级主块 1 行。代码没有统一层，两个规则同时落空。
- 实施后截图：思考头、工具卡连续堆叠仍无间隔；用户要求只补块间 1 行，卡内保持紧贴。
- 设计稿：`.process` 底 1 行、`.answer` 顶 1 行，折叠后 1 行；`--line` 单行节奏；2ch 缩进。
- 上游规格：2ch 边距、1ch inline、diff 4ch / 2ch 固定宽度继续生效。

## 否决了什么

- 不做 CSS 式盒模型、逐组件任意边距、新 crate、协议 / 状态来源扩展。
- 不改颜色、列宽、面板内部布局、diff 预算、Markdown 解析、工具 / diff 内部顺序。

## 接受的代价

- 缓存键与高度计算要带上 gap 角色；间距行不产生 hit；context 展开组的分隔空行不再可点击（周围行仍可点）。
- 以后调整密度要改角色表 / token，而不是逐点改空行。

## 允许重开的条件

- 用户明确要求改变过程组密度或引入第二种间距节奏。
- 新界面 / 终端能力需要不同的间距单位或折叠规则。
- 真实终端证据表明统一节奏无法同时满足可读性与窄屏降级。

## 关联

- 规格：[2026-10-26-nano-spacing-system](../specs/2026-10-26-nano-spacing-system/README.md)
- 上游规格：[2026-10-25-nano-visual-interaction-alignment](../specs/2026-10-25-nano-visual-interaction-alignment/README.md)、[2026-10-26-nano-input-preview-rendering](../specs/2026-10-26-nano-input-preview-rendering/README.md)

## 修订记录

- 2026-10-26：实施后用户实机截图指出过程块仍无呼吸感，选择“只留块间 1 行”。决定中的“过程组内 0 行”改为“过程块之间 1 行”；卡内命令 / 输出、工具 / diff 内部与 Preview 尾注仍紧贴。
