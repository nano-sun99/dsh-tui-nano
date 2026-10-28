#!/usr/bin/env python3
"""Capture PTY frames for the input/preview/table and outcome/XHigh specs.

The `evidence_frame` test renders a deterministic state through the real
`draw` path and prints ANSI. Each scenario runs inside tmux at the target
size, so the archive is a real PTY capture of the renderer output. The
`outcome-xhigh` group also runs `evidence_sweep`, which drives the real tick
clock and writes time-stamped continuous ANSI bar frames. The
`effort-sweep-binding` group launches the real binary against the account's
live model catalog, selects the sweep level, and records continuous frames.

Run after `cargo build -p nano-app --tests`:
    python3 scripts/pty-evidence-input-preview.py                 # input/preview/table
    python3 scripts/pty-evidence-input-preview.py outcome-xhigh  # outcome/XHigh
    python3 scripts/pty-evidence-input-preview.py effort-sweep-binding  # real catalog
    python3 scripts/pty-evidence-input-preview.py spacing-system  # spacing fixtures
    python3 scripts/pty-evidence-input-preview.py process-display  # process display fixtures
"""
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "evidence" / "2026-10-26-nano-input-preview-rendering"
NEW_OUT = ROOT / "docs" / "evidence" / "2026-10-26-nano-outcome-xhigh-correction"
REAL_OUT = ROOT / "docs" / "evidence" / "2026-10-26-nano-effort-sweep-binding"
SPACING_OUT = ROOT / "docs" / "evidence" / "2026-10-26-nano-spacing-system"
PROCESS_OUT = ROOT / "docs" / "evidence" / "2026-10-28-nano-process-display"

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

NEW_SCENARIOS = [
    ("01-tool-success-pty-100-dark.txt", "tool-success-100-dark", 100, 36, False),
    ("02-tool-success-pty-60-light.txt", "tool-success-60-light", 60, 30, False),
    (
        "03-tool-success-expanded-pty-100-dark.txt",
        "tool-success-expanded-100-dark",
        100,
        36,
        False,
    ),
    ("04-tool-success-pty-100-light.txt", "tool-success-100-light", 100, 36, False),
    ("05-tool-success-pty-60-dark.txt", "tool-success-60-dark", 60, 30, False),
    ("06-tool-failure-pty-100-dark.txt", "tool-failure-100-dark", 100, 36, False),
    ("07-tool-failure-pty-60-light.txt", "tool-failure-60-light", 60, 30, False),
    (
        "08-tool-failure-expanded-pty-100-dark.txt",
        "tool-failure-expanded-100-dark",
        100,
        36,
        False,
    ),
    ("09-tool-failure-pty-100-light.txt", "tool-failure-100-light", 100, 36, False),
    ("10-tool-failure-pty-60-dark.txt", "tool-failure-60-dark", 60, 30, False),
    ("11-tool-unknown-pty-100-dark.txt", "tool-unknown", 100, 36, False),
    ("12-tool-unknown-pty-60-light.txt", "tool-unknown-60-light", 60, 30, False),
    (
        "13-tool-unknown-expanded-pty-100-dark.txt",
        "tool-unknown-expanded-100-dark",
        100,
        36,
        False,
    ),
    ("14-tool-unknown-pty-100-light.txt", "tool-unknown-100-light", 100, 36, False),
    ("15-tool-unknown-pty-60-dark.txt", "tool-unknown-60-dark", 60, 30, False),
    ("16-model-default-ansi-100-dark.txt", "model-default-100-dark", 100, 36, True),
    ("17-model-max-ansi-100-dark.txt", "model-max-100-dark", 100, 36, True),
    (
        "18-model-reduced-motion-ansi-100-dark.txt",
        "model-reduced-motion-100-dark",
        100,
        36,
        True,
    ),
]

SPACING_SCENARIOS = [
    (
        "01-process-answer-pty-100-dark.txt",
        "spacing-tool-thinking-answer-100-dark",
        100,
        36,
        False,
    ),
    (
        "02-process-answer-pty-60-light.txt",
        "spacing-tool-thinking-answer-60-light",
        60,
        30,
        False,
    ),
    (
        "03-process-answer-pty-100-light.txt",
        "spacing-tool-thinking-answer-100-light",
        100,
        36,
        False,
    ),
    (
        "04-process-answer-pty-60-dark.txt",
        "spacing-tool-thinking-answer-60-dark",
        60,
        30,
        False,
    ),
    (
        "05-preview-answer-pty-100-dark.txt",
        "spacing-preview-answer-100-dark",
        100,
        36,
        False,
    ),
    (
        "06-preview-answer-pty-60-light.txt",
        "spacing-preview-answer-60-light",
        60,
        30,
        False,
    ),
    ("07-main-pty-100-dark.txt", "main-empty", 100, 36, False),
    ("08-main-pty-60-light.txt", "main-60-light", 60, 30, False),
]

PROCESS_SCENARIOS = [
    (
        "01-collapsed-pty-100-dark.txt",
        "process-collapsed-100-dark",
        100,
        36,
        False,
    ),
    (
        "02-collapsed-pty-60-light.txt",
        "process-collapsed-60-light",
        60,
        30,
        False,
    ),
    (
        "03-collapsed-pty-100-light.txt",
        "process-collapsed-100-light",
        100,
        36,
        False,
    ),
    (
        "04-collapsed-pty-60-dark.txt",
        "process-collapsed-60-dark",
        60,
        30,
        False,
    ),
    (
        "05-expanded-pty-100-dark.txt",
        "process-expanded-100-dark",
        100,
        36,
        False,
    ),
    (
        "06-expanded-pty-60-light.txt",
        "process-expanded-60-light",
        60,
        30,
        False,
    ),
    (
        "07-expanded-pty-100-light.txt",
        "process-expanded-100-light",
        100,
        36,
        False,
    ),
    (
        "08-expanded-pty-60-dark.txt",
        "process-expanded-60-dark",
        60,
        30,
        False,
    ),
]

STREAM_SCENARIOS = [
    ("19-xhigh-sweep-100-dark.txt", "xhigh-sweep-100-dark"),
    ("20-xhigh-sweep-60-light.txt", "xhigh-sweep-60-light"),
    ("21-xhigh-sweep-100-light.txt", "xhigh-sweep-100-light"),
    ("22-xhigh-sweep-60-dark.txt", "xhigh-sweep-60-dark"),
]


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


def capture(out, binary, name, scenario, width, height, ansi):
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
    (out / name).write_text(captured, encoding="utf-8")
    cursor = None
    if name in CURSOR_SCENARIOS:
        cursor = tmux(
            "display-message", "-p", "-t", session, "#{cursor_x},#{cursor_y}"
        ).stdout.strip()
    tmux("kill-session", "-t", session, check=False)
    return cursor


def capture_stream(out, binary, name, scenario):
    env = os.environ.copy()
    env["NANO_EVIDENCE_SCENARIO"] = scenario
    captured = subprocess.run(
        [str(binary), "evidence_sweep", "--ignored", "--nocapture"],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    lines = [
        line
        for line in captured.stdout.split("\n")
        if line.startswith("# ") or line.startswith("frame ") or "\x1b" in line
    ]
    (out / name).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"captured {name}")


def wait_for(session, needle, timeout=15.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if needle in tmux("capture-pane", "-p", "-t", session).stdout:
            return
        time.sleep(0.1)
    raise SystemExit(f"timed out waiting for {needle!r} in {session}")


def wait_until_absent(session, needle, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if needle not in tmux("capture-pane", "-p", "-t", session).stdout:
            return
        time.sleep(0.1)
    raise SystemExit(f"timed out waiting for {needle!r} to leave {session}")


def real_binary():
    subprocess.run(["cargo", "build", "-p", "nano-app"], cwd=ROOT, check=True)
    return ROOT / "target" / "debug" / "nano"


def open_real_models(session, width, height, theme, reduced_motion=False):
    tmux("kill-session", "-t", session, check=False)
    env = [f"NANO_THEME={theme}"]
    if reduced_motion:
        env.append("NANO_REDUCED_MOTION=1")
    command = f"cd {ROOT} && {' '.join(env)} ./target/debug/nano"
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
    wait_for(session, "nano  ~/", timeout=20)
    try:
        wait_for(session, "Enter / Esc 关闭", timeout=20)
        tmux("send-keys", "-t", session, "Enter")  # close the startup sources panel
        wait_until_absent(session, "Enter / Esc 关闭")
    except SystemExit:
        pass
    time.sleep(0.5)
    tmux("send-keys", "-t", session, "/model", "Enter")
    wait_for(session, "模型")
    time.sleep(0.5)


def cycle_effort(session, times):
    for _ in range(times):
        tmux("send-keys", "-t", session, "-H", "1b", "5b", "43")
        time.sleep(0.15)


def capture_frames(out, session, name, header, seconds=3.2, interval=0.05):
    frames = []
    start = time.monotonic()
    index = 0
    while True:
        elapsed = int((time.monotonic() - start) * 1000)
        if elapsed > seconds * 1000:
            break
        captured = tmux("capture-pane", "-p", "-e", "-t", session).stdout
        frames.append(f"frame {index} t={elapsed}ms\n{captured}")
        index += 1
        delay = start + index * interval - time.monotonic()
        if delay > 0:
            time.sleep(delay)
    body = header + "\n" + "\n".join(frames)
    (out / name).write_text(body.rstrip("\n") + "\n", encoding="utf-8")
    print(f"captured {name}")


def capture_gap(out, session, name, gap_ms, header):
    first = tmux("capture-pane", "-p", "-e", "-t", session).stdout
    time.sleep(gap_ms / 1000.0)
    second = tmux("capture-pane", "-p", "-e", "-t", session).stdout
    body = header + f"\nframe 0 t=0ms\n{first}\nframe 1 t={gap_ms}ms\n{second}"
    (out / name).write_text(body.rstrip("\n") + "\n", encoding="utf-8")
    print(f"captured {name}")


def capture_real_catalog(out):
    """Record the account's live catalog (Off/Low/High/Max) in a real PTY."""
    commit = subprocess.run(
        ["git", "rev-parse", "--short", "HEAD"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()

    def header(width, theme, level):
        return (
            f"# scenario=real-catalog width={width} theme={theme} "
            f"level={level} commit={commit}"
        )

    for name, width, theme in [
        ("01-real-sweep-100-dark.txt", 100, "dark"),
        ("02-real-sweep-60-light.txt", 60, "light"),
        ("03-real-sweep-100-light.txt", 100, "light"),
        ("04-real-sweep-60-dark.txt", 60, "dark"),
    ]:
        session = f"nano-real-sweep-{width}-{theme}"
        open_real_models(session, width, 36 if width == 100 else 30, theme)
        cycle_effort(session, 3)  # None -> Off -> Low -> High (second-highest)
        capture_frames(out, session, name, header(width, theme, "High"))
        tmux("kill-session", "-t", session, check=False)

    session = "nano-real-max"
    open_real_models(session, 100, 36, "dark")
    cycle_effort(session, 4)  # High -> Max keeps its pulse
    capture_gap(
        out,
        session,
        "05-real-max-pulse-100-dark.txt",
        600,
        header(100, "dark", "Max"),
    )
    tmux("kill-session", "-t", session, check=False)

    session = "nano-real-low"
    open_real_models(session, 100, 36, "dark")
    cycle_effort(session, 2)  # None -> Off -> Low stays static
    capture_gap(
        out,
        session,
        "06-real-low-static-100-dark.txt",
        600,
        header(100, "dark", "Low"),
    )
    tmux("kill-session", "-t", session, check=False)

    session = "nano-real-reduced"
    open_real_models(session, 100, 36, "dark", reduced_motion=True)
    cycle_effort(session, 3)
    capture_gap(
        out,
        session,
        "07-real-reduced-motion-100-dark.txt",
        700,
        header(100, "dark", "High reduced-motion"),
    )
    tmux("kill-session", "-t", session, check=False)


def main():
    if shutil.which("tmux") is None:
        print("tmux is required", file=sys.stderr)
        return 2
    group = sys.argv[1] if len(sys.argv) > 1 else "input-preview"
    if group == "effort-sweep-binding":
        out = REAL_OUT
        if out.exists():
            for path in out.glob("*.txt"):
                path.unlink()
        out.mkdir(parents=True, exist_ok=True)
        real_binary()
        capture_real_catalog(out)
        return 0
    if group == "spacing-system":
        out = SPACING_OUT
        scenarios = SPACING_SCENARIOS
    elif group == "process-display":
        out = PROCESS_OUT
        scenarios = PROCESS_SCENARIOS
    elif group == "outcome-xhigh":
        out = NEW_OUT
        scenarios = NEW_SCENARIOS
    elif group == "input-preview":
        out = OUT
        scenarios = SCENARIOS
    else:
        print(f"unknown group: {group}", file=sys.stderr)
        return 2
    binary = test_binary()
    if out.exists():
        for path in out.glob("*.txt"):
            path.unlink()
    out.mkdir(parents=True, exist_ok=True)
    cursors = []
    for name, scenario, width, height, ansi in scenarios:
        cursor = capture(out, binary, name, scenario, width, height, ansi)
        if cursor is not None:
            cursors.append(f"{name}: cursor {cursor}")
        print(f"captured {name}")
    if group == "outcome-xhigh":
        for name, scenario in STREAM_SCENARIOS:
            capture_stream(out, binary, name, scenario)
    if cursors:
        (out / "cursor-positions.txt").write_text(
            "\n".join(cursors) + "\n", encoding="utf-8"
        )
        print("captured cursor-positions.txt")
    return 0


if __name__ == "__main__":
    sys.exit(main())
