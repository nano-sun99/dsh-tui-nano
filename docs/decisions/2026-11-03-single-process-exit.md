# ADR-20261103-single-process-exit：守卫收进进程内，退出收敛为单一漏斗

- 状态：生效中（随 spec PR 2026-11-03 落地）
- 日期：2026-11-03
- 决策人：用户
- 适用范围：nano 的进程模型、诊断输出、退出路径、终端生命周期、终端失联检测
- 取代：[ADR-20261029-single-process-fd-guard](2026-10-29-single-process-fd-guard.md) 的两条决定——「launcher re-exec 拉起 runtime」「关停 3s 强制恢复定时器」；该 ADR 的「终端单写入者」「150ms 信号去重」继续有效（前者被本 ADR 加强为「只有 `Terminal.write` 能上屏」）
- 被取代：无
- 决策来源：2026-11-03 用户拍板——「按我的经验几轮下来不断地添油加醋打补丁，说明需求根本没有覆盖场景」「A：砍掉双进程」「claude code 解决过的问题，就站在巨人肩膀上；他没解决过的，告诉我你的方案」

## 决定

1. **不重定向 fd、不加 shim、不 re-exec**：`package.json` 的 `bin` 保持 `dist/bin.js`。守卫改为**进程内 sink**——启动时用 `openSync(path, 'a', 0o600)` 打开日志文件，所有诊断 `writeSync` 进去，失败即熔断。
2. **写改道**：TUI 路径下把 `process.stdout.write` / `process.stderr.write` / `console.*` 指到 sink（带重入保护）。`--version` / `--help` / `purge` 不装改道，输出照旧。`plain` 判定只在 JS 里做一份（`src/bin.ts:20-22`）。
3. **终端只有一个写入者，且该写入不可阻塞、可丢与必达分开**：`Terminal.write` 走 `/dev/tty`（改道之后的 stdout/stderr 不再能上屏）；句柄用 `O_RDWR | O_NONBLOCK` 打开。写分两类：`frame` 遇 `EAGAIN` 丢本帧剩余，`lifecycle`（7 条归还序列、探测、`writeVisible`）逐条有界重试（300ms，跨 `setImmediate`）；**`EAGAIN` 永不判失联**（XOFF 会让健康 tty 持续 EAGAIN），`EIO/ENXIO/ENODEV/EBADF/EPIPE` 才置 `lost`；`writeSync` 返回 `<= 0` 一律按 `EAGAIN` 处理（否则死循环）。**任何终端写都不许阻塞事件循环**——阻塞时所有进程内定时器（含 13.5s 保险丝）同时失效。
4. **退出收敛为单一漏斗** `exit(code, reason, hooks)`：`restore` → `release` → 记一行 → `process.exit` → 失败则 `SIGKILL`；`src/` 内除该文件外零 `process.exit(`。`restore` / `release` 由调用方以 hook 注入，漏斗不认识 `NanoApp`。
5. **终端归还排关停第一步**；只保留一个预算 `SHUTDOWN_BUDGET_MS = max(5000, TOTAL_BUDGET_MS + 3500) = 13.5s`（到点 `exit('fuse')` 且带 `release`）。不再保留 3s 强制恢复定时器。
6. **孤儿巡检**：30s 比对 `ppid` 快照（父进程先死）+ `/dev/tty` 零写探测（终端失联无 SIGHUP）；命中即走既有 `shutdown`。
7. **未捕获异常计数保险**：同进程连发 4 次 → `exit(70)`。
8. **退出码**：信号仍退 0；新增 70（连发未捕获）。不引入 129（launcher 已不存在）。

## 依据

- 事故：无守卫实例 fd 全 revoked、无日志文件，孤儿化后 83 分 20 秒吃满一核；4 秒复现；`uncaughtExceptionMonitor` 抓到 107,244 次未捕获异常，首条栈 `writeDiagnostic → stderr.write → EIO → onUncaught → writeDiagnostic`。
- 三轮补丁式审核共 37 条发现，且第四轮又在新位置掉出 2 个高——共同点是**判定与通道散落在结构里**（诊断通道随启动方式变、终端归属被切成两个进程、退出有五条路径、终端归还排最后）。
- v4 曾试过「POSIX sh shim + `exec` 重定向」，被第四轮重审证伪：npm 把 bin 装成符号链接（`dirname "$0"` 指错，`npm i -g` 后敲 `nano` 空白退出 1）、`scripts/prepack-check.mjs:59` 硬断言 `bin === 'dist/bin.js'`（发不出去）、`for a in "$@"` 把 `nano --root purge` 误判成 plain（守卫被静默跳过）、`exec node` 走 PATH（GUI/launchd 下 127）。四条同源：**判定被搬到了 sh 里**。
- 终端写会阻塞，不是理论风险：Node 文档〈A note on process I/O〉写明 POSIX 上 tty 写是同步的；本机实测（pty 且不读 master）macOS pty 缓冲只有 **1024 字节**，阻塞模式下 64KB 的第一笔写**永不返回**（1.5s 后仍 0% CPU），`O_NONBLOCK` 下第一次写 1024 字节（部分写）、第二次抛 `EAGAIN` 立即返回。这是事故里「0% CPU 卡死」与「100% CPU 自激」两种形态的另一半。
- Claude Code 2.1.88 的做法（本机归档）：诊断写文件 + 双层 try/catch（`utils/diagLogs.ts:44-60`）、patch `stderr.write` 并转日志（`ink/ink.tsx:1605-1642`，注释明说「Not patching process.stdout — Ink itself writes there」）、patch `console.*`（`:1570-1590`）、`process.exit` 抛 EIO 时降级 `SIGKILL`（`utils/gracefulShutdown.ts:193-232`）、终端回归还排在第一件事（`:436`）、failsafe 跟内部预算缩放（`:417-426`）。它**没有** fd 重定向、没有 re-exec、没有标记变量。
- 与 CC 的差异（它没解决、我们自研）：真孤儿（全仓无 `ppid` 存活判定）、无 SIGHUP 的失联（它靠 `stdout.writable`，Node 语义下恒真）、未捕获异常处理器自身抛错且不退出、关停期间重复信号不升级（我们保留 SIGINT 第二击）。

## 否决了什么

- **保留 launcher + re-exec，只把标记改成 argv**：能堵泄漏，但两套 fd 语义、两套生命周期的结构成本还在，会继续长条款。
- **POSIX sh shim + `exec` 重定向**（v4）：见〈依据〉，四个高/中问题同源，且全部来自「判定在 sh 里」。
- **只加 try/catch、不加漏斗**：挡住本次路径，关停卡住仍会挂死。
- **`uncaughtException` 只记日志不退出**（CC 的做法）：进程带病继续跑、终端不复位；本 ADR 选择「记一行 + 走关停 + 到点强杀 + 连发计数」。
- **加 `os: ["darwin","linux"]`**：不解决任何问题（darwin 本来就通过），不是风险缓解。

## 接受的代价

- **native 直写 fd1 拦不住**：改道只在 JS 层。phase-0 实测 0 次，CC 同样放弃这条。若将来引入 native 渲染库，需重开本 ADR。
- **同步阻塞卡死仍是洞**：failsafe 与 SIGKILL 都跑在同一个事件循环里。本 ADR 明确不承诺；如需硬保证，另开单用 `worker_threads` 看门狗。
- 孤儿巡检 30s 粒度，最坏空转 30s（CC 是永远发现不了）。
- `O_NONBLOCK` 下健康终端也可能出现部分写：`frame` 靠既有偏移量循环重试、极端情况掉一帧（下一帧全量重绘自愈）；`lifecycle` 序列最多重试 300ms，仍失败会落 `ttyRestoreFailed`，靠下次启动的 reset 提示兜底。
- 归还序列在极端拥塞下仍可能送不出去（300ms 预算），此时终端可能停在 alt-screen —— 由 `ttyRestoreFailed` 提示用户 `nano reset`。
- **日志写仍是同步 `writeSync`**：本地盘无碍，NFS / 网络文件系统上可能卡死——本 ADR 不解决，作为已知边界记录。
- 日志文件名沿用 `nano-<ts>-<pid>.log`，与历史一致；`NANO_LOG_FILE` 从契约中删除（零消费方）。
- 与 CC 在「关停期间重复信号」上行为不同：我们允许 SIGINT 第二击强制，CC 直接吞掉后续信号。

## 允许重开的条件

- 引入 native 模块直接写 fd1/2，且实测逃出改道。
- 需要 Windows 原生支持（改道与 `/dev/tty` 都要重做）。
- 决定用 worker 看门狗兜住同步阻塞（对 D 状态无效，只在「JS 层死循环且循环外无法干预」时有用）。
- 需要支持写日志到网络文件系统。

## 关联

- Spec：`docs/specs/2026-11-03-nano-exit-hardening/README.md`（v7）
- Issue：[#164](https://github.com/nano-sun99/dsh-tui-nano/issues/164)
- 被取代：[ADR-20261029-single-process-fd-guard](2026-10-29-single-process-fd-guard.md)（仅 launcher re-exec 与 3s 强制恢复两条；其「终端单写入者」「150ms 信号去重」继续有效）
