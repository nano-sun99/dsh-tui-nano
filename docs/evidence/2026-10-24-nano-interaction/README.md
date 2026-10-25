# 2026-10-24-nano-interaction 证据

- 实现分支：`issue-59`；实现提交 `de1f6e0`，本次审核修复见 PR #60 后续 commit。
- 终端：tmux PTY（真实终端，`TERM=xterm-256color`），100×36 与 80×30。
- 主题：Dark（默认，未设置 `NANO_THEME`）。
- 真实模型：DeepSeek-V4.1-Flash；模型面板中的强度来自官方目录。
- 说明：本目录是 PTY 屏幕快照。Ghostty 独立窗口的自动化截图未能稳定取得；合并前需在 Ghostty 补拍 100/80 列各一组。

## 文件

- `01-model-panel-pty-100.txt`：`/model` 单页，当前模型、模型列表、内联强度行、键位提示。
- `02-model-effort-pty-100.txt`：从 Low 连按两次 `→` 后强度行变化（`○○○○● Max`）。
- `03-slash-completion-pty-100.txt`：输入 `/` 的命令补全（含 `[技能]` 候选）。
- `04-ghost-text-pty-100.txt`：输入 `/mod` 的行内灰字补全（灰字补全到 `/model`，草稿仍是 `/mod`）。
- `05-tab-fill-pty-100.txt`：`Tab` 只补全 `/model `，不执行。
- `06-input-selection-ansi-100.txt`：`Shift+←` 选区的 ANSI 捕获；`48;2;59;74;102` 即主题 `selected_bg`。
- `07-selection-replaced-pty-100.txt`：输入字符替换选区。
- `08-model-panel-pty-80.txt`：80 列模型面板。
- `09-slash-completion-pty-80.txt`：80 列命令补全。
- `10-model-confirmed-pty-100.txt`：模型面板 Enter 确认后的状态栏回执。

## 复跑

```sh
cargo build -p nano-app
npm --prefix bridge test
cargo test
# 在 tmux 100×36 / 80×30 中运行 target/debug/nano，
# 发送按键后用 tmux capture-pane -p（选区用 -e）保存屏幕。
```

## 与 spec 的差距

本轮只完成 PTY 快照，以下 spec §5 场景没有截图：

- Ghostty 实拍 100/80 列（自动化环境未能稳定截取独立 Ghostty 窗口）。
- 鼠标点击定位、拖选区高亮、CJK 文本点击（PTY 驱动没有鼠标事件；由 `ui.rs` 的 `input_offset_at` / 点击拖选测试覆盖）。
- 确认后的状态已补在 `10-model-confirmed-pty-100.txt`。

合并前补拍，或在合并审核卡上明确豁免。
