// config.js
const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');

// ===== Firebase Admin Init (safe, idempotent) =====
if (!admin.apps.length) {
  try {
    const keyPath = path.join(__dirname, 'serviceAccountKey.json');
    let credential;

    // Option 1: JSON file exists
    if (fs.existsSync(keyPath)) {
      const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
      credential = admin.credential.cert(serviceAccount);
    }
    // Option 2: Env vars (FIREBASE_SERVICE_ACCOUNT as JSON string)
    else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      credential = admin.credential.cert(serviceAccount);
    }
    // Option 3: Application Default Credentials (GCP)
    else {
      credential = admin.credential.applicationDefault();
    }

    admin.initializeApp({
      credential,
      databaseURL: process.env.RTDB_URL
        || 'https://mayajaal-app-default-rtdb.asia-southeast1.firebasedatabase.app',
    });

    console.log('[CONFIG] Firebase Admin initialized');
  } catch (e) {
    console.error('[CONFIG] Firebase init failed:', e.message);
  }
}

// ===== Get RTDB (safe accessor) =====
function getDB() {
  try {
    return admin.database();
  } catch (e) {
    return null;
  }
}

// ===== Cache =====
let cachedConfig = null;
let lastFetch = 0;
const CACHE_MS = 10 * 1000; // 10 seconds

// ===== Default fallback (so bot never hangs) =====
const DEFAULT_CONFIG = {
  api_connected: true,                      // ← allow bot to start
  api_base: process.env.CENTRAL_API_BASE
    || (process.env.CUSTOM_DOMAIN ? `https://${process.env.CUSTOM_DOMAIN}` : 'https://mayajaal.online'),
  maintenance: false,
  min_version: '1.0.0',
  message: '',
};

// ===== Main function =====
async function getCentralConfig(force = false) {
  // 1. Return cached if fresh
  if (!force && cachedConfig && Date.now() - lastFetch < CACHE_MS) {
    return cachedConfig;
  }

  // 2. If Firebase unavailable → return default (bot still starts)
  const db = getDB();
  if (!db) {
    console.warn('[CONFIG] Firebase DB unavailable, using default config');
    cachedConfig = DEFAULT_CONFIG;
    lastFetch = Date.now();
    return cachedConfig;
  }

  try {
    // 3. Fetch from RTDB
    const snapshot = await Promise.race([
      db.ref('bot_config/main').once('value'),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Firebase fetch timeout (8s)')), 8000)
      ),
    ]);

    const data = snapshot.val();

    // 4. If no config in DB → use default (NOT null! so bot starts)
    if (!data) {
      console.warn('[CONFIG] bot_config/main not found — using default config');
      cachedConfig = { ...DEFAULT_CONFIG };
      lastFetch = Date.now();
      return cachedConfig;
    }

    // 5. Merge with defaults (so missing fields don't break bot)
    cachedConfig = {
      ...DEFAULT_CONFIG,
      ...data,
    };
    lastFetch = Date.now();
    console.log('[CONFIG] Loaded from Firebase:', {
      api_connected: cachedConfig.api_connected,
      api_base: cachedConfig.api_base,
      maintenance: cachedConfig.maintenance,
    });
    return cachedConfig;

  } catch (e) {
    console.error('[CONFIG] Fetch failed:', e.message);

    // 6. If error, return cached (if any) OR default
    if (cachedConfig) return cachedConfig;
    cachedConfig = DEFAULT_CONFIG;
    lastFetch = Date.now();
    return cachedConfig;
  }
}

module.exports = { getCentralConfig, DEFAULT_CONFIG };
