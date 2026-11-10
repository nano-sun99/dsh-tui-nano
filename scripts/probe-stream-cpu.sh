#!/bin/bash
# §6.4 行为验收：真 PTY 里跑一段 ~30 秒的流式回答，采样主进程 %CPU。
#
#   npm run build && bash scripts/probe-stream-cpu.sh [窗口秒数]
#
# 口径与 spec §6.4 一致：`ps -Ao %cpu`（近期 CPU 均值）多处采样取平均，
# 只算主进程（会话的 4 个 node 进程里带 `--root` 的那个）。
# 模型是本地 mock（tests/e2e/mock-model.mjs 的 stream 模式），不打真实请求。
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WINDOW="${1:-25}"
STREAM_MS="${MOCK_STREAM_MS:-$((WINDOW * 1000 + 8000))}"
ROOT_ID="cpu-probe-$$"

if [ ! -f "$ROOT/dist/bin.js" ]; then
  echo "缺少 dist/bin.js；先 npm run build" >&2
  exit 1
fi

HOME_DIR="$(mktemp -d)"
SCREEN="$(mktemp)"
cleanup() {
  [ -n "${MOCK_PID:-}" ] && kill -9 "$MOCK_PID" 2>/dev/null
  pkill -9 -f -- "--root $ROOT_ID" 2>/dev/null
  rm -rf "$HOME_DIR" "$SCREEN"
}
trap cleanup EXIT

# 1) 本地 mock 模型（Anthropic Messages SSE），流式模式。
mkdir -p "$HOME_DIR/.dsh"
MOCK_OUT="$HOME_DIR/mock.log"
MOCK_SCRIPT=stream MOCK_STREAM_MS="$STREAM_MS" node "$ROOT/tests/e2e/mock-model.mjs" \
  > "$MOCK_OUT" 2>&1 &
MOCK_PID=$!
PORT=""
for _ in $(seq 1 50); do
  PORT="$(sed -n 's/^LISTENING \([0-9]*\)$/\1/p' "$MOCK_OUT" | head -1)"
  [ -n "$PORT" ] && break
  sleep 0.1
done
if [ -z "$PORT" ]; then
  echo "mock 未启动：$(cat "$MOCK_OUT")" >&2
  exit 1
fi

# 2) 真 PTY 里启动 nano，看到输入提示后发一条消息，然后让它流完。
#    子进程必须有自己的一份 HOME / 凭据，否则会读写真实的 ~/.dsh。
export HOME="$HOME_DIR"
export DSH_HOME="$HOME_DIR/.dsh"
export NANO_DATA_ROOT="$HOME_DIR/.dsh-tui-nano"
export NANO_THEME=dark
export TERM=xterm-256color
export DEEPSEEK_API_KEY=sk-test-00000000000000000000000000000000
export DEEPSEEK_BASE_URL="http://127.0.0.1:$PORT"
mkdir -p "$DSH_HOME" "$NANO_DATA_ROOT"

python3 "$ROOT/tests/e2e/pty-start.py" \
  --out "$SCREEN" \
  --wait 6 \
  --send '写一段很长的回答，用来量流式渲染的 CPU' \
  --send-wait "$((WINDOW + 20))" \
  --cwd "$ROOT" \
  --cols 100 \
  --rows 30 \
  -- node "$ROOT/dist/bin.js" --permission-mode workspace-write --root "$ROOT_ID" \
  > "$HOME_DIR/pty.log" 2>&1 &
PTY_PID=$!

# 3) 找到主进程，等它进入流式，再采样。
PID=""
for _ in $(seq 1 80); do
  for candidate in $(pgrep -f -- "--root $ROOT_ID" 2>/dev/null); do
    ARGS="$(ps -o args= -p "$candidate" 2>/dev/null)"
    case "$ARGS" in
      *pty-start.py*) continue ;;
      *dist/bin.js*) PID="$candidate"; break ;;
    esac
  done
  [ -n "$PID" ] && break
  sleep 0.25
done
if [ -z "$PID" ]; then
  echo "找不到 nano 主进程；pty 日志：" >&2
  tail -20 "$HOME_DIR/pty.log" >&2
  exit 1
fi

# 采样窗口对齐流式：消息在 --wait 6 之后发出，等它进入流式再开始。
sleep 8
cputime_seconds() {
  ps -o cputime= -p "$PID" 2>/dev/null | tr -d ' ' | awk -F'[-:]' '{
    if (NF == 4) printf "%.2f", (($1 * 24 + $2) * 3600 + $3 * 60 + $4)
    else if (NF == 3) printf "%.2f", ($1 * 3600 + $2 * 60 + $3)
    else if (NF == 2) printf "%.2f", ($1 * 60 + $2)
    else printf "0"
  }'
}
START_CPU="$(cputime_seconds)"
MAX=0
SAMPLES=0
for _ in $(seq 1 $((WINDOW * 2))); do
  VALUE="$(ps -o %cpu= -p "$PID" 2>/dev/null | tr -d ' ')"
  if [ -n "$VALUE" ]; then
    SAMPLES=$((SAMPLES + 1))
    MAX="$(awk -v a="$MAX" -v b="$VALUE" 'BEGIN { print (b > a) ? b : a }')"
  fi
  sleep 0.5
done
END_CPU="$(cputime_seconds)"
wait "$PTY_PID" 2>/dev/null
MEAN="$(awk -v a="$START_CPU" -v b="$END_CPU" -v w="$WINDOW" 'BEGIN { if (w > 0) printf "%.1f", (b - a) / w * 100; else print "n/a" }')"
echo "pid=$PID window=${WINDOW}s samples=${SAMPLES} cpu(窗口均值)=${MEAN}% cpu(ps 峰值)=${MAX}%"
# 终端的 diff 重绘会把相邻字拆开（"STRE" + 光标移动 + "AM_DONE"），
# 用最后一个章节标题当「流式确实跑到了末尾」的标记。
MARKER='小节 59'
echo "screen: $(grep -c "$MARKER" "$SCREEN" 2>/dev/null || echo 0) 个 '$MARKER' 标记"
if ! grep -q "$MARKER" "$SCREEN" 2>/dev/null; then
  cp "$SCREEN" /tmp/probe-screen.bin 2>/dev/null
  cp "$HOME_DIR/pty.log" /tmp/probe-pty.log 2>/dev/null
  echo "流式没有跑到末尾；屏幕与 pty 日志已存 /tmp/probe-screen.bin /tmp/probe-pty.log" >&2
fi
