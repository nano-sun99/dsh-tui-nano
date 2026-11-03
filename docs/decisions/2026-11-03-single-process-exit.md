# ADR-20261103-single-process-exit：守卫改由 shim 承担，退出收敛为单一漏斗

- 状态：生效中（随 spec PR 2026-11-03 落地）
- 日期：2026-11-03
- 决策人：用户
- 适用范围：nano 的进程模型、fd 守护方式、退出路径、诊断输出、终端生命周期
- 取代：[ADR-20261029-single-process-fd-guard](2026-10-29-single-process-fd-guard.md) 的三条决定——「launcher re-exec 拉起 runtime」「用 `NANO_GUARDED` 标记已守卫」「关停 3s 强制恢复定时器」；该 ADR 的其余决定（终端单写入者、150ms 信号去重、诊断走重定向 stderr）继续有效
- 被取代：无
- 决策来源：2026-11-03 用户看完三轮审核（共 37 条发现）后拍板——「按我的经验几轮下来不断地添油加醋打补丁，说明需求根本没有覆盖场景需要重新梳理」「A：砍掉双进程」

## 决定

1. **守卫由 POSIX sh shim 承担，运行态只有一个 Node 进程**：`bin/nano` 是 `#!/bin/sh`，用 `exec node dist/bin.js "$@" >>"$LOG" 2>&1` 把 fd 1/2 在**进程出生时**绑到日志，stdin 仍是终端，渲染走 `/dev/tty`。`exec` 后 pid 不变，信号与父子关系与单进程一致。
2. **`NANO_GUARDED` 环境变量、`fd-guard.ts`、re-exec 分支全部删除**：「是否已守卫」不再是一个需要跨进程传递的状态。
3. **诊断只写 sink**：`writeDiagnostic` 写 fd 2（`try/catch` + 一次熔断），「必须让人看见」的错误走 `writeVisible` 写 `/dev/tty`。任何诊断代码不得抛。
4. **退出收敛为单一漏斗** `exit(code, reason)`：restore → 记一行 → `process.exit` → 失败则 `SIGKILL` 自己；`src/` 内除该文件外零 `process.exit(`。
5. **终端回归还优先**：`shutdown()` 第一件事就是 `terminal.restore()`；`TtyState` 是唯一的状态（`ok` / `lost`），只有一个探测者，关停一开始就停检。
6. **保留** ADR-20261029 的两条：终端单写入者（渲染只走 `/dev/tty`）、150ms 信号去重。

## 依据

- 事故：无守卫实例孤儿化后 83 分 20 秒吃满一核；4 秒可复现；`uncaughtExceptionMonitor` 抓到 4 秒 **107,244 次**未捕获异常，首条栈是 `writeDiagnostic → stderr.write → EIO → onUncaught → writeDiagnostic`。
- 三轮审核 37 条发现的归因：**9 条来自双进程切碎终端归属**（`NANO_GUARDED` 泄漏导致无限 re-exec、「哪个 fd 才是终端」、launcher 无 `shutdown`、129 退出码、回归用例构造不出来）；**8 条来自诊断通道身份随启动方式变**；**7 条来自退出无单一漏斗**；**6 条来自终端归还排最后**。补丁式修法在新位置持续冒同类问题。
- 双进程想拿的那条保证（第三方库直写 fd 1/2 不上屏），内核级重定向就能给，且**没有 JS 抓不到的缝隙**；项目 0 处 `win32` 代码，POSIX sh 足够。
- Claude Code 2.1.88 的对照：单进程无 re-exec、单一 `forceExit`（`utils/gracefulShutdown.ts:193-232`）、诊断写文件（`utils/diagLogs.ts:44-56`）、交互模式 patch 掉 `stderr.write`（`ink/ink.tsx:1604-1637`）、终端归还排在关停第一件事（`:436`）。本 ADR 与它同构，但比它多两条：父进程存活判定（它对真孤儿完全未覆盖）与「未捕获异常要退出」（它只记日志）。
- 公开同类案例：[cocalc#6963](https://github.com/sagemathinc/cocalc/issues/6963)、[vscode#44408](https://github.com/microsoft/vscode/issues/44408)——「tty 消失 + 持续写」是这一类工具的通病，不是本仓偶发。

## 关于「重新打开 ADR-20261029」

该 ADR 的〈允许重开的条件〉列的是「Node 提供 dup2」「官方 DSH 不再写 fd 1/2」「出现必须只有一个 OS 进程的部署约束」，本次**不属于其中任何一条**。

重开依据是新的经验证据：re-exec 的**成本已经超过它买到的收益**——它引入的是一整类跨进程状态缺陷（见〈依据〉的 9 条），而收益（拦截 native 直写）可以用更强的机制（内核重定向）零成本拿到。这条依据由用户 2026-11-03 明确拍板，记录在此，不追溯修改原 ADR 的重开条件。

## 否决了什么

- **B 案：保留双进程，只把标记从环境变量改成 argv**：能堵住泄漏，但「两套 fd 语义、launcher 二套生命周期、两份巡检」的结构成本仍在，后续还会长出新条款。
- **C 案：只写不变量、不动结构**：文档收敛了，缺陷还在。
- **保留 3s 强制恢复定时器**：终端归还既然排在关停第一步，3s 兜底的语义已被 `RESTORE_BUDGET_MS` 覆盖，不另设。

## 接受的代价

- `node dist/bin.js` 直跑时失去 fd 守护（开发态可接受；回归用例 B 保证它仍不会挂死）。
- shim 复制两行日志目录解析逻辑（`NANO_DATA_ROOT` / `$HOME`），用 parity 测试锁住与 `src/boot/cli.ts` 的一致性。
- 不再支持 Windows（项目本来 0 处 `win32` 代码；`package.json` 建议补 `os` 字段让安装显式失败）。
- 日志文件名从 `nano-<ISO>-<pid>.log` 变为 `nano-<YYYYMMDDTHHMMSS>-<pid>.log`（可读性优先，不追求逐字兼容）。
- shim 里为 `--help` / `--version` / `purge` 保留一条透传分支——这是新增的「两份清单要一致」的维护点。

## 允许重开的条件

- 需要真正的跨平台分发（Windows 原生），届时得把 shim 换成可移植的启动器。
- Node 提供标准化的 fd 重绑定能力，使 shim 也不必存在。
- 出现「必须拦截 native 直写、且内核重定向不可用」的场景。

## 关联

- Spec：`docs/specs/2026-11-03-nano-exit-hardening/README.md`（第 4 版，按 I1–I4 重写）
- Issue：[#164](https://github.com/nano-sun99/dsh-tui-nano/issues/164)
- 被取代：[ADR-20261029-single-process-fd-guard](2026-10-29-single-process-fd-guard.md)
