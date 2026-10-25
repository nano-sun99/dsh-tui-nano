# 2026-10-25-nano-visual-interaction-alignment 证据

- 实现分支：`issue-62`；执行 issue：#62。
- 终端：tmux PTY（真实终端，`TERM=xterm-256color`），100×36 与 60×30。
- 主题：Dark（默认，未设置 `NANO_THEME`）与 Light（`NANO_THEME=light`，重启生效）。
- 真实模型：DeepSeek-V4.1-Flash；官方目录声明的强度为 `Off / Low / High / Max`，本实现按官方档位动态渲染。
- 说明：本目录是 PTY 屏幕快照；文件名带 `-ansi` 的保留 ANSI SGR，用于核对整行底色与档位色。

## 文件

- `01-main-pty-100-dark.txt`：普通主界面。
- `02-model-default-pty-100-dark.txt`：`/model` 底部控制层默认态，轨道未点亮，官方四档标签。
- `03-model-off-pty-100-dark.txt` … `06-model-max-pty-100-dark.txt`：`→` 依次经过 `Off / Low / High / Max` 的文本快照。
- `07-model-confirmed-pty-100-dark.txt`：`Enter` 确认后输入、状态、dock 恢复，结果只进底部瞬态。
- `08-model-current-pty-100-dark.txt`：重新打开后头部显示当前模型与强度。
- `09-diff-short-long-pty-100-dark.txt`：短 diff 与长 diff（标题 → rule → 状态行）。
- `10-diff-budget-pty-100-dark.txt`：长 diff 只显示 8 个视觉行，并给出「还有 11 行」。
- `11-main-pty-60-light.txt` … `14-diff-short-pty-60-light.txt`：60 列浅色主界面、模型面板与短 diff。
- `15-model-low-ansi-100-dark.txt` / `16-model-low-ansi-60-light.txt`：`Low` 填充 33%，其余为 rule 轨道。
- `17-model-off-ansi-100-dark.txt`：`Off` 为第一档，轨道不填充，标签 accent。
- `18-model-high-ansi-100-dark.txt`：`High` 填充 66%，色值 `#8190a8`。
- `19-model-high-ansi-60-light.txt`：60 列浅色的 `High`。
- `20-model-current-max-ansi-100-dark.txt`：`Max` 全条点亮，捕获到脉冲较亮相位。

## 覆盖与差距

- 覆盖：`/model` 底部控制层、默认空轨道、官方档位与标签、Enter 回执与底部槽位恢复；100 / 60 列与深 / 浅主题；diff 的标题 → rule → 状态行、整行底色（深 / 浅）、8 视觉行预算与隐藏数。
- 真实目录没有 `xhigh` 档：XHigh 扫光与 Max 脉冲由 `crates/nano-app/src/ui.rs` 的 `effort_cycles_drive_the_fill_labels_and_animation_gate` 覆盖；无 reasoning 模型与不可用行由 `unavailable_and_disabled_models_explain_the_missing_track` 覆盖；diff 的视觉行预算、整行底色与 ZWJ emoji 由 `crates/nano-transcript/src/render.rs` 的渲染测试覆盖。
- 未拍独立 Ghostty 窗口截图：自动化环境只稳定拿到 PTY 快照，与上一轮证据口径一致。

## 复跑

```sh
cargo build -p nano-app
# 100×36 深色
tmux new-session -d -s nano62 -x 100 -y 36 \
  "cd /tmp/nano62-work && <repo>/target/debug/nano --no-install --data-root /tmp/nano62-data --cwd /tmp/nano62-work"
# 60×30 浅色
tmux new-session -d -s nano62light -x 60 -y 30 \
  "cd /tmp/nano62-light-work && NANO_THEME=light <repo>/target/debug/nano --no-install --data-root /tmp/nano62-light-data --cwd /tmp/nano62-light-work"
# 按键后 tmux capture-pane -p [-e] -t <session>
```
