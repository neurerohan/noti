require('dotenv').config();
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const axios = require('axios');
const NepaliDate = require('nepali-date-converter');
const moment = require('moment-timezone');
const JSONStream = require('JSONStream');

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

// --- Date Calculation Logic (Refactored for Streaming) ---
function calculateAndScheduleNotifications() {
    console.log(`
[${moment().tz(NPT_TIMEZONE).format()}] Running daily check for upcoming holidays...`);

    const todayGregorian = moment().tz(NPT_TIMEZONE).startOf('day');
    const thirtyDaysLaterGregorian = moment(todayGregorian).add(30, 'days');
    let holidaysFound = 0;
    let entriesProcessed = 0;
    let dataChunksReceived = 0; // Counter for raw data chunks

    // --- Log comparison boundaries once --- 
    console.log(`Current Date (NPT): ${todayGregorian.format('YYYY-MM-DD HH:mm Z')}`);
    console.log(`Target Window End (NPT): ${thirtyDaysLaterGregorian.format('YYYY-MM-DD HH:mm Z')}`);
    console.log(`Checking for holidays/Saturdays within this window...`);

    // Create a file read stream
    const fileStream = fs.createReadStream(CALENDAR_FILE_PATH, { encoding: 'utf8' }); // Explicit encoding

    // Create a JSON stream parser
    // Try simplest selector '*' which emits the value for each top-level key (should be arrays)
    const jsonParser = JSONStream.parse('*');

    fileStream.pipe(jsonParser);

    // Handle errors on the file stream
    fileStream.on('error', (err) => {
        console.error("FATAL: Error reading calendar file stream:", err);
        // Note: Might need a way to signal completion/failure if cron job waits
    });

    // Handle errors on the JSON parser stream
    jsonParser.on('error', (err) => {
        console.error(`FATAL: Error parsing calendar JSON stream: ${err.message}`);
        if (!fileStream.destroyed) fileStream.destroy(); // Close the file stream on parse error
    });

    // Process each value emitted by the parser (should be month arrays)
    jsonParser.on('data', (dataChunk) => {
        dataChunksReceived++;
        console.log(`[Stream Chunk ${dataChunksReceived}] Received data of type: ${typeof dataChunk}`);
        // Ensure we received an array
        if (!Array.isArray(dataChunk)) {
            console.warn("[Stream Chunk ${dataChunksReceived}] Data chunk is not an array, skipping.");
            return;
        }

        // Iterate through day entries within the month's array
        dataChunk.forEach(dayEntry => {
            entriesProcessed++;
            // Basic validation of the incoming day object
            if (!dayEntry || typeof dayEntry !== 'object' || !dayEntry.bs_year || !dayEntry.bs_month || !dayEntry.bs_day || !dayEntry.events || !Array.isArray(dayEntry.events)) {
                // console.warn(`[Stream Data] Skipping malformed day entry:`, dayEntry); // Optional: Log malformed data
                return; // Skip malformed entries
            }

            const date_np = `${dayEntry.bs_year}-${String(dayEntry.bs_month).padStart(2, '0')}-${String(dayEntry.bs_day).padStart(2, '0')}`;

            // --- !!! CRITICAL ASSUMPTION AREA !!! ---
            // Verify these assumptions based on your specific '2082-calendar.json' structure.
            // Assumption 1: week_day === 6 means Saturday. (0=Sun? 1=Mon?)
            const isSaturday = dayEntry.week_day === 6;
            // Assumption 2: event.jds.gh === '1' indicates a relevant holiday.
            const holidayEvent = dayEntry.events.find(event => event && event.jds && event.jds.gh === '1');
            // --- !!! END CRITICAL ASSUMPTION AREA !!! ---

            // --->>> MORE DETAILED LOGGING (EVERY DAY) START
            // Reduce log frequency if it gets too noisy, e.g., log every 100th entry
            // if (entriesProcessed % 100 === 0) {
                console.log(`[PROCESS_DAY ${date_np}] week_day: ${dayEntry.week_day}, isSaturday: ${isSaturday}, holidayEventFound: ${!!holidayEvent}`);
            // }
            // --->>> MORE DETAILED LOGGING (EVERY DAY) END

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
                    const rawJsDate = nepaliDate.toJsDate(); // Get the raw JS Date
                    const holidayGregorianDate = moment(nepaliDate.toJsDate()).tz(NPT_TIMEZONE).startOf('day');

                    // --->>> DETAILED DATE LOGGING START
                    console.log(`[DEBUG ${date_np}] BS: ${date_np}, Type: ${effectiveType}, Name: ${holidayName}`);
                    console.log(`[DEBUG ${date_np}] Raw JS Date:   ${rawJsDate.toISOString()} (from nepali-date-converter)`);
                    console.log(`[DEBUG ${date_np}] Calculated AD: ${holidayGregorianDate.format('YYYY-MM-DD HH:mm Z')}`);
                    console.log(`[DEBUG ${date_np}] isAfterToday?  ${holidayGregorianDate.isAfter(todayGregorian)}`);
                    console.log(`[DEBUG ${date_np}] isBefore+30? ${holidayGregorianDate.isBefore(thirtyDaysLaterGregorian)}`);
                    // --->>> DETAILED DATE LOGGING END

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
        }); // End of dataChunk.forEach
    }); // End of jsonParser.on('data')

    // Log when the stream ends
    jsonParser.on('end', () => {
        console.log(`Finished processing calendar stream. Chunks received: ${dataChunksReceived}, Total day entries processed: ${entriesProcessed}.`);
        // Check entriesProcessed count here. If it's still 0, the '*.[]' selector also failed.
        if (entriesProcessed === 0) {
            console.warn("WARNING: JSONStream did not process any day entries. Check JSON structure and parser selector ('*'). Chunks received might indicate structure issues.");
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