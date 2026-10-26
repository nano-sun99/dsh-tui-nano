#!/usr/bin/env python3
"""Capture PTY frames for the input/preview/table spec.

The `evidence_frame` test renders a deterministic state through the real
`draw` path and prints ANSI. Each scenario runs inside tmux at the target
size, so the archive is a real PTY capture of the renderer output.

Run after `cargo build -p nano-app --tests`:
    python3 scripts/pty-evidence-input-preview.py
"""
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "evidence" / "2026-10-26-nano-input-preview-rendering"

SCENARIOS = [
    ("01-main-empty-pty-100-dark.txt", "main-empty", 100, 36, False),
    ("02-main-empty-pty-60-light.txt", "main-60-light", 60, 30, False),
    ("03-main-typed-pty-100-dark.txt", "main-typed", 100, 36, False),
    ("04-table-pty-100-dark.txt", "table-100", 100, 36, False),
    ("05-table-pty-60-light.txt", "table-60", 60, 30, False),
    ("06-tool-unknown-pty-100-dark.txt", "tool-unknown", 100, 36, False),
    ("07-preview-live-gap-pty-100-dark.txt", "preview-live-gap-100", 100, 36, False),
    ("08-preview-live-gap-pty-60-light.txt", "preview-live-gap-60", 60, 30, False),
    (
        "09-preview-live-truncated-pty-100-dark.txt",
        "preview-live-truncated-100",
        100,
        36,
        False,
    ),
    (
        "10-preview-finished-unknown-pty-100-dark.txt",
        "preview-finished-unknown-100",
        100,
        36,
        False,
    ),
    (
        "11-preview-finished-unknown-pty-60-light.txt",
        "preview-finished-unknown-60",
        60,
        30,
        False,
    ),
    ("12-model-default-pty-100-dark.txt", "model-default-100", 100, 36, False),
    (
        "13-model-xhigh-phase560-ansi-100-dark.txt",
        "model-xhigh-100-560",
        100,
        36,
        True,
    ),
    (
        "14-model-xhigh-phase1050-ansi-100-dark.txt",
        "model-xhigh-100-1050",
        100,
        36,
        True,
    ),
    (
        "15-model-xhigh-phase560-ansi-60-light.txt",
        "model-xhigh-60-light-560",
        60,
        30,
        True,
    ),
    (
        "16-model-xhigh-phase1050-ansi-60-light.txt",
        "model-xhigh-60-light-1050",
        60,
        30,
        True,
    ),
    (
        "17-model-xhigh-phase560-ansi-100-light.txt",
        "model-xhigh-100-light-560",
        100,
        36,
        True,
    ),
    (
        "18-model-xhigh-phase1050-ansi-100-light.txt",
        "model-xhigh-100-light-1050",
        100,
        36,
        True,
    ),
    (
        "19-model-xhigh-phase560-ansi-60-dark.txt",
        "model-xhigh-60-dark-560",
        60,
        30,
        True,
    ),
    (
        "20-model-xhigh-phase1050-ansi-60-dark.txt",
        "model-xhigh-60-dark-1050",
        60,
        30,
        True,
    ),
    (
        "21-preview-finished-abandoned-pty-100-dark.txt",
        "preview-finished-abandoned-100",
        100,
        36,
        False,
    ),
    (
        "22-preview-finished-abandoned-pty-60-light.txt",
        "preview-finished-abandoned-60",
        60,
        30,
        False,
    ),
    ("23-main-dock-pty-100-dark.txt", "main-dock-100-dark", 100, 36, False),
    ("24-main-dock-pty-60-light.txt", "main-dock-60-light", 60, 30, False),
]

CURSOR_SCENARIOS = {"01-main-empty-pty-100-dark.txt", "03-main-typed-pty-100-dark.txt"}


def tmux(*args, check=True):
    return subprocess.run(
        ["tmux", *args], capture_output=True, text=True, check=check
    )


def test_binary():
    built = subprocess.run(
        ["cargo", "test", "-p", "nano-app", "--no-run"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    for line in reversed((built.stdout + built.stderr).splitlines()):
        match = re.search(r"\(([^)]+)\)\s*$", line)
        if line.lstrip().startswith("Executable") and match:
            return (ROOT / match.group(1)).resolve()
    raise SystemExit("could not locate the nano-app test binary")


def capture(binary, name, scenario, width, height, ansi):
    session = f"nano65-{scenario}"
    tmux("kill-session", "-t", session, check=False)
    command = (
        f"sleep 1; cd {ROOT} && NANO_EVIDENCE_SCENARIO={scenario} "
        f"{binary} evidence_frame --ignored --nocapture; sleep 6"
    )
    tmux(
        "new-session",
        "-d",
        "-s",
        session,
        "-x",
        str(width),
        "-y",
        str(height),
        command,
    )
    time.sleep(0.3)
    tmux("set-option", "-t", session, "status", "off", check=False)
    time.sleep(1.5)
    args = ["capture-pane", "-p", "-t", session]
    if ansi:
        args.insert(2, "-e")
    captured = tmux(*args).stdout
    (OUT / name).write_text(captured, encoding="utf-8")
    cursor = None
    if name in CURSOR_SCENARIOS:
        cursor = tmux(
            "display-message", "-p", "-t", session, "#{cursor_x},#{cursor_y}"
        ).stdout.strip()
    tmux("kill-session", "-t", session, check=False)
    return cursor


def main():
    if shutil.which("tmux") is None:
        print("tmux is required", file=sys.stderr)
        return 2
    binary = test_binary()
    if OUT.exists():
        for path in OUT.glob("*.txt"):
            path.unlink()
    OUT.mkdir(parents=True, exist_ok=True)
    cursors = []
    for name, scenario, width, height, ansi in SCENARIOS:
        cursor = capture(binary, name, scenario, width, height, ansi)
        if cursor is not None:
            cursors.append(f"{name}: cursor {cursor}")
        print(f"captured {name}")
    if cursors:
        (OUT / "cursor-positions.txt").write_text(
            "\n".join(cursors) + "\n", encoding="utf-8"
        )
        print("captured cursor-positions.txt")
    return 0


if __name__ == "__main__":
    sys.exit(main())
