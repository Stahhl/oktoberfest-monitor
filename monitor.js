const { chromium } = require('playwright');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

// Configuration
const URL = 'https://reservierung.hb-festzelt.de/reservierung';
const CLOSED_TEXT = 'Aktuell sind noch keine Reservierungen möglich';
const TARGET_DATE_REGEX = /\b28\.09\.2026\b/i;
const TARGET_SHIFT_REGEX = /^abend$/i;
const TARGET_AREA_REGEX = /^boxen$/i;
const TARGET_PAX_REGEX = /1\s*Tisch,\s*12\s*Personen/i;
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const SCREENSHOT_PATH = 'screenshot.png';
const FORM_IDS = {
    date: 'data.createBookingStepOneForm.date',
    shift: 'data.createBookingStepOneForm.booking_list_id',
    area: 'data.createBookingStepOneForm.seatplan_area_id',
    pax: 'data.createBookingStepOneForm.pax_options'
};

async function run() {
    console.log(`[${new Date().toISOString()}] Starting check...`);

    if (!WEBHOOK_URL) {
        console.error('Error: DISCORD_WEBHOOK_URL environment variable is not set.');
        process.exit(1);
    }

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
        console.log(`Navigating to ${URL}...`);
        await page.goto(URL, { waitUntil: 'networkidle' });
        await waitForCascadeUpdate(page);

        const isClosed = await isPortalClosed(page);

        if (isClosed) {
            console.log('Status: Reservations are still closed.');
            await sendHeartbeat('Still closed.');
        } else {
            const scanResult = await checkTargetCombination(page);

            if (scanResult.found) {
                console.log('Target availability detected.');
                await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
                await sendAlert(SCREENSHOT_PATH, scanResult);
            } else {
                console.log('Target combination is not currently available.');
                await sendHeartbeat(scanResult.message);
            }
        }
    } catch (error) {
        console.error('An error occurred during the check:', error);
        await captureScreenshot(page, SCREENSHOT_PATH);
        await sendUnexpected(SCREENSHOT_PATH, error);
    } finally {
        await browser.close();
        console.log('Check complete.');
    }
}

async function isPortalClosed(page) {
    const closedLocator = page.getByText(CLOSED_TEXT, { exact: false });
    if ((await closedLocator.count()) === 0) {
        return false;
    }
    return closedLocator.first().isVisible();
}

async function checkTargetCombination(page) {
    const dateOptions = await getSelectableOptions(page, FORM_IDS.date);
    if (dateOptions.length === 0) {
        throw new Error('Date dropdown has no selectable options.');
    }
    const date = findOption(dateOptions, TARGET_DATE_REGEX);
    if (!date) {
        return {
            found: false,
            message: `Target date 28.09.2026 is not available. Available dates: ${previewOptions(dateOptions)}`
        };
    }
    await selectByValue(page, FORM_IDS.date, date.value);

    const shiftOptions = await getSelectableOptions(page, FORM_IDS.shift);
    if (shiftOptions.length === 0) {
        return {
            found: false,
            message: `No shifts available for ${date.label}.`
        };
    }
    const shift = findOption(shiftOptions, TARGET_SHIFT_REGEX);
    if (!shift) {
        return {
            found: false,
            message: `Shift "Abend" is not available for ${date.label}. Available shifts: ${previewOptions(shiftOptions)}`
        };
    }
    await selectByValue(page, FORM_IDS.shift, shift.value);

    const areaOptions = await getSelectableOptions(page, FORM_IDS.area);
    if (areaOptions.length === 0) {
        return {
            found: false,
            message: `No areas available for ${date.label} / ${shift.label}.`
        };
    }
    const area = findOption(areaOptions, TARGET_AREA_REGEX);
    if (!area) {
        return {
            found: false,
            message: `Area "Boxen" is not available for ${date.label} / ${shift.label}. Available areas: ${previewOptions(areaOptions)}`
        };
    }
    await selectByValue(page, FORM_IDS.area, area.value);

    const paxOptions = await getSelectableOptions(page, FORM_IDS.pax);
    if (paxOptions.length === 0) {
        return {
            found: false,
            message: `No people options available for ${date.label} / ${shift.label} / ${area.label}.`
        };
    }

    const pax = findOption(paxOptions, TARGET_PAX_REGEX);
    if (!pax) {
        return {
            found: false,
            message: `No "1 Tisch, 12 Personen" option for ${date.label} / ${shift.label} / ${area.label}. Available options: ${previewOptions(paxOptions, 8)}`
        };
    }

    return {
        found: true,
        match: {
            date: date.label,
            shift: shift.label,
            area: area.label,
            pax: pax.label
        }
    };
}

async function getSelectableOptions(page, selectId) {
    const select = getSelectLocator(page, selectId);
    if ((await select.count()) === 0) {
        return [];
    }

    await select.waitFor({ state: 'visible', timeout: 10000 });
    return select.evaluate((el) =>
        Array.from(el.options)
            .filter((option) => option.value && !option.disabled)
            .map((option) => ({
                value: option.value,
                label: (option.textContent || '').trim()
            }))
    );
}

async function selectByValue(page, selectId, value) {
    const select = getSelectLocator(page, selectId);
    if ((await select.count()) === 0) {
        throw new Error(`Missing dropdown: ${selectId}`);
    }
    await select.selectOption(value);
    await waitForCascadeUpdate(page);
}

function getSelectLocator(page, selectId) {
    return page.locator(`select#${escapeCssId(selectId)}`).first();
}

function escapeCssId(value) {
    return value.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
}

function findOption(options, pattern) {
    return options.find((option) => pattern.test(option.label.trim()));
}

function previewOptions(options, limit = 5) {
    const labels = options.map((option) => option.label);
    if (labels.length <= limit) {
        return labels.join(', ');
    }
    return `${labels.slice(0, limit).join(', ')} (+${labels.length - limit} more)`;
}

async function waitForCascadeUpdate(page) {
    try {
        await page.waitForLoadState('networkidle', { timeout: 5000 });
    } catch (error) {
        // Dynamic selects often update without long network idle periods.
    }
    await page.waitForTimeout(800);
}

async function captureScreenshot(page, path) {
    try {
        await page.screenshot({ path, fullPage: true });
        return true;
    } catch (error) {
        console.error('Could not capture screenshot:', error.message);
        return false;
    }
}

async function sendHeartbeat(statusText) {
    try {
        const timestamp = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' });
        await axios.post(WEBHOOK_URL, {
            content: `🟥 Monitor check: ${statusText} Checked at ${timestamp}`
        });
        console.log('Heartbeat notification sent.');
    } catch (error) {
        console.error('Failed to send heartbeat:', error.message);
    }
}

async function sendAlert(imagePath, result) {
    const payload = {
        content: '@everyone Oktoberfest reservation alert: 1 table with 12 persons is available.',
        embeds: [{
            title: 'Go to Reservation Page',
            url: URL,
            color: 5763719,
            description: [
                `Date: ${result.match.date}`,
                `Shift: ${result.match.shift}`,
                `Area: ${result.match.area}`,
                `Option: ${result.match.pax}`
            ].join('\n'),
            timestamp: new Date().toISOString()
        }]
    };

    await sendDiscordPayload(payload, imagePath, 'match.png');
}

async function sendUnexpected(imagePath, error) {
    const errorMessage = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const payload = {
        content: '@everyone Oktoberfest monitor encountered an unexpected state. Screenshot attached for manual review.',
        embeds: [{
            title: 'Unexpected Monitor Error',
            url: URL,
            color: 15158332,
            description: errorMessage.slice(0, 1800),
            timestamp: new Date().toISOString()
        }]
    };
    await sendDiscordPayload(payload, imagePath, 'unexpected.png');
}

async function sendDiscordPayload(payload, imagePath, filename) {
    try {
        if (imagePath && fs.existsSync(imagePath)) {
            const form = new FormData();
            form.append('payload_json', JSON.stringify(payload));
            form.append('file', fs.createReadStream(imagePath), filename);
            await axios.post(WEBHOOK_URL, form, { headers: { ...form.getHeaders() } });
        } else {
            await axios.post(WEBHOOK_URL, payload);
        }
        console.log('Discord notification sent successfully.');
    } catch (error) {
        console.error('Failed to send Discord alert:', error.response ? error.response.data : error.message);
    }
}

run();
