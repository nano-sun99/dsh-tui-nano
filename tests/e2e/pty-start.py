#!/usr/bin/env python3
"""在真 PTY 里跑一条命令，按脚本输入，然后把屏幕字节写到 --out。

macOS 的 `script` 要求 stdin 本身是终端，Node 测试里给不了；这里直接开 pty，
设置窗口大小和控制终端，让 nano 的 `/dev/tty` 路径也走得到。

只用于发布级 e2e，不抢前台、不截图、不动剪贴板。信号（TERM/INT/HUP）会把
被测进程的整个会话组一起带走，避免留下持锁孤儿。
"""

import argparse
import fcntl
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

KEY_BYTES = {
    "up": b"\x1b[A",
    "down": b"\x1b[B",
    "left": b"\x1b[D",
    "right": b"\x1b[C",
    "enter": b"\r",
    "esc": b"\x1b",
    "tab": b"\t",
}

CURSOR_POS = re.compile(rb"\x1b\[(\d+);(\d+)H")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--wait", type=float, default=7.0)
    parser.add_argument("--rows", type=int, default=30)
    parser.add_argument("--cols", type=int, default=100)
    # 看到这个字符串就提前发 Ctrl+C；没看到就在 --wait 到点后发。
    parser.add_argument("--until", default=None)
    # 就绪后往终端里打若干行（用 \n 分隔，每行自动回车）。
    parser.add_argument("--send", default=None)
    parser.add_argument("--send-wait", type=float, default=3.0)
    # 只打字不回车（观察输入框/补全）。
    parser.add_argument("--send-raw", default=None)
    # 发 Ctrl+C 之前把当前屏幕字节另存一份（用于断言稳定态）。
    parser.add_argument("--split-out", default=None)
    # 发送后等到这个标记出现再继续（优先于固定 send-wait）。
    parser.add_argument("--send-until", default=None)
    # 按键（逗号分隔：up/down/left/right/enter/esc/tab）。
    parser.add_argument("--keys", default=None)
    parser.add_argument("--keys-wait", type=float, default=5.0)
    # 按键前先等这个标记出现（最多 20s）。
    parser.add_argument("--keys-after", default=None)
    # 按键后等到这个标记出现再继续。
    parser.add_argument("--keys-until", default=None)
    # 找到这个文本所在的屏幕行并点一下（用于展开工具行/差异块）。
    parser.add_argument("--click-marker", default=None)
    parser.add_argument("--click-wait", type=float, default=3.0)
    # 被测进程的工作目录（默认继承调用方）。
    parser.add_argument("--cwd", default=None)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()

    command = args.command
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        parser.error("missing command")

    # out 先转绝对路径：--cwd 之后相对路径会被解析到新目录。
    out_path = os.path.abspath(args.out)
    if args.cwd:
        os.chdir(args.cwd)

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
        # 外层（Node 的 spawnSync timeout）只杀 python；把整个会话组一起带走。
        try:
            os.killpg(pid, signal.SIGKILL)
        except OSError:
            pass
        os._exit(143)

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, forward_term)

    collected = bytearray()

    def drain(until=None, timeout=0.0):
        """读到标记出现或超时；标记为 None 时读满 timeout。"""
        target = until.encode("utf-8") if until else None
        deadline = time.time() + timeout
        while time.time() < deadline:
            if target is not None and target in collected:
                return True
            ready, _, _ = select.select([master], [], [], 0.2)
            if not ready:
                continue
            try:
                chunk = os.read(master, 65536)
            except OSError:
                return False
            if not chunk:
                return False
            collected.extend(chunk)
        return target is None or target in collected

    drain(args.until, args.wait)

    if args.send_raw:
        try:
            os.write(master, args.send_raw.encode("utf-8"))
        except OSError:
            pass
        drain(args.send_until, args.send_wait)

    if args.send:
        for line in args.send.split("\n"):
            try:
                os.write(master, line.encode("utf-8") + b"\r")
            except OSError:
                break
            if args.send_until:
                drain(args.send_until, args.send_wait)
            else:
                drain(None, args.send_wait)

    if args.keys:
        names = [name.strip() for name in args.keys.split(",") if name.strip()]
        unknown = [name for name in names if name not in KEY_BYTES]
        if unknown:
            parser.error(f"unknown key names: {', '.join(unknown)}")
        if args.keys_after:
            drain(args.keys_after, 20.0)
        for name in names:
            try:
                os.write(master, KEY_BYTES[name])
            except OSError:
                break
            # 分开写，避免 ESC 与 CR 粘成 Alt+Enter。
            time.sleep(0.15)
        if args.keys_until:
            drain(args.keys_until, args.keys_wait)
        else:
            drain(None, args.keys_wait)

    if args.click_marker:
        marker = args.click_marker.encode("utf-8")
        snapshot = bytes(collected)
        index = snapshot.rfind(marker)
        if index >= 0:
            positions = list(CURSOR_POS.finditer(snapshot[:index]))
            if positions:
                row = int(positions[-1].group(1))
                col = int(positions[-1].group(2))
                try:
                    os.write(master, f"\x1b[<0;{col};{row}M".encode())
                    os.write(master, f"\x1b[<0;{col};{row}m".encode())
                except OSError:
                    pass
                drain(None, args.click_wait)

    if args.split_out:
        with open(os.path.abspath(args.split_out), "wb") as handle:
            handle.write(bytes(collected))

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

    with open(out_path, "wb") as handle:
        handle.write(bytes(collected))
    print(exit_code)
    return 0


if __name__ == "__main__":
    sys.exit(main())
