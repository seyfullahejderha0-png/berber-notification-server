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

// 🔒 STRICT SECURITY CHECKS
if (!ONESIGNAL_APP_ID) {
  console.error("❌ CRITICAL ERROR: ONESIGNAL_APP_ID environment variable is missing.");
  process.exit(1);
}

if (!ONESIGNAL_REST_API_KEY) {
  console.error("❌ CRITICAL ERROR: ONESIGNAL_REST_API_KEY environment variable is missing.");
  process.exit(1);
}

// ✅ FIREBASE ADMIN INIT (SERVICE ACCOUNT)
// Not: Render environment variable 'FIREBASE_SERVICE_ACCOUNT' içinde JSON string olarak saklanmalı
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("🔥 Firebase Admin Initialized with Env Var");
  } catch (e) {
    console.error("❌ Firebase Env Var Parse Error:", e);
  }
} else {
  // Local development fallback
  try {
    const serviceAccount = require('./serviceAccountKey.json');
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("🔥 Firebase Admin Initialized with File");
  } catch (e) {
    console.warn("⚠️ Firebase credentials not found. Scheduler will not work without DB access.");
  }
}

const db = admin.firestore();
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
  res.status(200).json({ status: "ok", service: "notification-server", url: SERVER_URL });
});

/* ================================
   📅 SCHEDULER (CRON)
   Her dakika çalışır, zamanı gelen bildirimleri gönderir.
================================ */
cron.schedule('* * * * *', async () => {
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
   📮 ENDPOINTS
================================ */

// 1. Manuel / Anlık Bildirim
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
  const { userId, appointmentId, date, time } = req.body; // date: "2024-01-20", time: "14:30"

  if (!userId || !appointmentId || !date || !time) {
    return res.status(400).json({ error: "Missing fields" });
  }

  try {
    // Parse date time
    // Note: Basit string parsing yapiyoruz, timezone'a dikkat etmek gerekir.
    // Varsayim: Server ve App ayni timezone (TR saati) veya UTC isliyor.
    // Daha saglam olmasi icin ISO string gonderilmesi onerilir ama mevcut yapiyi bozmuyoruz.

    const appointmentDateTimeString = `${date}T${time}:00`; // "2024-01-20T14:30:00"
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
});
