const { chromium } = require('playwright');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

// Configuration
const URL = 'https://reservierung.hb-festzelt.de/reservierung';
const CLOSED_TEXT = 'Aktuell sind noch keine Reservierungen möglich';
const TARGET_DATES = [
    { label: '28.09.2026', pattern: /\b28\.09\.2026\b/i },
    { label: '29.09.2026', pattern: /\b29\.09\.2026\b/i }
];
const TARGET_SHIFT_REGEX = /^abend$/i;
const TARGET_AREA_REGEX = /^boxen$/i;
const MIN_TOTAL_PERSONS = 12;
const BETWEEN_DATES_DELAY_MS = 30000;
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const SCREENSHOT_PATH = 'screenshot.png';
// Persistent browser profile so a Cloudflare clearance cookie survives between hourly runs.
const USER_DATA_DIR = path.join(__dirname, '.browser-profile');
// Headed by default (looks like a real user); set HEADLESS=1 to force headless for debugging.
const HEADLESS = process.env.HEADLESS === '1';
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

    const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
        headless: HEADLESS,
        viewport: { width: 1280, height: 900 },
        locale: 'de-DE',
        timezoneId: 'Europe/Berlin',
        args: ['--disable-blink-features=AutomationControlled']
    });
    const page = context.pages()[0] || await context.newPage();

    try {
        console.log(`Navigating to ${URL}...`);
        await page.goto(URL, { waitUntil: 'networkidle' });
        await waitForCascadeUpdate(page);

        const initialBlockState = await detectCloudflareBlock(page);
        if (initialBlockState.blocked) {
            console.log('Cloudflare block detected before scanning.');
            await captureScreenshot(page, SCREENSHOT_PATH);
            await sendCloudflareAlert(SCREENSHOT_PATH, initialBlockState);
            return;
        }

        const isClosed = await isPortalClosed(page);

        if (isClosed) {
            console.log('Status: Reservations are still closed.');
            await sendHeartbeat('Still closed.');
        } else {
            const scanResult = await checkTargetDates(page);

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
        const blockState = await detectCloudflareBlock(page);
        await captureScreenshot(page, SCREENSHOT_PATH);
        if (blockState.blocked) {
            await sendCloudflareAlert(SCREENSHOT_PATH, blockState);
        } else {
            await sendUnexpected(SCREENSHOT_PATH, error);
        }
    } finally {
        await context.close();
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

async function checkTargetDates(page) {
    const results = [];
    const dateOptions = await getSelectableOptions(page, FORM_IDS.date);
    if (dateOptions.length === 0) {
        throw new Error('Date dropdown has no selectable options.');
    }

    for (const [index, targetDate] of TARGET_DATES.entries()) {
        const dateResult = await checkSingleDate(page, targetDate, dateOptions);
        if (dateResult.blocked) {
            return {
                found: false,
                blocked: true,
                block: dateResult.block,
                matches: results.filter((result) => result.found),
                failures: results.filter((result) => !result.found)
            };
        }

        results.push(dateResult);

        const nextTargetDate = TARGET_DATES[index + 1];
        if (nextTargetDate) {
            console.log(`Waiting ${BETWEEN_DATES_DELAY_MS / 1000}s before checking ${nextTargetDate.label}...`);
            await page.waitForTimeout(BETWEEN_DATES_DELAY_MS);
        }
    }

    const matches = results.filter((result) => result.found);
    if (matches.length > 0) {
        return {
            found: true,
            blocked: false,
            matches,
            failures: results.filter((result) => !result.found),
            message: `Availability found for ${matches.length} of ${TARGET_DATES.length} target dates.`
        };
    }

    return {
        found: false,
        blocked: false,
        matches: [],
        failures: results,
        message: summarizeFailures(results)
    };
}

async function checkSingleDate(page, targetDate, dateOptions) {
    const date = findOption(dateOptions, targetDate.pattern);
    if (!date) {
        return {
            found: false,
            dateLabel: targetDate.label,
            reason: `date not available. Available dates: ${previewOptions(dateOptions)}`
        };
    }
    await selectByValue(page, FORM_IDS.date, date.value);

    const blockAfterDate = await detectCloudflareBlock(page);
    if (blockAfterDate.blocked) {
        return {
            blocked: true,
            block: {
                ...blockAfterDate,
                stage: `after selecting date ${date.label}`
            }
        };
    }

    const shiftOptions = await getSelectableOptions(page, FORM_IDS.shift);
    if (shiftOptions.length === 0) {
        return {
            found: false,
            dateLabel: date.label,
            reason: 'no shifts available'
        };
    }
    const shift = findOption(shiftOptions, TARGET_SHIFT_REGEX);
    if (!shift) {
        return {
            found: false,
            dateLabel: date.label,
            reason: `Abend not available. Available shifts: ${previewOptions(shiftOptions)}`
        };
    }
    await selectByValue(page, FORM_IDS.shift, shift.value);

    const blockAfterShift = await detectCloudflareBlock(page);
    if (blockAfterShift.blocked) {
        return {
            blocked: true,
            block: {
                ...blockAfterShift,
                stage: `after selecting shift for ${date.label}`
            }
        };
    }

    const areaOptions = await getSelectableOptions(page, FORM_IDS.area);
    if (areaOptions.length === 0) {
        return {
            found: false,
            dateLabel: date.label,
            reason: `no areas available for ${shift.label}`
        };
    }
    const area = findOption(areaOptions, TARGET_AREA_REGEX);
    if (!area) {
        return {
            found: false,
            dateLabel: date.label,
            reason: `Boxen not available. Available areas: ${previewOptions(areaOptions)}`
        };
    }
    await selectByValue(page, FORM_IDS.area, area.value);

    const blockAfterArea = await detectCloudflareBlock(page);
    if (blockAfterArea.blocked) {
        return {
            blocked: true,
            block: {
                ...blockAfterArea,
                stage: `after selecting area for ${date.label}`
            }
        };
    }

    const paxOptions = await getSelectableOptions(page, FORM_IDS.pax);
    if (paxOptions.length === 0) {
        return {
            found: false,
            dateLabel: date.label,
            reason: `no people options available for ${shift.label} / ${area.label}`
        };
    }

    const qualifyingPaxOptions = paxOptions.filter((option) => {
        const totalPersons = extractTotalPersons(option);
        return totalPersons !== null && totalPersons >= MIN_TOTAL_PERSONS;
    });

    if (qualifyingPaxOptions.length === 0) {
        return {
            found: false,
            dateLabel: date.label,
            reason: `no seating option with >= ${MIN_TOTAL_PERSONS} persons. Available options: ${previewPaxOptions(paxOptions, 8)}`
        };
    }

    const bestMatch = qualifyingPaxOptions.sort((a, b) => {
        return extractTotalPersons(a) - extractTotalPersons(b);
    })[0];

    return {
        found: true,
        dateLabel: date.label,
        match: {
            date: date.label,
            shift: shift.label,
            area: area.label,
            pax: bestMatch.label
        },
        qualifyingOptions: qualifyingPaxOptions.map((option) => formatPaxOption(option))
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

function extractTotalPersons(option) {
    const value = option.value || '';
    const valueParts = value.split('_');
    const lastPart = valueParts[valueParts.length - 1];
    if (/^\d+$/.test(lastPart)) {
        return Number(lastPart);
    }

    const label = option.label || '';
    const labelMatch = label.match(/,\s*(\d+)\s*Personen/i) || label.match(/(\d+)\s*Personen/i);
    if (labelMatch) {
        return Number(labelMatch[1]);
    }

    return null;
}

function formatPaxOption(option) {
    const totalPersons = extractTotalPersons(option);
    if (totalPersons === null) {
        return option.label;
    }
    return `${option.label} [total=${totalPersons}]`;
}

function previewPaxOptions(options, limit = 5) {
    const labels = options.map((option) => formatPaxOption(option));
    if (labels.length <= limit) {
        return labels.join(', ');
    }
    return `${labels.slice(0, limit).join(', ')} (+${labels.length - limit} more)`;
}

function summarizeFailures(results) {
    const summaries = results.map((result) => `${result.dateLabel}: ${result.reason}`);
    return `No availability found for ${TARGET_DATES.length} target dates. ${summaries.join(' | ')}`;
}

async function detectCloudflareBlock(page) {
    const url = page.url();
    const title = await page.title().catch(() => '');
    const bodyText = await page.locator('body').innerText().catch(() => '');
    const html = await page.content().catch(() => '');
    const haystacks = [url, title, bodyText, html].filter(Boolean).join('\n');

    const markerPatterns = [
        { label: 'cloudflare challenge', pattern: /checking your browser|please enable javascript and cookies|verify you are human/i },
        { label: 'cloudflare brand', pattern: /\bcloudflare\b/i },
        { label: 'cdn-cgi challenge url', pattern: /cdn-cgi\/challenge-platform/i },
        { label: 'attention required', pattern: /attention required/i },
        { label: 'ray id', pattern: /ray id/i }
    ];

    const markers = markerPatterns
        .filter((marker) => marker.pattern.test(haystacks))
        .map((marker) => marker.label);

    if (markers.length === 0) {
        return { blocked: false, markers: [], url, title };
    }

    return {
        blocked: true,
        reason: 'Cloudflare challenge or block page detected',
        markers,
        url,
        title
    };
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
    const totalDates = TARGET_DATES.length;
    const successfulDates = result.matches.length;
    const descriptionLines = [
        `Availability found for ${successfulDates} of ${totalDates} target dates.`
    ];

    for (const match of result.matches) {
        const shownMatches = match.qualifyingOptions.slice(0, 8);
        const extraCount = match.qualifyingOptions.length - shownMatches.length;
        descriptionLines.push('');
        descriptionLines.push(`Date: ${match.match.date}`);
        descriptionLines.push(`Shift: ${match.match.shift}`);
        descriptionLines.push(`Area: ${match.match.area}`);
        descriptionLines.push(`Closest match: ${match.match.pax}`);
        descriptionLines.push('Qualifying options:');
        descriptionLines.push(...shownMatches);
        if (extraCount > 0) {
            descriptionLines.push(`(+${extraCount} more)`);
        }
    }

    if (result.failures.length > 0) {
        descriptionLines.push('');
        descriptionLines.push('Dates without availability:');
        descriptionLines.push(...result.failures.map((failure) => `${failure.dateLabel}: ${failure.reason}`));
    }

    const payload = {
        content: `@everyone Oktoberfest reservation alert: seating for >= ${MIN_TOTAL_PERSONS} persons is available for ${successfulDates} of ${totalDates} target dates.`,
        embeds: [{
            title: 'Go to Reservation Page',
            url: URL,
            color: 5763719,
            description: descriptionLines.join('\n'),
            timestamp: new Date().toISOString()
        }]
    };

    await sendDiscordPayload(payload, imagePath, 'match.png');
}

async function sendCloudflareAlert(imagePath, blockState) {
    const payload = {
        content: '@everyone Oktoberfest monitor likely hit a Cloudflare block. Screenshot attached for manual review.',
        embeds: [{
            title: 'Cloudflare Block Detected',
            url: URL,
            color: 16753920,
            description: [
                `Reason: ${blockState.reason}`,
                `Stage: ${blockState.stage || 'during page load or scanning'}`,
                `URL: ${blockState.url || 'unknown'}`,
                `Title: ${blockState.title || 'unknown'}`,
                `Markers: ${blockState.markers && blockState.markers.length > 0 ? blockState.markers.join(', ') : 'none'}`
            ].join('\n'),
            timestamp: new Date().toISOString()
        }]
    };

    await sendDiscordPayload(payload, imagePath, 'cloudflare.png');
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
