# 2026-10-26-nano-input-preview-rendering 证据

- 实现分支：`issue-65`；执行 issue：#65。
- 终端：tmux PTY（`status off`，真实 PTY），100×36 与 60×30。
- 主题：Dark（默认）与 Light（`Theme::Light`，与 `NANO_THEME=light` 同一套 Palette）。
- 帧来源：`crates/nano-app/src/ui.rs` 的 `evidence_frame` 测试夹具通过真实 `draw` 路径渲染，输出 ANSI 后由 tmux 截取。**这不是一次真实 dsh / 模型会话**；它使用合成会话、合成 stream 帧和确定性模型目录，目的正是覆盖真实宿主很少稳定复现的状态（事件缺口、字节截断、无退出标记、abandoned、XHigh 目录项）。正常主界面、输入状态、表格和 dock 帧同样走这条真实渲染路径。
- 说明：`-ansi` 文件保留 SGR，用于核对 XHigh 高光的行底色和位置；其余文件为纯文本快照。

## 文件

- `01-main-empty-pty-100-dark.txt`：空输入主界面；稳定 `>` 起点，无 `继续提问…`；光标在 `4,32`。
- `02-main-empty-pty-60-light.txt`：60 列浅色空输入主界面。
- `03-main-typed-pty-100-dark.txt`：输入首字符 `x` 后，输入区高度不变；光标在 `5,32`。
- `04-table-pty-100-dark.txt`：100 列 Markdown 表格，表头强调、对齐分隔线、中英文单元格。
- `05-table-pty-60-light.txt`：60 列浅色表格；列宽压缩、CJK 单元格换行，行宽不超过 58 显示列。
- `06-tool-unknown-pty-100-dark.txt`：Bash 结果没有终止标记；`结果未确认`、`退出状态未返回`、`工具未返回成功或失败结论`。
- `07-preview-live-gap-pty-100-dark.txt`：流式事件缺口；`生成中` + `当前只显示部分生成内容，最终回答到达后会补全`。
- `08-preview-live-gap-pty-60-light.txt`：60 列浅色的同一提示，按宽度换行。
- `09-preview-live-truncated-pty-100-dark.txt`：预览超过字节上限（`MAX_PREVIEW_BYTES + 1`）后的截断提示。
- `10-preview-finished-unknown-pty-100-dark.txt`：合成 `unknown` outcome；`未收到完整回答`，已到达的片段保留。宿主真实结算只发 `committed` / `abandoned`，这一帧仅用于覆盖“结论不可识别”的分支。
- `11-preview-finished-unknown-pty-60-light.txt`：60 列浅色的同一状态。
- `12-model-default-pty-100-dark.txt`：`/model` 默认态；确定性目录含 `Low / High / XHigh / Max`。
- `13` / `14`：100 列深色 `XHigh`，phase 560ms 与 1050ms 的 ANSI 帧；高光带在屏幕行 34，列 `2..5` 与 `6..12`（0-based，左边缘移动 4 列）。
- `15` / `16`：60 列浅色 `XHigh`，同一两个 phase；高光带在行 28，列 `2..5` 与 `6..12`。
- `17` / `18`：100 列浅色 `XHigh`，同上两 phase；高光带在行 34，列 `2..5` 与 `6..12`。
- `19` / `20`：60 列深色 `XHigh`，同上两 phase；高光带在行 28，列 `2..5` 与 `6..12`。
- `21-preview-finished-abandoned-pty-100-dark.txt`：宿主真实 `abandoned` outcome；`生成已中断`，保留片段。
- `22-preview-finished-abandoned-pty-60-light.txt`：60 列浅色的同一状态。
- `23-main-dock-pty-100-dark.txt`：100 列主界面 + subagent dock；status 与 dock 顶部 rule 之间保留一空行。
- `24-main-dock-pty-60-light.txt`：60 列浅色的同一布局。
- `cursor-positions.txt`：空输入与输入首字符后的 PTY 光标坐标；两次都在同一输入行，首字符后只右移一格。

## 覆盖与差距

- 覆盖：空输入焦点与光标、稳定输入起点、首字符不跳高、表格 100/60 列（含 60 列压缩与 CJK 换行）、工具未知状态、预览缺口 / 截断 / 不可识别结论 / abandoned、XHigh 在 100/60 列 × dark/light 四种组合下的两 phase ANSI 帧、subagent dock 分隔、深 / 浅主题与 100 / 60 列。
- 帧由测试夹具生成，不是真实模型会话；真实模型费用与不稳定性不进入本轮证据。合成数据只用于展示层，不写回任何官方会话。
- 帧是单次 draw（空缓存），不覆盖 live→finished 的缓存复用；该转换由 `crates/nano-transcript/tests/contract.rs` 的 `a_finished_preview_refreshes_through_the_render_cache` 与 `a_finished_preview_freezes_its_reasoning_duration` 覆盖。
- 独立 Ghostty 窗口截图未取得；与上一轮证据口径一致，PTY 是自动化环境能稳定取得的真实终端。
- 设计样稿仍写着旧的 `继续提问…` 占位；本 spec 的替代关系已声明冲突以 §4.1.2 为准。`verify-preview.py` 通过（仅校验样稿自身的浏览器布局与交互，不校验 TUI 文案）。
- 复跑：`python3 scripts/pty-evidence-input-preview.py`（需要 tmux；脚本会先构建 `nano-app` 测试目标）。单场景调试可用 `NANO_EVIDENCE_SCENARIO=<name> cargo test -p nano-app evidence_frame -- --ignored --nocapture`。
