#!/usr/bin/env bash
# Real-PTY approval-card evidence at 100/60 columns, dark/light themes.
# Uses the local mock model (tests/e2e/mock-model.mjs) — no real credentials or model calls.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
OUT="$ROOT/docs/evidence/2026-11-01-nano-approval-card-in-transcript/terminal"
mkdir -p "$OUT"
MOCK_LOG=$(mktemp)
MOCK_SCRIPT=approval node "$ROOT/tests/e2e/mock-model.mjs" >"$MOCK_LOG" 2>&1 &
MOCK_PID=$!
cleanup() { kill "$MOCK_PID" 2>/dev/null || true; rm -f "$MOCK_LOG"; }
trap cleanup EXIT
PORT=""
for _ in $(seq 1 50); do
  PORT=$(grep -o 'LISTENING [0-9]*' "$MOCK_LOG" | awk '{print $2}' | head -1 || true)
  [ -n "$PORT" ] && break
  sleep 0.1
done
[ -n "$PORT" ] || { echo "mock did not start" >&2; exit 1; }
for cols in 100 60; do
  for theme in dark light; do
    HOME_DIR=$(mktemp -d)
    WORK=$(mktemp -d)
    env -i \
      PATH="$PATH" HOME="$HOME_DIR" LANG="${LANG:-en_US.UTF-8}" TERM=xterm-256color \
      DSH_HOME="$HOME_DIR/.dsh" NANO_DATA_ROOT="$HOME_DIR/.dsh-tui-nano" NANO_THEME="$theme" \
      DEEPSEEK_API_KEY=sk-test-00000000000000000000000000000000 \
      DEEPSEEK_BASE_URL="http://127.0.0.1:$PORT" \
      python3 "$ROOT/tests/e2e/pty-start.py" \
        --out "$OUT/${cols}-${theme}.txt" --wait 10 --until "输入消息" \
        --send "触发审批" --send-wait 20 --send-until "是否运行这条检查命令？" \
        --cwd "$WORK" --cols "$cols" --rows 30 \
        -- "$(command -v node)" "$ROOT/dist/bin.js" --root "evidence-$cols-$theme"
    rm -rf "$HOME_DIR" "$WORK"
  done
done
echo "evidence written to $OUT"
