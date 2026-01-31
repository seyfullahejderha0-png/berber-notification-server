const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const cron = require('node-cron');
const admin = require('firebase-admin');

// ✅ ENVIRONMENT VARIABLES & SECURITY CHECK
const PORT = process.env.PORT || 3000;
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY;
const SERVER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

// 🔒 STRICT SECURITY CHECKS (OneSignal is mandatory)
if (!ONESIGNAL_APP_ID) {
  console.error("❌ CRITICAL ERROR: ONESIGNAL_APP_ID environment variable is missing.");
  process.exit(1);
}

if (!ONESIGNAL_REST_API_KEY) {
  console.error("❌ CRITICAL ERROR: ONESIGNAL_REST_API_KEY environment variable is missing.");
  process.exit(1);
}

// ✅ FIREBASE ADMIN INIT (SAFE & OPTIONAL)
let db = null; // Default to null, only set if init succeeds

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore();
    console.log("🔥 Firebase Admin Initialized with Env Var");
  } catch (e) {
    console.error("❌ Firebase Env Var Parse Error:", e.message);
    console.warn("⚠️ Server starting WITHOUT Firebase. DB features will be disabled.");
  }
} else {
  // Local development fallback
  try {
    const serviceAccount = require('./serviceAccountKey.json');
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore();
    console.log("🔥 Firebase Admin Initialized with File");
  } catch (e) {
    console.warn("⚠️ Firebase credentials not found. Server starting WITHOUT Firebase. DB features will be disabled.");
  }
}

const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Logger
app.use((req, res, next) => {
  console.log(`[SERVER] ${req.method} ${req.url}`);
  next();
});

/* ================================
   🏥 HEALTH CHECK
================================ */
app.get('/health', (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "notification-server",
    url: SERVER_URL,
    firebase: db ? "connected" : "disconnected"
  });
});

/* ================================
   📅 SCHEDULER (CRON)
   Her dakika çalışır, zamanı gelen bildirimleri gönderir.
================================ */
cron.schedule('* * * * *', async () => {
  // 🔒 DB CHECK
  if (!db) {
    console.warn("[SCHEDULE] Skipping cron job: Firebase DB not initialized.");
    return;
  }

  console.log("[SCHEDULE] Checking for pending notifications...");

  const now = admin.firestore.Timestamp.now();

  try {
    const snapshot = await db.collection('notification_jobs')
      .where('status', '==', 'pending')
      .where('scheduledAt', '<=', now)
      .get();

    if (snapshot.empty) return;

    console.log(`[SCHEDULE] Found ${snapshot.size} pending jobs.`);

    const batch = db.batch();

    for (const doc of snapshot.docs) {
      const job = doc.data();
      console.log(`[SCHEDULE] Processing Job: ${doc.id} -> User: ${job.userId}`);

      // Send via OneSignal
      sendOneSignal(job.userId, job.title, job.message);

      // Mark as sent
      batch.update(doc.ref, { status: 'sent', sentAt: now });
    }

    await batch.commit();
    console.log("[SCHEDULE] Batch update completed.");

  } catch (error) {
    console.error("[SCHEDULE] Error processing jobs:", error);
  }
});

/* ================================
   🔍 APPOINTMENT SCANNER (CRON)
   Verifies 1-Hour Reminders & Confirmations are scheduled/sent.
   Runs every 5 minutes.
================================ */
cron.schedule('*/5 * * * *', async () => {
  console.log("[SCANNER] Starting appointment health check...");

  // 🛑 DB SAFETY CHECK
  if (!db) {
    console.warn("[SCANNER] Skipping check: Database not connected.");
    return;
  }

  const now = new Date();

  // 1. SCHEDULE MISSING REMINDERS
  try {
    // Look for approved appointments in future that haven't been scheduled
    // Note: Firestore query limitations might require client-side filtering for date/time if stored as strings
    // We assume 'status' == 'approved' and 'reminderScheduled' != true
    // Generate Unpadded Date Strings (YYYY-M-D) for Today and Tomorrow
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const todayStr = `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}`;
    const tomorrowStr = `${tomorrow.getFullYear()}-${tomorrow.getMonth() + 1}-${tomorrow.getDate()}`;

    // Query both days to cover late-night/early-morning edge cases
    const todaySnapshot = await db.collection('appointments')
      .where('status', '==', 'approved')
      .where('date', '==', todayStr)
      .get();

    const tomorrowSnapshot = await db.collection('appointments')
      .where('status', '==', 'approved')
      .where('date', '==', tomorrowStr)
      .get();

    const allDocs = [...todaySnapshot.docs, ...tomorrowSnapshot.docs];

    if (allDocs.length > 0) {
      console.log(`[SCANNER] Found ${allDocs.length} approved appointments for Today/Tomorrow.`);
      const batch = db.batch();
      let updateCount = 0;

      for (const doc of allDocs) {
        const data = doc.data();

        // 🛑 MEMORY CHECK: Skip if already scheduled
        if (data.reminderScheduled === true) continue;

        // SKIP if old appointment (double check time logic below handles this)

        // Parse Date/Time (Assuming UTC+3 for Turkey)
        if (!data.date || !data.time) continue;

        // FIX: Pad date parts (YYYY-M-D -> YYYY-MM-DD) for JS Date compatibility
        const [sYear, sMonth, sDay] = data.date.split('-');
        const paddedDate = `${sYear}-${sMonth.padStart(2, '0')}-${sDay.padStart(2, '0')}`;

        const apptDateStr = `${paddedDate}T${data.time}:00+03:00`;
        const apptDate = new Date(apptDateStr);

        if (isNaN(apptDate.getTime())) continue;

        const diffMs = apptDate.getTime() - now.getTime();
        const oneHourMs = 60 * 60 * 1000;
        const thirtyMinMs = 30 * 60 * 1000;

        let jobsCreated = 0;

        // RULE 1: Schedule 1-Hour Reminder if > 60 mins away
        if (diffMs > oneHourMs) {
          const jobDate = new Date(apptDate.getTime() - oneHourMs);
          const jobRef = db.collection('notification_jobs').doc();
          batch.set(jobRef, {
            appointmentId: doc.id,
            userId: data.customerId,
            title: "⏰ Randevun 1 Saat Sonra",
            message: "Hazırlanmayı unutma, randevuna 1 saat kaldı.",
            scheduledAt: admin.firestore.Timestamp.fromDate(jobDate),
            status: 'pending',
            createdAt: admin.firestore.Timestamp.now()
          });
          jobsCreated++;
        }

        // RULE 2: Schedule 30-Min Reminder if > 30 mins away
        // (Even if we missed the 1-hour mark, we still want this if possible)
        if (diffMs > thirtyMinMs) {
          const jobDate2 = new Date(apptDate.getTime() - thirtyMinMs);

          // Only schedule distinct job if it's in the future
          // The diff check guarantees it's > 30 mins from NOW, so the trigger time (Target - 30m) is in the future.
          const jobRef2 = db.collection('notification_jobs').doc();
          batch.set(jobRef2, {
            appointmentId: doc.id,
            userId: data.customerId,
            title: "✂️ Randevun Yaklaşıyor",
            message: "Randevuna 30 dakika kaldı!",
            scheduledAt: admin.firestore.Timestamp.fromDate(jobDate2),
            status: 'pending',
            createdAt: admin.firestore.Timestamp.now()
          });
          jobsCreated++;
        }

        // Always mark as scheduled so we don't process this doc again
        // (If < 30 mins, we missed the window for scheduled jobs. Strict scanner might catch 1h logic, but 30m is lost. This is expected behavior for very late bookings)
        batch.update(doc.ref, { reminderScheduled: true });

        if (jobsCreated > 0) {
          console.log(`[REMINDER_SCHEDULED] appointmentId: ${doc.id} jobs: ${jobsCreated}`);
          updateCount++;
        } else {
          console.log(`[REMINDER_SKIPPED] Too close for scheduled jobs: ${doc.id}`);
          // We still count this as an update to clear the pending state
          updateCount++;
        }
      }

      if (updateCount > 0) {
        await batch.commit();
        console.log(`[SCANNER] Processed reminders for ${updateCount} appointments.`);
      }
    }
  } catch (e) {
    console.error("[SCANNER] Error in Reminder Check:", e);
  }

  // 2. CHECK CUSTOMER CONFIRMATION NOTIFICATIONS
  try {
    const confirmSnapshot = await db.collection('appointments')
      .where('customerConfirmed', '==', true)
      .where('barberNotified', '!=', true)
      .limit(20)
      .get();

    if (!confirmSnapshot.empty) {
      const batch = db.batch();

      for (const doc of confirmSnapshot.docs) {
        const data = doc.data();
        if (!data.barberId) continue;

        // Send Immediate Notification to Barber
        await sendOneSignal(
          data.barberId,
          "Müşteri Geliyor ✅",
          `${data.customerName || 'Müşteri'}, ${data.appointmentTime || data.time} randevusuna geleceğini onayladı.`
        );

        batch.update(doc.ref, { barberNotified: true });
        console.log(`[CONFIRMATION_SENT] To Barber: ${data.barberId} For: ${doc.id}`);
      }
      await batch.commit();
    }
  } catch (e) {
    console.error("[SCANNER] Error in Confirmation Check:", e);
  }
});

/* ================================
   ⚡ STRICT 1-HOUR REMINDER (DIRECT SEND)
   Bypasses job queue. Runs every 1 minute.
   Authority: Server-Side Time Check
================================ */
cron.schedule('*/1 * * * *', async () => {
  // 1. Log Scan Start
  // Note: We don't have the exact count yet, but we'll log it after query
  if (!db) return; // Skip if no DB

  const now = new Date();

  try {
    // Generate Unpadded Date String (YYYY-M-D)
    // Format: 2026-1-31 (No leading zeros for month/day based on user data)
    const dateStr = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;

    // Query ONLY today's approved appointments
    // We remove .where('oneHourReminderSent', '!=', true) to find docs where field is missing
    const snapshot = await db.collection('appointments')
      .where('status', '==', 'approved')
      .where('date', '==', dateStr)
      .get();

    if (snapshot.empty) {
      console.log(`[REMINDER_SCAN] checked: 0 eligible: 0 (Date: ${dateStr})`);
      return;
    }

    let sentCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    const batch = db.batch();
    let batchCommitNeeded = false;

    console.log(`[REMINDER_SCAN] checked: ${snapshot.size} eligible: ? (calculating)`);

    for (const doc of snapshot.docs) {
      const data = doc.data();
      const appointmentId = doc.id;

      // 1. Re-Verify status (paranoid check)
      if (data.status !== 'approved') {
        skippedCount++;
        continue;
      }

      // 🛑 IN-MEMORY CHECK: Skip if already sent
      if (data.oneHourReminderSent === true) {
        // console.log(`[REMINDER_SKIPPED] already sent: ${appointmentId}`); // Too noisy
        continue;
      }

      // 2. Parse Time
      if (!data.date || !data.time) {
        console.log(`[REMINDER_SKIPPED] appointmentId: ${appointmentId} reason: invalid_date_time`);
        skippedCount++;
        continue;
      }

      // FIX: Pad date parts
      const [sYear, sMonth, sDay] = data.date.split('-');
      const paddedDate = `${sYear}-${sMonth.padStart(2, '0')}-${sDay.padStart(2, '0')}`;

      const apptDateStr = `${paddedDate}T${data.time}:00+03:00`; // "2024-01-25T14:30:00+03:00"
      const apptDate = new Date(apptDateStr);

      if (isNaN(apptDate.getTime())) {
        console.log(`[REMINDER_SKIPPED] appointmentId: ${appointmentId} reason: invalid_date_parse`);
        skippedCount++;
        continue;
      }

      // 3. Time Logic
      // Rule: appointmentTime - now <= 60 minutes AND > 0
      const diffMs = apptDate.getTime() - now.getTime();
      const diffMinutes = diffMs / (1000 * 60);

      const isWithin1Hour = diffMinutes <= 60 && diffMinutes > 0;

      if (!isWithin1Hour) {
        console.log(`[REMINDER_SKIPPED] appointmentId: ${appointmentId} reason: time_not_in_range (${diffMinutes.toFixed(1)} min left)`);
        skippedCount++;
        continue;
      }

      // 4. Send Notification (DIRECTLY)
      // "Randevunuza 1 saat kaldı. Geliyor musunuz?"
      try {
        const success = await sendOneSignal(
          data.customerId,
          "Randevunuza 1 saat kaldı ⏳",
          "Geliyor musunuz?"
        );

        if (success) {
          // 5. Update Firestore Flag (oneHourReminderSent: true)
          batch.update(doc.ref, { oneHourReminderSent: true });
          batchCommitNeeded = true;
          sentCount++;

          console.log(`[REMINDER_SENT] appointmentId: ${appointmentId} customerId: ${data.customerId} appointmentTime: ${apptDateStr}`);
        } else {
          // Failed to send via OneSignal
          console.error(`[REMINDER_FAILED] appointmentId: ${appointmentId} error: OneSignal API failed`);
          failedCount++;
        }

      } catch (err) {
        console.error(`[REMINDER_FAILED] appointmentId: ${appointmentId} error: ${err.message}`);
        failedCount++;
      }
    }

    // 6. Commit Batch
    if (batchCommitNeeded) {
      await batch.commit();
      console.log(`[REMINDER_BATCH_COMMIT] Updated ${sentCount} appointments.`);
    }

    // Final Summary (Optional but helpful)
    console.log(`[REMINDER_CYCLE_DONE] sent: ${sentCount} skipped: ${skippedCount} failed: ${failedCount}`);

  } catch (error) {
    console.error(`[REMINDER_SCAN_ERROR] ${error.message}`);
  }
});

/* ================================
   📮 ENDPOINTS
================================ */

// 1. Manuel / Anlık Bildirim (DB Bağlantısı gerekmez)
app.post('/send-notification', async (req, res) => {
  const { userId, title, message } = req.body;

  if (!userId || !title || !message) {
    console.warn("[ERROR] Missing fields in /send-notification");
    return res.status(400).json({ error: "Missing required fields" });
  }

  const success = await sendOneSignal(userId, title, message);
  if (success) {
    res.json({ success: true });
  } else {
    res.status(500).json({ error: "Failed to send notification" });
  }
});

// 2. Planlı Bildirim (Randevu Alınca Çağrılır)
app.post('/schedule-notification', async (req, res) => {
  // 🔒 DB CHECK
  if (!db) {
    console.error("[ERROR] Cannot schedule notification: Firebase DB not initialized.");
    return res.status(503).json({ error: "Service unavailable: Database not connected" });
  }

  const { userId, appointmentId, date, time } = req.body; // date: "2024-01-20", time: "14:30"

  if (!userId || !appointmentId || !date || !time) {
    return res.status(400).json({ error: "Missing fields" });
  }

  try {
    // FIX: Pad date parts
    const [sYear, sMonth, sDay] = date.split('-');
    const paddedDate = `${sYear}-${sMonth.padStart(2, '0')}-${sDay.padStart(2, '0')}`;

    const appointmentDateTimeString = `${paddedDate}T${time}:00+03:00`;
    const appointmentDate = new Date(appointmentDateTimeString);

    if (isNaN(appointmentDate.getTime())) {
      return res.status(400).json({ error: "Invalid date format" });
    }

    // Job 1: 1 Saat Önce
    const job1Date = new Date(appointmentDate.getTime() - 60 * 60 * 1000);

    // Job 2: 30 Dakika Önce
    const job2Date = new Date(appointmentDate.getTime() - 30 * 60 * 1000);

    const batch = db.batch();

    // 1 Saat Kala
    const ref1 = db.collection('notification_jobs').doc();
    batch.set(ref1, {
      appointmentId,
      userId,
      title: "⏰ Randevun 1 Saat Sonra",
      message: "Hazırlanmayı unutma, randevuna 1 saat kaldı.",
      scheduledAt: admin.firestore.Timestamp.fromDate(job1Date),
      status: 'pending',
      createdAt: admin.firestore.Timestamp.now()
    });

    // 30 Dk Kala
    const ref2 = db.collection('notification_jobs').doc();
    batch.set(ref2, {
      appointmentId,
      userId,
      title: "✂️ Randevun Yaklaşıyor",
      message: "Randevuna 30 dakika kaldı!",
      scheduledAt: admin.firestore.Timestamp.fromDate(job2Date),
      status: 'pending',
      createdAt: admin.firestore.Timestamp.now()
    });

    await batch.commit();

    console.log(`[SCHEDULE] Created jobs for appointment ${appointmentId}`);
    res.json({ success: true, message: "Notifications scheduled" });

  } catch (error) {
    console.error("[ERROR] Scheduling failed:", error);
    res.status(500).json({ error: error.message });
  }
});

// HELPER: OneSignal Sender
async function sendOneSignal(userId, title, message) {
  console.log(`[NOTIFY] Sending -> ${userId}: ${title}`);
  try {
    await axios.post(
      "https://onesignal.com/api/v1/notifications",
      {
        app_id: ONESIGNAL_APP_ID,
        include_external_user_ids: [userId],
        headings: { en: title },
        contents: { en: message },
        channel_for_external_user_ids: "push",
        android_accent_color: "FF000000"
      },
      {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Basic ${ONESIGNAL_REST_API_KEY}`
        }
      }
    );
    return true;
  } catch (e) {
    console.error("[ERROR] OneSignal Failed:", e.response?.data || e.message);
    return false;
  }
}

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌍 Server URL: ${SERVER_URL}`);
  if (!db) console.log("⚠️ WARNING: Server running in NO-DATABASE mode.");
});
