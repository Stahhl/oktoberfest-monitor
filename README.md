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
# Generate the LaunchAgent from the committed template (run from the repo root).
# __REPO__ is replaced with the current path, since launchd needs absolute paths
# and (unlike systemd's %h) does no variable expansion of its own:
mkdir -p ~/Library/LaunchAgents
sed "s|__REPO__|$PWD|g" deploy/launchd/com.stahl.oktoberfest-monitor.plist \
  > ~/Library/LaunchAgents/com.stahl.oktoberfest-monitor.plist

# Load the hourly job into your logged-in GUI session (gui/$(id -u) = your user's
# graphical session, needed because the monitor opens a real browser window).
# Modern launchctl; use `launchctl load -w <plist>` on older macOS.
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
npx patchright install chrome --with-deps     # real Chrome + shared libs (needs sudo)
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
- The script uses **Patchright** (a stealth-patched Playwright drop-in) to drive **real Chrome** (`channel: 'chrome'`) in **headed** mode with a persistent profile (`.browser-profile/`) so a Cloudflare clearance cookie survives between runs, and a German locale/timezone. Patchright patches the automation/CDP leaks (e.g. `Runtime.enable`) that vanilla Playwright exposes to Cloudflare; if real Chrome isn't installed it falls back to bundled Chromium.
- If the closed text (`Aktuell sind noch keine Reservierungen möglich`) is visible, it sends a heartbeat.
- If the portal is open, it selects:
  - `Datum`: `28.09.2026` and `29.09.2026` (matched by label text, not by backend value/timestamp)
  - `Schicht`: `Abend`
  - `Bereich`: `Boxen`
- It then checks `Anzahl gewünschte Personen` and accepts any option where total persons is `>= 12` (for example `1x12`, `1x20`, `2x8` totals like 16, etc.).
- It waits 30 seconds between the two date checks to reduce abrupt scripted behavior inside the same session.
- A run succeeds if either date has qualifying seating, and the alert includes the per-date results.
- Cloudflare "managed challenge" interstitials usually auto-clear within a few seconds for a legit browser, so the script waits them out (polling, with one reload on the initial load) before reacting. It only sends a Discord alert when a **hard** block page is detected or a challenge fails to clear — so transient challenges no longer spam alerts.
- If another unexpected error happens, it sends a Discord ping with a screenshot for manual interpretation.

## 🧱 If Cloudflare blocks still persist
Cloudflare is adversarial, so nothing guarantees zero blocks. The current setup (Patchright + real Chrome + residential IP + persistent profile + automatic challenge wait-out) should make hard blocks rare and self-recovering. If they become frequent anyway, the next escalations both cost money:
- **Residential proxy** (e.g. Bright Data, IPRoyal) — rotate the egress IP. Wire it via Playwright's `proxy` launch option in `launchContext()`.
- **CAPTCHA / Turnstile solver** (e.g. 2Captcha, CapMonster) — answer challenges programmatically when waiting them out isn't enough.

## 📂 Files
- `monitor.js`: The main logic script.
- `run.sh`: Cross-platform wrapper (committed, no secrets). Sources `.env`; uses `caffeinate` on macOS and `xvfb-run` on Linux.
- `.env` / `.env.example`: `.env` (gitignored) holds the webhook secret + optional `NODE_BIN_PATH`; copy it from `.env.example`.
- `deploy/systemd/oktoberfest.{service,timer}`: systemd user timer for the headless Linux setup.
- `deploy/launchd/com.stahl.oktoberfest-monitor.plist`: LaunchAgent template for the macOS hourly schedule (with `__REPO__` placeholder; §3 copies it into `~/Library/LaunchAgents/` with the path substituted).
- `~/Library/LaunchAgents/com.stahl.oktoberfest-monitor.plist`: The installed (generated) copy of the above — the live hourly schedule on macOS.
- `.github/workflows/check.yml`: The old GitHub Actions schedule, now disabled (kept for reference / manual fallback).
