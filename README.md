# 🍺 Oktoberfest Reservation Monitor

This tool automatically checks the [Hofbräu Festzelt reservation page](https://reservierung.hb-festzelt.de/reservierung) every hour. It uses two fixed date combinations and alerts when any seating option with `>= 12` persons is available for either target date.

It runs on a Mac via a `launchd` LaunchAgent, driving a **headed** browser with a **persistent profile** from a residential IP. (It previously ran on GitHub Actions, but the datacenter IP + headless browser got repeatedly challenged by Cloudflare.)

## 🚀 Setup Instructions

### 1. Discord Webhook
1. Go to your Discord server.
2. Right-click a text channel > **Edit Channel** > **Integrations** > **Webhooks**.
3. Click **New Webhook**.
4. Copy the **Webhook URL**.

### 2. Configure the wrapper
1. Open `run.sh` (gitignored — it holds your secret) and paste your webhook URL into `DISCORD_WEBHOOK_URL`.
2. Adjust the `PATH` line if your Node lives somewhere other than the nvm path shown.

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
- `run.sh`: launchd wrapper (gitignored) holding the webhook secret and Node path.
- `~/Library/LaunchAgents/com.stahl.oktoberfest-monitor.plist`: The hourly schedule (LaunchAgent).
- `.github/workflows/check.yml`: The old GitHub Actions schedule, now disabled (kept for reference / manual fallback).
