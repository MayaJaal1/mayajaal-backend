const admin = require('firebase-admin');
require('dotenv').config();

const serviceAccount = require('./serviceAccountKey.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.RTDB_URL || "https://mayajaal-app-default-rtdb.asia-southeast1.firebasedatabase.app"
  });
}

const db = admin.firestore();
const rtdb = admin.database();

console.log('🔄 Cross-bot Sync Bridge v2 started...');

// === 1. RTDB -> Firestore ===
rtdb.ref('users').on('child_changed', async (snapshot) => {
  const uid = snapshot.key;
  const data = snapshot.val();
  
  if (data && data.apiKey) {
    try {
      await db.collection('users').doc(uid).set({
        api_key: data.apiKey,
        is_logged_in: true,
        telegram_id: uid,
        gmail: data.gmail || null
      }, { merge: true });
      console.log(`✅ RTDB→Firestore synced for ${uid}`);
    } catch (e) {}
  } else if (data && data.apiKey === null) {
    try {
      await db.collection('users').doc(uid).set({
        api_key: null,
        is_logged_in: false
      }, { merge: true });
      console.log(`🚪 Logout synced for ${uid}`);
    } catch (e) {}
  }
});

// === 2. Firestore -> RTDB ===
db.collection('users').onSnapshot(async (snapshot) => {
  for (const change of snapshot.docChanges()) {
    const uid = change.doc.id;
    const data = change.doc.data();
    
    if (data.is_logged_in === true && data.api_key) {
      try {
        await rtdb.ref(`users/${uid}/apiKey`).set(data.api_key);
        await rtdb.ref(`users/${uid}/cross_bot_session`).set({
          api_key: data.api_key,
          is_logged_in: true,
          updated_at: Date.now(),
          gmail: data.gmail || data.email || null
        });
        console.log(`✅ Firestore→RTDB synced for ${uid} (${data.gmail || 'no gmail'})`);
      } catch (e) {}
    } else if (data.is_logged_in === false) {
      try {
        await rtdb.ref(`users/${uid}/apiKey`).remove();
        await rtdb.ref(`users/${uid}/cross_bot_session`).remove();
        console.log(`🚪 Logout synced for ${uid}`);
      } catch (e) {}
    }
  }
});

// === 3. Gmail fetch from website API (every 30s) ===
setInterval(async () => {
  try {
    const snap = await db.collection('users').where('is_logged_in', '==', true).get();
    for (const doc of snap.docs) {
      const uid = doc.id;
      const data = doc.data();
      if (!data.gmail && data.api_key) {
        try {
          const axios = require('axios');
          const res = await axios.get(`https://www.mayajaal.online/api/user-by-key?key=${data.api_key}`, { timeout: 5000 });
          if (res.data && res.data.email) {
            await db.collection('users').doc(uid).set({ gmail: res.data.email }, { merge: true });
            await rtdb.ref(`users/${uid}/cross_bot_session/gmail`).set(res.data.email);
            console.log(`📧 Gmail fetched for ${uid}: ${res.data.email}`);
          }
        } catch (e) {}
      }
    }
  } catch (e) {}
}, 30000);

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
