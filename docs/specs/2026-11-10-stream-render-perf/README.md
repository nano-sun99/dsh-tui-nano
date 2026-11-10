# [2026-11-10-stream-render-perf] 流式渲染性能：增量预览 + 帧预算 + 文本快路径

- 组标识：`2026-11-10-stream-render-perf`
- 角色：单份 spec（终稿 · 按轻审修订后）；实施拆 2 个 PR（P1 = 第 1 步；P2 = 第 2+3 步）
- 状态：方案期 · 待合并
- Issue：待开（spec 合入后开执行 issue）
- 结构：不拆——1 份 spec + 1 张执行 issue + 2 个 PR
- 页面：无（纯 TUI 渲染管线改造，无可交互 GUI，2026-11-10 用户确认）
- 机制范围：流式 markdown 的分块渲染、帧调度预算、文本度量快路径。无新运行时依赖
- 基线：`origin/main` @ `69d531e`（全部 `file:line` 按此核）
- 上游参照：pi `#3785`、hermes `#67236`、Ink 默认 `maxFps: 30`、string-width `#71`
- 替代关系：不改既有 spec；#164（launcher 死循环）不在本范围，另开单
- ADR：本次新增 [ADR-20261110-markdown-render-parity](../../decisions/2026-11-10-markdown-render-parity.md)（同一条决定的唯一正文；本 spec 只链不抄）
- 下游：执行 issue（待开）

## 1. 目标

流式输出时，单会话 CPU 从「吃满一核」降到「≤0.3 核」，且单次刷新成本不再随**已稳定文本**增长：

1. **增量预览**：每个 `text-delta` 只重排尾块，已稳定块命中缓存；尾块有上界（§5.1）。
2. **帧预算**：内容刷新按时间合并（≤30 次/秒）；纯动画帧不重排整棵树。
3. **文本快路径**：ASCII 内容不走 `Intl.Segmenter`；绘制复用上一帧的换行结果。

三步合计目标 ≤0.3 核；P1 单独预期 ≤0.4 核（增量预览是主因），P2 收尾到底噪。

不承诺：

- 不承诺「三步后 CPU 一定 ≤30%」。§6 给的是验收门槛；实测不达标按 §9 处置，不靠调门槛过关。
- 不承诺内存下降。单会话峰值 footprint 1.1GB、8 会话合计 RSS 4.5GB（口径见 §2），归因另开。
- 不承诺**静态工具结果/展开详情**变快：它们已有模型层 LRU（`model.ts:167` / `:424`），块缓存对静态文本零收益，本次不覆盖。
- 不承诺视觉零差异：第 2 步改变动画节拍（26ms → 33ms）；第 1 步在**未闭合长块**的冻结边界处可能有一次高亮差异（§5.1、§9）。

## 2. 当前事实与根因

基线：`origin/main` @ `69d531e`；全局安装的 `dsh-tui-nano@0.2.5` 与本仓 `dist/` 逐字节一致（`diff -rq` 无输出）。

| 事实 | 证据 |
|---|---|
| 每个 `text-delta` 都全量重排「到目前为止的整段回答」 | `src/conversation/controller.ts:551` → `model.ts:402`（notify）→ `:663`（layout 以 revision 为键）→ `:711`（`renderMarkdown(preview.text)`） |
| 展开的「思考」同样按全量重排 | `src/transcript/model.ts:696`（`renderMarkdown(preview.reasoning)`） |
| 全量渲染成本随长度线性增长 | 临时探针（vitest，跑完即删，见 §8.1）：4KB 1.35ms / 16KB 4.56ms / 48KB 13.22ms / 96KB 26.12ms；其中 lexer 仅 1.78ms@48KB |
| 单 delta 总成本随预览变长 | 同上探针（React update + frame）：4KB p50 2.20ms / 16KB 3.17ms / 48KB 9.33ms，p95 14.51ms |
| 只要有鲸鱼动画，每 26ms 无条件整屏重排（≈38fps），无脏检查 | `src/render/renderer.ts:305` + `:209`（`scheduleFrame` → `setImmediate` → 全量 `frame()`，`:245`） |
| 单帧绘制成本本身不高 | 同上探针：40 行屏 `frame()` p50 0.39ms / p95 1.08ms |
| 每个 text 节点每帧都重做换行，measure 结果未复用 | `src/render/renderer.ts:452`（`wrapText`）vs `src/render/host.ts:282`（`node.lines`） |
| 文本切分全程走 `Intl.Segmenter`，ASCII 也走 | `src/render/text.ts:8`、`:29`；探针：ASCII 48KB wrap 15.4ms，中文 49.3ms |
| 主线程 CPU 集中在逐字切分与每字分配 | `sample 46618` 4s：主线程 76% 在 `uv__run_check`；叶子帧 ICU `RuleBasedBreakIterator` + V8 分配/查表合计约 40% |
| 单会话进程 CPU 尖峰 | 同口径 `ps -Ao %cpu` 多次采样：同一会话 63%–104%（该口径是近期窗口均值，不是生涯均值） |
| 静态工具结果的重复渲染已被缓存 | `model.ts:167`（`RENDER_CACHE_MAX = 400`）、`:424`（`cachedRows`，键含 width/expanded/version） |
| 运行态体量 | `ps` 聚合：8 个会话、28 个 node 进程、RSS 合计 4.5GB；单会话峰值 physical footprint 1.1GB（`sample` 报的 peak） |

根因：**预览渲染没有「稳定前缀」概念**，每个 delta 从零重算全文；**帧调度没有预算**，动画与内容更新共用一个无条件的全量重排循环。成本 = 已稳定文本长度 × delta 次数。

## 3. 范围与边界

### 3.1 本次做

| 步 | 改哪里 | 做什么 |
|---|---|---|
| 1 增量预览 | 新增 `src/transcript/blocks.ts`；`model.ts:684` `previewUnit`；`model.ts:498` 助手消息单元；`markdown.ts:28` `renderMarkdown` | 行扫描器把文本切成「稳定块 + 尾块」，尾块有上界；稳定块渲染一次进块缓存 |
| 2 帧预算 | `src/app/nano-app.ts:910` `scheduleRender`；`src/render/renderer.ts:209`/`:245`/`:305` | 内容刷新按 33ms 合并（末帧必补）；纯动画帧复用上帧图片坐标，跳过 layout/paint/diff |
| 3 文本快路径 | `src/render/text.ts:29` `graphemes`、`:48` `displayWidth`；`src/render/renderer.ts:452` `paintText` | 纯可打印 ASCII 直接按码元切分/取长度；`paintText` 复用上一帧换行结果 |

**分块渲染的入口（唯一答案，共 3 处）**：

1. 预览正文：`model.ts:711`
2. 预览中展开的思考：`model.ts:696`
3. settle 后的助手消息：`model.ts:498`

不在这三处之列的都不改：`thinkingUnit`（`model.ts:625`，settle 后的思考）、工具结果/展开详情、问卷详情（`src/app/question-card.ts:113`）。

### 3.2 本次不做

- **静态工具结果 / 展开详情 / settle 后的思考分块化**：已有模型层 LRU，块缓存对静态文本零收益。
- **内存归因**：另开一条线，用 `node --heapsnapshot-signal=SIGUSR2` 抓快照；本 spec 只记「本次不修」。
- **`string-width` 升 8.x**：已有按 grapheme 的宽度缓存，收益有限，且会引入 emoji 宽度规则变化的视觉回归。
- **进程链瘦身**（每会话 4 个 node 进程）：属启动架构。
- **issue #164**（launcher 终端挂断后死循环）：不同根因与验证方式，另开单。

## 4. 主路（步｜触发 → 响应｜失败 / 空态｜落点 · 依据）

| 步 | 触发 → 响应 | 失败 / 空态 | 落点 · 依据 |
|---|---|---|---|
| 1 | `text-delta` 到达 → 切出稳定块 + 尾块；稳定块命中缓存 | 围栏未闭合且超过尾块上界 → 冻结前缀、只重排尾部；含引用式链接定义 → 全文走全量并计数 | `blocks.ts`；规则见 §5.1 |
| 2 | 内容更新 / 动画帧 → 距上次绘制 <33ms 则合并；末次必补 | 输入回显、滚动、resize、退出、中断、审批/问卷弹出 → 立即绘制，不节流 | `nano-app.ts` / `renderer.ts`；见 §5.2 |
| 3 | 文本进入 `graphemes` / `displayWidth` / `paintText` → ASCII 走快路径 | 含非 ASCII 或控制符 → 走原 `Intl.Segmenter` 路径 | `text.ts` / `renderer.ts`；见 §5.3 |

## 5. 行为规则

### 5.1 分块与尾块上界（第 1 步）

- 边界 = **代码围栏之外的空行**；围栏内（``` / ~~~）的空行不切。
- 表格行（`|` 开头）连成一块，不在行间切。
- **尾块上界**：尾块超过 `TAIL_MAX_LINES`（默认 200 行）时，把超出的前缀**冻结**为稳定块，只保留最后 200 行参与重排。
  - 未闭合围栏的冻结：前缀按「显式闭合的代码块」渲染；尾块带同一语言标记渲染。边界处 Prism 的跨行 token 状态可能不同，视觉上允许一次差异；settle 后由全文渲染覆盖。
  - 表格的冻结：按整行冻结，行间无跨行状态，无差异。
- 块缓存键：`width|indent|lead|块原文`；LRU 512 块。
- 退化：文本含引用式链接定义（`^ {0,3}\[[^\]]+\]:`）时，**该文本的全部入口**（预览正文、展开思考、settle 后的助手消息）都走全量渲染，并记一次计数；计数在 `NANO_DEBUG_RENDER=1` 时写诊断行。
- **不变式**（唯一正文在 [ADR-20261110-markdown-render-parity](../../decisions/2026-11-10-markdown-render-parity.md)）：已稳定部分必须与全文渲染的对应行逐行相等；settle 时对全文再校验一次。

### 5.2 帧预算（第 2 步）

- 内容更新：最小间隔 33ms；连续更新时丢弃中间帧，**最后一帧必须画**（trailing timer，`unref()`）。
- 立即绘制（绕过节流）：输入回显、滚动、resize、退出/中断、审批卡与问卷卡出现/消失。
- 纯动画帧：仅重发鲸鱼图，复用上一帧的图片坐标；不跑 React、不重算 layout、不重建 screen、不 diff。
- 动画节拍：26ms → 33ms，与内容节流共用同一常量。常量由 `nano-app.ts` 定义并经 `RendererOptions.activityIntervalMs`（默认 33）注入 renderer，renderer 不反向依赖 app 层。
- 只有 `NANO_REDUCED_MOTION` 这一个既有开关（2026-11-10 用户确认不加新开关）。

### 5.3 快路径边界（第 3 步）

- 快路径条件：整串落在 `\u0020–\u007E` 与 `\n`，不含 `\t` 与控制符。
- `graphemes` 快路径返回逐码元数组；`displayWidth` 快路径返回「长度 − 换行数」。
- `paintText` 的换行缓存键：`text` 引用 + `width`；两者未变即复用，否则重算。
- 其余输入逐字保持现状，不新增宽度表、不改 `WIDTH_OVERRIDES`。

## 6. 验收

### 6.1 测量协议（两张表共用）

- 每个指标在同一进程内跑 3 轮，取中位数；每轮前预热 20 次。
- "p95" = 每轮 200 个样本的 95 分位；比较用 p95（不用 p50）。
- `frame()` 的「不劣化」= p95 ≤ 基线 × 1.2。
- 基线由 `scripts/bench-stream.mjs` 在**改动前**的提交上跑出，数字写进 PR。
- `scripts/bench-stream.mjs` 由 **P1 落**（P2 复用）。

### 6.2 P1（第 1 步）合并前必须全绿

| 项 | 门槛 | 命令 |
|---|---|---|
| 单 delta 成本（48KB 预览，p95） | ≤2ms（基线 14.51ms） | `node scripts/bench-stream.mjs --case=preview` |
| 4KB 与 48KB 的 delta 成本比（p95） | ≤1.5x（基线约 4x） | 同上 |
| 长未闭合代码块（500 行，持续追加） | 单 delta p95 ≤2ms 且不随已追加行数增长 | 同上 `--case=fence` |
| 增量 vs 全文一致性 | 随机切点（≥200 个）逐行相等；settle 后全文校验 | `tests/unit/blocks.test.ts` |
| 既有测试 | `npm test` 全绿（不改 `tests/unit/perf.test.ts` 的既有预算） | `npm test` |

### 6.3 P2（第 2+3 步）合并前必须全绿

| 项 | 门槛 | 命令 |
|---|---|---|
| `frame()` 成本（40 行屏） | p95 ≤ 基线 × 1.2（基线 1.08ms） | `node scripts/bench-stream.mjs --case=frame` |
| `graphemes` / `displayWidth` 的 ASCII 快路径 | 48KB ASCII ≤ 基线的 1/5（基线 15.4ms）；CJK 不劣化（基线 49.3ms） | 同上 `--case=text` |
| 既有测试 | `npm test` 全绿 | `npm test` |

### 6.4 行为验收（两个 PR 各自跑，同单证据）

- 流式输出 30 秒窗口，`top -pid <pid>` 平均 CPU：P1 ≤40%，P2 ≤30%（基线 60–100%，同口径 `ps -Ao %cpu` 多处采样）。
- 空闲但鲸鱼动画可见：P2 后 ≤5%。
- 交互不退化：输入回显、滚动、resize 无可见延迟；审批卡弹出即时可见。
- 视觉：一次长回答（含代码块、表格、列表）从流式到 settle 无跳版；PTY 截图对比作证。

## 7. 机制清单

| 机制 | 位置 | 状态 |
|---|---|---|
| 分块扫描 + 块缓存 + 尾块上界 | `src/transcript/blocks.ts`（新） | 待建（P1） |
| 帧预算（合并 + 末帧补 + 动画帧跳过） | `src/app/nano-app.ts`、`src/render/renderer.ts` | 改（P2） |
| ASCII 快路径 + 换行复用 | `src/render/text.ts`、`src/render/renderer.ts` | 改（P2） |
| 基准脚本 | `scripts/bench-stream.mjs`（新） | 待建（P1，P2 复用） |
| 长决策 | `docs/decisions/2026-11-10-markdown-render-parity.md` | 本 PR 落 |

## 8. 证据

### 8.1 spec 期数字（不可复跑，只作选题依据）

§2 的 4KB/16KB/48KB/96KB 数字来自一次临时 vitest 探针（挂载 `App` + `Renderer`，1200 行 transcript，逐步 `setPreview` 计时）；用例跑完即删，**本 PR 不含可复跑脚本**。P1 落 `scripts/bench-stream.mjs` 后，以脚本基线为准；两者偏差 >20% 时以脚本为准并在 PR 里注明。

### 8.2 实施期证据（待补）

- `scripts/bench-stream.mjs` 改动前后两轮输出（P1 与 P2 各一份）。
- 一致性 property test 的切点数与结果。
- PTY 会话的 CPU 采样与截图。

## 9. 风险与回退

| 风险 | 影响 | 回退 |
|---|---|---|
| 分块与全文不一致（围栏、表格、列表、setext） | 预览错行或 settle 跳版 | 一致性 property test 拦；必要时该文本退化全量 |
| 未闭合长块冻结边界的高亮差异 | 边界处一次视觉差异 | settle 后全文覆盖；差异出现在截图对比里就调 `TAIL_MAX_LINES` |
| 节流引入输入延迟 | 打字/滚动发涩 | 输入等路径绕过节流；常量可回调 |
| 快路径把 `\t` 当普通字符 | 表格/缩进错位 | 快路径条件排除控制符；补 tab 用例 |

**回退方式**：两个 PR 独立，按 PR 整份 revert：P2 回退 = 帧预算与快路径一起撤；P1 回退 = 分块渲染撤回到全量（`previewUnit` 恢复直接 `renderMarkdown`）。

## 10. DoR 自查

| 判据 | 结论 |
|---|---|
| 承重规则与已确认做法一致，无未决承重问题 | 是——入口 3 处唯一（§3.1）、尾块上界唯一（§5.1）、退化范围唯一（§5.1） |
| 行为有触发/响应/失败/空态 | 是——§4 每步列触发、失败/空态、落点 |
| 验收能判对错，有命令与断言 | 是——§6.1 协议 + §6.2/6.3 分 PR 门槛与命令 |
| 数据迁移/回滚/兼容/外部合同 | 不适用（无数据迁移、无外部契约）；回退方式见 §9 末段 |
| ADR 一致 | 是——不变式与范围唯一正文在 ADR，本 spec 只链接不复制 |

## 11. 自定细节（agent 决定的默认值，可改）

| 细节 | 取值 | 理由 |
|---|---|---|
| 尾块上界 `TAIL_MAX_LINES` | 200 行 | 一屏约 40 行；200 行足够覆盖常见未闭合代码块，超出即冻结 |
| 块缓存容量 | 512 块 | 覆盖最近几轮回答的稳定块 |
| 尾块重渲染频率 | 每个 delta 都重排尾块（≤200 行） | 尾块有上界，成本可预期；不引入第二个计时器 |
| 退化计数出口 | `NANO_DEBUG_RENDER=1` 写诊断行 | 不污染正常日志，测试可直接断言 |
| 33ms 常量的归属 | `nano-app.ts` 定义，经 `RendererOptions.activityIntervalMs` 注入 | 单一来源，且不让 renderer 反向依赖 app |

## 12. 审核修订记录

### 2026-11-10 规格期轻审（1 个 agent，只读）

12 条：阻断 1、高 4、中 6、低 1。结论原文见 [PR #181 评论](https://github.com/nano-sun99/dsh-tui-nano/pull/181#issuecomment-6763531237)。

处置：用户选**全改**（2026-11-10）。逐条落点：

| # | 级别 | 修订 |
|---|---|---|
| 1 | 阻断 | §5.1 增「尾块上界 200 行 + 冻结规则」；§1 目标改为「不随已稳定文本增长」；§6.2 增长未闭合围栏用例 |
| 2 | 高 | §6 拆成 P1/P2 两张表；明写 bench 脚本由 P1 落、P2 复用；§1 区分合计目标与 P1 阶段预期 |
| 3 | 高 | §6.1 增测量协议（预热、样本数、p95、容差）；删掉未经确认的「50ms→8ms」门槛，改为「既有预算不动」；`frame()` 容差 ×1.2 |
| 4 | 高 | §3.1 列出唯一 3 处入口，明写 `thinkingUnit`/工具结果/问卷详情不改；ADR 影响面同步 |
| 5 | 高 | §5.1 退化范围统一为「该文本的全部入口」，与 ADR 措辞一致 |
| 6 | 中 | §5.2/§11 改为 `RendererOptions.activityIntervalMs` 注入，不再要求 renderer 引用 app 常量 |
| 7 | 中 | §8.1 改成「不可复跑，只作选题依据」，删掉「本 PR 可复跑」 |
| 8 | 中 | §5.1 只留操作规则，不变式改为链接 ADR；§1/§3.2 不再复述 ADR 范围 |
| 9 | 中 | §1/§2 内存口径拆开：单会话峰值 footprint 1.1GB vs 8 会话 RSS 4.5GB |
| 10 | 中 | §1/§2 行号改为 `model.ts:167`/`:424` |
| 11 | 中 | §2/§6.4 的 CPU 口径统一为 `ps -Ao %cpu` 采样与 `top -pid` 30s 平均，并写明基线区间来源 |
| 12 | 低 | `markdown.ts:24` → `:28`；全表按 `69d531e` 重核 |
