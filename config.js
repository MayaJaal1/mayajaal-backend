const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json'); 

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    // Tumhari .env file me RTDB_URL pehle se hai, wahi use kar rahe hain
    databaseURL: process.env.RTDB_URL || "https://mayajaal-app-default-rtdb.firebaseio.com/"
  });
}

// ⚠️ Yahan Firestore ki jagah Realtime
 Database use ho raha hai
const db = admin.database(); 

let cachedConfig = null;
let lastFetch = 0;

async function getCentralConfig(force = false) {
  if (!force && cachedConfig && Date.now() - lastFetch < 10000) {
    return cachedConfig;
  }

  try {
    // Realtime Database me data fetch karne ka tarika
    const snapshot = await db.ref('bot_config/main').once('value');
    const data = snapshot.val();

    if (!data) {
      console.warn('[CONFIG] Firebase me bot_config/main nahi mila!');
      return cachedConfig;
    }

    cachedConfig = data;
    lastFetch = Date.now();
    return cachedConfig;

  } catch (e) {
    console.error('[CONFIG] Fetch failed:', e.message);
    return cachedConfig;
  }
}

module.exports = { getCentralConfig };
