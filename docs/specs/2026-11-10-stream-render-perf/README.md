# [2026-11-10-stream-render-perf] 流式渲染性能：增量预览 + 帧预算 + 文本快路径

- 组标识：`2026-11-10-stream-render-perf`
- 角色：单份 spec（终稿）；实施拆 2 个 PR（P1 = 第 1 步；P2 = 第 2+3 步）
- 状态：方案期 · 终稿待送审
- Issue：待开（spec 合入后开执行 issue）
- 结构：不拆——1 份 spec + 1 张执行 issue + 2 个 PR
- 页面：无（纯 TUI 渲染管线改造，无可交互 GUI，2026-11-10 用户确认）
- 机制范围：流式 markdown 的分块渲染、帧调度预算、文本度量快路径。无新运行时依赖
- 上游参照：pi `#3785`（流式 markdown 分块缓存，5508ms → 659ms）、hermes `#67236`（按块增量渲染，1024 块 333.5s → 21.6s）、Ink 默认 `maxFps: 30`、string-width `#71`（ASCII 快路径 61–177x）
- 替代关系：不改既有 spec；#164（launcher 死循环）不在本范围，另开单
- ADR：本次新增 [ADR-20261110-markdown-render-parity](../../decisions/2026-11-10-markdown-render-parity.md)
- 下游：执行 issue（待开）

## 1. 目标

流式输出时，单会话 CPU 从「吃满一核」降到「≤0.3 核」，且单次刷新成本不再随回答长度增长：

1. **增量预览**：每个 `text-delta` 只重排「未稳定的尾块」，已稳定块命中缓存。
2. **帧预算**：内容刷新按时间合并（≤30 次/秒）；纯动画帧不重排整棵树。
3. **文本快路径**：ASCII 内容不走 `Intl.Segmenter`；绘制复用上一帧的换行结果。

不承诺：

- 不承诺「三步后 CPU 一定 ≤30%」。§6 给的是验收门槛；实测不达标按 §9 处置，不靠调门槛过关。
- 不承诺内存下降。1.1GB/会话的归因另开，见 §3.2。
- 不承诺**静态工具结果/展开详情**变快。它们已有模型层 LRU（`model.ts:524`，400 条），块缓存对静态文本零收益；本 spec 不覆盖它们（2026-11-10 用户确认收窄）。
- 不承诺视觉零差异。第 2 步改变动画节拍（26ms → 33ms）。

## 2. 当前事实与根因

基线：`origin/main` @ `913d151`；全局安装的 `dsh-tui-nano@0.2.5` 与本仓 `dist/` 逐字节一致（`shasum` 比对）。

| 事实 | 证据 |
|---|---|
| 每个 `text-delta` 都全量重排「到目前为止的整段回答」 | `src/conversation/controller.ts:548` → `model.ts:402`（notify）→ `:663`（layout 以 revision 为键）→ `:711`（`renderMarkdown(preview.text)`） |
| 展开的「思考」同样按全量重排 | `src/transcript/model.ts:696`（`renderMarkdown(preview.reasoning)`） |
| 全量渲染成本随长度线性增长 | 本机探针：4KB 1.35ms / 16KB 4.56ms / 48KB 13.22ms / 96KB 26.12ms；其中 lexer 仅 1.78ms@48KB |
| 单 delta 总成本随预览变长 | 本机探针（React update + frame）：4KB p50 2.20ms / 16KB 3.17ms / 48KB 9.33ms，p95 14.51ms |
| 只要有鲸鱼动画，每 26ms 无条件整屏重排（≈38fps），无脏检查 | `src/render/renderer.ts:305` + `:209`（`scheduleFrame` → `setImmediate` → 全量 `frame()`） |
| 单帧绘制成本本身不高 | 本机探针：40 行屏 `frame()` p50 0.39ms / p95 1.08ms |
| 每个 text 节点每帧都重做换行，measure 结果未复用 | `src/render/renderer.ts:452`（`wrapText`）vs `src/render/host.ts:282`（`node.lines`） |
| 文本切分全程走 `Intl.Segmenter`，ASCII 也走 | `src/render/text.ts:8`、`:29`；ASCII 48KB wrap 15.4ms，中文 49.3ms |
| 主线程采样：逐字切分 + 每字对象分配约占四成 | 本机 `sample 46618` 4s：主线程 76% 在 `uv__run_check`；叶子帧 ICU `RuleBasedBreakIterator` + V8 分配/查表合计约 40% |
| 运行态体量：8 会话 / 28 个 node 进程 / 4.5GB RSS | 本机 `ps -Ao pid,ppid,%cpu,rss,etime,command` 聚合 |

根因：**预览渲染没有「稳定前缀」概念**，每个 delta 从零重算全文；**帧调度没有预算**，动画与内容更新共用一个无条件的全量重排循环。成本 = 回答长度 × delta 次数。

## 3. 范围与边界

### 3.1 本次做

| 步 | 改哪里 | 做什么 |
|---|---|---|
| 1 增量预览 | 新增 `src/transcript/blocks.ts`；`src/transcript/model.ts:684` `previewUnit`；`src/transcript/markdown.ts:24` `renderMarkdown` | 行扫描器跟踪代码围栏状态，把文本切成「稳定块 + 尾巴」；稳定块渲染一次进块缓存，每个 delta 只渲染尾巴；预览、最终消息、展开的思考共用这条路径 |
| 2 帧预算 | `src/app/nano-app.ts:910` `scheduleRender`；`src/render/renderer.ts:209/245/305` | 内容刷新按 33ms 合并（末帧必补）；纯动画帧复用上帧图片坐标，跳过 layout/paint/diff |
| 3 文本快路径 | `src/render/text.ts:29` `graphemes`、`:48` `displayWidth`；`src/render/renderer.ts:452` `paintText` | 纯可打印 ASCII 直接按码元切分/取长度；`paintText` 复用上一帧换行结果 |

### 3.2 本次不做

- **静态工具结果 / 展开详情分块化**：已有模型层 LRU，块缓存对其零收益（2026-11-10 用户确认收窄）。
- **内存归因**（1.1GB/会话）：另开一条线，用 `node --heapsnapshot-signal=SIGUSR2` 抓快照；本 spec 只记一句「本次不修」。
- **`string-width` 升 8.x**：已有按 grapheme 的宽度缓存，收益有限，且会引入 emoji 宽度规则变化的视觉回归。
- **进程链瘦身**（每会话 4 个 node 进程、约 150MB 空壳）：属启动架构。
- **issue #164**（launcher 终端挂断后死循环）：不同根因与验证方式，另开单。

## 4. 主路（步｜触发 → 响应｜失败 / 空态｜落点 · 依据）

| 步 | 触发 → 响应 | 失败 / 空态 | 落点 · 依据 |
|---|---|---|---|
| 1 | `text-delta` 到达 → 切出稳定块 + 尾巴；命中块缓存的部分不重排 | 围栏未闭合 → 尾部整体留到闭合；含引用式链接定义 → 本次走全量并计数 | `blocks.ts`；规则见 §5.1 |
| 2 | 内容更新 / 动画帧 → 距上次绘制 <33ms 则合并；末次必补 | 输入回显、滚动、resize、退出、中断、审批/问卷弹出 → 立即绘制，不节流 | `nano-app.ts` / `renderer.ts`；见 §5.2 |
| 3 | 文本进入 `graphemes` / `displayWidth` / `paintText` → ASCII 走快路径 | 含非 ASCII 或控制符 → 走原 `Intl.Segmenter` 路径 | `text.ts` / `renderer.ts`；见 §5.3 |

## 5. 行为规则

### 5.1 分块边界（第 1 步）

- 边界 = **代码围栏之外的空行**；围栏内（``` / ~~~）的空行不切。
- 表格行（`|` 开头）连成一块，不在中间切。
- 尾部未闭合的围栏、未完成的行，留在尾巴里直到闭合/换行到达。
- 块缓存的键：`width|indent|lead|块原文`；LRU 512 块，超出淘汰最旧。
- **不变式**：任一时刻，分块渲染结果必须与 `renderMarkdown(全文)` **逐行相等**（行文本、缩进、tone 一致）。最终消息走同一路径，因此 settle 不跳版。见 ADR-20261110-markdown-render-parity。
- 退化：文本含引用式链接定义（`^ {0,3}\[[^\]]+\]:`）时，本次预览改走全量渲染，并记一次计数；计数只在 `NANO_DEBUG_RENDER=1` 时写入诊断行。

### 5.2 帧预算（第 2 步）

- 内容更新：最小间隔 33ms；连续更新时丢弃中间帧，**最后一帧必须画**（trailing timer，`unref()`）。
- 立即绘制（绕过节流）：输入回显、滚动、resize、退出/中断、审批卡与问卷卡出现/消失。
- 纯动画帧：仅重发鲸鱼图，复用上一帧的图片坐标；不跑 React、不重算 layout、不重建 screen、不 diff。
- 动画节拍：26ms → 33ms；`NANO_REDUCED_MOTION=1` 时仍然完全静止。
- 不加配置开关（2026-11-10 用户确认）：只有 `NANO_REDUCED_MOTION` 这一个既有开关。

### 5.3 快路径边界（第 3 步）

- 快路径条件：整串落在 `\u0020–\u007E` 与 `\n`，不含 `\t` 与控制符。
- `graphemes` 快路径返回逐码元数组；`displayWidth` 快路径返回「长度 − 换行数」。
- `paintText` 的换行缓存键：`text` 引用 + `width`；两者未变即复用，否则重算。
- 其余输入逐字保持现状，不新增宽度表、不改 `WIDTH_OVERRIDES`。

## 6. 验收

### 6.1 机械验收（合并前全绿）

| 项 | 门槛 | 命令 |
|---|---|---|
| 单 delta 成本（48KB 预览，p95） | ≤2ms（现状 14.51ms） | `node scripts/bench-stream.mjs` |
| 4KB 与 48KB 的 delta 成本比 | ≤1.5x（现状约 4x） | 同上 |
| `frame()` 成本（40 行屏） | 不劣化（现状 p50 0.39ms） | 同上 |
| 增量 vs 全量一致性 | 随机切点（≥200 个）逐行相等 | `tests/unit/blocks.test.ts` |
| 既有性能预算 | `tests/unit/perf.test.ts` 全绿，streaming 预算 50ms → 8ms | `npm test` |
| 类型与 lint | `npm run typecheck`、`npm run lint` 绿 | — |

门槛取值方式：先落 `scripts/bench-stream.mjs`，用**改动前**基线跑一遍，再按 §6.1 的绝对值验收；若脚本基线与 §2 的探针数字偏差 >20%，以脚本为准并在 PR 里注明。

### 6.2 行为验收（PTY 实测，同单证据）

- 单会话流式输出 30 秒窗口，`top -pid <pid>` 平均 CPU ≤30%（现状 60–100%）。
- 空闲但鲸鱼动画可见，同窗口平均 CPU ≤5%。
- 交互不退化：输入回显、滚动、resize 无可见延迟；审批卡弹出即时可见。
- 视觉：一次长回答（含代码块、表格、列表）从流式到 settle 无跳版；PTY 截图对比作证。

## 7. 机制清单

| 机制 | 位置 | 状态 |
|---|---|---|
| 分块扫描 + 块缓存 | `src/transcript/blocks.ts`（新） | 待建 |
| 帧预算（合并 + 末帧补 + 动画帧跳过） | `src/app/nano-app.ts`、`src/render/renderer.ts` | 改 |
| ASCII 快路径 + 换行复用 | `src/render/text.ts`、`src/render/renderer.ts` | 改 |
| 基准脚本 | `scripts/bench-stream.mjs`（新） | 待建 |
| 长决策 | `docs/decisions/2026-11-10-markdown-render-parity.md` | 本 PR 落 |

## 8. 证据

### 8.1 spec 期探针（本 PR 可复跑）

- 探针方式：vitest 临时用例挂载 `App` + `Renderer`，构造 1200 行 transcript，按 4KB/16KB/48KB 逐步 `setPreview` 并计时；跑完即删，结论进 §2。
- 采样方式：`sample <pid> 4 -f` 聚合主线程叶子帧；`ps`/`top` 取进程与线程级 CPU。
- 外部基准：pi `#3785`、hermes `#67236` 的公开数据（见头部「上游参照」），只作参照，不作本仓数字。

### 8.2 实施期证据（待补）

- `scripts/bench-stream.mjs` 改动前后两轮输出。
- 一致性 property test 的切点数与结果。
- PTY 会话的 CPU 采样与截图。

## 9. 风险与回退

| 风险 | 影响 | 回退 |
|---|---|---|
| 分块与全量不一致（围栏、表格、列表、setext） | 预览错行或 settle 跳版 | 一致性 property test 拦；必要时该 delta 退化全量 |
| 节流引入输入延迟 | 打字/滚动发涩 | 输入等路径绕过节流；33ms 可回调 |
| 快路径把 `\t` 当普通字符 | 表格/缩进错位 | 快路径条件排除控制符；补 tab 用例 |
| 两个 PR 的收益无法归因 | 出问题不知退哪个 | P1 先量一次（目标 ~0.3 核），P2 再量增量 |

## 10. DoR 自查

| 判据 | 结论 |
|---|---|
| 承重规则与已确认做法一致，无未决承重问题 | 是（§11 列出的默认值均可识别、可改） |
| 行为有触发/响应/失败/空态 | 是（§4、§5） |
| 验收能判对错，有命令与断言 | 是（§6.1 命令与阈值；§6.2 采样口径） |
| 数据迁移/回滚/兼容/外部合同 | 不适用：无数据迁移、无外部契约；回退按 §9 逐个 PR 回退 |
| ADR 一致 | 是：本 PR 新增 ADR-20261110-markdown-render-parity，spec 只链不抄 |

## 11. 自定细节（agent 决定的默认值，可改）

| 细节 | 取值 | 理由 |
|---|---|---|
| 块缓存容量 | 512 块 | 一屏约 40 行、常见回答几十块；512 足够覆盖最近几轮 |
| 尾块重渲染阈值 | 每个 delta 都重渲染尾块 | 尾块通常 <1KB，成本可忽略；避免引入第二个计时器 |
| 退化计数出口 | `NANO_DEBUG_RENDER=1` 写诊断行 | 不污染正常日志，测试可直接断言 |
| 33ms 常量位置 | `src/app/nano-app.ts` 单点常量 | 与动画节拍同源，避免两处漂移 |
| 基准脚本输出 | JSON + 人读表 | 便于 CI 与人工对比 |

## 12. 审核修订记录

（待送审后追加）
