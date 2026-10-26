# 统一间距架构 · 证据

- 规格：`docs/specs/2026-10-26-nano-spacing-system/README.md`
- 生成：`python3 scripts/pty-evidence-input-preview.py spacing-system`
- 构建：worktree `fix/process-block-gap`，基线 `3523fcb`，`target/debug/nano` 测试二进制
- 数据：确定性 `evidence_frame` fixture，不是账号真实会话，也不产生模型费用

## 过程组 → 回答

| 文件 | 场景 |
|---|---|
| 01-process-answer-pty-100-dark.txt | 100 列 dark：Bash 卡 → 思考 已完成 → 一句话回答 |
| 02-process-answer-pty-60-light.txt | 60 列 light，同一形状 |
| 03-process-answer-pty-100-light.txt | 100 列 light，同一形状 |
| 04-process-answer-pty-60-dark.txt | 60 列 dark，同一形状 |

实测行序（四份一致）：

- `▸ Bash echo hi` 与命令 / 输出紧贴，0 空行；
- Bash 输出与 `▸ 思考 已完成` 之间 1 空行；
- 思考与 `一句话：……` 之间 1 空行；
- 回答之后保留 1 行底部留白。

这验证了过程块之间各有 1 行呼吸，卡内命令 / 输出仍紧贴。

## Preview → 正文

| 文件 | 场景 |
|---|---|
| 05-preview-answer-pty-100-dark.txt | 100 列 dark：预览状态 → 思考 → 正文 → 工具参数行 |
| 06-preview-answer-pty-60-light.txt | 60 列 light，同一形状 |

实测：状态与思考紧贴 → 正文前 1 空行 → 工具参数行紧贴正文，不重排。

## UI chrome 回归

| 文件 | 场景 |
|---|---|
| 07-main-pty-100-dark.txt | 100 列 dark 主界面，标题下 1 空行 |
| 08-main-pty-60-light.txt | 60 列 light 主界面，标题下 1 空行 |

## 方法

- 每个场景由 `NANO_EVIDENCE_SCENARIO=<name> cargo test -p nano-app evidence_frame -- --ignored --nocapture` 经真实 `draw` 路径渲染，再在 tmux PTY 里按目标列数 / 主题捕获 ANSI 屏幕。
- 过程组 fixture 通过真实会话事件构造：`tool/call` + `tool/result` + 带 `reasoning` 与 `text` 的 `assistant/message`；预览 fixture 通过 `conversation.stream` 构造。
- 证据只证明渲染层节奏；真实账号会话的同一路径由现有 `main-*` 证据与人工使用覆盖，本次不额外发送消息。

## 边界

- fixture 使用合成命令与合成文本，不冒充账号真实目录或真实会话。
- 60 列下标签和换行可能省略远端内容，但间距规则与 100 列一致。
- 主题只影响颜色，不影响行数；dark / light 四组合已覆盖。
