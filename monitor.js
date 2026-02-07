const { chromium } = require('playwright');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

// Configuration
const URL = 'https://reservierung.hb-festzelt.de/reservierung';
// Text that appears when reservations are CLOSED/NOT READY
const CLOSED_TEXT = 'Aktuell sind noch keine Reservierungen möglich';
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

async function run() {
    console.log(`[${new Date().toISOString()}] Starting check...`);

    if (!WEBHOOK_URL) {
        console.error('Error: DISCORD_WEBHOOK_URL environment variable is not set.');
        process.exit(1);
    }

    const browser = await chromium.launch();
    const page = await browser.newPage();

    try {
        console.log(`Navigating to ${URL}...`);
        await page.goto(URL, { waitUntil: 'networkidle' });

        // Wait a brief moment for any dynamic content (Alpine/Livewire) to settle
        await page.waitForTimeout(2000);

        // Check if the "Closed" text is present
        const isClosed = await page.getByText(CLOSED_TEXT).isVisible();

        if (isClosed) {
            console.log('Status: Reservations are still closed. Sending heartbeat...');
            await sendHeartbeat();
        } else {
            console.log('🚨 STATUS CHANGE DETECTED! Reservations might be open!');
            
            // Take a screenshot
            const screenshotPath = 'screenshot.png';
            await page.screenshot({ path: screenshotPath, fullPage: true });

            // Send notification
            await sendAlert(screenshotPath);
        }

    } catch (error) {
        console.error('An error occurred during the check:', error);
    } finally {
        await browser.close();
        console.log('Check complete.');
    }
}

async function sendHeartbeat() {
    try {
        // Format: YYYY-MM-DD HH:MM:SS
        const timestamp = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' });
        await axios.post(WEBHOOK_URL, {
            content: `🍺 **Monitor Check:** Still closed 🙁 Checked at ${timestamp}`
        });
        console.log('Heartbeat notification sent.');
    } catch (error) {
        console.error('Failed to send heartbeat:', error.message);
    }
}

async function sendAlert(imagePath) {
    const form = new FormData();
    
    // Discord Webhook payload
    const payload = {
        content: "@everyone 🍺 **Oktoberfest Reservation Alert!** 🥨\n\nThe status text on the Hofbräu Festzelt page has changed/disappeared. Check the link immediately!",
        embeds: [{
            title: "Go to Reservation Page",
            url: URL,
            color: 5763719, // Green-ish color
            description: `The text "${CLOSED_TEXT}" was not found on the page.`,
            timestamp: new Date().toISOString()
        }]
    };

    form.append('payload_json', JSON.stringify(payload));
    form.append('file', fs.createReadStream(imagePath));

    try {
        console.log('Sending Discord alert...');
        await axios.post(WEBHOOK_URL, form, {
            headers: {
                ...form.getHeaders()
            }
        });
        console.log('Alert sent successfully!');
    } catch (error) {
        console.error('Failed to send Discord alert:', error.response ? error.response.data : error.message);
    }
}

run();
