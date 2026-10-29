# 发布级 e2e

这些测试只属于发布验收（S03 §6），不替代 `tests/unit`（S01）与 `tests/feature`（S02）的回归。

```sh
npm run test:e2e
```

前置：`npm ci && npm run build`；`npm pack` 的 `prepack` 会自己再构建一次。

## 覆盖

| 用例                             | 判据                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| `pack 产物与哈希可复现`          | tarball 名含版本、SHA-256；`dist/bin.js` 在包内且带 shebang；`src/`、`tests/` 不进包 |
| `全新安装后 nano --version 可用` | 合成前缀里 `npm install -g <tarball>`，bin 可执行，版本与 harness 正确               |
| `--help 含用法与键位段`          | `--help` 有用法与从 keymap 源生成的键位段                                            |
| `purge 无 --yes 且非交互时拒绝`  | 退出非零、提示 `--yes`、数据根原样保留                                               |
| `purge --yes 删除数据根`         | 数据根被删除                                                                         |
| `启动冒烟`                       | 真 PTY 下起界面、Ctrl+C 干净退出；`$DSH_HOME` 只允许新增 `.anonymous-user-id`        |
| `未知 harness 版本拒绝启动`      | `loadOfficial` 对非 `0.2.1-rc.2` 的锚点报「版本不受支持」                            |
| `强杀残留提示 reset`             | 预置陈旧挂载锁（不存在的 pid），下次启动界面出现 `reset` 提示                        |
| `升级`                           | 装 0.2.1 后 `--version` 跟着变，再装回 0.2.0                                         |
| `普通卸载保留数据根`             | bin 消失、数据根保留、重装后可用                                                     |
| `keymap 文档与源码一致`          | `scripts/keymap-docs.mjs --check`                                                    |
| `架构门禁`                       | 对 `git ls-files` 结果跑 S03 §4 的 grep，必须为空                                    |

## 隔离与边界

- 全部使用合成的 `HOME` / `DSH_HOME` / `NANO_DATA_ROOT` / npm 安装前缀，不读写真实数据根。
- 启动冒烟用 `tests/e2e/pty-start.py` 开真 PTY（macOS 的 `script` 不接受非 TTY stdin），只发 Ctrl+C，不开窗口、不截图、不动剪贴板。
- 「升级」用的 0.2.1 包是从 0.2.0 tarball 解包改版本号重打的，只验证升级安装路径，不是发布物。
- 需要桌面合成、透明与字体的 Ghostty 视觉验收不在此自动化范围内，按需人工跑并在发布结论里注明证据来源。
