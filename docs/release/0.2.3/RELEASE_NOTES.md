# dsh-tui-nano v0.2.3

本地构建的安装包（GitHub Release 附件），**未发布到 npm registry**。

## 安装

下载附件 `dsh-tui-nano-0.2.3.tgz` 后：

```sh
npm install -g ./dsh-tui-nano-0.2.3.tgz
nano --version   # nano 0.2.3
```

> 不要执行 `npm install -g dsh-tui-nano`：整包未上 npm registry（E404）。

## 本版内容

- **#164 / #166 崩溃修复**：终端挂断后，诊断写 `stderr` 抛 `EIO`，而「未捕获异常」的处理器里**又**调同一个写 → 再抛 → 自激。4 秒可复现、107,244 次未捕获异常、一条核烧 83 分钟不退。
  - 诊断写改走 `writeSync` + 一次熔断（`EAGAIN` 不熔断，其余视为通道已死）；
  - 新增 `forceExit`：`process.exit` 抛错就 `SIGKILL` 自己；
  - 三处接线（`main.ts` 诊断注入 / `bin.ts` 顶层 catch / `writeToTty` 的 stderr 腿），缺一条就少一条兜底。
- **#165** 该修复的最小 spec；过程复盘见 [spec-flow#130](https://github.com/nano-sun99/spec-flow/issues/130)。
- **#163** README 重写，用真机截图展示思考、Bash 与模型切换。

## 验证

- typecheck 通过；lint 0 error / 5 warning（存量）。
- unit 537 / 537；feature 55 / 55。
- e2e：62 项中 59 通过、0 失败、3 跳过（433.5s）。
- 事故复现回归：`NANO_GUARDED=1 node dist/bin.js` 在 pty 挂断后 **1 秒内退出**（修复前稳定 100% CPU 不退）。

## 已知限制

- 未做：单一退出漏斗、孤儿巡检（父进程先死 / 无 SIGHUP）、终端写不可阻塞（`O_NONBLOCK` / 输出队列）、`feature-host.ts` 的 7 处诊断写、`NANO_GUARDED` 泄漏本身。
- 诊断改为同步写后，终端读停时 `writeSync` 可能阻塞事件循环（本版只保证不再自激）。

## 校验

```
SHA-256   9bb439f0a330955c0960b724196b842615183382963f10f456ce90af88237415
integrity sha512-+zPYTnpn02bJzCa991PVKz8FmAxZLpNZGQFbkH0bKlGrFzQJXELbVqxT/0xvdYZpjzPMjkBR+ekuxsvl4viaQw==
文件      157（595,614 字节）
```
