#!/usr/bin/env python3
"""在真 PTY 里按带延迟的步骤输入，用于需要「先开面板、再输入」的自动化证据。

只用于发布级 e2e：不开窗口、不抢焦点、不截图。
步骤是 JSON 数组，每项 {"delay": 秒, "send": "文本"}；文本里的 \\u0014 等按 JSON 解码。
"""

import argparse
import fcntl
import json
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
    parser.add_argument("--split-out", default=None)
    parser.add_argument("--wait", type=float, default=10.0)
    parser.add_argument("--until", default="输入消息")
    parser.add_argument("--rows", type=int, default=30)
    parser.add_argument("--cols", type=int, default=100)
    parser.add_argument("--cwd", default=None)
    parser.add_argument("--steps", required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        parser.error("missing command")
    steps = json.loads(args.steps)
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
        try:
            os.killpg(pid, signal.SIGKILL)
        except OSError:
            pass
        os._exit(143)

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, forward_term)

    collected = bytearray()

    def drain(until=None, timeout=0.0):
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
    for step in steps:
        time.sleep(float(step.get("delay", 0.2)))
        text = str(step.get("send", ""))
        if text:
            try:
                os.write(master, text.encode("utf-8"))
            except OSError:
                break
        if step.get("until"):
            drain(str(step["until"]), float(step.get("timeout", 10.0)))
    drain(None, 1.0)

    if args.split_out:
        with open(os.path.abspath(args.split_out), "wb") as handle:
            handle.write(bytes(collected))
    with open(out_path, "wb") as handle:
        handle.write(bytes(collected))

    try:
        os.write(master, b"\x03")
    except OSError:
        pass
    deadline = time.time() + 8.0
    while time.time() < deadline:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done == pid:
            return 0
        ready, _, _ = select.select([master], [], [], 0.2)
        if ready:
            try:
                os.read(master, 65536)
            except OSError:
                break
    try:
        os.killpg(pid, signal.SIGKILL)
    except OSError:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
