#!/usr/bin/env python3
"""Real-Ghostty visual capture for the S03 release (0.2.0).

Launches a dedicated Ghostty window per scenario against the packed tarball
installed into a synthetic prefix, drives it with System Events, and captures
only that window with `screencapture -l`. No real credentials, sessions or
model spend: a local Messages-compatible mock serves the responses.

Requirements: macOS Accessibility + Screen Recording permissions, Ghostty,
Pillow (`pip install pillow`), swiftc (Xcode command line tools).

Run:
    python3 tests/e2e/ghostty-visual.py \
        --tarball packaging/dist/dsh-tui-nano-0.2.0.tgz \
        --out docs/release/0.2.0/evidence/ghostty
"""

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit("ghostty-visual: Pillow is required (pip install pillow)")

ROOT = Path(tempfile.mkdtemp(prefix="nano-ghostty-visual-"))
LIST_WINDOWS = ROOT / "list-windows"

LONG_CJK = (
    "这是一段用于真实 Ghostty 视觉验收的中文长文本，检查 CJK 宽度、换行与阅读层级。"
    "nano 不铺整屏实色，普通背景保留终端默认背景；diff、选择与 hover 才用自有 RGB。\n\n"
    + "\n".join(f"第 {i:02d} 行：主题、间距与窄屏换行检查。" for i in range(1, 25))
)

RAISE_SCRIPT = """
on run argv
  set targetTitle to item 1 of argv
  tell application "System Events"
    repeat with p in (every process whose name is "Ghostty")
      try
        if (name of windows of p) contains targetTitle then
          set frontmost of p to true
          perform action "AXRaise" of window targetTitle of p
          return (unix id of p) as text
        end if
      end try
    end repeat
  end tell
  return ""
end run
"""


def run(cmd, **kwargs):
    return subprocess.run(cmd, capture_output=True, text=True, **kwargs)


def applescript(script, *args):
    return run(["osascript", "-e", script, *args])


def focus(title):
    result = applescript(RAISE_SCRIPT, title)
    if result.returncode != 0 or not result.stdout.strip():
        raise RuntimeError(
            f"could not focus Ghostty window {title!r}: {result.stderr.strip() or 'not found'}"
        )
    time.sleep(0.3)


def send_key(title, code):
    focus(title)
    applescript(f'tell application "System Events" to key code {code}')


def paste_text(title, text):
    focus(title)
    subprocess.run(["pbcopy"], input=text.encode(), check=True)
    applescript('tell application "System Events" to keystroke "v" using command down')


def wait_for_window(title, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        result = run([str(LIST_WINDOWS)])
        for line in result.stdout.splitlines():
            fields = line.split("\t")
            if len(fields) >= 5 and fields[2] == "Ghostty" and fields[3] == title:
                return int(fields[0])
        time.sleep(0.25)
    raise RuntimeError(f"Ghostty window {title!r} did not appear")


def wait_for_window_gone(title, timeout=15):
    deadline = time.time() + timeout
    while time.time() < deadline:
        result = run([str(LIST_WINDOWS)])
        if not any(
            line.split("\t")[2:4] == ["Ghostty", title]
            for line in result.stdout.splitlines()
            if len(line.split("\t")) >= 5
        ):
            return True
        time.sleep(0.25)
    return False


def capture(title, path):
    window_id = wait_for_window(title)
    listing = run([str(LIST_WINDOWS)]).stdout
    for line in listing.splitlines():
        fields = line.split("\t")
        if len(fields) >= 5 and fields[0] == str(window_id):
            print(f"WINDOW {title} id={window_id} bounds={fields[4]}")
    subprocess.run(["screencapture", "-x", "-l", str(window_id), "-o", str(path)], check=True)
    return window_id


def close_window(title):
    """关掉本次专有实例：按 --title 找到 Ghostty 进程并结束它。"""
    for _ in range(3):
        killed = False
        for pid in ghostty_pids():
            command = run(["ps", "-o", "command=", "-p", str(pid)]).stdout
            if f"--title={title}" in command:
                try:
                    os.kill(pid, signal.SIGTERM)
                    killed = True
                except OSError:
                    pass
        if killed:
            time.sleep(0.6)
            if wait_for_window_gone(title, 4):
                return True
        if wait_for_window_gone(title, 1):
            return True
    return False


def ghostty_pids():
    result = run(["pgrep", "-f", "Ghostty.app/Contents/MacOS/ghostty"])
    return {int(line) for line in result.stdout.split() if line.strip().isdigit()}


def launch(title, command, cols, rows, opacity=None, font_size=None, bg=None, fg=None, cwd=None):
    args = [
        "open",
        "-na",
        "Ghostty.app",
        "--args",
        f"--title={title}",
        f"--command={command}",
        f"--window-width={cols}",
        f"--window-height={rows}",
        "--cursor-blink=false",
        "--wait-after-command=false",
        "--macos-option-as-alt=true",
        "--window-save-state=never",
        "--window-inherit-working-directory=false",
    ]
    if cwd is not None:
        args.append(f"--working-directory={cwd}")
    if bg is not None:
        args.append(f"--background={bg}")
    if fg is not None:
        args.append(f"--foreground={fg}")
    if opacity is not None:
        args.append(f"--background-opacity={opacity}")
    if font_size is not None:
        args.append(f"--font-size={font_size}")
    run(args, check=True)
    wait_for_window(title)
    time.sleep(5)
    focus(title)


class MockModel(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw)
        except Exception:
            body = {}
        text_dump = json.dumps(body.get("messages", []), ensure_ascii=False)
        wants_diff = "DIFF-SCENARIO" in text_dump
        results = [
            block
            for message in body.get("messages", [])
            for block in (message.get("content") or [])
            if isinstance(block, dict) and block.get("type") == "tool_result"
        ]
        with_tools = bool(body.get("tools"))
        events = [
            {"type": "message_start", "message": {"usage": {"input_tokens": 1, "output_tokens": 0}}}
        ]
        if with_tools and wants_diff and len(results) == 0:
            events += [
                {
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": {"type": "tool_use", "id": "toolu_read", "name": "read", "input": {}},
                },
                {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "input_json_delta", "partial_json": json.dumps({"file_path": "note.txt"})},
                },
                {"type": "content_block_stop", "index": 0},
                {
                    "type": "message_delta",
                    "delta": {"stop_reason": "tool_use"},
                    "usage": {"output_tokens": 5},
                },
            ]
        elif with_tools and wants_diff and len(results) == 1:
            events += [
                {
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": {"type": "tool_use", "id": "toolu_edit", "name": "edit", "input": {}},
                },
                {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {
                        "type": "input_json_delta",
                        "partial_json": json.dumps(
                            {
                                "file_path": "note.txt",
                                "old_string": "old line",
                                "new_string": "new line",
                            }
                        ),
                    },
                },
                {"type": "content_block_stop", "index": 0},
                {
                    "type": "message_delta",
                    "delta": {"stop_reason": "tool_use"},
                    "usage": {"output_tokens": 5},
                },
            ]
        else:
            text = LONG_CJK if "LONG-CJK" in text_dump or not wants_diff else "diff 场景完成。"
            events += [
                {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
                {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}},
                {"type": "content_block_stop", "index": 0},
                {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 1}},
            ]
        events.append({"type": "message_stop"})
        payload = "".join(
            f"event: {event['type']}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"
            for event in events
        ).encode()
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_args):
        pass


def compile_list_windows():
    source = ROOT / "list-windows.swift"
    source.write_text(
        """
import CoreGraphics
import Foundation
let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
if let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] {
  for w in list {
    let owner = w[kCGWindowOwnerName as String] as? String ?? ""
    let name = w[kCGWindowName as String] as? String ?? ""
    let number = w[kCGWindowNumber as String] as? Int ?? 0
    let layer = w[kCGWindowLayer as String] as? Int ?? 0
    let bounds = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
    print("\\(number)\\t\\(layer)\\t\\(owner)\\t\\(name)\\t\\(bounds)")
  }
}
"""
    )
    subprocess.run(["swiftc", "-O", str(source), "-o", str(LIST_WINDOWS)], check=True)


def image_check(path):
    image = Image.open(path).convert("RGB")
    pixels = list(image.getdata())
    unique = len(set(pixels))
    non_blank = sum(1 for pixel in pixels if pixel != (0, 0, 0)) / max(1, len(pixels))
    return {
        "size": image.size,
        "unique_colors": unique,
        "non_black_ratio": round(non_blank, 4),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tarball", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--keep", action="store_true")
    args = parser.parse_args()

    tarball = Path(args.tarball).resolve()
    out = Path(args.out).resolve()
    original_clipboard = subprocess.run(["pbpaste"], capture_output=True).stdout
    out.mkdir(parents=True, exist_ok=True)

    compile_list_windows()

    home = ROOT / "home"
    dsh_home = ROOT / "dsh-home"
    data = ROOT / "data"
    work = ROOT / "work"
    prefix = ROOT / "prefix"
    for directory in (home, dsh_home, data, work):
        directory.mkdir(parents=True)
    (work / "note.txt").write_text("old line\n")

    # 安装被验收的 tarball，证据绑定这个产物。
    install_env = dict(os.environ)
    install_env.update({"HOME": str(home), "npm_config_cache": str(ROOT / "npm-cache")})
    install = subprocess.run(
        ["npm", "install", "-g", "--prefix", str(prefix), "--no-audit", "--no-fund", str(tarball)],
        capture_output=True,
        text=True,
        env=install_env,
    )
    if install.returncode != 0:
        sys.exit(f"ghostty-visual: npm install failed\n{install.stderr}")
    bin_path = prefix / "bin" / "nano"

    server = ThreadingHTTPServer(("127.0.0.1", 0), MockModel)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    results = []

    def scenario(name, *, theme, cols, rows, send, opacity=None, capture_after=5.0, bg=None, fg=None):
        title = f"nano-visual-{name}"
        env = {
            "HOME": str(home),
            "DSH_HOME": str(dsh_home),
            "NANO_DATA_ROOT": str(data),
            "NANO_THEME": theme,
            "DEEPSEEK_API_KEY": "sk-test-00000000000000000000000000000000",
            "DEEPSEEK_BASE_URL": f"http://127.0.0.1:{port}",
            "TERM": "xterm-256color",
        }
        command = "env " + " ".join(f"{key}={value}" for key, value in env.items())
        command += f' "{bin_path}" --root ghostty-{name}'
        try:
            launch(title, command, cols, rows, opacity=opacity, bg=bg, fg=fg, cwd=str(work))
            paste_text(title, send)
            send_key(title, 36)  # Return
            time.sleep(capture_after)
            path = out / f"{name}.png"
            capture(title, path)
            check = image_check(path)
            results.append({"scenario": name, "path": str(path), **check})
            print(f"CAPTURED {name} {check}")
        finally:
            close_window(title)

    scenario(
        "01-dark-100-response",
        theme="dark",
        cols=100,
        rows=35,
        send="请用 LONG-CJK 回复一段长文本",
        capture_after=6.0,
        bg="#17191d",
        fg="#e8e6e0",
    )
    scenario(
        "02-light-60",
        theme="light",
        cols=60,
        rows=30,
        send="请用 LONG-CJK 回复一段长文本",
        capture_after=6.0,
        bg="#f6f3ed",
        fg="#343945",
    )
    scenario(
        "03-dark-diff",
        theme="dark",
        cols=100,
        rows=35,
        send="DIFF-SCENARIO 请改 note",
        capture_after=6.0,
        bg="#17191d",
        fg="#e8e6e0",
    )
    scenario(
        "04-dark-transparency",
        theme="dark",
        cols=100,
        rows=35,
        send="请用 LONG-CJK 回复一段长文本",
        opacity=0.8,
        capture_after=6.0,
        bg="#17191d",
        fg="#e8e6e0",
    )

    subprocess.run(["pbcopy"], input=original_clipboard, check=False)
    summary = ROOT / "summary.json"
    summary.write_text(json.dumps(results, indent=2, ensure_ascii=False))
    shutil.copyfile(summary, out / "summary.json")
    print(f"SUMMARY {summary}")
    if not args.keep:
        shutil.rmtree(ROOT, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
