#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT_DIR/data/runtime-logs"
mkdir -p "$LOG_DIR"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

export PATH="/home/hcf/software/nodejs/bin:$PATH"

BROWSER_CMD="${CDP_BROWSER_COMMAND:-microsoft-edge}"
BROWSER_UI_RAW="${STARTUP_BROWSER_UI:-visible}"
BROWSER_UI="$(printf '%s' "$BROWSER_UI_RAW" | tr '[:upper:]' '[:lower:]')"
OPEN_CHATGPT="${STARTUP_OPEN_CHATGPT:-true}"
OPEN_GEMINI="${STARTUP_OPEN_GEMINI:-true}"
OPEN_DOUBAO="${STARTUP_OPEN_DOUBAO:-true}"
OPEN_DEEPSEEK="${STARTUP_OPEN_DEEPSEEK:-true}"
OPEN_CLAUDE="${STARTUP_OPEN_CLAUDE:-false}"
OPEN_QWEN="${STARTUP_OPEN_QWEN:-false}"
OPEN_GROK="${STARTUP_OPEN_GROK:-false}"

case "$BROWSER_UI" in
  visible)
    BROWSER_UI_LABEL="visible"
    ;;
  headless|hidden)
    BROWSER_UI_LABEL="headless"
    ;;
  *)
    echo "[stack] invalid STARTUP_BROWSER_UI=$BROWSER_UI_RAW (expected visible or headless)"
    exit 1
    ;;
esac

start_cdp_browser() {
  local name="$1"
  local port="$2"
  local profile_dir="$3"
  local url="$4"
  local enabled="$5"
  local -a browser_args

  if [[ "$enabled" != "true" ]]; then
    echo "[$name] skip (disabled by env)"
    return
  fi

  if curl -fsS "http://127.0.0.1:${port}/json/version" >/dev/null 2>&1; then
    echo "[$name] CDP already listening on :$port"
    return
  fi

  mkdir -p "$profile_dir"
  browser_args=(
    "--remote-debugging-port=$port"
    "--user-data-dir=$profile_dir"
    "--no-first-run"
    "--no-default-browser-check"
  )

  if [[ "$BROWSER_UI_LABEL" == "headless" ]]; then
    browser_args+=(
      "--headless=new"
      "--disable-gpu"
      "--hide-scrollbars"
      "--mute-audio"
    )
  fi

  browser_args+=("$url")

  echo "[$name] starting $BROWSER_CMD on :$port (ui=$BROWSER_UI_LABEL)"
  nohup "$BROWSER_CMD" "${browser_args[@]}" >"$LOG_DIR/${name}.log" 2>&1 &

  sleep 2
}

echo "[stack] root=$ROOT_DIR"
echo "[stack] logs=$LOG_DIR"
echo "[stack] browser_ui=$BROWSER_UI_LABEL"

start_cdp_browser "chatgpt_web" "9222" "$ROOT_DIR/.profiles/chatgpt-cdp" "https://chatgpt.com/" "$OPEN_CHATGPT"
start_cdp_browser "gemini_web" "9223" "$ROOT_DIR/.profiles/gemini" "https://gemini.google.com/app" "$OPEN_GEMINI"
start_cdp_browser "doubao_web" "9224" "$ROOT_DIR/.profiles/doubao" "https://www.doubao.com/chat/" "$OPEN_DOUBAO"
start_cdp_browser "deepseek_web" "9228" "$ROOT_DIR/.profiles/deepseek" "https://chat.deepseek.com/" "$OPEN_DEEPSEEK"
start_cdp_browser "claude_web" "9225" "$ROOT_DIR/.profiles/claude" "https://claude.ai/new" "$OPEN_CLAUDE"
start_cdp_browser "qwen_web" "9226" "$ROOT_DIR/.profiles/qwen-clean" "https://chat.qwen.ai/" "$OPEN_QWEN"
start_cdp_browser "grok_web" "9227" "$ROOT_DIR/.profiles/grok-x" "https://grok.com/" "$OPEN_GROK"

echo "[server] starting pnpm dev"
cd "$ROOT_DIR"
exec pnpm dev
