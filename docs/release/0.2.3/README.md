# dsh-tui-nano 0.2.3 发布验收

- **结论：发布（2026-11-04 用户指示「打一个 0.2.3 到 GitHub，不在本地安装」）。** 发行渠道为 **GitHub Release `v0.2.3`**；**npm registry 仍不发布**。
- 产物：`packaging/dist/dsh-tui-nano-0.2.3.tgz`，595,614 字节 / 157 文件；SHA-256 `9bb439f0a330955c0960b724196b842615183382963f10f456ce90af88237415`；npm integrity `sha512-+zPYTnpn02bJzCa991PVKz8FmAxZLpNZGQFbkH0bKlGrFzQJXELbVqxT/0xvdYZpjzPMjkBR+ekuxsvl4viaQw==`。
- 构建基线：`742b22d`（Merge PR #167）+ 本发布提交（`package.json` / lock 0.2.3、两个 README 版本面、本记录）。tag 打在发布 PR 的合并 commit。
- 安装：下载附件后 `npm install -g ./dsh-tui-nano-0.2.3.tgz`；**不要**执行 `npm install -g dsh-tui-nano`（E404，registry 未发布）。

## 本版内容（v0.2.2..v0.2.3）

| 范围 | 内容 |
| --- | --- |
| **崩溃修复** | #164 / #166：终端挂断后诊断写抛 `EIO` → `onUncaught` 里再写 → 自激，4 秒 107,244 次未捕获异常、一条核烧 83 分钟不退。现在诊断写走 `writeSync` + 熔断、退出走 `forceExit`（`process.exit` 抛错则 `SIGKILL` 自己），三处接线（`main.ts` 诊断注入 / `bin.ts` 顶层 catch / `writeToTty` 的 stderr 腿） |
| 规格 | #165：该修复的最小 spec（骨架→七版收敛为一份）；过程复盘见 [spec-flow#130](https://github.com/nano-sun99/spec-flow/issues/130) |
| 文档 | #163：README 重写，用真机截图展示思考、Bash 与模型切换 |

## 验证

- `npm run typecheck`：通过。
- `npm run lint`：0 error / 5 warning（存量 warning，无 error）。
- `npm test`：unit 537 / 537，feature 55 / 55。
- `npm run test:e2e`：62 项中 59 通过、0 失败、3 跳过（433.5s）。
- `npm run prepack`：通过（157 文件，入口 `dist/bin.js` 带 shebang）。
- 事故复现回归（手工，spec §2 R3）：`NANO_GUARDED=1 node dist/bin.js` 在 pty 挂断后 **1 秒内退出**；修复前同一脚本稳定 100% CPU 不退。

## 已知限制（本版明确未做，见 spec §4）

- 单一退出漏斗（五条退出路径合一）、孤儿巡检（父进程先死 / 无 SIGHUP）、终端写不可阻塞（`O_NONBLOCK` / 输出队列）、`feature-host.ts` 的 7 处诊断写、`NANO_GUARDED` 泄漏本身 —— 均未在本版修复，各自待立项。
- 诊断改为同步写后，终端读停时 `writeSync` 可能阻塞事件循环（本次只保证不再自激）。
- `npm run lint` 的 5 条 warning 为存量，未在本版处理。
