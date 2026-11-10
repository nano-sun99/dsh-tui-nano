# [2026-11-10-stream-render-perf] 流式渲染性能：增量预览 + 帧预算 + 文本快路径

- 组标识：`2026-11-10-stream-render-perf`
- 角色：单份 spec（骨架；拆分由用户在公共缺口闭合后选）
- 状态：方案期 · 骨架（Draft PR）
- Issue：待开（spec 合入后按流程开执行 issue）
- 结构：待定（不拆 / 拆 3 份），见 §10 缺口 G5
- 机制范围：渲染管线的三处内部机制——流式预览的分块渲染、帧调度预算、文本度量快路径。暂定**无新运行时依赖**
- 页面：无（纯 TUI 性能改造，无可交互 GUI；待用户确认）
- 上游参照：pi `#3785`（流式 markdown 分块缓存，实测 5508ms → 659ms）、hermes `#67236`（按块增量渲染，1024 块 333.5s → 21.6s）、Ink 默认 `maxFps: 30`、string-width `#71`（ASCII 快路径 61–177x）
- 替代关系：不改既有 spec；与 issue `#164`（launcher 终端挂断后死循环）的关系见 §10 G4
- ADR：待判（若「预览与最终消息共用同一套分块渲染」被定为长期约束，需落 ADR）
- 下游：待开执行 issue

## 1. 目标

流式输出时，单会话 CPU 从「吃满一核」降到「≤0.3 核」，且成本不再随回答长度增长：

1. **增量预览**：每个 `text-delta` 只重排「最后一个未稳定块」，已稳定块不重排。
2. **帧预算**：渲染按时间合并（≤30 次/秒）；纯动画帧不重排整棵树。
3. **文本快路径**：ASCII 内容不走 `Intl.Segmenter`；绘制复用 measure 阶段的换行结果。

不承诺：

- 不承诺「三步后 CPU 一定 ≤30%」——§6 给的是验收门槛，实测不达标就按 §9 回退或调范围。
- 不承诺内存下降。本次不动内存（1.1GB/会话的归因另开，见 §3.2）。
- 不承诺视觉零差异。第 2 步会改变动画节拍（26ms → 33–50ms）；第 1 步要求「预览与最终消息逐行一致」，但该要求本身待确认（§10 G1）。

## 2. 当前事实与根因

基线：`origin/main` @ `913d151`；全局安装的 `dsh-tui-nano@0.2.5` 与本仓 `dist/` 逐字节一致（`shasum` 比对）。

| 事实 | 证据 |
|---|---|
| 每个 `text-delta` 都全量重排「到目前为止的整段回答」 | `src/conversation/controller.ts:548` → `setPreview` → `src/transcript/model.ts:402`（notify）+ `:663`（layout 以 revision 为键）+ `:711`（`renderMarkdown(preview.text)`） |
| 全量渲染成本随长度线性增长 | 本机探针：4KB 1.35ms / 16KB 4.56ms / 48KB 13.22ms / 96KB 26.12ms；其中 lexer 仅占 1.78ms@48KB |
| 单个 delta 的总成本随预览变长 | 本机探针（React update + frame）：4KB p50 2.20ms / 16KB 3.17ms / 48KB 9.33ms，p95 14.51ms |
| 只要有鲸鱼动画，每 26ms 无条件整屏重排（≈38fps），无脏检查 | `src/render/renderer.ts:305`（`setTimeout(..., 26)`）+ `:209`（`scheduleFrame` → `setImmediate` → 全量 `frame()`） |
| 单帧绘制成本本身不高（0.39ms p50），高的是每 delta 的布局+markdown | 本机探针：40 行屏 `frame()` p50 0.39ms / p95 1.08ms |
| 每个 text 节点每帧都重做换行，measure 阶段的结果被丢弃 | `src/render/renderer.ts:452`（`wrapText`）vs `src/render/host.ts:282`（`node.lines` 已存） |
| 文本切分全程走 `Intl.Segmenter`，ASCII 也走 | `src/render/text.ts:8`、`:29`；实测 ASCII 48KB wrap 15.4ms，中文 49.3ms |
| 主线程采样里，逐字切分 + 每字对象分配约占四成 | 本机 `sample 46618` 4s：主线程 76% 在 `uv__run_check`；叶子帧 ICU `RuleBasedBreakIterator` + V8 分配/查表合计约 40% |
| 运行态体量：8 会话 / 28 个 node 进程 / 4.5GB RSS；单会话 1:55 内累计 26:52 CPU | 本机 `ps -Ao pid,ppid,%cpu,rss,etime,command` 聚合 |

根因：**预览渲染没有「稳定前缀」概念**，每个 delta 从零重算全文；同时**帧调度没有预算**，动画与内容更新共用一个无条件的全量重排循环。两者叠加，成本 = 回答长度 × delta 次数。

## 3. 范围与边界

### 3.1 本次做（三步，按此顺序落地与验收）

| 步 | 改哪里 | 做什么 |
|---|---|---|
| 1 增量预览 | 新增 `src/transcript/stream-blocks.ts`；`src/transcript/model.ts:684` `previewUnit` | 行扫描器跟踪代码围栏状态，切「稳定块 + 尾巴」；稳定块只渲染一次并入缓存，每个 delta 只渲染尾巴 |
| 2 帧预算 | `src/app/nano-app.ts:910` `scheduleRender`；`src/render/renderer.ts:209/305` | 渲染按时间合并（最小间隔 33ms、末帧补 flush）；纯动画帧复用上帧图片坐标，跳过 layout/paint/diff |
| 3 文本快路径 | `src/render/text.ts:29` `graphemes`、`displayWidth`；`src/render/renderer.ts:452` | 纯可打印 ASCII 直接按码元切分/取长度（排除 `\t` 与控制符）；`paintText` 复用 `node.lines` |

### 3.2 本次不做

- **内存归因**（1.1GB/会话）：另开一条线，用 `node --heapsnapshot-signal=SIGUSR2` 抓快照；本次不猜、不改。
- **`string-width` 升 8.x**：nano 已按 grapheme 缓存宽度，收益有限，且会引入 emoji 宽度规则变化的视觉回归风险。
- **进程链瘦身**（每会话 4 个 node 进程、约 150MB 空壳）：属启动架构，与本次渲染无关。
- **issue #164**（launcher 死循环）：不同故障面，是否并入见 §10 G4。

## 4. 主路（步｜触发 → 响应｜失败 / 空态｜落点 · 依据）

| 步 | 触发 → 响应 | 失败 / 空态 | 落点 · 依据 |
|---|---|---|---|
| 1 | `text-delta` 到达 → 只在尾巴上重新渲染，稳定块命中缓存 | 围栏未闭合 / 引用式链接定义出现 → 退化为全量渲染（正确但慢），并计数 | `stream-blocks.ts`；边界规则见 §5.1 |
| 2 | 内容或动画触发重绘 → 若距上次绘制 <33ms 则合并；末次必补 | 输入、resize、退出、中断 → 绕过节流立即绘制 | `nano-app.ts` / `renderer.ts`；见 §5.2 |
| 3 | 文本进入 `graphemes` / `displayWidth` / `paintText` → ASCII 走快路径 | 含非 ASCII 或控制符 → 走原 `Intl.Segmenter` 路径 | `text.ts`；见 §5.3 |

## 5. 行为规则

### 5.1 分块边界（第 1 步）

- 边界 = **代码围栏之外的空行**；围栏内的空行不切。
- 尾块未闭合的围栏、未完成的行，留在尾巴里直到闭合/换行到达。
- 不变式（待确认，见 §10 G1）：任一时刻，`增量渲染结果` 必须与 `renderMarkdown(全文)` **逐行相等**；若最终消息也用同一套分块渲染，则 settle 时不跳版。
- 退化条件：出现引用式链接定义（`^\[.*\]:`）→ 本次预览改为全量渲染。

### 5.2 帧预算（第 2 步）

- 内容更新：最小间隔 33ms；连续更新时最多丢中间帧，**最后一帧必须画**。
- 输入回显、resize、退出、中断：不节流，立即绘制。
- 纯动画帧：仅重发鲸鱼图，不重算 layout、不重建 screen、不 diff。
- 动画节拍：26ms → 33–50ms（具体值见 §10 G2）；`NANO_REDUCED_MOTION=1` 仍完全静止。

### 5.3 快路径边界（第 3 步）

- 快路径条件：字符串全部落在 `\u0020–\u007E` 与 `\n`；不含 `\t` 与控制符。
- `graphemes` 快路径返回逐码元数组；`displayWidth` 快路径返回「长度 − 换行数」。
- 其余情况逐字保持现状，不引入新宽度表、不改 `WIDTH_OVERRIDES`。

## 6. 验收

### 6.1 机械验收（合并前全绿）

| 项 | 门槛 |
|---|---|
| 单 delta 成本（48KB 预览，p95） | ≤2ms（现状 14.5ms） |
| 4KB 与 48KB 的 delta 成本比 | ≤1.5x（现状约 4x） |
| `frame()` 成本（40 行屏） | 不劣化（现状 p50 0.39ms） |
| 增量 vs 全量一致性 | 随机切点重放，逐行相等（property test，≥200 个切点） |
| 既有预算 | `tests/unit/perf.test.ts` 全部通过，且 streaming 预算由 50ms 收到 8ms 级 |

### 6.2 行为验收（PTY 实测，同单证据）

- 单会话流式输出期间：`top -pid <pid>` 平均 CPU ≤30%（现状 60–100%）。
- 空闲但动画可见：平均 CPU ≤5%。
- 交互不退化：输入回显、滚动、resize 无可见延迟。

## 7. 机制清单

| 机制 | 位置 | 状态 |
|---|---|---|
| 分块扫描 + 稳定块缓存 | `src/transcript/stream-blocks.ts`（新） | 待建 |
| 帧调度预算 | `src/app/nano-app.ts`、`src/render/renderer.ts` | 改 |
| ASCII 快路径 | `src/render/text.ts` | 改 |
| 基准脚本 | `scripts/bench-stream.mjs`（新） | 待建 |

## 8. 证据

### 8.1 spec 期探针（本 PR 可复跑）

- 探针方式：vitest 临时用例挂载 `App` + `Renderer`，构造 1200 行 transcript，按 1KB/4KB/48KB 三档逐步 `setPreview` 并计时；跑完即删，只留结论与复跑说明。
- 采样方式：`sample <pid> 4 -f` 聚合主线程叶子帧。
- 原始数字见 §2 表格；外部参照见头部「上游参照」。

## 9. 风险与回退

| 风险 | 影响 | 回退 |
|---|---|---|
| 分块渲染与全量渲染不一致（围栏、列表、setext） | 预览出现错行或 settle 跳版 | 一致性 property test 拦；必要时该 delta 退化全量 |
| 节流引入输入延迟 | 打字/滚动发涩 | 输入路径绕过节流；阈值可调 |
| 快路径把 `\t` 当普通字符 | 表格/缩进错位 | 快路径条件排除控制符；补 tab 用例 |
| 三步一起上，收益无法归因 | 出问题不知回退哪步 | 按 1→2→3 各自独立 PR 与验收 |

## 10. 待解决问题（公共缺口，未闭合不定终稿）

- **G1**：`增量渲染结果 == 全量渲染结果` 是硬要求吗？最终消息是否也改走分块渲染（保证不跳版）？
- **G2**：动画节拍取 33ms 还是 50ms？是否给用户开关？
- **G3**：验收门槛（≤2ms / ≤30%）按现状数字直接定，还是先在仓内沉淀基准脚本、用脚本数字定？
- **G4**：issue #164（launcher 死循环吃满一核）是否并入本 spec 的范围？
- **G5**：拆不拆——3 个独立 PR（可分别验收/回退）vs 1 个 PR。
- **G6**：内存那 1.1GB 是否要在本 spec 里给一条「只观测、不修」的验收项？

## 11. DoR 自查

待 §10 闭合后填写。

## 12. 审核修订记录

（空）
