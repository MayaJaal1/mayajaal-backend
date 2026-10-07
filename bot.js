require('dotenv').config();
const express = require('express');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { CallbackQuery } = require('telegram/events/CallbackQuery');
const { Readable } = require('stream');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const { Redis } = require('@upstash/redis');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { getCentralConfig } = require('./config');

process.on('uncaughtException', (e) => console.error('[Uncaught]', e.stack || e.message));
process.on('unhandledRejection', (e) => console.error('[Unhandled]', e?.stack || e));

const TOKEN = (process.env.BOT_TOKEN || '').trim();
const API_ID = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
const API_HASH = (process.env.TELEGRAM_API_HASH || '').trim();
const BASE_URL = process.env.CUSTOM_DOMAIN
  ? (process.env.CUSTOM_DOMAIN.startsWith('http') ? process.env.CUSTOM_DOMAIN : `https://${process.env.CUSTOM_DOMAIN}`)
  : 'https://mayajaal.online';
const R2_ACCOUNT_ID = (process.env.R2_ACCOUNT_ID || '').trim();
const R2_ACCESS_KEY_ID = (process.env.R2_ACCESS_KEY_ID || '').trim();
const R2_SECRET_ACCESS_KEY = (process.env.R2_SECRET_ACCESS_KEY || '').trim();
const R2_BUCKET_NAME = (process.env.R2_BUCKET_NAME || '').trim();
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || '2147483648', 10);
const PORT = parseInt(process.env.PORT || '8080', 10);
const VIDEO_SECRET = (process.env.VIDEO_SECRET || '').trim();
const APP_NAME = process.env.APP_NAME || 'MayaJaal';
const APP_UA_KEYWORD = (process.env.APP_UA_KEYWORD || 'MayaJaalApp').trim();

console.log('=== ENV ===');
console.log('BOT_TOKEN:', !!TOKEN, '| API_ID:', !!API_ID, '| API_HASH:', !!API_HASH);
console.log('R2:', !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET_NAME));
console.log('VIDEO_SECRET:', VIDEO_SECRET.length >= 20 ? 'OK' : 'MISSING/WEAK!');

if (!TOKEN || !API_ID || !API_HASH) throw new Error('Missing BOT_TOKEN / API_ID / API_HASH');
if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) throw new Error('Missing R2 config');
if (VIDEO_SECRET.length < 20) throw new Error('VIDEO_SECRET missing or too weak');

let redis;
try { redis = Redis.fromEnv(); console.log('Redis connected'); }
catch (e) { console.log('Redis not available'); redis = { get: async () => null, set: async () => null, del: async () => null }; }

const memStore = new Map();

async function saveMeta(id, payload) {
  memStore.set(id, payload);
  try { await redis.set(`v:${id}`, JSON.stringify(payload), { ex: 30 * 86400 }); } catch (e) { }
}
async function getMeta(id) {
  if (memStore.has(id)) return memStore.get(id);
  try {
    const raw = await redis.get(`v:${id}`);
    if (raw) { const d = typeof raw === 'string' ? JSON.parse(raw) : raw; memStore.set(id, d); return d; }
  } catch (e) { }
  return null;
}
async function getUserKey(tgId) {
  try {
    const raw = await redis.get(`apikey:${tgId}`);
    if (raw) return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) { }
  return null;
}
async function saveUserKey(tgId, key) {
  try { await redis.set(`apikey:${tgId}`, JSON.stringify({ apiKey: key, connectedAt: Date.now() })); } catch (e) { }
}
async function deleteUserKey(tgId) {
  try { await redis.del(`apikey:${tgId}`); } catch (e) { }
}
async function getUserLang(tgId) {
  try {
    const raw = await redis.get(`lang:${tgId}`);
    if (raw) return typeof raw === 'string' ? raw.replace(/"/g, '') : 'en';
  } catch (e) { }
  return 'en';
}
async function saveUserLang(tgId, lang) {
  try { await redis.set(`lang:${tgId}`, lang); } catch (e) { }
}

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
});

function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function signVideo(videoId, expiresInHours = 720) {
  const exp = Math.floor(Date.now() / 1000) + (expiresInHours * 3600);
  const payload = `${videoId}.${exp}`;
  const sig = crypto.createHmac('sha256', VIDEO_SECRET).update(payload).digest('hex').substring(0, 16);
  return `${exp}.${sig}`;
}
function verifyVideoSig(videoId, token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [expStr, sig] = parts;
  const exp = parseInt(expStr, 10);
  if (!exp || isNaN(exp)) return false;
  if (Math.floor(Date.now() / 1000) > exp) return false;
  const payload = `${videoId}.${exp}`;
  const expected = crypto.createHmac('sha256', VIDEO_SECRET).update(payload).digest('hex').substring(0, 16);
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); }
  catch (e) { return false; }
}

const T = {
  en: {
    welcome_title: 'M A Y A  J A A L',
    subtitle: 'Official Stream Bot',
    tagline: 'Fast • Secure • App-Only Streaming',
    about_title: 'About This Bot',
    about_text: 'This bot uploads your videos to a secure cloud and gives you a signed player link.',
    security_features: 'Security Features',
    sec_1: 'HMAC-signed links (cannot be copied)',
    sec_2: 'Plays only in MayaJaal App',
    sec_3: 'Browser playback disabled',
    sec_4: '30-day link validity',
    status: 'Status',
    api_connected: 'API Connected',
    api_not_connected: 'API Not Connected',
    how_to_use: 'How to Use',
    step_1: 'Connect API key (one time)',
    step_2: 'Send video or Terabox link',
    step_3: 'Get signed player link',
    step_4: 'Play in App',
    nav_hint: 'Use the buttons below to navigate',
    btn_api: 'API Connect',
    btn_help: 'How to Use',
    btn_allbots: 'All Bots',
    btn_account: 'Account',
    btn_logout: 'Logout',
    btn_settings: 'Settings',
    btn_language: 'Language',
    btn_main_menu: 'Main Menu',
    btn_generate_key: 'Generate API Key',
    btn_generate_new: 'Generate New Key',
    btn_confirm_logout: 'Confirm Logout',
    btn_cancel: 'Cancel',
    api_status_title: 'API Status',
    already_connected: 'Already Connected',
    connected_at: 'Connected',
    key_label: 'Key',
    need_new_key: 'Need a new key? Tap below:',
    api_connect_title: 'API Connect',
    api_connect_step1: 'Tap the button below',
    api_connect_step2: 'API key will be generated in browser',
    api_connect_step3: 'Copy the key',
    api_connect_step4: 'Send it here: /api YOUR_KEY',
    api_key_connected: 'API Key Connected!',
    api_key_required: 'API Key Required',
    api_key_required_text: 'Please connect your API key first:',
    api_key_invalid: 'Invalid API key',
    api_key_min_12: 'Key must be at least 12 characters',
    now_send_video: 'Now send a video or paste a Terabox link',
    help_title: 'How to Use MayaJaal Bot',
    help_step1: 'Step 1 — API Connect (once):',
    help_step1_a: 'Tap "API Connect" button',
    help_step1_b: 'Get API key in browser',
    help_step1_c: 'Copy the key',
    help_step1_d: 'Send: /api YOUR_KEY',
    help_step2: 'Step 2 — Video Upload:',
    help_step2_a: 'Send video/file directly (up to 2GB)',
    help_step2_b: 'Or paste Terabox link',
    help_step3: 'Step 3 — Player Link:',
    help_step3_a: 'Bot gives signed link',
    help_step3_b: 'Open the link',
    help_step3_c: 'Play button → App download',
    help_step4: 'Step 4 — App Install:',
    help_step4_a: 'Download APK',
    help_step4_b: 'Install and watch videos',
    all_bots_title: 'All MayaJaal Bots',
    bot1_name: 'Stream Bot',
    bot1_desc: 'Video upload + player link',
    bot2_name: 'Link Converter Bot',
    bot2_desc: 'Short link generator + earning',
    bot3_name: 'Content Bot',
    bot3_desc: 'Coming soon',
    bot4_name: 'Web Bot',
    bot4_desc: 'Coming soon',
    status_active: 'Active',
    status_soon: 'Soon',
    data_safe: 'Everyone\'s data is safe',
    account_title: 'Your Account',
    user_id: 'User ID',
    api_status: 'API Status',
    connected_label: 'Connected',
    not_connected_label: 'Not Connected',
    connected_since: 'Connected Since',
    bot_version: 'Bot Version',
    logout_title: 'Logout',
    logout_confirm_text: 'Are you sure you want to disconnect your API?',
    logout_safe: 'Your data will remain safe.',
    logout_success: 'Logout Successful!',
    logout_disconnected: 'Your API key has been disconnected.',
    logout_restart: 'Send /start to connect again.',
    already_logged_out: 'You are already logged out.',
    settings_title: 'Settings',
    settings_lang_label: 'Current Language',
    settings_choose_lang: 'Choose your preferred language:',
    lang_english: 'English',
    lang_hindi: 'हिंदी (Hindi)',
    lang_changed: 'Language changed successfully!',
    lang_changed_to: 'Language set to:',
    terabox_detected: 'Terabox link detected, processing...',
    downloading_uploading: 'Download + upload in progress...',
    uploading: 'Uploading...',
    ready_app_only: 'Ready — App Only',
    app_only_note: 'Will play only in App',
    player_link: 'Player Link',
    max_size: 'Max',
  },
  hi: {
    welcome_title: 'माया जाल',
    subtitle: 'ऑफिशियल स्ट्रीम बॉट',
    tagline: 'तेज़ • सुरक्षित • सिर्फ ऐप में',
    about_title: 'इस बॉट के बारे में',
    about_text: 'यह बॉट आपकी वीडियो को सुरक्षित क्लाउड पर अपलोड करता है और साइन किया हुआ प्लेयर लिंक देता है।',
    security_features: 'सुरक्षा फीचर्स',
    sec_1: 'HMAC-साइन लिंक (कोई कॉपी नहीं कर सकता)',
    sec_2: 'सिर्फ MayaJaal ऐप में चलेगा',
    sec_3: 'ब्राउज़र प्लेबैक बंद',
    sec_4: '30 दिन तक लिंक वैध',
    status: 'स्थिति',
    api_connected: 'API कनेक्टेड',
    api_not_connected: 'API कनेक्ट नहीं',
    how_to_use: 'इस्तेमाल कैसे करें',
    step_1: 'API की कनेक्ट करें (एक बार)',
    step_2: 'वीडियो या Terabox लिंक भेजें',
    step_3: 'साइन किया प्लेयर लिंक मिलेगा',
    step_4: 'ऐप में देखें',
    nav_hint: 'नीचे बटन्स से नेविगेट करें',
    btn_api: 'API कनेक्ट',
    btn_help: 'कैसे इस्तेमाल करें',
    btn_allbots: 'सभी बॉट्स',
    btn_account: 'अकाउंट',
    btn_logout: 'लॉगआउट',
    btn_settings: 'सेटिंग्स',
    btn_language: 'भाषा',
    btn_main_menu: 'मुख्य मेन्यू',
    btn_generate_key: 'API की बनाएं',
    btn_generate_new: 'नई की बनाएं',
    btn_confirm_logout: 'लॉगआउट पक्का करें',
    btn_cancel: 'रद्द करें',
    api_status_title: 'API स्टेटस',
    already_connected: 'पहले से कनेक्टेड',
    connected_at: 'कनेक्टेड',
    key_label: 'की',
    need_new_key: 'नई की चाहिए? नीचे दबाएं:',
    api_connect_title: 'API कनेक्ट',
    api_connect_step1: 'नीचे बटन दबाएं',
    api_connect_step2: 'ब्राउज़र में API की बनेगी',
    api_connect_step3: 'की कॉपी करें',
    api_connect_step4: 'यहां भेजें: /api YOUR_KEY',
    api_key_connected: 'API की कनेक्ट हो गई!',
    api_key_required: 'API की ज़रूरी है',
    api_key_required_text: 'पहले अपनी API की कनेक्ट करें:',
    api_key_invalid: 'गलत API की',
    api_key_min_12: 'की कम से कम 12 अक्षर की होनी चाहिए',
    now_send_video: 'अब वीडियो भेजें या Terabox लिंक पेस्ट करें',
    help_title: 'MayaJaal बॉट कैसे इस्तेमाल करें',
    help_step1: 'स्टेप 1 — API कनेक्ट (एक बार):',
    help_step1_a: '"API कनेक्ट" बटन दबाएं',
    help_step1_b: 'ब्राउज़र में API की लें',
    help_step1_c: 'की कॉपी करें',
    help_step1_d: 'भेजें: /api YOUR_KEY',
    help_step2: 'स्टेप 2 — वीडियो अपलोड:',
    help_step2_a: 'वीडियो/फाइल सीधे भेजें (2GB तक)',
    help_step2_b: 'या Terabox लिंक पेस्ट करें',
    help_step3: 'स्टेप 3 — प्लेयर लिंक:',
    help_step3_a: 'बॉट साइन किया लिंक देगा',
    help_step3_b: 'लिंक खोलें',
    help_step3_c: 'प्ले बटन → ऐप डाउनलोड',
    help_step4: 'स्टेप 4 — ऐप इंस्टॉल:',
    help_step4_a: 'APK डाउनलोड करें',
    help_step4_b: 'इंस्टॉल करके वीडियो देखें',
    all_bots_title: 'सभी MayaJaal बॉट्स',
    bot1_name: 'स्ट्रीम बॉट',
    bot1_desc: 'वीडियो अपलोड + प्लेयर लिंक',
    bot2_name: 'लिंक कनवर्टर बॉट',
    bot2_desc: 'शॉर्ट लिंक जेनरेटर + कमाई',
    bot3_name: 'कंटेंट बॉट',
    bot3_desc: 'जल्द आ रहा है',
    bot4_name: 'वेब बॉट',
    bot4_desc: 'जल्द आ रहा है',
    status_active: 'सक्रिय',
    status_soon: 'जल्द',
    data_safe: 'सबका डेटा सुरक्षित है',
    account_title: 'आपका अकाउंट',
    user_id: 'यूज़र ID',
    api_status: 'API स्टेटस',
    connected_label: 'कनेक्टेड',
    not_connected_label: 'कनेक्ट नहीं',
    connected_since: 'कनेक्टेड कब से',
    bot_version: 'बॉट वर्ज़न',
    logout_title: 'लॉगआउट',
    logout_confirm_text: 'क्या आप API डिसकनेक्ट करना चाहते हैं?',
    logout_safe: 'आपका डेटा सुरक्षित रहेगा।',
    logout_success: 'लॉगआउट हो गया!',
    logout_disconnected: 'आपकी API की डिसकनेक्ट हो गई।',
    logout_restart: 'दोबारा कनेक्ट करने के लिए /start भेजें।',
    already_logged_out: 'आप पहले से लॉगआउट हैं।',
    settings_title: 'सेटिंग्स',
    settings_lang_label: 'वर्तमान भाषा',
    settings_choose_lang: 'अपनी पसंदीदा भाषा चुनें:',
    lang_english: 'English',
    lang_hindi: 'हिंदी (Hindi)',
    lang_changed: 'भाषा सफलतापूर्वक बदली गई!',
    lang_changed_to: 'भाषा सेट:',
    terabox_detected: 'Terabox लिंक मिला, प्रोसेस हो रहा है...',
    downloading_uploading: 'डाउनलोड + अपलोड हो रहा है...',
    uploading: 'अपलोड हो रहा है...',
    ready_app_only: 'तैयार — सिर्फ ऐप में',
    app_only_note: 'सिर्फ ऐप में चलेगा',
    player_link: 'प्लेयर लिंक',
    max_size: 'अधिकतम',
  }
};

function t(lang, key) {
  return (T[lang] && T[lang][key]) || T.en[key] || key;
}
  const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(express.static(__dirname, { index: false }));

app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/download.html', (req, res) => res.sendFile(path.join(__dirname, 'download.html')));
app.get('/player.html', (req, res) => res.sendFile(path.join(__dirname, 'player.html')));
app.get('/logo.jpg', (req, res) => res.sendFile(path.join(__dirname, 'logo.jpg')));

app.get('/', (req, res) => res.send('MayaJaal Online'));
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime(), mode: 'app-only' }));

app.post('/save-key', async (req, res) => {
  try {
    const { telegram_id, key } = req.body;
    if (!telegram_id || !key) return res.status(400).json({ error: 'Missing data' });
    await saveUserKey(telegram_id, key);
    console.log(`[API SAVED] tg=${telegram_id}`);
    return res.json({ success: true });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.get('/v/:id', async (req, res) => {
  try {
    const videoId = req.params.id;
    const token = req.query.t || req.query.s || '';
    if (!verifyVideoSig(videoId, token)) {
      return res.status(403).send('<h2 style="font-family:sans-serif;padding:40px;text-align:center">🔒 Invalid or expired link</h2>');
    }
    const meta = await getMeta(videoId);
    if (!meta) return res.status(404).send('Video not found');
    return res.sendFile(path.join(__dirname, 'player.html'));
  } catch (e) { return res.status(500).send('err'); }
});

app.get('/api/v/:id', async (req, res) => {
  const videoId = req.params.id;
  const token = req.query.t || req.query.s || '';
  if (!verifyVideoSig(videoId, token)) return res.status(403).json({ error: 'Invalid token' });
  const meta = await getMeta(videoId);
  if (!meta) return res.status(404).json({ error: 'Not found' });
  return res.json({ id: videoId, name: meta.name || 'Video', size: meta.size || 0, mime: meta.mime || 'video/mp4' });
});

// Yahan naya route jod diya hai taaki app connection error na de[span_4](start_span)[span_4](end_span)[span_5](start_span)[span_5](end_span)[span_6](start_span)[span_6](end_span)
app.get('/api/stream-info/:id', async (req, res) => {
  const videoId = req.params.id;
  const meta = await getMeta(videoId);
  if (!meta) {
    return res.status(404).json({ success: false, error: 'Video not found or expired' });
  }
  return res.json({
    success: true,
    url: `${BASE_URL}/stream/${videoId}?t=${signVideo(videoId, 720)}`,
    title: meta.name || 'Video',
    uploader: '@MayaJaalBot'
  });
});

app.get('/stream/:id', async (req, res) => {
  try {
    const videoId = req.params.id;
    const token = req.query.t || req.query.s || '';
    if (!verifyVideoSig(videoId, token)) return res.status(403).send('Forbidden');
    const ua = req.headers['user-agent'] || '';
    if (!ua.includes(APP_UA_KEYWORD)) return res.status(403).send('App required');
    const meta = await getMeta(videoId);
    if (!meta?.r2Key) return res.status(404).send('Not found');
    const out = await r2.send(new GetObjectCommand({
      Bucket: R2_BUCKET_NAME, Key: meta.r2Key,
      Range: req.headers.range || undefined,
    }));
    res.status(req.headers.range ? 206 : 200);
    res.setHeader('Content-Type', out.ContentType || meta.mime || 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    if (out.ContentRange) res.setHeader('Content-Range', out.ContentRange);
    if (out.ContentLength) res.setHeader('Content-Length', out.ContentLength);
    out.Body.on('error', () => { if (!res.headersSent) res.status(500); res.end(); });
    out.Body.pipe(res);
  } catch (e) { if (!res.headersSent) res.status(500).send('err'); }
});

app.listen(PORT, () => console.log(`Web on ${PORT}`));
      function detectTeraboxUrl(text) {
  if (!text) return null;
  const domains = ['terabox\\.com','terabox\\.app','terabox\\.link','terabox\\.club','terabox\\.fun','terabox\\.cc','terabox\\.top','terabox\\.online','1024tera\\.com','1024terabox\\.com','4funbox\\.com','4funbox\\.co','mirrobox\\.com','nephobox\\.com','momerybox\\.com','tibibox\\.com','teraboxapp\\.com','teraboxlink\\.com','teraboxshare\\.com','teraboxurl\\.com','teraboxdl\\.com','teraboxdownloader\\.com','terafileshare\\.com','terashare\\.com','terasharelink\\.com','terasharefile\\.com','freeterabox\\.com','gearbox\\.app','teraboxcdn\\.com','terabox\\.store','terabox\\.site','terabox\\.space','terabox\\.website','dubox\\.com','terabox\\.icu','terabox\\.xyz','diskwala\\.com'];
  const regex = new RegExp(`https?:\\/\\/[^\\s]*(${domains.join('|')})[^\\s]*`, 'i');
  const m = text.match(regex);
  return m ? m[0] : null;
}

async function getTeraboxDirectLink(shareUrl) {
  const TERABOX_COOKIE = (process.env.TERABOX_COOKIE || '').trim();
  if (!TERABOX_COOKIE) throw new Error('TERABOX_COOKIE missing');
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  const pageResp = await axios.get(shareUrl, { headers: { 'User-Agent': UA, 'Cookie': TERABOX_COOKIE }, timeout: 30000, maxRedirects: 5 });
  const html = String(pageResp.data);
  let shareid = null, uk = null, sign = null, timestamp = null, fs_id = null;
  let server_filename = 'video.mp4', size = 0;
  const match = html.match(/window\.yunData\s*=\s*(\{[\s\S]+?\});?\s*<\/script>/);
  if (match) {
    try {
      const y = JSON.parse(match[1]);
      shareid = y.shareid; uk = y.uk; sign = y.sign; timestamp = y.timestamp;
      const f = y.file_list?.[0];
      if (f) { fs_id = f.fs_id; server_filename = f.server_filename || server_filename; size = f.size || 0; }
    } catch (e) { }
  }
  if (!shareid) { const m2 = html.match(/"shareid"\s*:\s*"?(\d+)"?[\s\S]{0,3000}?"uk"\s*:\s*"?(\d+)"?/); if (m2) { shareid = m2[1]; uk = m2[2]; } }
  if (!sign) { const mS = html.match(/"sign"\s*:\s*"([^"]+)"/); if (mS) sign = mS[1]; }
  if (!timestamp) { const mT = html.match(/"timestamp"\s*:\s*(\d+)/); if (mT) timestamp = mT[1]; }
  if (!fs_id) { const m3 = html.match(/"fs_id"\s*:\s*"?(\d+)"?/); if (m3) fs_id = m3[1]; }
  if (server_filename === 'video.mp4') { const m4 = html.match(/"server_filename"\s*:\s*"([^"]+)"/); if (m4) server_filename = m4[1]; }
  if (!size) { const m5 = html.match(/"size"\s*:\s*(\d+)/); if (m5) size = parseInt(m5[1], 10); }
  if (!shareid || !uk) throw new Error('Share info not found');
  const apiHeaders = { 'User-Agent': UA, 'Cookie': TERABOX_COOKIE, 'Referer': shareUrl };
  if (!fs_id) {
    const shorturl = shareUrl.split('/s/')[1]?.split('?')[0] || '';
    try {
      const lr = await axios.get(`https://www.terabox.com/share/list?shorturl=${shorturl}&root=1&web=1&app_id=250528`, { headers: apiHeaders, timeout: 30000 });
      const f = lr.data?.list?.[0];
      if (f) { fs_id = f.fs_id; server_filename = f.server_filename || server_filename; size = f.size || size; }
    } catch (e) { }
  }
  if (!fs_id) throw new Error('fs_id not found');
  const dlResp = await axios.get(`https://www.terabox.com/share/download?shareid=${shareid}&uk=${uk}&sign=${sign || ''}&timestamp=${timestamp || ''}&fs_id=${fs_id}&channel=dubox&web=1&app_id=250528`, { headers: apiHeaders, timeout: 30000 });
  const dlink = dlResp.data?.dlink;
  if (!dlink) throw new Error('Direct link not found');
  return { url: Array.isArray(dlink) ? dlink[0] : dlink, fileName: server_filename, size };
}

async function waitForApiConnection() {
  console.log('[BOT] Waiting for central API connection...');
  while (true) {
    const cfg = await getCentralConfig();
    if (cfg && cfg.api_connected === true) {
      console.log('[BOT] ✅ Central API Connected:', cfg.api_base);
      return cfg;
    }
    console.log('[BOT] ⏳ Not connected yet. Retrying in 10s...');
    await new Promise(r => setTimeout(r, 10000));
  }
}

(async () => {
  await waitForApiConnection();

  const client = new TelegramClient(new StringSession(''), API_ID, API_HASH, {
    connectionRetries: 5, autoReconnect: true,
  });

  console.log('Connecting MTProto...');
  await client.start({ botAuthToken: TOKEN });
  console.log('GramJS connected — 2GB unlocked!');

  const MAX_CONCURRENT_UPLOADS = 5;
  const uploadQueue = [];
  let activeUploads = 0;

  function enqueueUpload(task) {
    uploadQueue.push(task);
    processQueue();
  }

  async function processQueue() {
    while (activeUploads < MAX_CONCURRENT_UPLOADS && uploadQueue.length > 0) {
      const task = uploadQueue.shift();
      activeUploads++;
      task().finally(() => {
        activeUploads--;
        setImmediate(processQueue);
      });
    }
  }

  console.log(`Upload queue ready — max ${MAX_CONCURRENT_UPLOADS} parallel uploads`);

  function keyboard(rows) {
    return new Api.ReplyInlineMarkup({
      rows: rows.map(row => new Api.KeyboardButtonRow({
        buttons: row.map(btn => {
          if (btn.url) return new Api.KeyboardButtonUrl({ text: btn.text, url: btn.url });
          return new Api.KeyboardButtonCallback({ text: btn.text, data: Buffer.from(btn.callback_data || '') });
        }),
      })),
    });
  }

  async function sendWelcome(chatId, uid, editMsgId = null) {
    const lang = await getUserLang(uid);
    const userData = await getUserKey(uid);
    const statusText = userData ? `✅ ${t(lang, 'api_connected')}` : `⚠️ ${t(lang, 'api_not_connected')}`;

    const text =
      `<b>╔══════════════════════╗</b>\n` +
      `<b>   🎬  ${t(lang, 'welcome_title')}  🎬</b>\n` +
      `<b>╚══════════════════════╝</b>\n\n` +
      `<b>🚀 ${t(lang, 'subtitle')}</b>\n` +
      `<i>${t(lang, 'tagline')}</i>\n\n` +
      `<b>━━━━━━━━━━━━━━━━━━━━━━</b>\n` +
      `<b>📖 ${t(lang, 'about_title')}</b>\n` +
      `<b>━━━━━━━━━━━━━━━━━━━━━━</b>\n\n` +
      `${t(lang, 'about_text')}\n\n` +
      `<b>🔐 ${t(lang, 'security_features')}:</b>\n` +
      `├ ✅ ${t(lang, 'sec_1')}\n` +
      `├ ✅ ${t(lang, 'sec_2')}\n` +
      `├ ✅ ${t(lang, 'sec_3')}\n` +
      `└ ✅ ${t(lang, 'sec_4')}\n\n` +
      `<b>━━━━━━━━━━━━━━━━━━━━━━</b>\n` +
      `<b>📌 ${t(lang, 'status')}:</b> ${statusText}\n` +
      `<b>━━━━━━━━━━━━━━━━━━━━━━</b>\n\n` +
      `<b>🎯 ${t(lang, 'how_to_use')}:</b>\n` +
      `<b>1.</b> ${t(lang, 'step_1')}\n` +
      `<b>2.</b> ${t(lang, 'step_2')}\n` +
      `<b>3.</b> ${t(lang, 'step_3')}\n` +
      `<b>4.</b> ${t(lang, 'step_4')}\n\n` +
      `<i>${t(lang, 'nav_hint')} 👇</i>`;

    const rows = [
      [{ text: `🔑 ${t(lang, 'btn_api')}`, callback_data: 'menu_api' }, { text: `📖 ${t(lang, 'btn_help')}`, callback_data: 'menu_help' }],
      [{ text: `🤖 ${t(lang, 'btn_allbots')}`, callback_data: 'menu_allbots' }, { text: `📊 ${t(lang, 'btn_account')}`, callback_data: 'menu_account' }],
      [{ text: `⚙️ ${t(lang, 'btn_settings')}`, callback_data: 'menu_settings' }, { text: `🚪 ${t(lang, 'btn_logout')}`, callback_data: 'menu_logout' }],
    ];

    if (editMsgId) {
      try {
        await client.editMessage(chatId, { message: editMsgId, text, parseMode: 'html', buttons: keyboard(rows) });
        return;
      } catch (e) { }
    }
    await client.sendMessage(chatId, { message: text, parseMode: 'html', buttons: keyboard(rows) });
  }

  async function sendHelp(chatId, uid, editMsgId = null) {
    const lang = await getUserLang(uid);
    const text = `📖 <b>${t(lang, 'help_title')}</b>\n\n` +
      `<b>${t(lang, 'help_step1')}</b>\n` +
      `├ ${t(lang, 'help_step1_a')}\n` +
      `├ ${t(lang, 'help_step1_b')}\n` +
      `├ ${t(lang, 'help_step1_c')}\n` +
      `└ ${t(lang, 'help_step1_d')}\n\n` +
      `<b>${t(lang, 'help_step2')}</b>\n` +
      `├ ${t(lang, 'help_step2_a')}\n` +
      `└ ${t(lang, 'help_step2_b')}\n\n` +
      `<b>${t(lang, 'help_step3')}</b>\n` +
      `├ ${t(lang, 'help_step3_a')}\n` +
      `├ ${t(lang, 'help_step3_b')}\n` +
      `└ ${t(lang, 'help_step3_c')}\n\n` +
      `<b>${t(lang, 'help_step4')}</b>\n` +
      `├ ${t(lang, 'help_step4_a')}\n` +
      `└ ${t(lang, 'help_step4_b')}`;
    const rows = [[{ text: `⬅️ ${t(lang, 'btn_main_menu')}`, callback_data: 'main_menu' }]];
    if (editMsgId) {
      try { await client.editMessage(chatId, { message: editMsgId, text, parseMode: 'html', buttons: keyboard(rows) }); return; } catch (e) { }
    }
    await client.sendMessage(chatId, { message: text, parseMode: 'html', buttons: keyboard(rows) });
  }

  async function sendAllBots(chatId, uid, editMsgId = null) {
    const lang = await getUserLang(uid);
    const text = `🤖 <b>${t(lang, 'all_bots_title')}</b>\n\n` +
      `<b>1. 🎬 ${t(lang, 'bot1_name')}</b>\n<i>${t(lang, 'bot1_desc')}</i>\n${t(lang, 'status')}: ✅ ${t(lang, 'status_active')}\n\n` +
      `<b>2. 🔗 ${t(lang, 'bot2_name')}</b>\n<i>${t(lang, 'bot2_desc')}</i>\n${t(lang, 'status')}: ✅ ${t(lang, 'status_active')}\n\n` +
      `<b>3. 📝 ${t(lang, 'bot3_name')}</b>\n<i>${t(lang, 'bot3_desc')}</i>\n${t(lang, 'status')}: ⏳ ${t(lang, 'status_soon')}\n\n` +
      `<b>4. 🌐 ${t(lang, 'bot4_name')}</b>\n<i>${t(lang, 'bot4_desc')}</i>\n${t(lang, 'status')}: ⏳ ${t(lang, 'status_soon')}\n\n` +
      `<i>🔒 ${t(lang, 'data_safe')}</i>`;
    const rows = [[{ text: `⬅️ ${t(lang, 'btn_main_menu')}`, callback_data: 'main_menu' }]];
    if (editMsgId) {
      try { await client.editMessage(chatId, { message: editMsgId, text, parseMode: 'html', buttons: keyboard(rows) }); return; } catch (e) { }
    }
    await client.sendMessage(chatId, { message: text, parseMode: 'html', buttons: keyboard(rows) });
  }

  async function sendSettings(chatId, uid, editMsgId = null) {
    const lang = await getUserLang(uid);
    const text = `⚙️ <b>${t(lang, 'settings_title')}</b>\n\n` +
      `<b>${t(lang, 'settings_lang_label')}:</b> ${lang === 'hi' ? 'हिंदी' : 'English'}\n\n` +
      `${t(lang, 'settings_choose_lang')}`;
    const rows = [
      [{ text: `🌐 ${t(lang, 'btn_language')}`, callback_data: 'menu_language' }],
      [{ text: `⬅️ ${t(lang, 'btn_main_menu')}`, callback_data: 'main_menu' }],
    ];
    if (editMsgId) {
      try { await client.editMessage(chatId, { message: editMsgId, text, parseMode: 'html', buttons: keyboard(rows) }); return; } catch (e) { }
    }
    await client.sendMessage(chatId, { message: text, parseMode: 'html', buttons: keyboard(rows) });
  }

  async function sendLanguageSelector(chatId, uid, editMsgId = null) {
    const lang = await getUserLang(uid);
    const text = `🌐 <b>${t(lang, 'btn_language')} / भाषा</b>\n\n` +
      `Current / वर्तमान: <b>${lang === 'hi' ? 'हिंदी' : 'English'}</b>\n\n` +
      `Choose / चुनें:`;
    const rows = [
      [{ text: '🇬🇧 English', callback_data: 'set_lang_en' }],
      [{ text: '🇮🇳 हिंदी (Hindi)', callback_data: 'set_lang_hi' }],
      [{ text: `⬅️ ${t(lang, 'btn_main_menu')}`, callback_data: 'main_menu' }],
    ];
    if (editMsgId) {
      try { await client.editMessage(chatId, { message: editMsgId, text, parseMode: 'html', buttons: keyboard(rows) }); return; } catch (e) { }
    }
    await client.sendMessage(chatId, { message: text, parseMode: 'html', buttons: keyboard(rows) });
  }

  async function handleDirectFile(msg, uid, lang) {
    const chatId = msg.chatId;
    const doc = msg.media && msg.media.document;
    if (!doc) return;

    let fileName = 'video.mp4', mime = 'application/octet-stream', size = 0;
    size = Number(doc.size) || 0;
    mime = doc.mimeType || (msg.video ? 'video/mp4' : 'application/octet-stream');
    const attr = (doc.attributes || []).find(a => a.className === 'DocumentAttributeFilename');
    if (attr && attr.fileName) fileName = attr.fileName;
    else if (msg.video) fileName = `video_${Date.now()}.mp4`;

    if (size && size > MAX_FILE_SIZE) {
      await client.sendMessage(chatId, { message: `❌ ${t(lang, 'max_size')} ${(MAX_FILE_SIZE / 1024 / 1024).toFixed(0)} MB` });
      return;
    }

    const status = await client.sendMessage(chatId, {
      message: `⚡ <i>${t(lang, 'uploading')}</i>\n📌 ${escapeHtml(fileName)}\n📦 ${(size / 1024 / 1024).toFixed(2)} MB\n\n🔄 <b>0%</b>`,
      parseMode: 'html',
    });

    try {
      const fileLocation = new Api.InputDocumentFileLocation({
        id: doc.id, accessHash: doc.accessHash, fileReference: doc.fileReference, thumbSize: '',
      });

      const CHUNK = 1024 * 1024;
      let downloadedBytes = 0;
      let lastProgressUpdate = Date.now();

      const stream = Readable.from((async function* () {
        let offset = 0;
        while (offset < size) {
          let res;
          try {
            res = await client.invoke(new Api.upload.GetFile({ location: fileLocation, offset, limit: CHUNK }));
          } catch (err) {
            console.error('[GetFile]', err.message);
            break;
          }
          if (!res || !res.bytes || res.bytes.length === 0) break;
          offset += res.bytes.length;
          downloadedBytes = offset;

          const now = Date.now();
          if (now - lastProgressUpdate > 2000 && size > 0) {
            lastProgressUpdate = now;
            const percent = Math.min(100, Math.floor((downloadedBytes / size) * 100));
            client.editMessage(chatId, {
              message: status.id,
              text: `⚡ <i>${t(lang, 'uploading')}</i>\n📌 ${escapeHtml(fileName)}\n📦 ${(size / 1024 / 1024).toFixed(2)} MB\n\n🔄 <b>${percent}%</b>`,
              parseMode: 'html',
            }).catch(() => {});
          }

          yield Buffer.from(res.bytes);
        }
      })());

      const ext = path.extname(fileName) || '.mp4';
      const r2Key = `uploads/${crypto.randomBytes(8).toString('hex')}${ext}`;
      const isLarge = size > 100 * 1024 * 1024;

      const upload = new Upload({
        client: r2,
        params: {
          Bucket: R2_BUCKET_NAME, Key: r2Key, Body: stream, ContentType: mime,
          CacheControl: 'public, max-age=31536000',
        },
        queueSize: isLarge ? 4 : 1,
        partSize: isLarge ? 10 * 1024 * 1024 : 5 * 1024 * 1024,
      });
      await upload.done();

      const shortId = crypto.randomBytes(4).toString('hex');
      await saveMeta(shortId, { name: fileName, mime, r2Key, size, ts: Date.now() });
      const token = signVideo(shortId, 720);
      const playUrl = `${BASE_URL}/v/${shortId}?t=${token}`;

      await client.deleteMessages(chatId, [status.id], { revoke: true }).catch(() => {});
      await client.sendMessage(chatId, {
        message: `✅ <b>${t(lang, 'ready_app_only')}</b>\n\n📌 <b>${escapeHtml(fileName)}</b>\n📦 ${(size / 1024 / 1024).toFixed(2)} MB\n\n🔒 <b>${t(lang, 'app_only_note')}</b>\n\n▶️ <b>${t(lang, 'player_link')}:</b>\n${playUrl}`,
        parseMode: 'html',
      });
    } catch (e) {
      console.error('[Upload Error]', e.message);
      await client.deleteMessages(chatId, [status.id], { revoke: true }).catch(() => {});
      await client.sendMessage(chatId, { message: `❌ ${escapeHtml(e.message)}`, parseMode: 'html' });
    }
  }

  async function handleTerabox(teraboxUrl, chatId, uid, lang) {
    const status = await client.sendMessage(chatId, { message: `🔍 <i>${t(lang, 'terabox_detected')}</i>`, parseMode: 'html' });
    try {
      const info = await getTeraboxDirectLink(teraboxUrl);
      await client.editMessage(chatId, {
        message: status.id,
        text: `⬇️ <i>${t(lang, 'downloading_uploading')}</i>\n📌 ${escapeHtml(info.fileName)}\n📦 ${(info.size / 1024 / 1024).toFixed(2)} MB`,
        parseMode: 'html',
      });
      const TERABOX_COOKIE = (process.env.TERABOX_COOKIE || '').trim();
      const resp = await axios.get(info.url, {
        responseType: 'stream', maxContentLength: Infinity, maxBodyLength: Infinity, timeout: 0,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': TERABOX_COOKIE, 'Referer': teraboxUrl },
      });
      const ext = path.extname(info.fileName) || '.mp4';
      const r2Key = `uploads/${crypto.randomBytes(8).toString('hex')}${ext}`;
      const upload = new Upload({
        client: r2,
        params: { Bucket: R2_BUCKET_NAME, Key: r2Key, Body: resp.data, ContentType: 'video/mp4', CacheControl: 'public, max-age=31536000', Metadata: { source: 'terabox' } },
        queueSize: 4, partSize: 10 * 1024 * 1024,
      });
      await upload.done();
      const shortId = crypto.randomBytes(4).toString('hex');
      await saveMeta(shortId, { name: info.fileName, mime: 'video/mp4', r2Key, size: info.size, ts: Date.now() });
      const token = signVideo(shortId, 720);
      const playUrl = `${BASE_URL}/v/${shortId}?t=${token}`;
      await client.deleteMessages(chatId, [status.id], { revoke: true }).catch(() => {});
      await client.sendMessage(chatId, {
        message: `✅ <b>${t(lang, 'ready_app_only')}</b>\n\n📌 <b>${escapeHtml(info.fileName)}</b>\n📦 ${(info.size / 1024 / 1024).toFixed(2)} MB\n\n🔒 <b>${t(lang, 'app_only_note')}</b>\n\n▶️ <b>${t(lang, 'player_link')}:</b>\n${playUrl}`,
        parseMode: 'html',
      });
    } catch (e) {
      console.error('[Terabox Error]', e.message);
      await client.deleteMessages(chatId, [status.id], { revoke: true }).catch(() => {});
      await client.sendMessage(chatId, { message: `❌ ${escapeHtml(e.message)}`, parseMode: 'html' });
    }
  }

  client.addEventHandler(async (event) => {
    try {
      const msg = event.message;
      if (!msg) return;
      const chatId = msg.chatId;
      const text = (msg.message || '').trim();
      const uid = msg.senderId || (msg.fromId && msg.fromId.userId) || 0;
      const lang = await getUserLang(uid);

      if (text === '/start') { await sendWelcome(chatId, uid); return; }
      if (text === '/help') { await sendHelp(chatId, uid); return; }
      if (text === '/allbots') { await sendAllBots(chatId, uid); return; }
      if (text === '/settings') { await sendSettings(chatId, uid); return; }
      if (text === '/language') { await sendLanguageSelector(chatId, uid); return; }

      if (text.startsWith('/api ')) {
        const key = text.replace('/api ', '').trim();
        if (key.length < 12) {
          await client.sendMessage(chatId, { message: `❌ <b>${t(lang, 'api_key_invalid')}</b>\n\n${t(lang, 'api_key_min_12')}`, parseMode: 'html' });
          return;
        }
        await saveUserKey(uid, key);
        await client.sendMessage(chatId, {
          message: `✅ <b>${t(lang, 'api_key_connected')}</b>\n\n🔑 <code>${escapeHtml(key.substring(0, 8))}...</code>\n\n📤 <b>${t(lang, 'now_send_video')}</b>`,
          parseMode: 'html',
        });
        return;
      }

      if (text === '/logout') {
        const userData = await getUserKey(uid);
        if (!userData) {
          await client.sendMessage(chatId, { message: `⚠️ ${t(lang, 'already_logged_out')}`, parseMode: 'html' });
          return;
        }
        await deleteUserKey(uid);
        await client.sendMessage(chatId, {
          message: `✅ <b>${t(lang, 'logout_success')}</b>\n\n${t(lang, 'logout_disconnected')}\n${t(lang, 'logout_restart')}`,
          parseMode: 'html',
        });
        return;
      }

      const userData = await getUserKey(uid);
      const teraboxUrl = detectTeraboxUrl(text);
      const hasMedia = !!msg.media;

      if (!userData && (hasMedia || teraboxUrl)) {
        await client.sendMessage(chatId, {
          message: `🔒 <b>${t(lang, 'api_key_required')}</b>\n\n${t(lang, 'api_key_required_text')}\n\n1. <code>/start</code>\n2. ${t(lang, 'btn_api')}\n3. <code>/api YOUR_KEY</code>`,
          parseMode: 'html',
          buttons: keyboard([[{ text: `🔑 ${t(lang, 'btn_api')}`, url: `${BASE_URL}/index.html?tg=${uid}` }]]),
        });
        return;
      }

      if (teraboxUrl) {
        enqueueUpload(() => handleTerabox(teraboxUrl, chatId, uid, lang));
        return;
      }

      if (hasMedia && msg.media.document) {
        enqueueUpload(() => handleDirectFile(msg, uid, lang));
        return;
      }
    } catch (err) {
      console.error('[HANDLER ERROR]', err.stack || err.message);
    }
  }, new NewMessage({}));

  client.addEventHandler(async (event) => {
    const q = event.query;
    if (!q) return;
    try { await q.answer(); } catch (e) { }
    const data = q.data.toString();
    const chatId = q.chatId || q.userId;
    const uid = q.userId;
    const msgId = q.msgId;
    const lang = await getUserLang(uid);

    if (data === 'menu_api') {
      const userData = await getUserKey(uid);
      if (userData) {
        await client.editMessage(chatId, {
          message: msgId,
          text: `🔑 <b>${t(lang, 'api_status_title')}</b>\n\n✅ <b>${t(lang, 'already_connected')}</b>\n\n🔐 ${t(lang, 'key_label')}: <code>${escapeHtml(userData.apiKey.substring(0, 8))}...${escapeHtml(userData.apiKey.slice(-4))}</code>\n📅 ${t(lang, 'connected_at')}: ${new Date(userData.connectedAt).toLocaleString()}\n\n${t(lang, 'need_new_key')}`,
          parseMode: 'html',
          buttons: keyboard([
            [{ text: `🔄 ${t(lang, 'btn_generate_new')}`, url: `${BASE_URL}/index.html?tg=${uid}` }],
            [{ text: `⬅️ ${t(lang, 'btn_main_menu')}`, callback_data: 'main_menu' }],
          ]),
        });
      } else {
        await client.editMessage(chatId, {
          message: msgId,
          text: `🔑 <b>${t(lang, 'api_connect_title')}</b>\n\n` +
            `<b>Step 1:</b> ${t(lang, 'api_connect_step1')}\n` +
            `<b>Step 2:</b> ${t(lang, 'api_connect_step2')}\n` +
            `<b>Step 3:</b> ${t(lang, 'api_connect_step3')}\n` +
            `<b>Step 4:</b> <code>/api YOUR_KEY</code>`,
          parseMode: 'html',
          buttons: keyboard([
            [{ text: `🔑 ${t(lang, 'btn_generate_key')}`, url: `${BASE_URL}/index.html?tg=${uid}` }],
            [{ text: `⬅️ ${t(lang, 'btn_main_menu')}`, callback_data: 'main_menu' }],
          ]),
        });
      }
      return;
    }

    if (data === 'menu_help') { await sendHelp(chatId, uid, msgId); return; }
    if (data === 'menu_allbots') { await sendAllBots(chatId, uid, msgId); return; }
    if (data === 'menu_settings') { await sendSettings(chatId, uid, msgId); return; }
    if (data === 'menu_language') { await sendLanguageSelector(chatId, uid, msgId); return; }

    if (data === 'menu_account') {
      const userData = await getUserKey(uid);
      await client.editMessage(chatId, {
        message: msgId,
        text: `📊 <b>${t(lang, 'account_title')}</b>\n\n` +
          `<b>${t(lang, 'user_id')}:</b> <code>${uid}</code>\n` +
          `<b>${t(lang, 'api_status')}:</b> ${userData ? '✅ ' + t(lang, 'connected_label') : '❌ ' + t(lang, 'not_connected_label')}\n` +
          (userData ? `<b>${t(lang, 'connected_since')}:</b> ${new Date(userData.connectedAt).toLocaleString()}\n` : '') +
          `\n<b>${t(lang, 'bot_version')}:</b> v2.1.0`,
        parseMode: 'html',
        buttons: keyboard([[{ text: `⬅️ ${t(lang, 'btn_main_menu')}`, callback_data: 'main_menu' }]]),
      });
      return;
    }

    if (data === 'set_lang_en' || data === 'set_lang_hi') {
      const newLang = data === 'set_lang_en' ? 'en' : 'hi';
      await saveUserLang(uid, newLang);
      await client.editMessage(chatId, {
        message: msgId,
        text: `✅ <b>${t(newLang, 'lang_changed')}</b>\n\n🌐 ${t(newLang, 'lang_changed_to')} <b>${newLang === 'hi' ? 'हिंदी' : 'English'}</b>`,
        parseMode: 'html',
        buttons: keyboard([[{ text: `⬅️ ${t(newLang, 'btn_main_menu')}`, callback_data: 'main_menu' }]]),
      });
      return;
    }

    if (data === 'menu_logout') {
      await client.editMessage(chatId, {
        message: msgId,
        text: `🚪 <b>${t(lang, 'logout_title')}</b>\n\n${t(lang, 'logout_confirm_text')}\n\n${t(lang, 'logout_safe')}`,
        parseMode: 'html',
        buttons: keyboard([
          [{ text: `✅ ${t(lang, 'btn_confirm_logout')}`, callback_data: 'confirm_logout' }],
          [{ text: `❌ ${t(lang, 'btn_cancel')}`, callback_data: 'main_menu' }],
        ]),
      });
      return;
    }

    if (data === 'confirm_logout') {
      await deleteUserKey(uid);
      await client.editMessage(chatId, {
        message: msgId,
        text: `✅ <b>${t(lang, 'logout_success')}</b>\n\n${t(lang, 'logout_disconnected')}\n${t(lang, 'logout_restart')}`,
        parseMode: 'html',
      });
      return;
    }

    if (data === 'main_menu') { await sendWelcome(chatId, uid, msgId); return; }
  }, new CallbackQuery({}));

  console.log('Bot ready — Power Mode (5 parallel uploads)');
})();
