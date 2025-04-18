require('dotenv').config();
const cron = require('node-cron');
const axios = require('axios');
const moment = require('moment-timezone');

const ONE_SIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY;
const ONE_SIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const NPT_TIMEZONE = 'Asia/Kathmandu'; // UTC+5:45
const AXIOS_TIMEOUT = 20000; // Increased timeout slightly for external API
const NP_EVENTS_API_BASE_URL = 'https://npclapi.casualsnek.eu.org/v2'; // API Base URL

// --- OneSignal API Helper ---
async function scheduleNotification(holidayName, dateNpString, notificationType, sendAfterUtc) {
    if (!ONE_SIGNAL_API_KEY || !ONE_SIGNAL_APP_ID || ONE_SIGNAL_API_KEY === 'YOUR_REST_API_KEY') {
        console.warn(`[${dateNpString}] OneSignal API Key or App ID not configured. Skipping ${notificationType} notification for ${holidayName}.`);
        return;
    }
    const nowUtc = moment.utc();
    const sendAfterMoment = moment.utc(sendAfterUtc);

    if (sendAfterMoment.isBefore(nowUtc)) {
        console.log(`[${dateNpString}] Skipping past ${notificationType} notification for ${holidayName} scheduled at ${sendAfterUtc}`);
        return;
    }

    let headingText = "Upcoming Holiday!";
    let contentText = `Parsi ta '${holidayName}' ko xutti, party hanna jaam baby!!`; // Default

    if (notificationType === '2 days prior') {
        headingText = `Holiday Reminder: ${holidayName}`;
        contentText = `Just 2 days until '${holidayName}'! Get ready!`;
    } else if (notificationType === '1 day prior') {
        headingText = `Holiday Tomorrow: ${holidayName}`;
        contentText = `'${holidayName}' is tomorrow! Almost time!`;
    } else if (notificationType === 'Same day') {
        headingText = `Happy Holiday: ${holidayName}!`
        contentText = `Today is '${holidayName}'! Enjoy your day off!`;
    }

    const notification = {
        app_id: ONE_SIGNAL_APP_ID,
        included_segments: ['All'],
        send_after: sendAfterUtc,
        contents: { "en": contentText },
        headings: { "en": headingText }
    };

    try {
        console.log(`[${dateNpString}] Scheduling ${notificationType} notification for ${holidayName} at ${sendAfterUtc}`);
        const response = await axios.post('https://onesignal.com/api/v1/notifications', notification, {
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Authorization': `Basic ${ONE_SIGNAL_API_KEY}`
            },
            timeout: AXIOS_TIMEOUT
        });
        console.log(`[${dateNpString}] Notification scheduled successfully for ${holidayName} (${notificationType}):`, response.data.id || response.data.success || 'Success');
    } catch (error) {
        const errorData = error.response?.data;
        console.error(`[${dateNpString}] Error scheduling ${notificationType} notification for ${holidayName}:`, error.message);
        if (errorData) {
            console.error("OneSignal Error Details:", JSON.stringify(errorData, null, 2));
        }
        if (error.code === 'ECONNABORTED') {
            console.error("Request timed out.");
        }
    }
}

// --- Date Calculation Logic (Using npEventsAPI) ---
async function calculateAndScheduleNotifications() { // Made async for await axios
    console.log(`
[${moment().tz(NPT_TIMEZONE).format()}] Running daily check for upcoming holidays...`);

    let holidaysFound = 0;
    const today = moment.tz(NPT_TIMEZONE);
    const fromDate = moment(today).add(1, 'days'); // Start check from tomorrow
    const toDate = moment(today).add(30, 'days'); // Check up to 30 days ahead

    const fromDateStr = fromDate.format('YYYY-MM-DD');
    const toDateStr = toDate.format('YYYY-MM-DD');

    const apiUrl = `${NP_EVENTS_API_BASE_URL}/range/ad/from/${fromDateStr}/to/${toDateStr}`; // Using AD dates for API call
    console.log(`Querying API for date range: ${fromDateStr} to ${toDateStr} -> ${apiUrl}`);

    try {
        const response = await axios.get(apiUrl, { timeout: AXIOS_TIMEOUT });
        const apiData = response.data;

        if (!apiData || typeof apiData !== 'object') {
            console.error("API Error: Invalid response structure received.", apiData);
            return;
        }

        console.log("API response received, processing...");

        // Iterate through the response structure (years -> months -> days)
        for (const year in apiData) {
            if (!apiData[year] || typeof apiData[year] !== 'object') continue;
            for (const month in apiData[year]) {
                if (!apiData[year][month] || typeof apiData[year][month] !== 'object') continue;
                for (const day in apiData[year][month]) {
                    const dayData = apiData[year][month][day];

                    // Validate dayData structure from API
                    if (!dayData || !dayData.date || !dayData.date.ad || !dayData.date.bs || !dayData.date.ad.year || !dayData.date.ad.month || !dayData.date.ad.day || !dayData.date.bs.year || !dayData.date.bs.month || !dayData.date.bs.day ) {
                        console.warn(`Skipping malformed day data from API for ${year}-${month}-${day}`);
                        continue;
                    }

                    // --- Check Holiday --- 
                    const isHoliday = dayData.public_holiday === true;
                    let holidayName = null;
                    if (isHoliday) {
                        // Try to get a name from the event array or use a default
                        holidayName = Array.isArray(dayData.event) && dayData.event.length > 0
                            ? dayData.event.join(', ') // Join event names if multiple
                            : 'Public Holiday';
                    }

                    // --- Check Saturday --- 
                    // Use the AD date provided by the API to determine day of week
                    const targetGregorianDate = moment.tz({
                        year: dayData.date.ad.year,
                        month: dayData.date.ad.month - 1, // API month is 1-based, moment is 0-based
                        day: dayData.date.ad.day
                    }, NPT_TIMEZONE).startOf('day');

                    if (!targetGregorianDate.isValid()) {
                        console.warn(`Skipping day due to invalid AD date from API: ${year}-${month}-${day}`);
                        continue;
                    }

                    const dayOfWeek = targetGregorianDate.day(); // 0 = Sunday, 6 = Saturday
                    const isSaturday = dayOfWeek === 6;

                    // Construct BS date string for logging
                    const dateNpString = `${dayData.date.bs.year}-${String(dayData.date.bs.month).padStart(2, '0')}-${String(dayData.date.bs.day).padStart(2, '0')}`;

                    console.log(`[PROCESS_DAY ${dateNpString}] AD:${targetGregorianDate.format('YYYY-MM-DD')} DayOfWeek:${dayOfWeek} isSaturday:${isSaturday} isHoliday:${isHoliday} holidayName:${holidayName || 'N/A'}`);

                    if (isSaturday || isHoliday) {
                        holidaysFound++;
                        const effectiveHolidayName = holidayName || 'Saturday';
                        const effectiveType = holidayName ? "Holiday" : "Saturday";

                        console.log(`Found upcoming ${effectiveType}: ${effectiveHolidayName} on ${dateNpString} (Gregorian: ${targetGregorianDate.format('YYYY-MM-DD')})`);

                        // Schedule notifications using the already calculated targetGregorianDate
                        const twoDaysBeforeNpt = moment(targetGregorianDate).subtract(2, 'days').set({ hour: 20, minute: 0, second: 0, millisecond: 0 });
                        const oneDayBeforeNpt = moment(targetGregorianDate).subtract(1, 'day').set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
                        const sameDayNpt = moment(targetGregorianDate).set({ hour: 10, minute: 0, second: 0, millisecond: 0 });

                        scheduleNotification(effectiveHolidayName, dateNpString, '2 days prior', twoDaysBeforeNpt.utc().format());
                        scheduleNotification(effectiveHolidayName, dateNpString, '1 day prior', oneDayBeforeNpt.utc().format());
                        scheduleNotification(effectiveHolidayName, dateNpString, 'Same day', sameDayNpt.utc().format());
                    }
                }
            }
        }

    } catch (error) {
        console.error("API Call Error:", error.message);
        if (error.response) {
            // The request was made and the server responded with a status code
            // that falls out of the range of 2xx
            console.error("API Response Status:", error.response.status);
            console.error("API Response Data:", error.response.data);
        } else if (error.request) {
            // The request was made but no response was received
            console.error("API No Response Received. Request:", error.request);
        } else {
            // Something happened in setting up the request that triggered an Error
            console.error('API Request Setup Error', error.message);
        }
        if (error.code === 'ECONNABORTED') {
            console.error("API Request Timed Out.");
       }
    }

    if (holidaysFound === 0) {
        console.log("No upcoming holidays or Saturdays found via API within the next 30 days requiring notification scheduling.");
    }
    console.log("Daily check finished.");
}

// --- Cron Job ---
console.log('Setting up cron job to run daily at 00:05 NPT (Asia/Kathmandu)...');
cron.schedule('5 0 * * *', () => {
    try {
        // No need to await here unless the cron job needs to know when it finishes
        calculateAndScheduleNotifications();
    } catch (err) {
        console.error("FATAL ERROR in cron job execution:", err);
    }
}, {
    scheduled: true,
    timezone: NPT_TIMEZONE
});

// --- Initial Run (Trigger async function) ---
console.log('Performing initial run on startup...');
(async () => { // Use an async IIFE for the initial run
    try {
        await calculateAndScheduleNotifications(); // await ensures initial run completes before potentially exiting
    } catch (err) {
        console.error("FATAL ERROR during initial run:", err);
    }
})(); // Immediately invoke the async function

console.log(`Notification scheduler started. Waiting for cron trigger at 00:05 NPT...`); 