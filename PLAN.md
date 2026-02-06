# Oktoberfest Reservation Monitor Plan

## Overview
This project is a lightweight, serverless monitoring tool designed to check the [Hofbräu Festzelt reservation page](https://reservierung.hb-festzelt.de/reservierung) for availability changes. It runs automatically on a schedule and notifies you via Discord when reservations appear to be open.

## Architecture

### 1. Core Logic (Node.js + Playwright)
We will use a Node.js script utilizing **Playwright**, a powerful browser automation library.
*   **Behavior**: It launches a headless Chromium browser to visit the reservation page.
*   **Detection**: It waits for the page to load and checks for the presence of the specific text: *"Aktuell sind noch keine Reservierungen möglich"* (Currently no reservations possible).
*   **Trigger**: If this text is **NOT** found, the script assumes the reservation portal has opened or changed status.
*   **Evidence**: It captures a full-page screenshot for verification.

### 2. Notification System (Discord Webhooks)
*   **Integration**: Direct HTTP POST requests to a Discord Webhook URL.
*   **Payload**: The message will include an alert text ("🚨 STATUS CHANGE DETECTED") and the captured screenshot of the webpage.
*   **Why Discord?**: It natively renders images sent via webhooks, providing an instant visual confirmation without needing to host the image externally.

### 3. Automation & Hosting (GitHub Actions)
*   **Platform**: GitHub Actions (Free tier is sufficient).
*   **Schedule**: A cron job defined in `.github/workflows/schedule.yml` will trigger the script every hour (e.g., `0 * * * *`).
*   **Zero Maintenance**: No local server or VPS required. The script runs in the cloud.

## Implementation Steps

### Step 1: Project Initialization
*   Create `package.json` to manage dependencies (`playwright`, `axios`, `form-data`).
*   Create `.gitignore` to exclude `node_modules` and local screenshots.

### Step 2: The Monitor Script (`monitor.js`)
*   **Setup**: Import Playwright and Discord utilities.
*   **Navigation**: Go to the target URL.
*   **Check**:
    ```javascript
    const isClosed = await page.getByText('Aktuell sind noch keine Reservierungen möglich').isVisible();
    ```
*   **Action**:
    *   If `!isClosed`:
        1.  Take screenshot: `page.screenshot({ path: 'status.png' })`.
        2.  Construct `FormData` with the image.
        3.  POST to `DISCORD_WEBHOOK_URL`.

### Step 3: GitHub Actions Workflow (`.github/workflows/check.yml`)
*   Define a workflow that runs on:
    1.  `schedule`: cron `'0 * * * *'` (Hourly).
    2.  `workflow_dispatch`: Allows manual triggering for testing.
*   **Job Steps**:
    1.  Checkout code.
    2.  Setup Node.js.
    3.  Install dependencies (`npm ci`).
    4.  Install Playwright browsers (`npx playwright install chromium`).
    5.  Run the monitor script (`node monitor.js`).
*   **Secrets**: The `DISCORD_WEBHOOK_URL` will be stored as a GitHub Repository Secret for security.

## User Instructions (Post-Creation)
1.  **Discord Setup**: Create a Webhook in your Discord Server (Channel Settings > Integrations > Webhooks) and copy the URL.
2.  **GitHub Setup**:
    *   Fork/Copy this repository.
    *   Go to Settings > Secrets and variables > Actions.
    *   Add a new repository secret named `DISCORD_WEBHOOK_URL` with your copied URL.
3.  **Activate**: The action will start running automatically on the next hour.
