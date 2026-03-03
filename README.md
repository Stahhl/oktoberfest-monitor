# 🍺 Oktoberfest Reservation Monitor

This tool automatically checks the [Hofbräu Festzelt reservation page](https://reservierung.hb-festzelt.de/reservierung) every hour. It uses a fixed combination and alerts only when it finds `1 Tisch, 12 Personen` for that combination.

## 🚀 Setup Instructions

### 1. Discord Webhook
1. Go to your Discord server.
2. Right-click a text channel > **Edit Channel** > **Integrations** > **Webhooks**.
3. Click **New Webhook**.
4. Copy the **Webhook URL**.

### 2. GitHub Configuration
1. **Fork** or **Copy** this repository to your GitHub account.
2. Go to your repository's **Settings** tab.
3. In the left sidebar, click **Secrets and variables** > **Actions**.
4. Click **New repository secret**.
   - **Name**: `DISCORD_WEBHOOK_URL`
   - **Value**: *(Paste your Discord Webhook URL here)*
5. Click **Add secret**.

### 3. Activate
The monitor is now set up!
- It will run automatically **every hour**.
- To test it immediately:
    1. Go to the **Actions** tab in your repository.
    2. Click **Monitor Reservations** in the left sidebar.
    3. Click the **Run workflow** button.

## 🛠️ How it Works
- The script uses **Playwright** (a headless browser) to load the page exactly like a real user.
- If the closed text (`Aktuell sind noch keine Reservierungen möglich`) is visible, it sends a heartbeat.
- If the portal is open, it selects:
  - `Datum`: `28.09.2026` (matched by label text, not by backend value/timestamp)
  - `Schicht`: `Abend`
  - `Bereich`: `Boxen`
- It then checks `Anzahl gewünschte Personen` for an option matching `1 Tisch, 12 Personen`.
- If an unexpected error happens, it sends a Discord ping with a screenshot for manual interpretation.

## 📂 Files
- `monitor.js`: The main logic script.
- `.github/workflows/check.yml`: The schedule configuration (runs every hour).
