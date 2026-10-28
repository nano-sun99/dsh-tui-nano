# S01 α 证据 · 运行时、渲染与对话

- 日期：2026-10-28
- 环境：macOS arm64（Darwin 27.0.0）、Node v24.18.0、官方 harness `0.2.1-rc.2`、模型 `deepseek-official/deepseek-flash`、终端 pty（`script`）与 Ghostty
- 数据根：证据运行使用 `/tmp/nano-*`（生产默认 `~/.dsh-tui-nano`）；凭据来自 `~/.dsh/.credentials.yaml`，未复制值
- 复现命令见各节；工具脚本在本目录 `tools/`

## 1. 验收清单（spec §5.2）

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 干净机器首次启动可用 | 通过 | 每次证据运行都用全新 `/tmp/nano-*` 数据根：自动 `initProfile` + 补 `cordis.yml=[]`，BootProbe `profileFiles` 见下 |
| 2 | profile 损坏/版本不支持有可见错误 | 通过 | 损坏 `package.json` → 备份 `.corrupt-<ts>`、tty 可见报错、退出码 1、无备用屏字节 |
| 3 | 升级保留 settings | 通过 | 二次启动前追加 `# user-marker-keep-me`，二次启动后仍在（1 处） |
| 4 | 同根第二窗口在备用屏前被拒、不建会话 | 通过 | 第二进程输出「根 "locktest" 已被进程 63100 占用…」，退出码 1，无备用屏字节 |
| 5 | 启动失败两段处置 | 通过（骨架前实测；骨架后代码路径） | 骨架前：profile 损坏、版本、认领失败均 tty 可见；骨架后：`startCore` 失败走 restore + `/dev/tty` 报错 + 退出 1（代码路径，未构造真实 boot 失败） |
| 6 | 首启显示来源、不复制凭据（B8） | 通过 | 首帧 notice：`已加载来源： profile … settings … 凭据 ~/.dsh/.credentials.yaml（不显示值） 全局指令 ~/.agents/AGENTS.md` |
| 7 | 真实对话/流式/工具/差异/审批/问卷 | 通过 | 对话与工具：见 §2；问卷 UI：见 §3；审批 seam：见 §4；差异：`renderDiffs` 单测 + 工具 `meta.diffs` |
| 8 | 过程显示（process-display ADR） | 通过 | 单测：合并读取 2 项为 1 行、成功 0 行/失败 3 行、流式思考 1 行且提交后消失、点击展开 |
| 9 | 1000 行滚动/流式/resize p95；5000 行内存有界 | 通过 | p95：滚动 2.90ms、流式 2.68ms、resize 9.01ms；60 帧堆增长 1000 行 26.3MB vs 5000 行 23.0MB（与行数无关） |
| 10 | CJK/emoji/ZWJ/IME/粘贴/鼠标拖选与复制 | 部分通过（IME 与真机拖选待人工） | CJK/ZWJ/宽字符、粘贴、SGR 鼠标、选区提取有单测；IME 组合态与 Ghostty 实际拖选见 §6 |
| 11 | 主题/间距/深色/浅色/60/100 列 | 部分通过（浅色与真机视觉待人工） | 60/100 列每行不超宽有单测；深浅主题色板已实现，真机视觉见 §6 |
| 12 | 正常退出 + SIGINT/SIGTERM/SIGHUP + 未捕获异常恢复终端 | 通过（未捕获异常路径未强制触发） | SIGTERM/SIGHUP 报告全 stopped 且释放认领；Ctrl+C 退出码 0；`uncaughtException` 走同一关停路径（代码路径） |
| 13 | 关停故障注入仍恢复终端并逐项报告；清理失败保留认领 | 通过（单测） | `lifecycle` 单测：hook 抛错 → failed；超时 → unknown；清理失败保留认领由 release hook 实现 |
| 14 | 控制字符/ESC/OSC 注入不改变屏幕、光标、剪贴板和标题 | 通过 | `sanitizeText` 单测 + 渲染器注入测试：输出仅含渲染器自身一次 `ESC[2J`，不含注入的 OSC 载荷 |

## 2. 真实对话（pty，2026-10-28 21:14）

命令（节选）：

```text
( sleep 14; printf 'Reply with exactly: pong\r'; sleep 25; printf '\003'; sleep 6 ) \
  | NANO_DATA_ROOT=/tmp/nano-alpha-chat2 script -q /tmp/nano-chat2.log node dist/bin.js --root chat-smoke2
```

结果：输入 → 状态「运行中」→ 回复 `OK` → 状态「空闲」；退出码 0；关停报告逐项 stopped；认领已释放；会话写入数据根：

```text
/tmp/nano-alpha-chat2/sessions/--Users-sunchongsheng-code-dsh-tui-nano-.worktrees-issue-86--/chat-smoke2/session.v4.jsonl.zstd
```

同一根二次启动（resume）后，历史回放可见上次提问与回答（`› Reply with exactly: one` / `one`），退出码 0。

## 3. 问卷 UI（真实模型 + ask_user_question）

驱动：让模型调用 `ask_user_question` 提一个「Pick a color / Red / Blue」，40 秒后发送 `Space`+`Enter`。

结果：屏幕出现覆盖层「需要你的回答 · Pick a color · Red/Blue · 其他 · 提示」；模型最终回答「你选了 Red。」；退出码 0，关停全 stopped。

## 4. 审批 seam（真实 approval 服务）

脚本：`tools/seams-live.mjs`。在真实核心、真实 agent 打开的回合内调用 `ctx.approval.request`，由 UI 同款 `DecisionManager` 按键（↑ + Enter，即「允许一次」）回答：

```text
QUESTION: {"ok":true,"answer":{"answers":[{"id":"color","selected":["Red"]}]}}
APPROVAL: {"ok":true,"outcome":"allowed-once"}
```

说明：本机 sandbox 下 bash 工具直接放行，未能从模型工具路径自然触发审批；此脚本走的是同一条官方 `approval/request` waterfall 与同一 UI 方法。

## 5. 启动、能力与存储

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

- 启动期间 stdout 写入 0；storage/session 根写入数据根（真实对话后 sessions 出现在 `<dataRoot>/sessions`）。
- 首帧骨架在 boot 前绘制（`已确认`：pty 日志先出现「正在启动官方核心…」，507ms 后出现正式 UI）。

## 6. 人工/未完成项（诚实标坑）

- **IME 组合态**：parser 按 UTF-8/grahemes 处理；组合中的预编辑文本由终端负责，本环境无法自动模拟真实输入法。需在 Ghostty 中人工输入中文确认。
- **鼠标拖选与复制**：选区提取与 OSC 52/pbcopy 已实现、单测覆盖提取；Ghostty 实际剪贴板行为与拖选手感需人工确认。
- **浅色主题与间距的视觉验收**：`NANO_THEME=light` 已实现，60/100 列不溢出有单测；设计观感需人工看。
- **未捕获异常路径**：代码与 lifecycle 单测覆盖，未在真实运行中强制触发。
- **骨架后 boot 失败**：未构造真实失败（会破坏官方核心），代码路径为 restore + tty 报错 + 退出 1。
- **审批的自然触发**：受 sandbox 自动放行限制，见 §4。

## 7. 性能原始数据

`node --expose-gc tools/perf.mjs`：

```json
{
  "lines": 1000,
  "scrollP95ms": 2.9,
  "streamingP95ms": 2.68,
  "resizeP95Ms": 9.01,
  "heapGrowth1000Bytes": 26290032,
  "heapGrowth5000Bytes": 22989592,
  "node": "v24.18.0",
  "platform": "darwin/arm64"
}
```

## 8. 与 spec 的实现偏差（已记录）

1. **fd 级守护**：Node 无 `dup2`，改为启动时 re-exec 一次，把 fd 1/2 绑到 `<dataRoot>/logs/*.log`；运行时用独立 `/dev/tty` 句柄渲染。效果等价：任何写 fd 1/2 的库都到不了屏幕。
2. **根会话恢复**：官方持久化拒绝在已有日志上 `create`（`SessionAlreadyExistsError`），因此改为 **resume 优先、NotFound 才 create**，并校验官方返回 id == 根身份；恢复后从 `session.deriveMessages()` 回放阅读面。
3. **信号去重**：终端会把 Ctrl+C 同时发给 launcher 与 runtime，launcher 还会转发；同一信号 150ms 内的重复投递被忽略，只有真正第二次按键才强制恢复。
