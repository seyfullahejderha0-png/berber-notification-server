const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ KONFIGURASYON (Environment variables öncelikli)
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID || "82106189-8f2b-43c0-ae33-7fff72838053";
const ONESIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY || "os_v2_app_qiigdcmpfnb4blrtp77xfa4akmcp6h53hozeey4phahgniz5gagl45d6dy5qnbxboftwotjnot6otd5xviemobftauicfibsycom2oy";

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Logger Middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

/* ================================
   🏥 HEALTH CHECK
   ================================ */
app.get("/health", (req, res) => {
  res.status(200).json({ status: "OK", timestamp: new Date() });
});

/* ================================
   🔵 TEST ENDPOINT
   ================================ */
app.get("/test", async (req, res) => {
  console.log("🧪 TEST notification triggered");

  try {
    const result = await axios.post(
      "https://onesignal.com/api/v1/notifications",
      {
        app_id: ONESIGNAL_APP_ID,
        include_external_user_ids: ["TEST_UID_BURAYA"], // TODO: Test ederken burayı güncelleyin
        headings: { en: "Test Bildirimi - Prod Check" },
        contents: { en: "Sistem çalışıyor! 🚀" },
        channel_for_external_user_ids: "push",
      },
      {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Basic ${ONESIGNAL_API_KEY}`
        }
      }
    );

    console.log("✅ TEST SUCCESS:", result.data);
    res.json({ ok: true, result: result.data });

  } catch (e) {
    console.error("❌ TEST ERROR:", e.response?.data || e.message);
    res.status(500).json(e.response?.data || { error: e.message });
  }
});

/* ================================
   🟢 GERÇEK BİLDİRİM ENDPOINT
   ================================ */
app.post('/send-notification', async (req, res) => {
  const { userId, title, message } = req.body;

  // Validation
  if (!userId || !title || !message) {
    console.warn("⚠️ Eksik veri ile istek yapıldı:", req.body);
    return res.status(400).json({ error: "Missing required fields: userId, title, message" });
  }

  console.log(`📤 Bildirim Gönderiliyor -> User: ${userId}, Title: ${title}`);

  try {
    const response = await axios.post(
      "https://onesignal.com/api/v1/notifications",
      {
        app_id: ONESIGNAL_APP_ID,
        include_external_user_ids: [userId],
        headings: { en: title },
        contents: { en: message },
        channel_for_external_user_ids: "push",
        // Android için ek ayarlar (ikon, renk vs eklenebilir)
        android_accent_color: "FF00FF00", // Örnek renk
      },
      {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Basic ${ONESIGNAL_API_KEY}`
        }
      }
    );

    console.log("✅ OneSignal Response:", response.data);
    res.json({ success: true, id: response.data.id });

  } catch (error) {
    console.error("❌ OneSignal ERROR:", error.response?.data || error.message);
    // Hata detayını güvenli şekilde dönüyoruz
    res.status(500).json({
      error: "Notification sending failed",
      details: error.response?.data || error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Notification Server running on port ${PORT}`);
  console.log(`ℹ️  OneSignal App ID: ${ONESIGNAL_APP_ID.substring(0, 8)}...`);
});
