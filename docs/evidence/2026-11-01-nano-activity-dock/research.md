# 活动栏与四款鲸尾：规格期调查证据

- 调查日期：2026-11-01
- 产品基线：`2a0e7d999ce68d4028b3b71796913910963b83b2`
- 对应[规格](../../specs/2026-11-01-nano-activity-dock/README.md)与[业务决定](../../decisions/2026-11-01-activity-dock.md)；本文件只记录事实与验证边界，不另立行为规范。

## 1. 证据等级

已完成：指定本地 Claude Code 源码检查、指定 GitHub 仓库固定提交检查、浏览器原生动效对照与临时预览测试。

未完成：完整 Claude Code 运行时场景实测、Nano 产品接线、真实 Ghostty 图片绘制及清理。不能把浏览器通过写成产品已实现或终端已验收。临时预览中的场景菜单仅用于演示/检查。

## 2. 现有产品与既有设计

| 结论 | 可核来源 |
| --- | --- |
| 旧规格定义运行、等待授权/选择、空闲；空闲写 0 行 | `docs/specs/2026-10-22-nano-visual-v1/README.md` §4.1、§9 |
| 设计稿实际固定一行；空闲只清内容 | `docs/design/2026-10-17-dsh-tui-ux-research/preview/index.html` 的 `.activity`、`#activity`、场景 draw |
| 当前主 App 没有独立活动行 | `src/app/App.tsx` 的 `App` 与 `transcriptBodyHeight` |
| idle/running 不能表达完整执行阶段 | `src/conversation/controller.ts` 的 `statusValue`、`attach`、`handleSessionEvent`、`handleStreamFrame` |
| 流式 start 带 attemptId，正文和思考 delta 已被接收 | 同文件 `handleStreamFrame`；当前安装包 `@deepseek-ai/dsh-agent-loop/lib/types/assistant-stream.d.ts` 的 `AssistantStreamAttempt` |
| 工具参数 delta 在官方类型中存在 | 当前安装包 `@deepseek-ai/dsh-llm/lib/types/types.d.ts` 的 `StreamChunk` / `tool-call-delta` |
| 主渲染器输出字符单元格，尚无本功能图片能力 | `src/render/components.ts` 的 Box/Text/Overlay/Grid，`src/render/renderer.ts` 的 frame 输出，`src/runtime/terminal.ts` |
| 当前停止操作发送 cancel，不等于同步确认工具退出 | `src/conversation/controller.ts` 的 `stop` / `clear` |
| 输入键位已是 Ctrl+C 停止、Enter 插话 | `src/app/App.tsx` 的 `RUNNING_HINT`、`src/input/keymap.ts`；主代理响应 ADR |

官方类型存在不代表 start 的发射时点与所有重试分支已完整验证；实施必须核发射点、身份、过期事件和回合结束的对应关系，不靠类型名推断。

2026-11-01 修订时再次核对问卷实施 PR #127：OPEN，HEAD `7d0031eb5fa0938d056d0bfdb47d0bdd93002291`。与本任务允许改动面直接重叠的文件是 `src/app/App.tsx`、`src/app/nano-app.ts`、`src/decisions/manager.ts`、`src/input/parser.ts`；另有 `src/decisions/types.ts` 类型修改、新增 `src/app/question-card.ts`、相关单测/feature/e2e 与文档。此清单记录当时实际 diff，不预测最终合并内容；实施前需重新取远端核对。

问卷规格已合入、实现当时未在主干。其 §3.1 与 §7 都约定等待文案复用 notice、不新开活动行；本规格明确局部取代这两处，增加页面一行，但不迁走问卷 §3.9 的取消结果和 §8 的回答回执。卡片内部结构及答案/取消契约不变，不能把新增一行说成全局布局完全不变。

取代对象也需分清：visual-v1 和设计稿包含活动栏高度/图标预算；design-contract §5 只有主忙碌指示约 500ms，§4 的 2ch 是 diff 标记槽，不属于本次图标改动。

现行职责依据：[S01/S02 接缝](../../decisions/2026-10-29-s02-s01-seams.md) 保留 S01 核心行为 owner；[单一终端写入者](../../decisions/2026-10-29-single-process-fd-guard.md) 要求 runtime 经 `/dev/tty` 输出；[根会话恢复](../../decisions/2026-10-29-root-session-resume-first.md) 沿用官方历史。本任务为 S01 后续能力，不通过 S02 feature/dock 钩子替换核心渲染、不建第二份历史；现有接缝形状及其回归责任仍有效。

## 3. Claude Code 2.1.88 显隐

本地档案根目录：`/Users/sunchongsheng/Downloads/归档/06-软件与安装包/ClaudeCode/`。版本来自 `package/package.json:3`。以下路径相对此归档；这不是最新版行为结论，也不是公开源码链接。

| 结论 | 本地源码位置 |
| --- | --- |
| 请求开始、思考、正文、工具参数由不同事件设置阶段 | `src/utils/messages.ts:2984–3045` |
| 是否显示 spinner 是独立复合条件，不是只看阶段 | `src/screens/REPL.tsx:1672–1685` |
| 已接纳用户输入能在 API 请求前提供反馈 | `src/screens/REPL.tsx:3367–3375` |
| 普通模式当前流式正文可显示时隐藏 spinner；brief 例外 | `src/screens/REPL.tsx:1672–1685` |
| 当前正文按完整行进入显示，未换行的文本可能还不可见 | `src/screens/REPL.tsx:1461–1473` |
| 授权/提问队列非空，或者存在不允许 spinner 的自定义工具界面时隐藏 | `src/screens/REPL.tsx:1672–1685` |
| 仅 Sleep 工具在运行时不显示 spinner | `src/screens/REPL.tsx:1654–1660` |
| 工具授权等待扣除活动计时 | `src/screens/REPL.tsx:2077–2087` |
| 取消先 forceEnd、保留部分正文、重置 UI loading，然后触发 abort | `src/screens/REPL.tsx:2118–2152` |
| finally 用 query generation 防止旧结束事件清掉新请求 | `src/screens/REPL.tsx:2919–2930` |
| 只有队友工作、主代理 idle 时显示静态 Idle，不画忙碌动画 | `src/components/Spinner.tsx:226–251` |
| 2 秒策略仅平滑 thinking 标签，不是延迟整个活动栏隐藏 | `src/components/Spinner.tsx:124–159` |
| 普通模式输入区自己留一行；brief 分支另有忙闲两行 footprint | `src/components/PromptInput/PromptInput.tsx:317–324,2244`；`src/components/Spinner.tsx:303–310,451–465` |

复合条件概要：有在途请求/输入处理/运行队友/待消费命令之一；自定义工具界面允许；授权和提问队列为空；无待批准 worker request；不是仅 Sleep；普通模式没有当前 visibleStreamingText。所有条件共同成立才显示。后台活动触发组件不代表主代理必须继续动画，组件内部还会区分 idle。

Nano 采用原则而非复制全部行为：固定一行来自用户要求；按 Nano 实际显示正文收起，不改为完整行缓冲；停止未确认给静态等待，不声称 Claude 原生有这个 spinner mode；不新增 Sleep 命令猜测、brief 模式或队友状态树。详细适配契约只见规格。

## 4. 四款动效固定来源

- 仓库：`https://github.com/01Virex/dsh-status-rotator`
- 固定提交：`0d486a80c55dabee9e62ce8d87612dc15792c805`；2026-11-01 fetch 后与当时 origin/main 一致。
- 固定源码：`https://github.com/01Virex/dsh-status-rotator/blob/0d486a80c55dabee9e62ce8d87612dc15792c805/lib/client.js`
- 授权：该提交 `LICENSE` 标识 MIT，`Copyright (c) 2026 01Virex`。实现复制实质素材时须保留完整许可；此处是源许可标识，不替代法律意见。
- 轮廓/时间轴：`TAIL_POSES`、`TAIL_SWAY_POSES`、`TAIL_TWIST_POSES`、`TAIL_OFFICIAL_BASE/DELTAS/TIMELINE`、`TAIL_ANIMATION_POSES`。
- 播放路径：`ensureWhaleWagStyle`、`TAIL_MORPH_CLASS` 和 `viewBox=20 40 300 240`；每帧为离散轮廓，evenodd 填充。
- 演示：`scripts/readme-demo.html`；其 icon 模式前三款非 official 使用 0.5 次/秒，official 按推荐 0.25 次/秒；不是从动画外观估算周期。
- 参考说明：同提交 `docs/whale-tail-reference.md`。

源帧提取结果：official 150 帧、wag 24 帧、sway 24 帧、twist 36 帧。wag 按索引 15、twist 按索引 29 旋转源循环，使首帧遵循上游 `TAIL_ANIMATION_POSES`，不是删掉之前帧。

帧序列摘要算法：把对应 `paths` 数组按 JSON 紧凑分隔符 `(',', ':')` 编码为 UTF-8，再计算 SHA-256。

| 动作 | 提取帧序列 SHA-256 |
| --- | --- |
| official | `d5d98ff5ff2eada7d68247e932011a8e4679a3fb56c48cdf0db0c3c138491e46` |
| wag | `aed4a831e5dd5a8e984f716d7e3f833861e0d37d7f72e906514e09b8da97e4af` |
| sway | `288a1184d9d48e4b9dc368fe4c306b0d8ab712daf58438be715e3210929d058a` |
| twist | `d9321bc4c061b52c61a6b308b1e80218d483297ec3c4f2718b4e5ac9e1765edd` |

源参考 GIF `assets/references/official-tail.gif` SHA-256：`4a97c91a602c5d2c420b44bd89d031d38f33ef01862c33d8b649ef085d5edf02`。该源官方款是描摹的 150 帧版本，与初次调查本机 Harness 提取的 28×28、60 帧、3 秒 APNG 不同；后者未作为最终四款的官方素材。

[早期动画来源摘要](initial-animation-evidence.json) 记录本机包版本、源码与图片 SHA-256、IHDR/acTL/fcTL 解析结果；本次重新解码本地源码内嵌 mask，与早期提取图片逐字节一致，仅核元数据、未重跑动效。未提交整个本地安装包或 APNG，复现其字节仍需取得摘要所指的本地源。原始单行字符转绘对照已保存为[历史截图](archive/initial-original-vs-character.png)：它支持作者的视觉取舍，不是终端验收或量化保真率；不将“明显失真”伪装成用户原话。[MIT 许可原文](archive/status-rotator-LICENSE.txt) 随上游衍生证据保留。

## 5. 已有预览验证与限度

临时工作目录：`/tmp/nano-whale-loading.eI7FkZ/`。不把临时 HTTP 会话密钥、浏览器 profile 或调试进程配置提交仓库。临时目录只供本机复核，正式实施不能依赖其长期存在。

已归档[显隐预览检查](verification-dock-visibility.json)；本次只补充上下文与来源，**没有重跑浏览器或产品测试**。原执行输出保存在[raw JSON](archive/verification-dock-visibility.raw.json)，当时 verifier 原文以[只读文本](archive/verify-dock-visibility.mjs.txt) 归档，二者 SHA-256 在注释版 JSON 中。脚本保留原临时路径假设，未配置为仓库执行入口；没有复制页面/服务密钥/浏览器 profile，故此档案是可审阅的断言及结果，不宣称独立可重放的完整夹具。

- 视图参数：1440×1300px / 配置 100 列 / dark；1100×1300px / 60 列 / light；390×1400px / 60 列 / dark。三者 deviceScaleFactor=1、mobileEmulation=false；第三种仅手机尺寸浏览器窗口，不是移动设备或终端仿真。
- 每种视图检查同一组 11 个场景：`thinking`、`requesting`、`toolInput`、`tool`、`respondingPending`、`responding`、`approval`、`question`、`idle`、`stopping`、`error`，含义与列表均写入 JSON。3×11=33；固定 22px 是预览的一行，不是终端硬编码行高。
- 本组没有“提交已接纳但请求未开始”或“仅子代理工作”，也没有多个条件同时成立的优先级用例。规格修订新增明确的 C01、C13、P01–P08 仍全部待实施，不从已有 33 场景推导覆盖。
- 当前正文显示时活动图文为空、动画时钟暂停；文字尚未显示时仍有活动反馈。
- 同一请求多次重放和状态切换不重抽，下一个请求只增加一次抽取；键盘焦点和草稿不被重新渲染丢弃。
- 四种动作均实际推进；减少动态效果能冻结；无页面横向溢出。
- Twist 与上游原生组件在相同 180×180 容器、相同相位下逐一比较索引 0–35 的计算后 SVG 轮廓，共 36/36 一致；不是截图像素 diff。原 verifier 循环检查 36 次但仅持久化匹配数，因此注释版 JSON 的空 mismatches 是由全数匹配推导并明确标注，不伪造未保存的逐帧日志。[较早的另一次源帧核对 raw JSON](archive/twist-source-comparison.raw.json) 也明确记录 frameCount=36、mismatches=[]。旧版自行刷新方式被替换为源同类 CSS 逐帧播放，修复隐藏/恢复后的残留动画实例；用户随后确认「现在ok了」。

这些结果没有证明：真实终端图片保真、协议兼容、终端图片清理、IME 不受影响、生产事件映射、真实请求重试/取消竞态、完整 13 场景或组合优先级。以上仍是规格的未勾选实施验收。本次补录仅归档已有 raw 输出、verifier 文本、历史截图及来源摘要，不复制完整插件包/页面/启动脚本，不新增检查机制；实施素材与可复现终端验收工具随实施 PR 交付。

## 6. 本次约定与流程事实

用户已明确：四款均采用、真实图片支持纳入、Twist 观感认可、正文显示后收起、每次模型请求抽取、四项机制全要、一份规格不拆，并要求创建 PR。完整业务决定记录于关联 ADR。

本次只提交规格/决定/调查证据；不授权实现，不授权合并，不提前创建执行 issue。2026-11-01 收到 #128 的轻审评论（[原文](https://github.com/nano-sun99/dsh-tui-nano/pull/128#issuecomment-6555498148)，审核基线 `f32f5f4`），用户选择「修改（推荐）」。修订自查不等于重新派审或审核放行；逐条处置记在规格 §10。规格 PR 经明确合并同意后，才创建一张执行 issue 与交接。
