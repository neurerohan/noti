require('dotenv').config();
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const axios = require('axios');
const NepaliDate = require('nepali-date-converter');
const moment = require('moment-timezone');

const ONE_SIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY;
const ONE_SIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const CALENDAR_FILE_PATH = path.join(__dirname, 'data', '2082-calendar.json');
const NPT_TIMEZONE = 'Asia/Kathmandu'; // UTC+5:45

// --- OneSignal API Helper ---
async function scheduleNotification(holidayName, sendAfterUtc) {
    if (!ONE_SIGNAL_API_KEY || !ONE_SIGNAL_APP_ID || ONE_SIGNAL_API_KEY === 'YOUR_REST_API_KEY') {
        console.warn('OneSignal API Key or App ID not configured. Skipping notification.');
        return;
    }

    // Check if send_after time is in the past
    const nowUtc = moment.utc();
    const sendAfterMoment = moment.utc(sendAfterUtc);

    if (sendAfterMoment.isBefore(nowUtc)) {
        console.log(`Skipping past notification for ${holidayName} scheduled at ${sendAfterUtc}`);
        return;
    }

    const notification = {
        app_id: ONE_SIGNAL_APP_ID,
        included_segments: ['All'], // Or specify your target segments
        send_after: sendAfterUtc, // ISO 8601 format in UTC
        contents: {
            en: `Parsi ta '${holidayName}' ko xutti, party hanna jaam baby!!` // Customize message as needed
            // Add other languages if needed: "ne": "..."
        },
        headings: {
            en: "Upcoming Holiday!"
            // "ne": "..."
        }
        // Add any other relevant OneSignal parameters here
        // e.g., data, buttons, android_channel_id etc.
    };

    try {
        console.log(`Scheduling notification for ${holidayName} at ${sendAfterUtc}`);
        const response = await axios.post('https://onesignal.com/api/v1/notifications', notification, {
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Authorization': `Basic ${ONE_SIGNAL_API_KEY}`
            }
        });
        console.log(`Notification scheduled successfully for ${holidayName}:`, response.data.id || 'Success');
    } catch (error) {
        console.error(`Error scheduling notification for ${holidayName}:`, error.response?.data || error.message);
    }
}

// --- Date Calculation Logic ---
function calculateAndScheduleNotifications() {
    console.log(`
[${moment().tz(NPT_TIMEZONE).format()}] Running daily check for upcoming holidays...`);

    let calendarDataByMonth = {}; // Changed variable name for clarity
    try {
        const rawData = fs.readFileSync(CALENDAR_FILE_PATH, 'utf8');
        calendarDataByMonth = JSON.parse(rawData); // Expecting an object keyed by month
    } catch (error) {
        console.error("Error reading or parsing calendar file:", error);
        return; // Stop if calendar data is unavailable
    }

    // Check if the parsed data is an object
    if (typeof calendarDataByMonth !== 'object' || calendarDataByMonth === null || Array.isArray(calendarDataByMonth)) {
        console.error("Calendar data is not in the expected format (object keyed by month). Found:", typeof calendarDataByMonth);
        return;
    }

    const todayGregorian = moment().tz(NPT_TIMEZONE).startOf('day'); // Today in NPT
    const thirtyDaysLaterGregorian = moment(todayGregorian).add(30, 'days');

    // Iterate through each month in the calendar data object
    Object.values(calendarDataByMonth).forEach(monthArray => {
        // Ensure monthArray is actually an array (days for the month)
        if (!Array.isArray(monthArray)) {
            console.warn("Skipping non-array month data:", monthArray);
            return;
        }

        // Iterate through each day entry in the month
        monthArray.forEach(dayEntry => {
            // Basic check for necessary properties
            if (!dayEntry || !dayEntry.bs || !dayEntry.events || !Array.isArray(dayEntry.events)) {
                 // console.warn("Skipping malformed day entry:", dayEntry); // Can be noisy, uncomment if needed
                 return;
            }

            // Construct the BS date string from the day entry
            const date_np = `${dayEntry.bs_year}-${String(dayEntry.bs_month).padStart(2, '0')}-${String(dayEntry.bs_day).padStart(2, '0')}`;

            // Check if this day is a holiday or Saturday based on its events
            let holidayEvent = null;
            let isSaturday = dayEntry.week_day === 6; // Assuming 6 represents Saturday in the data

            for (const event of dayEntry.events) {
                // Look for event title indicating Saturday or check specific holiday conditions if available
                // The original check relied on a 'type' field which doesn't seem present here.
                // We might need to refine this logic based on actual holiday event data structure.
                // For now, let's look for common holiday names or assume specific event IDs/types mark holidays if known.
                // Let's search for explicit holidays based on common keywords or properties in jds (job description service?).
                // This is a guess based on the data structure - adjust as needed.
                 if (event.jds && event.jds.gh === '1') { // 'gh' might indicate 'Government Holiday' ?
                    holidayEvent = event;
                    break; // Found a significant holiday event for this day
                 }
                 // Add more specific checks if needed, e.g., event.jds.ne === "Dashain Holiday"
            }

            // Proceed if it's a Saturday OR a detected holiday event
             if (isSaturday || holidayEvent) {
                const holidayName = holidayEvent ? (holidayEvent.jds?.ne || holidayEvent.jds?.en || holidayEvent.jtl || 'Holiday') : 'Saturday';
                 const effectiveType = holidayEvent ? "holiday-holiday" : "Saturday-holiday"; // Recreate the type concept

                 try {
                     // Convert Nepali Date (YYYY-MM-DD) to Gregorian Moment object
                     const bsDateParts = date_np.split('-').map(Number);
                     // Ensure year, month, day are valid numbers before creating Date
                     if (bsDateParts.length !== 3 || bsDateParts.some(isNaN)) {
                         console.error(`Invalid date format parsed: ${date_np}`);
                         return; // Skip this entry
                     }
                     const nepaliDate = new NepaliDate(new Date(bsDateParts[0], bsDateParts[1] - 1, bsDateParts[2])); // Use JS Date for BS constructor
                     const holidayGregorianDate = moment(nepaliDate.toJsDate()).tz(NPT_TIMEZONE).startOf('day');

                     // Check if the holiday is within the next 30 days (and not today or in the past)
                     if (holidayGregorianDate.isAfter(todayGregorian) && holidayGregorianDate.isBefore(thirtyDaysLaterGregorian)) {
                         console.log(`Found upcoming ${effectiveType}: ${holidayName} on ${date_np} (Gregorian: ${holidayGregorianDate.format('YYYY-MM-DD')})`);

                         // Schedule notifications:

                         // 1. Two days before @ 8:00 PM NPT
                         const twoDaysBeforeNpt = moment(holidayGregorianDate).subtract(2, 'days').set({ hour: 20, minute: 0, second: 0, millisecond: 0 });
                         const twoDaysBeforeUtc = twoDaysBeforeNpt.utc().format(); // ISO 8601 format (YYYY-MM-DDTHH:mm:ssZ)
                         scheduleNotification(`${holidayName} (2 days prior)`, twoDaysBeforeUtc);

                         // 2. One day before @ 10:00 AM NPT
                         const oneDayBeforeNpt = moment(holidayGregorianDate).subtract(1, 'day').set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
                         const oneDayBeforeUtc = oneDayBeforeNpt.utc().format();
                         scheduleNotification(`${holidayName} (1 day prior)`, oneDayBeforeUtc);

                         // 3. Same day @ 10:00 AM NPT
                         const sameDayNpt = moment(holidayGregorianDate).set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
                         const sameDayUtc = sameDayNpt.utc().format();
                         scheduleNotification(`${holidayName} (Same day)`, sameDayUtc);
                     }

                 } catch (dateError) {
                     console.error(`Error processing date ${date_np} for ${holidayName}:`, dateError);
                 }
             }
        });
    });
    console.log("Daily check finished.");
}

// --- Cron Job ---
// Schedule to run every day at midnight NPT (00:00)
// Note: The server's timezone might affect this. If running on a UTC server,
// you might need to adjust the cron time or explicitly set TZ env variable.
// For NPT (UTC+5:45), midnight is 18:15 UTC the previous day.
// Let's run it slightly after midnight NPT to be safe, e.g., 00:05 NPT
console.log('Setting up cron job to run daily at 00:05 NPT (Asia/Kathmandu)...');
cron.schedule('5 0 * * *', () => {
    calculateAndScheduleNotifications();
}, {
    scheduled: true,
    timezone: NPT_TIMEZONE
});

// --- Initial Run (Optional) ---
// Run once immediately when the script starts, useful for testing
console.log('Performing initial run on startup...');
calculateAndScheduleNotifications();

console.log(`Notification scheduler started. Waiting for cron trigger at 00:05 NPT...`); 