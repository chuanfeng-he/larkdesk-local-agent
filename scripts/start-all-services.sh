#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export STARTUP_BROWSER_UI="${STARTUP_BROWSER_UI:-headless}"
export STARTUP_OPEN_CHATGPT=true
export STARTUP_OPEN_GEMINI=true
export STARTUP_OPEN_DOUBAO=true
export STARTUP_OPEN_DEEPSEEK=true
export STARTUP_OPEN_CLAUDE=true
export STARTUP_OPEN_QWEN=true
export STARTUP_OPEN_GROK=true

bash "$ROOT_DIR/scripts/stop-dev-stack.sh"
exec bash "$ROOT_DIR/scripts/start-dev-stack.sh"
