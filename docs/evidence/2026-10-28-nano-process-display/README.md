# 过程显示收敛 · 证据

- 规格：`docs/specs/2026-10-28-nano-process-display/README.md`
- 生成：`python3 scripts/pty-evidence-input-preview.py process-display`
- 构建：worktree `.claude/worktrees/issue-79`（`issue-79`），基线 `aeb343a`，`target/debug/nano` 测试二进制
- 终端：tmux PTY（`TERM=xterm-256color`），100×36 与 60×30；Dark 默认主题，Light 用 `NANO_THEME=light`
- 数据：确定性 `evidence_frame` fixture，不是账号真实会话，也不产生模型费用

## 连续读取 / 搜索（收起）

| 文件 | 场景 |
|---|---|
| 01-collapsed-pty-100-dark.txt | 100 列 dark：分组行、Bash 成功、失败卡、流式思考 |
| 02-collapsed-pty-60-light.txt | 60 列 light，同一形状 |
| 03-collapsed-pty-100-light.txt | 100 列 light，同一形状 |
| 04-collapsed-pty-60-dark.txt | 60 列 dark，同一形状 |

实测口径（四份一致）：

- 连续 Read ×2 / Grep / List 合并为一行 `▸ Read 2 个文件 · Grep 1 次 · List 1 个目录`，右端 `完成 · 点击展开`。
- Bash 成功只留标题与命令首行，输出 0 行，左端记 `+3 行`；右端状态与提示完整。
- 中间失败的 Read 独占失败卡，露出 3 行摘要与 `+1 行`，前后调用各自成组。
- 失败之后的组只有一次调用，直接显示目标 `Read src/after-failure.ts`。
- 通用工具成功结果 0 行，左端 `+2 行`。
- 流式思考显示标题、用时与正文（缩进 2ch），正文与后续正文之间 1 行；未提交前不出现「已完成」行。
- 60 列下分组标题被截断为省略号，状态词与「点击展开」完整可见。

## 组展开

| 文件 | 场景 |
|---|---|
| 05-expanded-pty-100-dark.txt | 100 列 dark：组行 + 每次调用的目标与结果 |
| 06-expanded-pty-60-light.txt | 60 列 light，同一形状 |
| 07-expanded-pty-100-light.txt | 100 列 light，同一形状 |
| 08-expanded-pty-60-dark.txt | 60 列 dark，同一形状 |

实测：组行变为 `▾`，右端改为 `完成 · 点击收起`；展开体按调用顺序列出 `Read <path>` / `Grep "<pattern>"` 与各自结果，结果 muted、缩进 2ch；60 列下结果按视觉行换行，不溢出。

## 方法

- 每个场景由 `NANO_EVIDENCE_SCENARIO=<name> cargo test -p nano-app evidence_frame -- --ignored --nocapture` 经真实 `draw` 路径渲染，再在 tmux PTY 里按目标列数 / 主题捕获屏幕。
- fixture 通过真实会话事件构造：`user/message` + `tool/call` + `tool/result`，收起场景另加一路 `conversation.stream` 的 reasoning / text 增量。
- 分组、预算、提示与思考的逐项边界由 `crates/nano-transcript/src/render.rs` 的单元测试覆盖；本目录只归档真实终端画面。

## 边界

- fixture 使用合成命令、合成路径与合成文本，不冒充账号真实目录或真实会话。
- 流式思考用时在首帧为 `0ms`：证据在流开始后立即渲染，未等待计时；用时格式由现有 `format_duration` 覆盖。
- 主题只影响颜色，不影响行数；100 / 60 列 × dark / light 四组合已覆盖收起与展开。
- 本目录不覆盖 File / Edit 差异预算、审批、问卷与子代理布局；这些区域本次未改，沿用既有证据。
