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
  const now = new Date();

  // 1. SCHEDULE MISSING REMINDERS
  try {
    // Look for approved appointments in future that haven't been scheduled
    // Note: Firestore query limitations might require client-side filtering for date/time if stored as strings
    // We assume 'status' == 'approved' and 'reminderScheduled' != true
    const snapshot = await db.collection('appointments')
      .where('status', '==', 'approved')
      .where('reminderScheduled', '!=', true)
      .limit(50) // Process in batches
      .get();

    if (!snapshot.empty) {
      console.log(`[SCANNER] Found ${snapshot.size} approved appointments to check.`);
      const batch = db.batch();
      let updateCount = 0;

      for (const doc of snapshot.docs) {
        const data = doc.data();

        // Parse Date/Time
        if (!data.date || !data.time) continue;
        const apptDateStr = `${data.date}T${data.time}:00`;
        const apptDate = new Date(apptDateStr);

        if (isNaN(apptDate.getTime())) continue;

        // Only schedule if appointment is in the future (> 60 mins from now to be safe, or just future)
        const diffMs = apptDate.getTime() - now.getTime();
        const oneHourMs = 60 * 60 * 1000;

        // If appointment is more than 1 hour away, we schedule the reminder
        if (diffMs > oneHourMs) {
          const jobDate = new Date(apptDate.getTime() - oneHourMs);

          // Create Notification Job
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

          // Mark Appointment as Scheduled
          batch.update(doc.ref, { reminderScheduled: true });

          console.log(`[REMINDER_SCHEDULED] appointmentId: ${doc.id} scheduledFor: ${jobDate.toISOString()}`);
          updateCount++;
        } else if (diffMs > 0) {
          // Less than 1 hour away but approved? Maybe send immediate or skip?
          // Mark as 'skipped' so we don't re-query
          batch.update(doc.ref, { reminderScheduled: true });
          console.log(`[REMINDER_SKIPPED] Too close: ${doc.id}`);
          updateCount++;
        }
      }

      if (updateCount > 0) {
        await batch.commit();
        console.log(`[SCANNER] Scheduled reminders for ${updateCount} appointments.`);
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
    const appointmentDateTimeString = `${date}T${time}:00`;
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
