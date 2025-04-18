require('dotenv').config();
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const axios = require('axios');
const moment = require('moment-timezone');
const JSONStream = require('JSONStream');
const adbs = require('ad-bs-converter');

const ONE_SIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY;
const ONE_SIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const CALENDAR_FILE_PATH = path.join(__dirname, 'data', '2082-calendar.json');
const NPT_TIMEZONE = 'Asia/Kathmandu'; // UTC+5:45
const AXIOS_TIMEOUT = 15000; // Reset timeout if desired

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

// --- Date Calculation Logic (Streaming local file + ad-bs-converter) ---
function calculateAndScheduleNotifications() {
    console.log(`
[${moment().tz(NPT_TIMEZONE).format()}] Running daily check for upcoming holidays...`);

    const todayGregorian = moment().tz(NPT_TIMEZONE).startOf('day');
    const thirtyDaysLaterGregorian = moment(todayGregorian).add(30, 'days');
    let holidaysFound = 0;
    let entriesProcessed = 0;
    let dataChunksReceived = 0;

    console.log(`Current Date (NPT): ${todayGregorian.format('YYYY-MM-DD HH:mm Z')}`);
    console.log(`Target Window End (NPT): ${thirtyDaysLaterGregorian.format('YYYY-MM-DD HH:mm Z')}`);
    console.log(`Checking for holidays/Saturdays within this window from local file...`);

    const fileStream = fs.createReadStream(CALENDAR_FILE_PATH, { encoding: 'utf8' });
    const jsonParser = JSONStream.parse('*.[]'); // Use the selector that worked before for getting month arrays

    fileStream.pipe(jsonParser);

    fileStream.on('error', (err) => {
        console.error("FATAL: Error reading calendar file stream:", err);
    });

    jsonParser.on('error', (err) => {
        console.error(`FATAL: Error parsing calendar JSON stream: ${err.message}`);
        if (!fileStream.destroyed) fileStream.destroy();
    });

    jsonParser.on('data', (monthArray) => {
        dataChunksReceived++;
        // console.log(`[Stream Chunk ${dataChunksReceived}] Received data of type: ${typeof monthArray}`);
        if (!Array.isArray(monthArray)) {
            console.warn(`[Stream Chunk ${dataChunksReceived}] Data chunk is not an array, skipping.`);
            return;
        }

        monthArray.forEach(dayEntry => {
            entriesProcessed++;
            if (!dayEntry || typeof dayEntry !== 'object' || !dayEntry.bs_year || !dayEntry.bs_month || !dayEntry.bs_day || !dayEntry.events || !Array.isArray(dayEntry.events) || typeof dayEntry.week_day === 'undefined') {
                 return;
            }

            const date_np_str = `${dayEntry.bs_year}-${String(dayEntry.bs_month).padStart(2, '0')}-${String(dayEntry.bs_day).padStart(2, '0')}`;
            const bsYear = parseInt(dayEntry.bs_year, 10);
            const bsMonth = parseInt(dayEntry.bs_month, 10);
            const bsDay = parseInt(dayEntry.bs_day, 10);

            // --- Saturday/Holiday Identification (from JSON) --- 
            const weekDayValue = dayEntry.week_day;
            const isSaturday = weekDayValue === 6;
            let holidayEventFound = null;
            let foundGhValue = 'N/A';
            let foundGhType = 'N/A';

            for (const event of dayEntry.events) {
                 if (event && event.jds && typeof event.jds.gh !== 'undefined') {
                     foundGhValue = event.jds.gh;
                     foundGhType = typeof foundGhValue;
                     if (String(foundGhValue) === '1') {
                        holidayEventFound = event;
                        break;
                     }
                 }
             }
             const isHoliday = !!holidayEventFound;

            // Log processing for every day
            console.log(`[PROCESS_DAY ${date_np_str}] week_day: ${weekDayValue} (type: ${typeof weekDayValue}), ghValue: ${foundGhValue} (type: ${foundGhType}), isSaturday: ${isSaturday}, isHoliday: ${isHoliday}`);

            if (isSaturday || isHoliday) {
                const holidayName = holidayEventFound ? (holidayEventFound.jds?.ne || holidayEventFound.jds?.en || holidayEventFound.jtl || `Holiday on ${date_np_str}`) : 'Saturday';
                const effectiveType = holidayEventFound ? "Holiday" : "Saturday";

                try {
                    // --- Convert BS to AD using ad-bs-converter --- 
                    if (isNaN(bsYear) || isNaN(bsMonth) || isNaN(bsDay)){
                         console.error(`[${date_np_str}] Invalid BS date components for conversion: ${dayEntry.bs_year}, ${dayEntry.bs_month}, ${dayEntry.bs_day}`);
                         return; // Skip if parts aren't numbers
                    }
                    const convertedAD = adbs.bs2ad(bsYear, bsMonth, bsDay);
                    if (!convertedAD || !convertedAD.year || !convertedAD.month || !convertedAD.day) {
                        console.error(`[${date_np_str}] Failed to convert BS to AD. BS: ${bsYear}-${bsMonth}-${bsDay}`);
                        return; // Skip if conversion fails
                    }

                    // Create moment object from converted AD date for comparison
                    const holidayGregorianDate = moment.tz({
                        year: convertedAD.year,
                        month: convertedAD.month - 1, // ad-bs-converter month is 1-based, moment is 0-based
                        day: convertedAD.day
                    }, NPT_TIMEZONE).startOf('day');
                    // --- End Conversion ---

                    console.log(`[DATE_CONV ${date_np_str}] AD Result: ${convertedAD.year}-${convertedAD.month}-${convertedAD.day}`);
                    console.log(`[DATE_CONV ${date_np_str}] Final Gregorian Moment (NPT): ${holidayGregorianDate.format('YYYY-MM-DD HH:mm:ss Z')}`);
                    console.log(`[DATE_COMPARE ${date_np_str}] Vs Today (${todayGregorian.format('YYYY-MM-DD Z')}): isAfter? ${holidayGregorianDate.isAfter(todayGregorian)}`);
                    console.log(`[DATE_COMPARE ${date_np_str}] Vs +30 (${thirtyDaysLaterGregorian.format('YYYY-MM-DD Z')}): isBefore? ${holidayGregorianDate.isBefore(thirtyDaysLaterGregorian)}`);

                    if (!holidayGregorianDate.isValid()) {
                        console.error(`[${date_np_str}] Gregorian date moment object is invalid.`);
                        return;
                    }

                    if (holidayGregorianDate.isAfter(todayGregorian) && holidayGregorianDate.isBefore(thirtyDaysLaterGregorian)) {
                        holidaysFound++;
                        console.log(`Found upcoming ${effectiveType}: ${holidayName} on ${date_np_str} (Gregorian: ${holidayGregorianDate.format('YYYY-MM-DD')})`);

                        const twoDaysBeforeNpt = moment(holidayGregorianDate).subtract(2, 'days').set({ hour: 20, minute: 0, second: 0, millisecond: 0 });
                        const oneDayBeforeNpt = moment(holidayGregorianDate).subtract(1, 'day').set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
                        const sameDayNpt = moment(holidayGregorianDate).set({ hour: 10, minute: 0, second: 0, millisecond: 0 });

                        scheduleNotification(holidayName, date_np_str, '2 days prior', twoDaysBeforeNpt.utc().format());
                        scheduleNotification(holidayName, date_np_str, '1 day prior', oneDayBeforeNpt.utc().format());
                        scheduleNotification(holidayName, date_np_str, 'Same day', sameDayNpt.utc().format());
                    }
                } catch (error) {
                    console.error(`[${date_np_str}] Error during date conversion or scheduling for ${holidayName}:`, error);
                }
            }
        }); // End of monthArray.forEach
    }); // End of jsonParser.on('data')

    jsonParser.on('end', () => {
        console.log(`Finished processing calendar stream. Chunks received: ${dataChunksReceived}, Total day entries processed: ${entriesProcessed}.`);
        if (entriesProcessed === 0) {
             console.warn("WARNING: JSONStream did not process any day entries. Check JSON structure and parser selector ('*.[]').");
        }
        else if (holidaysFound === 0) {
            console.log("No upcoming holidays or Saturdays found within the next 30 days requiring notification scheduling.");
        } else {
            console.log(`Finished checking. Found and processed ${holidaysFound} relevant dates.`);
        }
        console.log("Daily check finished.");
    });
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

// --- Initial Run (Now synchronous again as file streaming is event-based) ---
console.log('Performing initial run on startup...');
try {
    calculateAndScheduleNotifications(); // No longer needs await
} catch (err) {
    console.error("FATAL ERROR during initial run:", err);
}

console.log(`Notification scheduler started. Waiting for cron trigger at 00:05 NPT...`); 