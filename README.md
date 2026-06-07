# 🍺 Oktoberfest Reservation Monitor

This tool automatically checks the [Hofbräu Festzelt reservation page](https://reservierung.hb-festzelt.de/reservierung) every hour. It uses two fixed date combinations and alerts when any seating option with `>= 12` persons is available for either target date.

It runs on a Mac via a `launchd` LaunchAgent, driving a **headed** browser with a **persistent profile** from a residential IP. (It previously ran on GitHub Actions, but the datacenter IP + headless browser got repeatedly challenged by Cloudflare.) It can also run on a **headless Linux server** on a residential connection using Xvfb + a systemd timer — see [§4](#4-alternative-install-on-a-headless-linux-server-xvfb--systemd).

## 🚀 Setup Instructions

### 1. Discord Webhook
1. Go to your Discord server.
2. Right-click a text channel > **Edit Channel** > **Integrations** > **Webhooks**.
3. Click **New Webhook**.
4. Copy the **Webhook URL**.

### 2. Configure secrets
1. Copy `.env.example` to `.env` (gitignored) and paste your webhook URL into `DISCORD_WEBHOOK_URL`.
2. If `node` isn't on the minimal PATH that launchd/systemd use, set `NODE_BIN_PATH` to its bin dir (e.g. your nvm path). `run.sh` (committed, no secrets) sources `.env` and is shared by macOS and Linux.

### 3. Install the scheduler (macOS LaunchAgent)
```sh
# Load the hourly job (modern launchctl; use `launchctl load -w <plist>` on older macOS)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.stahl.oktoberfest-monitor.plist

# Force a run now to test
launchctl kickstart -k gui/$(id -u)/com.stahl.oktoberfest-monitor
tail -f monitor.log

# Inspect the job / stop it
launchctl print  gui/$(id -u)/com.stahl.oktoberfest-monitor
launchctl bootout gui/$(id -u)/com.stahl.oktoberfest-monitor
```
The job runs at minute 0 of every hour. Output goes to `monitor.log`.

You can also run a one-off check by hand (watch the browser window open):
```sh
DISCORD_WEBHOOK_URL="<url>" node monitor.js   # add HEADLESS=1 to run without a window
```

> **Requirements:** the Mac must stay **logged in** (LaunchAgents don't run at the login window) and **plugged in** (on battery it can still sleep; with "Prevent automatic sleeping on power adapter when the display is off" enabled it stays awake on power). A browser window briefly appears each hour — that's expected (headed mode).

### 4. (Alternative) Install on a headless Linux server (Xvfb + systemd)
On an always-on Linux box on a **residential** connection (datacenter IPs get blocked by Cloudflare), you can run the same `run.sh` without a GUI — Chromium runs **headed** inside a virtual framebuffer:
```sh
# Node >= 18 (use NodeSource or nvm if apt's is too old), then from the repo root:
npm ci
npx playwright install --with-deps chromium   # browser + shared libs (needs sudo)
sudo apt-get install -y xvfb                   # virtual framebuffer for headed mode

cp .env.example .env                           # then fill in DISCORD_WEBHOOK_URL (+ NODE_BIN_PATH if needed)

# Install the hourly systemd user timer (unit files live in deploy/systemd/):
mkdir -p ~/.config/systemd/user
cp deploy/systemd/oktoberfest.service deploy/systemd/oktoberfest.timer ~/.config/systemd/user/
loginctl enable-linger "$USER"                 # let it run without an interactive login
systemctl --user daemon-reload
systemctl --user enable --now oktoberfest.timer

# Test now / inspect:
systemctl --user start oktoberfest.service
journalctl --user -u oktoberfest.service -f
systemctl --user list-timers | grep oktoberfest
```
`run.sh` auto-detects the OS (`caffeinate` on macOS, `xvfb-run` on Linux). The persistent `.browser-profile/` is created fresh on first run — don't copy it from the Mac, since the Cloudflare clearance cookie is bound to the browser platform.

## 🛠️ How it Works
- The script uses **Playwright** to drive a **headed** Chromium with a persistent profile (`.browser-profile/`) so a Cloudflare clearance cookie survives between runs, and a German locale/timezone.
- If the closed text (`Aktuell sind noch keine Reservierungen möglich`) is visible, it sends a heartbeat.
- If the portal is open, it selects:
  - `Datum`: `28.09.2026` and `29.09.2026` (matched by label text, not by backend value/timestamp)
  - `Schicht`: `Abend`
  - `Bereich`: `Boxen`
- It then checks `Anzahl gewünschte Personen` and accepts any option where total persons is `>= 12` (for example `1x12`, `1x20`, `2x8` totals like 16, etc.).
- It waits 30 seconds between the two date checks to reduce abrupt scripted behavior inside the same session.
- A run succeeds if either date has qualifying seating, and the alert includes the per-date results.
- If Cloudflare presents a challenge/block page, it sends a dedicated Discord alert with a screenshot and diagnostic markers.
- If another unexpected error happens, it sends a Discord ping with a screenshot for manual interpretation.

## 📂 Files
- `monitor.js`: The main logic script.
- `run.sh`: Cross-platform wrapper (committed, no secrets). Sources `.env`; uses `caffeinate` on macOS and `xvfb-run` on Linux.
- `.env` / `.env.example`: `.env` (gitignored) holds the webhook secret + optional `NODE_BIN_PATH`; copy it from `.env.example`.
- `deploy/systemd/oktoberfest.{service,timer}`: systemd user timer for the headless Linux setup.
- `~/Library/LaunchAgents/com.stahl.oktoberfest-monitor.plist`: The hourly schedule on macOS (LaunchAgent).
- `.github/workflows/check.yml`: The old GitHub Actions schedule, now disabled (kept for reference / manual fallback).
