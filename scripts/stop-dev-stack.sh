#!/usr/bin/env bash
set -euo pipefail

PATTERNS=(
  "/home/hcf/iai/apps/server/src/index.ts"
  "apps/server/src/index.ts"
  "node --import tsx src/index.ts"
  "remote-debugging-port=9222"
  "remote-debugging-port=9223"
  "remote-debugging-port=9224"
  "remote-debugging-port=9228"
  "remote-debugging-port=9225"
  "remote-debugging-port=9226"
  "remote-debugging-port=9227"
  "/home/hcf/iai/apps/server/.profiles/deepseek"
)

stop_pattern() {
  local pattern="$1"
  local pids
  pids="$(pgrep -f "$pattern" || true)"
  if [[ -z "$pids" ]]; then
    return
  fi

  echo "[stop] $pattern -> $pids"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
}

force_stop_pattern() {
  local pattern="$1"
  local pids
  pids="$(pgrep -f "$pattern" || true)"
  if [[ -z "$pids" ]]; then
    return
  fi

  echo "[force-stop] $pattern -> $pids"
  # shellcheck disable=SC2086
  kill -9 $pids 2>/dev/null || true
}

for pattern in "${PATTERNS[@]}"; do
  stop_pattern "$pattern"
done

sleep 2

for pattern in "${PATTERNS[@]}"; do
  force_stop_pattern "$pattern"
done

echo "[done] stack stopped"
