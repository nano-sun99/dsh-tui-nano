# 发布级 e2e

这些测试只属于发布验收（S03 §6），不替代 `tests/unit`（S01）与 `tests/feature`（S02）的回归。

```sh
npm run test:e2e
# 可选：带上 Node 版本矩阵
NANO_NODE_22=<node-22.19> NANO_NODE_20=<node-20> npm run test:e2e
```

前置：`npm ci && npm run build`；`npm pack` 的 `prepack` 会自己再构建一次。首次运行会下载官方依赖树，之后复用固定 cache。所有套件串行跑（`--test-concurrency=1`）。共 42 个用例：安装 16 + 视觉 3 + 能力 1 + 交互 6 + 输入 2 + 跨会话 10 + 主链路 2 + Monitor 1 + 调度 1。发布证据运行显式设置了 `NANO_NODE_22` / `NANO_NODE_20`，因此 Node 矩阵两例不 skip，42/42 全过。

## `release.test.mjs`（16）

| 用例                                   | 判据                                                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `pack 产物可复现且与版本矩阵一致`      | 连打两次 SHA-256 相同；`version-matrix.md` 记录了该值；`dist/bin.js` 带 shebang；`src/`、`tests/` 不进包 |
| `全新安装后 nano --version 可用`       | 合成前缀里 `npm install -g <tarball>`，bin 可执行，版本与 harness 正确                                   |
| `--help 含用法与键位段`                | `--help` 有用法与从 keymap 源码生成的键位段                                                              |
| `purge 无 --yes 且非交互时拒绝`        | 退出非零、提示 `--yes`、数据根原样保留                                                                   |
| `--root purge 不会被当成 purge 子命令` | `--root purge --yes` 与 `--root=purge --yes` 都不得删数据根                                              |
| `purge --yes 删除数据根`               | 数据根被删除                                                                                             |
| `启动冒烟`                             | 真 PTY 下出现 pre-boot 骨架、Ctrl+C 干净退出；`$DSH_HOME` 只允许新增 `.anonymous-user-id`                |
| `未知 harness 版本拒绝启动`            | `loadOfficial` 对非 `0.2.1-rc.2` 的锚点报「版本不受支持」                                                |
| `强杀残留提示 reset`                   | 预置陈旧挂载锁（不存在的 pid），下次启动界面出现 `reset` 提示                                            |
| `骨架后核心加载失败`                   | 把已安装包的 `startCore` 换成抛错 shim：骨架可见、错误可见、退出 1、安装前缀恢复原状                     |
| `Node 22.19（下限）里能启动`           | 先断言 `NANO_NODE_22` 真是 22.19.0 且 PATH 解析一致，再跑启动冒烟                                        |
| `低于 22.19 拒绝启动并给可操作错误`    | 20.20 在入口打印可操作错误并退出 1                                                                       |
| `升级`                                 | 装 0.2.1 后 `--version` 跟着变，再装回 0.2.0                                                             |
| `普通卸载保留数据根`                   | bin 消失、数据根保留；重装后真 PTY 启动成功                                                              |
| `keymap 文档与源码一致`                | `scripts/keymap-docs.mjs --check`                                                                        |
| `架构门禁`                             | 从 spec §4 提取 grep 正则，对 `git ls-files` 结果必须为空                                                |

每个安装/升级/purge/卸载步骤都会打印 `STEP <name>` 行，记录数据根、`$DSH_HOME` 与安装目录的文件数及摘要哈希。

## `vision-pty.test.mjs`（3）

真 PTY 无头跑 nano，解析它发出的 SGR 字节：深/浅主题分别命中各自色盘的 RGB、均不含 ANSI 命名色；60/100 列骨架行不超宽且有一行铺满。该套件跑仓库 `dist/`，不安装 tarball。

**边界**：PTY 只证明 nano 发了什么颜色，不证明 Ghostty 的合成、透明、字体与窗口观感；后者仍要真机截图，不能用本文件替代。

## `capability.test.mjs`（1）

boot 官方核心后读工具注册表：断言 terminal 不在 Agent 工具表里，且 `ask_user_question` 存在。

## `interaction-pty.test.mjs`（6）

真 PTY 里输入并观察界面：

- 无凭据发送消息：界面显示「回合出错」与官方原因，进程不崩。
- 网络不可达：`DEEPSEEK_BASE_URL=http://127.0.0.1:9`（连接被拒）时显示「回合出错」与网络错误原文，进程不崩；没有 DNS 用例。
- `/model` 打开面板：显示标题、当前模型、官方目录与强度。
- `/model` 直接切换与目录外拒绝：合法模型切换成功，目录外模型被拒。
- `!echo nano-bang`：首次使用先显示「以用户权限运行，不是 Agent 授权」的提示，再显示命令行、输出与退出码。
- `!!` 与 `!` 各自提示一次，文案区分「不注入上下文」与「会作为上下文注入」。

## `monitor-policy.test.mjs`（1）

读编译产物：`watch()` 默认 `quiet`；`notify` 行必须显示「会唤醒模型并计费」。

## `cross-session.test.mjs`（2）

共用一份数据根的两个真 PTY 进程：

- 同根第二窗口被拒，并说明被哪个进程占用。
- 双 root 并发都能起界面；`sessions` 根共享、叶子目录按 root 分开，`runtime-data/<root>/storage` 各自独立；root-b 的界面与会话日志都不含 root-a 的输入（含正控）。

边界：这里覆盖目录与进程层；九面内容隔离由 `cross-surface.test.mjs`（8 项）与 `schedule-surface.test.mjs`（1 项）单独取证。

## `cross-surface.test.mjs`（8）

同一数据根、不同 root 的真 PTY：A 制造内容，B 的界面不得出现。覆盖 transcript、草稿、附件、审批、队列、终端、问题、Monitor；Monitor 的 B 侧先断言任务面板打开且为空（正控），再断言 A 的后台任务 / 监听器不可见。

## `schedule-surface.test.mjs`（1）

boot 两个 root 的官方核心与 nano 调度门面：A 创建任务后，A 门面能看到；B 创建自己的任务后，B 门面能看到自己的、看不到 A 的，A 也看不到 B 的。同时断言门面投影不丢 `id/title/prompt/scheduledAt`。

## `main-chain.test.mjs`（2）+ `mock-model.mjs`

用本地 Anthropic Messages SSE mock 当模型（`DEEPSEEK_BASE_URL` 指向它，假 key），真 PTY 跑主链路：

- 同一条链路：read → edit → bash 提权；差异块点击展开后可见 `- old` / `+ new`；审批卡默认焦点「拒绝」，↑+Enter 选「允许一次」后命令执行并完成。
- 拒绝路径：直接 Enter 走默认「拒绝」，命令不执行，mock 按 `is_error` 回失败文本、不谎报完成。

mock 监听随机端口，不触真实网络与真实凭据。

## `ghostty-visual.py`

真 Ghostty 截图（需要辅助功能与屏幕录制权限）：深/浅、60/100 列、CJK、diff 工具行、0.8 透明度。每个场景用独立 Ghostty 实例，跑完立即结束该实例并清理临时目录；只截取本次窗口。

```sh
python3 tests/e2e/ghostty-visual.py --tarball packaging/dist/dsh-tui-nano-0.2.0.tgz --out docs/release/0.2.0/evidence/ghostty
```

## 隔离与边界

- 使用合成 `HOME` / `DSH_HOME` / `NANO_DATA_ROOT` / npm 安装前缀，并清掉继承的 `DEEPSEEK_API_KEY` 等凭据变量；npm cache 固定在系统临时目录，不写 `~/.npm`。`capability.test.mjs` 在进程内临时改 `process.env`，finally 恢复。
- 所有 PTY 测试都不开窗口、不抢焦点、不动剪贴板；`pty-start.py` 的 `waitpid` 带超时，卡住时 `killpg` 整组。
- 「升级」用的 0.2.1 包是从 0.2.0 tarball 解包改版本号重打的，只验证升级安装路径，不是发布物。
- 需要桌面合成、透明与字体的 Ghostty 视觉验收不在此自动化范围内，按需人工跑并在发布结论里注明证据来源。
