require('dotenv').config();
const cron = require('node-cron');
const axios = require('axios');
const moment = require('moment-timezone');
const NepaliCalendar = require('nepali-calendar-js');

const ONE_SIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY;
const ONE_SIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const NPT_TIMEZONE = 'Asia/Kathmandu'; // UTC+5:45
const AXIOS_TIMEOUT = 15000; // 15 seconds timeout for OneSignal API calls

// Initialize the calendar - Use current date context by default
const calendar = new NepaliCalendar();

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

// --- Date Calculation Logic (Using nepali-calendar-js) ---
function calculateAndScheduleNotifications() {
    console.log(`
[${moment().tz(NPT_TIMEZONE).format()}] Running daily check for upcoming holidays...`);

    let holidaysFound = 0;
    const today = moment.tz(NPT_TIMEZONE); // Use moment for today's AD date

    console.log(`Checking next 30 days from ${today.format('YYYY-MM-DD')} (NPT)...`);

    // Loop through the next 30 days starting from tomorrow
    for (let i = 1; i <= 30; i++) {
        const targetAdDateMoment = moment(today).add(i, 'days');
        const adYear = targetAdDateMoment.year();
        const adMonth = targetAdDateMoment.month() + 1; // moment months are 0-indexed
        const adDay = targetAdDateMoment.date();

        try {
            // Convert AD date to BS date using the library
            // Ensure this function exists and works as expected
            const bsDate = calendar.ad2bs(adYear, adMonth, adDay);
            if (!bsDate || !bsDate.bsYear || !bsDate.bsMonth || !bsDate.bsDay) {
                console.warn(`[${adYear}-${adMonth}-${adDay}] Failed to convert AD to BS.`);
                continue;
            }

            const bsYear = bsDate.bsYear;
            const bsMonth = bsDate.bsMonth; // Assuming 1-indexed from library
            const bsDay = bsDate.bsDay;
            const dateNpString = `${bsYear}-${String(bsMonth).padStart(2, '0')}-${String(bsDay).padStart(2, '0')}`;

            // --- Check Day of Week --- 
            // Use moment's day() method on the target AD date
            const dayOfWeek = targetAdDateMoment.day(); // 0 = Sunday, 6 = Saturday
            const isSaturday = dayOfWeek === 6;

            // --- Check for Holidays --- 
            // CRITICAL: Replace with actual function from nepali-calendar-js docs!
            // Example: const dayInfo = calendar.getDayInfo({ year: bsYear, month: bsMonth, day: bsDay });
            // Example: const dayEvents = calendar.getEvents(bsYear, bsMonth, bsDay);
            let dayInfo = null; // Placeholder
            try {
                 // Attempt to get day info - replace with actual library call
                 dayInfo = calendar.getDateInfo({ year: bsYear, month: bsMonth, day: bsDay }); // GUESSING function name/params
            } catch (libError) {
                 console.warn(`[${dateNpString}] Error calling library function (maybe getDateInfo) for date: ${libError.message}`);
                 dayInfo = null; // Ensure it's null on error
            }

            let holidayName = null;
            let isHoliday = false;

            // Check the result from the library - ADJUST PROPERTY NAMES BASED ON DOCS!
            if (dayInfo && dayInfo.isHoliday) { // GUESSING 'isHoliday' property
                 isHoliday = true;
                 holidayName = dayInfo.eventName || dayInfo.event || dayInfo.title || `Holiday`; // GUESSING event name property
            } else if (dayInfo && Array.isArray(dayInfo.events)) {
                // Alternative check if it returns an events array
                const holidayEvent = dayInfo.events.find(e => e && e.isHoliday); // GUESSING structure
                if (holidayEvent) {
                    isHoliday = true;
                    holidayName = holidayEvent.eventName || holidayEvent.event || holidayEvent.title || 'Holiday';
                }
            }
            // --- End Holiday Check --- 


            console.log(`[PROCESS_DAY ${dateNpString}] AD:${targetAdDateMoment.format('YYYY-MM-DD')} DayOfWeek:${dayOfWeek} isSaturday:${isSaturday} isHoliday:${isHoliday} holidayName:${holidayName || 'N/A'}`);

            if (isSaturday || isHoliday) {
                holidaysFound++;
                const effectiveHolidayName = holidayName || 'Saturday';
                const effectiveType = holidayName ? "Holiday" : "Saturday";

                // Use the moment object we already have for the target AD date
                const targetGregorianDate = targetAdDateMoment.clone().startOf('day'); // Clone to avoid modification

                console.log(`Found upcoming ${effectiveType}: ${effectiveHolidayName} on ${dateNpString} (Gregorian: ${targetGregorianDate.format('YYYY-MM-DD')})`);

                // Schedule notifications (using the targetGregorianDate directly)
                const twoDaysBeforeNpt = moment(targetGregorianDate).subtract(2, 'days').set({ hour: 20, minute: 0, second: 0, millisecond: 0 });
                const oneDayBeforeNpt = moment(targetGregorianDate).subtract(1, 'day').set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
                const sameDayNpt = moment(targetGregorianDate).set({ hour: 10, minute: 0, second: 0, millisecond: 0 });

                scheduleNotification(effectiveHolidayName, dateNpString, '2 days prior', twoDaysBeforeNpt.utc().format());
                scheduleNotification(effectiveHolidayName, dateNpString, '1 day prior', oneDayBeforeNpt.utc().format());
                scheduleNotification(effectiveHolidayName, dateNpString, 'Same day', sameDayNpt.utc().format());
            }

        } catch (error) {
            // Catch errors from ad2bs or other processing within the loop
            console.error(`Error processing AD date ${adYear}-${adMonth}-${adDay}:`, error);
        }
    }

    if (holidaysFound === 0) {
        console.log("No upcoming holidays or Saturdays found within the next 30 days requiring notification scheduling.");
    }
    console.log("Daily check finished.");
}

// --- Cron Job ---
console.log('Setting up cron job to run daily at 00:05 NPT (Asia/Kathmandu)...');
cron.schedule('5 0 * * *', () => {
    try {
        calculateAndScheduleNotifications();
    } catch (err) {
        console.error("FATAL ERROR in cron job execution:", err);
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