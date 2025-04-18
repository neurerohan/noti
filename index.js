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
const AXIOS_TIMEOUT = 15000; // 15 seconds timeout for OneSignal API calls

// --- OneSignal API Helper ---
async function scheduleNotification(holidayName, dateNp, notificationType, sendAfterUtc) { // Added dateNp and type for logging
    if (!ONE_SIGNAL_API_KEY || !ONE_SIGNAL_APP_ID || ONE_SIGNAL_API_KEY === 'YOUR_REST_API_KEY') {
        console.warn(`[${dateNp}] OneSignal API Key or App ID not configured. Skipping ${notificationType} notification for ${holidayName}.`);
        return;
    }

    const nowUtc = moment.utc();
    const sendAfterMoment = moment.utc(sendAfterUtc);

    if (sendAfterMoment.isBefore(nowUtc)) {
        console.log(`[${dateNp}] Skipping past ${notificationType} notification for ${holidayName} scheduled at ${sendAfterUtc}`);
        return;
    }

    // --- Bonus: Dynamic Notification Content ---
    // Example: Customize message based on notification type
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
    // --- End Bonus ---


    const notification = {
        app_id: ONE_SIGNAL_APP_ID,
        included_segments: ['All'],
        send_after: sendAfterUtc,
        contents: { "en": contentText }, // Use dynamic content
        headings: { "en": headingText } // Use dynamic heading
    };

    try {
        console.log(`[${dateNp}] Scheduling ${notificationType} notification for ${holidayName} at ${sendAfterUtc}`);
        const response = await axios.post('https://onesignal.com/api/v1/notifications', notification, {
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Authorization': `Basic ${ONE_SIGNAL_API_KEY}`
            },
            timeout: AXIOS_TIMEOUT // Added timeout
        });
        // Check for specific success indicators if needed, OneSignal often returns {success: true} or an id
        console.log(`[${dateNp}] Notification scheduled successfully for ${holidayName} (${notificationType}):`, response.data.id || response.data.success || 'Success');
    } catch (error) {
        // Log more detailed error info
        const errorData = error.response?.data;
        console.error(`[${dateNp}] Error scheduling ${notificationType} notification for ${holidayName}:`, error.message);
        if (errorData) {
            console.error("OneSignal Error Details:", JSON.stringify(errorData, null, 2));
        }
        if (error.code === 'ECONNABORTED') {
             console.error("Request timed out.");
        }
    }
}

// --- Date Calculation Logic ---
function calculateAndScheduleNotifications() {
    console.log(`
[${moment().tz(NPT_TIMEZONE).format()}] Running daily check for upcoming holidays...`);

    let calendarDataByMonth = {};
    try {
        // Potential memory issue: Reading very large file synchronously. Monitor usage.
        console.log("Reading calendar file...");
        const rawData = fs.readFileSync(CALENDAR_FILE_PATH, 'utf8');
        console.log("Parsing calendar JSON...");
        calendarDataByMonth = JSON.parse(rawData);
        console.log("Calendar data parsed successfully.");
    } catch (error) {
        console.error("FATAL: Error reading or parsing calendar file:", error);
        return; // Stop if calendar data is unavailable
    }

    if (typeof calendarDataByMonth !== 'object' || calendarDataByMonth === null || Array.isArray(calendarDataByMonth)) {
        console.error("FATAL: Calendar data is not in the expected format (object keyed by month). Found:", typeof calendarDataByMonth);
        return;
    }

    const todayGregorian = moment().tz(NPT_TIMEZONE).startOf('day');
    const thirtyDaysLaterGregorian = moment(todayGregorian).add(30, 'days');
    let holidaysFound = 0;

    console.log(`Checking for holidays/Saturdays between ${todayGregorian.format('YYYY-MM-DD')} and ${thirtyDaysLaterGregorian.format('YYYY-MM-DD')} NPT.`);

    Object.entries(calendarDataByMonth).forEach(([monthKey, monthArray]) => { // Use entries to get monthKey if needed
        if (!Array.isArray(monthArray)) {
            // console.warn(`Skipping non-array data for month key: ${monthKey}`); // Less noise
            return;
        }

        monthArray.forEach(dayEntry => {
            if (!dayEntry || !dayEntry.bs_year || !dayEntry.bs_month || !dayEntry.bs_day || !dayEntry.events || !Array.isArray(dayEntry.events)) {
                 return; // Skip malformed entries quietly
            }

            const date_np = `${dayEntry.bs_year}-${String(dayEntry.bs_month).padStart(2, '0')}-${String(dayEntry.bs_day).padStart(2, '0')}`;

            // --- !!! CRITICAL ASSUMPTION AREA !!! ---
            // Verify these assumptions based on your specific '2082-calendar.json' structure.
            // Assumption 1: week_day === 6 means Saturday. (0=Sun? 1=Mon?)
            const isSaturday = dayEntry.week_day === 6;
            // Assumption 2: event.jds.gh === '1' indicates a relevant holiday.
            const holidayEvent = dayEntry.events.find(event => event && event.jds && event.jds.gh === '1');
            // --- !!! END CRITICAL ASSUMPTION AREA !!! ---

            if (isSaturday || holidayEvent) {
                const holidayName = holidayEvent ? (holidayEvent.jds?.ne || holidayEvent.jds?.en || holidayEvent.jtl || `Holiday on ${date_np}`) : 'Saturday';
                const effectiveType = holidayEvent ? "Holiday" : "Saturday";

                try {
                    const bsDateParts = date_np.split('-').map(Number);
                    if (bsDateParts.length !== 3 || bsDateParts.some(isNaN)) {
                        console.error(`[${date_np}] Invalid date format parsed: ${date_np} for ${holidayName}`);
                        return;
                    }

                    // Validate month and day ranges before creating Date object
                    if (bsDateParts[1] < 1 || bsDateParts[1] > 12 || bsDateParts[2] < 1 || bsDateParts[2] > 32) {
                         console.error(`[${date_np}] Invalid month/day in date: ${date_np} for ${holidayName}`);
                         return;
                    }

                    // Correct instantiation: Pass BS Year, Month (0-indexed), Day directly
                    const nepaliDate = new NepaliDate(bsDateParts[0], bsDateParts[1] - 1, bsDateParts[2]);

                    const holidayGregorianDate = moment(nepaliDate.toJsDate()).tz(NPT_TIMEZONE).startOf('day');

                    if (!holidayGregorianDate.isValid()) {
                        console.error(`[${date_np}] Gregorian date conversion failed for ${holidayName}`);
                        return;
                    }

                    if (holidayGregorianDate.isAfter(todayGregorian) && holidayGregorianDate.isBefore(thirtyDaysLaterGregorian)) {
                        holidaysFound++;
                        console.log(`Found upcoming ${effectiveType}: ${holidayName} on ${date_np} (Gregorian: ${holidayGregorianDate.format('YYYY-MM-DD')})`);

                        // Schedule notifications:
                        const twoDaysBeforeNpt = moment(holidayGregorianDate).subtract(2, 'days').set({ hour: 20, minute: 0, second: 0, millisecond: 0 });
                        const oneDayBeforeNpt = moment(holidayGregorianDate).subtract(1, 'day').set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
                        const sameDayNpt = moment(holidayGregorianDate).set({ hour: 10, minute: 0, second: 0, millisecond: 0 });

                        scheduleNotification(holidayName, date_np, '2 days prior', twoDaysBeforeNpt.utc().format());
                        scheduleNotification(holidayName, date_np, '1 day prior', oneDayBeforeNpt.utc().format());
                        scheduleNotification(holidayName, date_np, 'Same day', sameDayNpt.utc().format());
                    }

                } catch (dateError) {
                    console.error(`[${date_np}] Error processing date for ${holidayName}:`, dateError);
                }
            }
        });
    });

    if (holidaysFound === 0) {
        console.log("No upcoming holidays or Saturdays found within the next 30 days requiring notification scheduling.");
    } else {
        console.log(`Finished checking. Found and processed ${holidaysFound} relevant dates.`);
    }
    console.log("Daily check finished.");
}

// --- Cron Job ---
console.log('Setting up cron job to run daily at 00:05 NPT (Asia/Kathmandu)...');
cron.schedule('5 0 * * *', () => {
    // Added top-level try-catch for the entire job execution
    try {
        calculateAndScheduleNotifications();
    } catch (err) {
        console.error("FATAL ERROR in cron job execution:", err);
        // Optional: Consider sending an alert notification here if the whole job fails critically
    }
}, {
    scheduled: true,
    timezone: NPT_TIMEZONE
});

// --- Initial Run (Optional but recommended for testing) ---
console.log('Performing initial run on startup...');
// Added top-level try-catch for the initial run as well
try {
    calculateAndScheduleNotifications();
} catch (err) {
    console.error("FATAL ERROR during initial run:", err);
}

console.log(`Notification scheduler started. Waiting for cron trigger at 00:05 NPT...`); 