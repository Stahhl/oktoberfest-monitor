#!/usr/bin/env bash
# Wrapper for the Oktoberfest monitor. Committed to source — NO secrets here.
# Secrets + machine-specific config live in .env (gitignored). See .env.example.
# Used by the macOS launchd job and the Linux systemd timer alike.
set -euo pipefail
cd "$(dirname "$0")"

# Load DISCORD_WEBHOOK_URL (+ optional NODE_BIN_PATH) from the gitignored .env.
if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

# launchd/systemd/cron run with a minimal PATH; point at node if .env says where it is.
if [ -n "${NODE_BIN_PATH:-}" ]; then
  export PATH="$NODE_BIN_PATH:$PATH"
fi

# Jitter: the scheduler fires exactly at minute 0, which is a bot-like tell.
# Sleep a random 0-20 min so the actual request time varies hour to hour.
sleep $((RANDOM % 1200))

if [ "$(uname)" = "Darwin" ]; then
  # macOS: caffeinate blocks idle sleep for the duration of the check.
  exec caffeinate -i node monitor.js
else
  # Headless Linux server: run headed Chromium under a virtual framebuffer (Xvfb) so it looks
  # like a real browser to Cloudflare. Do NOT set HEADLESS=1. Matches monitor.js's 1280x900 viewport.
  exec xvfb-run -a --server-args="-screen 0 1280x900x24" node monitor.js
fi
