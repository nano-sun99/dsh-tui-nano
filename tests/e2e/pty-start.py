#!/usr/bin/env python3
"""在真 PTY 里跑一条命令，等一会儿、发 Ctrl+C，然后把屏幕字节写到 --out。

macOS 的 `script` 要求 stdin 本身是终端，Node 测试里给不了；这里直接开 pty，
设置窗口大小和控制终端，让 nano 的 `/dev/tty` 路径也走得到。

只用于发布级冒烟，不抢前台、不截图、不动剪贴板。
"""

import argparse
import fcntl
import os
import pty
import select
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
    chunks = []
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
        chunks.append(chunk)

    try:
        os.write(master, b"\x03")
    except OSError:
        pass

    # 再给关停一点时间；3s 强制恢复之后还没退出就收尾。
    quiet_deadline = time.time() + 8.0
    while time.time() < quiet_deadline:
        ready, _, _ = select.select([master], [], [], 0.2)
        if not ready:
            continue
        try:
            chunk = os.read(master, 65536)
        except OSError:
            break
        if not chunk:
            break
        chunks.append(chunk)

    _, status = os.waitpid(pid, 0)
    exit_code = os.waitstatus_to_exitcode(status)

    with open(args.out, "wb") as handle:
        handle.write(b"".join(chunks))
    print(exit_code)
    return 0


if __name__ == "__main__":
    sys.exit(main())
