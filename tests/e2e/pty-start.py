#!/usr/bin/env python3
"""在真 PTY 里跑一条命令，等到发 Ctrl+C，然后把屏幕字节写到 --out。

macOS 的 `script` 要求 stdin 本身是终端，Node 测试里给不了；这里直接开 pty，
设置窗口大小和控制终端，让 nano 的 `/dev/tty` 路径也走得到。

只用于发布级冒烟，不抢前台、不截图、不动剪贴板。
"""

import argparse
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--wait", type=float, default=7.0)
    parser.add_argument("--rows", type=int, default=30)
    parser.add_argument("--cols", type=int, default=100)
    # 看到这个字符串就提前发 Ctrl+C；没看到就在 --wait 到点后发。
    parser.add_argument("--until", default=None)
    # 就绪后往终端里打一行（自动回车），再等 --send-wait 秒收集输出。
    parser.add_argument("--send", default=None)
    parser.add_argument("--send-wait", type=float, default=3.0)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()

    command = args.command
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        parser.error("missing command")

    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", args.rows, args.cols, 0, 0))

    pid = os.fork()
    if pid == 0:
        os.close(master)
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        os.dup2(slave, 0)
        os.dup2(slave, 1)
        os.dup2(slave, 2)
        if slave > 2:
            os.close(slave)
        try:
            os.execvp(command[0], command)
        finally:
            os._exit(127)

    os.close(slave)

    def forward_term(_signum, _frame):
        # 外层（Node 的 spawnSync timeout）只杀 python；把整个会话组一起带走，
        # 避免 nano 成为孤儿并一直持有 pty 与挂载锁。
        try:
            os.killpg(pid, signal.SIGKILL)
        except OSError:
            pass
        os._exit(143)

    signal.signal(signal.SIGTERM, forward_term)

    until = args.until.encode("utf-8") if args.until else None
    collected = bytearray()
    deadline = time.time() + args.wait
    while time.time() < deadline:
        ready, _, _ = select.select([master], [], [], 0.2)
        if not ready:
            continue
        try:
            chunk = os.read(master, 65536)
        except OSError:
            break
        if not chunk:
            break
        collected.extend(chunk)
        if until is not None and until in collected:
            break

    if args.send:
        try:
            os.write(master, args.send.encode("utf-8") + b"\r")
        except OSError:
            pass
        send_deadline = time.time() + args.send_wait
        while time.time() < send_deadline:
            ready, _, _ = select.select([master], [], [], 0.2)
            if not ready:
                continue
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            collected.extend(chunk)

    try:
        os.write(master, b"\x03")
    except OSError:
        pass

    # 再给关停一点时间；waitpid 必须带超时：被测进程若卡住，python 不能永久阻塞。
    status = None
    quiet_deadline = time.time() + 8.0
    while time.time() < quiet_deadline:
        done, waited = os.waitpid(pid, os.WNOHANG)
        if done == pid:
            status = waited
            break
        ready, _, _ = select.select([master], [], [], 0.2)
        if not ready:
            continue
        try:
            chunk = os.read(master, 65536)
        except OSError:
            break
        if not chunk:
            break
        collected.extend(chunk)

    if status is None:
        # 子进程是 setsid 出来的，pgid == pid；整组杀掉，避免遗留持有挂载锁。
        try:
            os.killpg(pid, signal.SIGKILL)
        except OSError:
            pass
        try:
            _, status = os.waitpid(pid, 0)
        except ChildProcessError:
            status = 0

    exit_code = os.waitstatus_to_exitcode(status)

    with open(args.out, "wb") as handle:
        handle.write(bytes(collected))
    print(exit_code)
    return 0


if __name__ == "__main__":
    sys.exit(main())
