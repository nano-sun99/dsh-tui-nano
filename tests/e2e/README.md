# 发布级 e2e

这些测试只属于发布验收（S03 §6），不替代 `tests/unit`（S01）与 `tests/feature`（S02）的回归。

```sh
npm run test:e2e
# 可选：带上 Node 版本矩阵
NANO_NODE_22=<node-22.19> NANO_NODE_20=<node-20> npm run test:e2e
```

前置：`npm ci && npm run build`；`npm pack` 的 `prepack` 会自己再构建一次。首次运行会下载官方依赖树，之后复用固定 cache。两个套件串行跑（`--test-concurrency=1`）。

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

## 隔离与边界

- 使用合成 `HOME` / `DSH_HOME` / `NANO_DATA_ROOT` / npm 安装前缀；npm cache 固定在系统临时目录，不写 `~/.npm`。
- 所有 PTY 测试都不开窗口、不抢焦点、不动剪贴板；`pty-start.py` 的 `waitpid` 带超时，卡住时 `killpg` 整组。
- 「升级」用的 0.2.1 包是从 0.2.0 tarball 解包改版本号重打的，只验证升级安装路径，不是发布物。
- 需要桌面合成、透明与字体的 Ghostty 视觉验收不在此自动化范围内，按需人工跑并在发布结论里注明证据来源。
