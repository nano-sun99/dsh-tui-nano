# S01 α 证据 · 运行时、渲染与对话

- 日期：2026-10-28（初版） / 2026-10-29（重审返修后）
- 环境：macOS arm64（Darwin 27.0.0）、Node v24.18.0、官方 harness `0.2.1-rc.2`、模型 `deepseek-official/deepseek-flash`、终端 pty（`script`）与 Ghostty
- 数据根：证据运行使用 `/tmp/nano-*`（生产默认 `~/.dsh-tui-nano`）；凭据来自 `~/.dsh/.credentials.yaml`，未复制值
- 复现前提：先 `npm ci && npm run build`（工具脚本导入 `dist/`，`dist/` 不进仓）

## 1. 验收清单（spec §5.2）

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 干净机器首次启动可用 | 通过 | 每次证据运行都用全新 `/tmp/nano-*` 数据根：自动 `initProfile` + 补 `cordis.yml=[]`，BootProbe `profileFiles` 见 §5 |
| 2 | profile 损坏/版本不支持有可见错误 | 通过 | 损坏 `package.json` → 备份 `.corrupt-<ts>`、tty 可见报错、退出码 1、无备用屏字节 |
| 3 | 升级保留 settings | 通过 | 二次启动前追加 `# user-marker-keep-me`，二次启动后仍在 |
| 4 | 同根第二窗口在备用屏前被拒、不建会话 | 通过 | 第二进程输出「根 "locktest" 已被进程 63100 占用…」，退出码 1，无备用屏字节 |
| 5 | 启动失败两段处置 | 通过（骨架前实测；骨架后代码路径） | 骨架前：profile 损坏、版本、认领失败均 tty 可见；骨架后：`startCore` 失败走 restore + `/dev/tty` 报错 + 退出 1 |
| 6 | 首启显示来源、不复制凭据（B8） | 通过 | 首帧 notice：`profile … settings … 生效层 … 凭据 …（不显示值） 全局指令 …` |
| 7 | 真实对话/流式/工具/差异/审批/问卷 | 通过（差异仅有单测） | 对话/工具/问卷见 §2–§3；**流式见 §4（13 次增量预览）**；审批 seam 见 §5；差异渲染为单测 + `meta.diffs` 解析 |
| 8 | 过程显示（process-display ADR） | 通过 | 单测：合并读取 2 项为 1 行、成功 0 行/失败 3 行、流式思考 1 行且提交后消失、点击展开 |
| 9 | 1000 行滚动/流式/resize p95；5000 行内存有界 | 通过 | p95：滚动 2.80ms、流式 1.61ms、resize 6.99ms；60 帧堆增长 1000 行 6.9MB vs 5000 行 5.5MB（与行数无关；返修修复了 Yoga 节点泄漏） |
| 10 | CJK/emoji/ZWJ/IME/粘贴/鼠标拖选与复制 | 部分通过（IME 与真机拖选待人工） | CJK/ZWJ/宽字符、粘贴、SGR 鼠标、选区提取有单测；IME 组合态与 Ghostty 实际拖选见 §7 |
| 11 | 主题/间距/深色/浅色/60/100 列 | 部分通过（浅色与真机视觉待人工） | 60/100 列每行不超宽有单测；深浅主题色板已实现，真机视觉见 §7 |
| 12 | 正常退出 + SIGINT/SIGTERM/SIGHUP + 未捕获异常恢复终端 | 通过（未捕获异常路径未强制触发） | SIGTERM/SIGHUP 报告全 stopped 且释放认领；Ctrl+C（raw 0x03）退出码 0；3s 强制恢复定时器已加 |
| 13 | 关停故障注入仍恢复终端并逐项报告；清理失败保留认领 | 通过（单测） | `lifecycle` 单测：hook 抛错 → failed；超时 → unknown；未知结果会置 cleanupFailed，release 保留认领 |
| 14 | 控制字符/ESC/OSC 注入不改变屏幕、光标、剪贴板和标题 | 通过 | `sanitizeText` 单测 + 渲染器注入测试：输出仅含渲染器自身一次 `ESC[2J`，不含注入的 OSC 载荷；`commitTextUpdate` 也已净化 |

## 2. 真实对话（pty）

命令（节选）：

```text
( sleep 14; printf 'Reply with exactly: pong\r'; sleep 24; printf '\003' ) \
  | NANO_DATA_ROOT=/tmp/nano-after script -q /tmp/nano-after.log node dist/bin.js --root after-root
```

结果：输入 → 状态「运行中」→ 回复 `pong` → 状态「空闲」；退出码 0；关停逐项 stopped；认领已释放；会话写入数据根：

```text
/tmp/nano-after/sessions/--Users-sunchongsheng-code-dsh-tui-nano-.worktrees-issue-86--/after-root/session.v4.jsonl.zstd
```

同一根二次启动（resume）后，历史回放可见上次提问与回答，退出码 0。

## 3. 问卷 UI（真实模型 + ask_user_question）

驱动：让模型调用 `ask_user_question` 提一个「Pick a color / Red / Blue」，40 秒后发送 `Space`+`Enter`。

结果：屏幕出现覆盖层「需要你的回答 · Pick a color · Red/Blue · 其他 · 提示」；模型最终回答「你选了 Red。」；退出码 0，关停全 stopped。自定义答案输入（含空格与字母 c）已有回归单测。

## 4. 流式（真实模型）

`tools/stream-probe.mjs`（`node .../stream-probe.mjs`）：

```json
{
  "previewUpdates": 13,
  "firstPreviews": ["1", "1,", "1, ", "1, 2", "1, 2,", "1, 2, "],
  "lastPreview": "1, 2, 3, 4, 5",
  "committedText": "1, 2, 3, 4, 5",
  "reasoningPreviewed": false
}
```

说明：13 次增量预览证明 `agent/assistant-stream` 的逐帧 revision 已被正确消费；提交后的正式消息替换预览且文本一致。

## 5. 启动、能力、存储与审批 seam

`tools/boot-probe.mjs`：

```json
{
  "bootMs": 487,
  "stdoutWritesDuringBoot": 0,
  "services": 85,
  "missingServices": [],
  "tools": { "ask_user_question": true },
  "profileFiles": ["cordis.patch.yml", "cordis.yml", "package.json", "pnpm-workspace.yaml"]
}
```

- 启动期间 stdout 写入 0；sessions/storage 根写入数据根（真实对话后 sessions 出现）。
- 首帧骨架在 boot 前绘制（pty 日志先出现「正在启动官方核心…」，约 0.5s 后出现正式 UI）。

`tools/seams-live.mjs`（真实核心、真实 agent 打开的回合内调用审批；问卷为程序化 `ask`）：

```text
QUESTION: {"ok":true,"answer":{"answers":[{"id":"color","selected":["Red"]}]}}
APPROVAL: {"ok":true,"outcome":"allowed-once"}
```

说明：本机 sandbox 下 bash 工具直接放行，未能从模型工具路径自然触发审批；该脚本走同一条官方 `approval/request` waterfall 与 UI 同款方法。

## 6. 性能原始数据

`node --expose-gc tools/perf.mjs`（返修后）：

```json
{
  "lines": 1000,
  "scrollP95ms": 2.8,
  "streamingP95ms": 1.61,
  "resizeP95Ms": 6.99,
  "heapGrowth1000Bytes": 6888840,
  "heapGrowth5000Bytes": 5529376,
  "node": "v24.18.0",
  "platform": "darwin/arm64"
}
```

返修前同脚本为 26.3MB / 23.0MB；差距来自本轮修复的 Yoga 节点未释放问题（滚动/展开会不断新建节点）。三次重复的离散度已在单测中以「5000 行与 1000 行增长同量级」断言。

## 7. 人工/未完成项（诚实标坑）

- **IME 组合态**：parser 按 UTF-8/graphemes 处理；组合中的预编辑文本由终端负责，本环境无法自动模拟真实输入法。需在 Ghostty 中人工输入中文确认。
- **鼠标拖选与复制**：选区提取、宽字符起点、OSC 52/pbcopy 已实现并有单测；Ghostty 实际剪贴板行为与拖选手感需人工确认。
- **浅色主题与间距的视觉验收**：`NANO_THEME=light` 已实现，60/100 列不溢出有单测；设计观感需人工看。
- **未捕获异常路径**：代码与 lifecycle 单测覆盖，未在真实运行中强制触发。
- **骨架后 boot 失败**：未构造真实失败（会破坏官方核心），代码路径为 restore + tty 报错 + 退出 1。
- **审批的自然触发**：受 sandbox 自动放行限制，见 §5。
- **差异路径**：`meta.diffs` 解析与渲染有单测，真实文件编辑工具未在证据中触发。

## 8. 与 spec 的实现偏差（待用户裁决，未私自改 spec）

1. **fd 级守护**：Node 无 `dup2`，改为启动时 re-exec 一次，把 fd 1/2 绑到 `<dataRoot>/logs/*.log`；运行时用独立 `/dev/tty` 句柄渲染。代价是 launcher + runtime 两个 Node 进程常驻，与总纲「单一 Node 进程」字面冲突。
2. **根会话恢复**：官方持久化拒绝在已有日志上 `create`（`SessionAlreadyExistsError`），因此改为 **resume 优先、NotFound 才 create**，并校验官方返回 id == 根身份；恢复后从 `session.deriveMessages()` 回放阅读面。与 spec §2.2 字面「sessions.create」冲突。
3. **handoff 与 input-history ADR**：spec 把受控切根 handoff 标为显式例外，但 `docs/decisions/` 尚无对应修订（issue #86 已知限制要求合并前补）。
4. **新增文件/目录**：`src/app/`、`src/main.ts`、`src/bin.ts`、`biome.json`、`tsconfig.json`、`vitest.config.ts`、`package-lock.json` 不在 spec §1 拥有清单与总纲 §6 地图内。

## 9. 重审返修记录（2026-10-29）

已修复：流式 revision（高）、`wrapSpans` 粘词、纯空格 Text 宽度/状态栏对齐、问卷自定义输入吃空格与 c、滚轮方向、覆盖层命中与拖选优先级、宽字符选区复制、Yoga 节点泄漏、Grid 宽字符与 256 色、Alt+Backspace/Enter、ESC 超时卡死、UTF-8 分片、`commitTextUpdate` 净化、历史浏览即时重读、32 KiB 提交上限、状态变化重绘、稳定阅读锚点、3s 强制恢复、清理失败保留认领、thinking 行只留标题、空 assistant unit gap、diff 空文件语义、Prism 语言注册、启动早期信号保护。

未在本轮改（已在 PR 评论中保留）：spec/ADR 四条偏差（见 §8）、Cordis/React 版本锁与单实例校验、区域滚动/overscan、完整位置标注、子代理历史投影与 timed question 细节（D01 已注明的 S02 面）。
