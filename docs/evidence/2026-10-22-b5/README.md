# B5 首启来源面板 · 真实终端证据

- 日期：2026-10-25（按共享主题重拍）
- 分支：`issue-46`（已 rebase 到当前 `main`）
- 终端：Ghostty 1.3.1，macOS，默认字号；深色 100 列 × 35 行、浅色 60 列 × 30 行
- 主题：面板使用 `NANO_THEME` 调色板（`accent` / `muted` / `warning` / `fg`）；深浅两套隔离 Ghostty 配置，不读取用户配置
- 产物：本分支 `cargo build --release -p nano-app` 的 `target/release/nano`
- 测试：`cargo test --workspace` 全绿（653 通过）；桥接 274 通过 / 5 skip；真实宿主集成 21 通过
- 脚本验收：`tests/e2e/theme-pty.py` RESULT ok；`tests/e2e/ghostty-acceptance.py` RESULT ok（启动后先 Enter 关闭首启面板，再接原流程）
- 环境：合成 `HOME` / `DSH_HOME` / `NANO_DATA_ROOT` / workdir；启动环境设置假 `DEEPSEEK_API_KEY`，不读写用户真实凭据、会话或配置
- 宿主：真实官方 `dsh 0.2.1-rc.2`；本面板出现在 `nano.hello` 之后，不产生模型请求

## 场景与步骤

| 图 | 操作步骤 | 覆盖判据 |
| --- | --- | --- |
| `dark-100-sources.png` | 用合成环境安装 profile，`nano --no-install` 启动；夹具为 `$DSH_HOME/AGENTS.md`、`$HOME/.agents/AGENTS.md`、`work/AGENTS.md`、`work/CLAUDE.md`，启动环境设置 `DEEPSEEK_API_KEY`；握手完成后截图 | 面板显示配置 patch 的实际路径、凭据引用 `DEEPSEEK_API_KEY` 与来源「启动环境」、4 份规矩候选；不显示任何凭据值 |
| `dark-100-sources-dismissed.png` | 在上图按 Enter | 面板关闭，回到正常主界面；输入区可继续使用 |
| `light-60-sources.png` | 浅色主题、60 列窗口重复同一启动步骤 | 配置路径折行；候选路径折行完整显示，不溢出 |
| `light-60-sources-dismissed.png` | 在上图按 Enter | 浅色主题下关闭后回到正常主界面；输入区可继续使用 |

## 检查项

- [x] 配置来源：显示 `hello.provenance.config.path`（profile 的 `cordis.patch.yml`）
- [x] 凭据来源：显示引用名与官方来源标签（`启动环境`）；未配置时显示「未配置」；从不显示值
- [x] 规矩来源：首次对话前显示官方默认候选集中**存在**的文件，并标注「默认候选 · 以首轮实际加载为准」；首次对话后由 `Alt+R` 的官方投影显示实际加载来源
- [x] 缺失/不可读：缺失显示「宿主未报告」/「未发现」；不可读或超过 1 MiB 的候选标注「首轮跳过」，不伪造来源
- [x] 面板可关闭（Enter / Esc），关闭后正常进入主界面
- [x] 真实 Ghostty 窗口级截图；无用户真实路径、用户名、主机名或密钥

## 说明

官方 `agent-instructions` 在会话第一次 `agent/pre-step` 才把规矩文件载入为 durable 消息。首启面板因此分两态：

1. 首次对话前：列出官方默认候选集中实际存在的文件（`$DSH_HOME/AGENTS.md`、`$DSH_AGENTS_HOME/AGENTS.md`、项目链 `AGENTS.md` / `CLAUDE.md` 及 local 变体），并标注「默认候选 · 以首轮实际加载为准」。
2. 首次对话后：`Alt+R` 面板显示官方投影的实际加载来源、加载时间与预算提示。

面板不会把「候选存在」写成「已加载」；两态都不显示凭据值。

## 已知限制

- 凭据行显示 host 报告的默认 DeepSeek API Key 引用（`DEEPSEEK_API_KEY`）；`--provider` 覆盖或 profile 自定义 `apiKeyEnv` 时，面板不跟随实际 route。按「默认 DeepSeek」标注，避免写成当前 route。
- 候选集是官方默认规则在客户端的镜像：profile 覆盖的候选字段、同内容去重、resumed session 的当前工作目录不在本面板反映；最终以首轮实际加载为准（面板已写明）。
- `HOME` 未设置时客户端无法推导 `$HOME/.dsh` 与 `$HOME/.agents` 候选；官方 Node 侧另有 fallback。
