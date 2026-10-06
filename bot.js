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
const APP_SCHEME = process.env.APP_SCHEME || 'mayajaal';
const APP_PACKAGE = process.env.APP_PACKAGE || 'com.mayajaal.app';
const PLAY_STORE_URL = process.env.PLAY_STORE_URL || `https://play.google.com/store/apps/details?id=${APP_PACKAGE}`;
const APP_STORE_URL = process.env.APP_STORE_URL || 'https://apps.apple.com/app/mayajaal/id000000000';
const APP_SHA256 = process.env.APP_SHA256 || 'REPLACE_WITH_YOUR_SHA256';
const APPLE_TEAM_ID = process.env.APPLE_TEAM_ID || 'TEAMID';
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
catch (e) { console.log('Redis not available, memory mode'); redis = { get: async () => null, set: async () => null }; }

const memStore = new Map();
const userKeys = new Map();

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

async function saveUserKey(tgId, apiKey) {
  const data = { apiKey, connectedAt: Date.now() };
  userKeys.set(String(tgId), data);
  try { await redis.set(`apikey:${tgId}`, JSON.stringify(data)); } catch (e) { }
}
async function getUserKey(tgId) {
  if (userKeys.has(String(tgId))) return userKeys.get(String(tgId));
  try {
    const raw = await redis.get(`apikey:${tgId}`);
    if (raw) {
      const d = typeof raw === 'string' ? JSON.parse(raw) : raw;
      userKeys.set(String(tgId), d);
      return d;
    }
  } catch (e) { }
  return null;
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

// ===== EXPRESS =====
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
    if (!telegram_id || !key) return res.status(400).json({ error: 'Missing telegram_id or key' });
    await saveUserKey(telegram_id, key);
    console.log(`[API KEY SAVED] tg=${telegram_id} key=${key.substring(0, 8)}...`);
    return res.json({ success: true });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.get('/get-key/:tgId', async (req, res) => {
  const data = await getUserKey(req.params.tgId);
  return res.json(data || { apiKey: null });
});

app.get('/.well-known/assetlinks.json', (req, res) => {
  res.type('application/json').send(JSON.stringify([{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: APP_PACKAGE,
      sha256_cert_fingerprints: [APP_SHA256],
    },
  }], null, 2));
});

app.get('/.well-known/apple-app-site-association', (req, res) => {
  res.type('application/json').send(JSON.stringify({
    applinks: {
      apps: [],
      details: [{ appID: APPLE_TEAM_ID + '.' + APP_PACKAGE, paths: ['*'] }],
    },
  }, null, 2));
});

app.get('/api/v/:id', async (req, res) => {
  const videoId = req.params.id;
  const token = req.query.t || req.query.s || '';
  if (!verifyVideoSig(videoId, token)) {
    return res.status(403).json({ error: 'Invalid token' });
  }
  const meta = await getMeta(videoId);
  if (!meta) return res.status(404).json({ error: 'Not found' });
  return res.json({
    id: videoId,
    name: meta.name || 'Video',
    size: meta.size || 0,
    mime: meta.mime || 'video/mp4',
    ts: meta.ts || 0,
  });
});

app.get('/v/:id', async (req, res) => {
  const videoId = req.params.id;
  const token = req.query.t || req.query.s || '';
  if (!verifyVideoSig(videoId, token)) {
    return res.status(403).send('<h2 style="font-family:sans-serif;padding:40px;text-align:center">🔒 Invalid or expired link<br><small>Please get a fresh link from the bot</small></h2>');
  }
  const meta = await getMeta(videoId);
  if (!meta) return res.status(404).send('Video not found');
  return res.sendFile(path.join(__dirname, 'player.html'));
});

app.get('/stream/:id', async (req, res) => {
  try {
    const videoId = req.params.id;
    const token = req.query.t || req.query.s || '';
    if (!verifyVideoSig(videoId, token)) return res.status(403).send('Forbidden — invalid token');
    const ua = req.headers['user-agent'] || '';
    if (!ua.includes(APP_UA_KEYWORD)) return res.status(403).send('Forbidden — app required');

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
    if (out.ETag) res.setHeader('ETag', out.ETag);
    out.Body.on('error', () => { if (!res.headersSent) res.status(500); res.end(); });
    out.Body.pipe(res);
  } catch (e) { if (!res.headersSent) res.status(500).send('err'); }
});

app.get('/watch/:id', (req, res) => res.status(403).send('Browser playback disabled'));

app.listen(PORT, () => console.log(`Web on ${PORT} — App-only mode + static files`));

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
  if (!shareid || !uk) throw new Error('Share info nahi mili');
  const apiHeaders = { 'User-Agent': UA, 'Cookie': TERABOX_COOKIE, 'Referer': shareUrl };
  if (!fs_id) {
    const shorturl = shareUrl.split('/s/')[1]?.split('?')[0] || '';
    try {
      const lr = await axios.get(`https://www.terabox.com/share/list?shorturl=${shorturl}&root=1&web=1&app_id=250528`, { headers: apiHeaders, timeout: 30000 });
      const f = lr.data?.list?.[0];
      if (f) { fs_id = f.fs_id; server_filename = f.server_filename || server_filename; size = f.size || size; }
    } catch (e) { }
  }
  if (!fs_id) throw new Error('fs_id nahi mila');
  const dlResp = await axios.get(`https://www.terabox.com/share/download?shareid=${shareid}&uk=${uk}&sign=${sign || ''}&timestamp=${timestamp || ''}&fs_id=${fs_id}&channel=dubox&web=1&app_id=250528`, { headers: apiHeaders, timeout: 30000 });
  const dlink = dlResp.data?.dlink;
  if (!dlink) throw new Error('Direct link nahi mila');
  return { url: Array.isArray(dlink) ? dlink[0] : dlink, fileName: server_filename, size };
  }
// ===== BOT =====
(async () => {
  const client = new TelegramClient(new StringSession(''), API_ID, API_HASH, {
    connectionRetries: 5, autoReconnect: true,
  });

  console.log('Connecting MTProto...');
  await client.start({ botAuthToken: TOKEN });
  console.log('GramJS connected — 2GB unlocked!');

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

  async function sendWelcome(chatId, tgId) {
    const userData = await getUserKey(tgId);
    const isConnected = !!userData;

    if (isConnected) {
      await client.sendMessage(chatId, {
        message: `✅ <b>API Connected!</b>\n\n` +
          `🔑 Key: <code>${userData.apiKey.substring(0, 8)}...${userData.apiKey.substring(userData.apiKey.length - 4)}</code>\n\n` +
          `📤 <b>Ab video bhejo ya Terabox link paste karo</b>\n\n` +
          `⚡ Upload hoga → signed player link milega\n` +
          `🔒 Sirf app me play hoga`,
        parseMode: 'html',
        buttons: keyboard([
          [{ text: '🎬 How to Use', callback_data: 'how_to' }],
          [{ text: '🔄 Reset API', callback_data: 'reset_api_cmd' }],
        ]),
      });
      return;
    }

    await client.sendMessage(chatId, {
      message: `👋 <b>Welcome to MayaJaal Stream Bot</b>\n\n` +
        `<b>Step 1:</b> Pehle apni API key connect karo.\n\n` +
        `🔑 Neeche button dabao → API key generate hogi\n` +
        `📋 Us key ko yahan bhejo: <code>/api YOUR_KEY</code>\n\n` +
        `Uske baad hi video upload kar paoge.`,
      parseMode: 'html',
      buttons: keyboard([
        [{ text: '🔑 Generate API Key', url: `${BASE_URL}/index.html?tg=${tgId}` }],
        [{ text: '📖 How to Use', callback_data: 'how_to' }],
      ]),
    });
  }

  client.addEventHandler(async (event) => {
    const msg = event.message;
    if (!msg) return;
    if ((msg.message || '') === '/start') {
      const uid = msg.senderId || (msg.fromId && msg.fromId.userId) || 0;
      await sendWelcome(msg.chatId, uid);
    }
  }, new NewMessage({}));

  client.addEventHandler(async (event) => {
    const q = event.query;
    if (!q) return;
    try { await q.answer(); } catch (e) {}
    const data = q.data.toString();
    const chatId = q.chatId || q.userId;
    const uid = q.userId;

    if (data === 'how_to') {
      await client.editMessage(chatId, {
        message: q.msgId,
        text: `📖 <b>How to Use MayaJaal Bot</b>\n\n` +
          `<b>1. API Connect (Ek Baar):</b>\n` +
          `• "🔑 Generate API Key" button dabao\n` +
          `• Browser me key milega — copy karo\n` +
          `• Bot me bhejo: <code>/api YOUR_KEY</code>\n\n` +
          `<b>2. Video Upload:</b>\n` +
          `• Direct video/file bhejo (2GB tak)\n` +
          `• Ya Terabox link paste karo\n\n` +
          `<b>3. Player Link:</b>\n` +
          `• Bot signed link dega\n` +
          `• Us link ko kholo → player khulega\n` +
          `• Play/Download button → app download\n\n` +
          `<b>4. App Install:</b>\n` +
          `• APK download karo\n` +
          `• Install karke video dekho`,
        parseMode: 'html',
        buttons: keyboard([[{ text: '⬅️ Back', callback_data: 'back_menu' }]]),
      });
      return;
    }

    if (data === 'back_menu') {
      await sendWelcome(chatId, uid);
      return;
    }

    if (data === 'reset_api_cmd') {
      await client.editMessage(chatId, {
        message: q.msgId,
        text: `🔄 <b>Reset API Key</b>\n\n` +
          `Nayi key chahiye? Neeche button dabao:\n\n` +
          `Ya bot me bhejo: <code>/resetapi</code>`,
        parseMode: 'html',
        buttons: keyboard([
          [{ text: '🔑 Generate New Key', url: `${BASE_URL}/index.html?tg=${uid}` }],
          [{ text: '⬅️ Back', callback_data: 'back_menu' }],
        ]),
      });
      return;
    }
  }, new CallbackQuery({}));

  client.addEventHandler(async (event) => {
    const msg = event.message;
    if (!msg) return;
    const chatId = msg.chatId;
    const text = msg.message || '';

    // ===== FIX: Media hone par bhi aage badho =====
    if (!text && !msg.media) return;

    const uid = msg.senderId || (msg.fromId && msg.fromId.userId) || 0;

    // /api KEY
    if (text.startsWith('/api ')) {
      const key = text.replace('/api ', '').trim();
      if (key.length < 12) {
        return client.sendMessage(chatId, { message: `❌ Invalid API key format. Minimum 12 characters.`, parseMode: 'html' });
      }
      await saveUserKey(uid, key);
      await client.sendMessage(chatId, {
        message: `✅ <b>API Key Connected!</b>\n\n` +
          `🔑 <code>${key.substring(0, 8)}...${key.substring(key.length - 4)}</code>\n\n` +
          `📤 <b>Ab video bhejo ya Terabox link paste karo</b>`,
        parseMode: 'html',
      });
      return;
    }

    if (text === '/resetapi') {
      await client.sendMessage(chatId, {
        message: `🔄 <b>Reset API Key</b>\n\n` +
          `Neeche button dabao, nayi key generate karo, phir /api KEY bhejo:`,
        parseMode: 'html',
        buttons: keyboard([
          [{ text: '🔑 Generate New Key', url: `${BASE_URL}/index.html?tg=${uid}` }],
        ]),
      });
      return;
    }

    if (text === '/start') return;

    // API CHECK
    const userData = await getUserKey(uid);
    if (!userData) {
      return client.sendMessage(chatId, {
        message: `🔒 <b>API Key Required</b>\n\n` +
          `Pehle apni API key connect karo.\n\n` +
          `1. Neeche button → key generate karo\n` +
          `2. Bot me bhejo: <code>/api YOUR_KEY</code>`,
        parseMode: 'html',
        buttons: keyboard([
          [{ text: '🔑 Generate API Key', url: `${BASE_URL}/index.html?tg=${uid}` }],
        ]),
      });
    }

    // TERABOX
    const teraboxUrl = detectTeraboxUrl(text);
    if (teraboxUrl) {
      let status;
      try {
        status = await client.sendMessage(chatId, { message: `🔍 <i>Terabox link mila...</i>`, parseMode: 'html' });
        const info = await getTeraboxDirectLink(teraboxUrl);
        await client.editMessage(chatId, {
          message: status.id,
          text: `⬇️ <i>Download + upload...</i>\n📌 ${escapeHtml(info.fileName)}\n📦 ${(info.size / 1024 / 1024).toFixed(2)} MB`,
          parseMode: 'html',
        });
        const TERABOX_COOKIE = (process.env.TERABOX_COOKIE || '').trim();
        const resp = await axios.get(info.url, {
          responseType: 'stream', maxContentLength: Infinity, maxBodyLength: Infinity, timeout: 0,
          headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': TERABOX_COOKIE, 'Referer': teraboxUrl },
        });
        const ext = path.extname(info.fileName) || '.mp4';
        const r2Key = `uploads/${crypto.randomBytes(8).toString('hex')}${ext}`;
        const isLarge = info.size > 100 * 1024 * 1024;
        const upload = new Upload({
          client: r2,
          params: { Bucket: R2_BUCKET_NAME, Key: r2Key, Body: resp.data, ContentType: 'video/mp4', CacheControl: 'public, max-age=31536000', Metadata: { source: 'terabox' } },
          queueSize: isLarge ? 4 : 1, partSize: isLarge ? 10 * 1024 * 1024 : 5 * 1024 * 1024,
        });
        await upload.done();

        const shortId = crypto.randomBytes(4).toString('hex');
        await saveMeta(shortId, { name: info.fileName, mime: 'video/mp4', r2Key, size: info.size, ts: Date.now() });

        const token = signVideo(shortId, 720);
        const playUrl = `${BASE_URL}/v/${shortId}?t=${token}`;

        await client.deleteMessages(chatId, [status.id], { revoke: true }).catch(() => {});
        await client.sendMessage(chatId, {
          message: `✅ <b>Ready — App Only</b>\n\n📌 <b>${escapeHtml(info.fileName)}</b>\n📦 ${(info.size / 1024 / 1024).toFixed(2)} MB\n\n🔒 <b>Sirf app me play hoga</b>\n\n▶️ <b>Player Link:</b>\n${playUrl}\n\n<i>Link 30 din tak valid hai. App na ho toh download page khulega.</i>`,
          parseMode: 'html',
        });
        return;
      } catch (e) {
        console.error('[Terabox Error]', e.message);
        if (status) await client.deleteMessages(chatId, [status.id], { revoke: true }).catch(() => {});
        await client.sendMessage(chatId, { message: `❌ ${escapeHtml(e.message)}`, parseMode: 'html' });
        return;
      }
    }

    // DIRECT FILE
    if (!msg.media) return;
    const fileMedia = msg.media.document || msg.document || msg.video;
    if (!fileMedia) return;

    console.log('[File] className:', fileMedia.className, '| hasId:', !!fileMedia.id, '| size:', fileMedia.size);

    let fileName = 'video.mp4', mime = 'application/octet-stream', size = 0;
    size = Number(fileMedia.size) || 0;
    mime = fileMedia.mimeType || (msg.video ? 'video/mp4' : 'application/octet-stream');
    const attr = (fileMedia.attributes || []).find(a => a.className === 'DocumentAttributeFilename');
    if (attr) fileName = attr.fileName;
    if (fileName === 'video.mp4' && msg.video) fileName = `video_${Date.now()}.mp4`;

    if (size && size > MAX_FILE_SIZE) {
      return client.sendMessage(chatId, { message: `❌ Max ${(MAX_FILE_SIZE / 1024 / 1024).toFixed(0)} MB` });
    }

    let status;
    try {
      status = await client.sendMessage(chatId, {
        message: `⚡ <i>Uploading...</i>\n📌 ${escapeHtml(fileName)}\n📦 ${(size / 1024 / 1024).toFixed(2)} MB`,
        parseMode: 'html',
      });

      const fileLocation = new Api.InputDocumentFileLocation({
        id: fileMedia.id,
        accessHash: fileMedia.accessHash,
        fileReference: fileMedia.fileReference,
        thumbSize: '',
      });

      const totalSize = Number(fileMedia.size) || 0;
      const CHUNK = 512 * 1024;

      const stream = Readable.from((async function* () {
        let offset = 0;
        while (offset < totalSize) {
          let res;
          try {
            res = await client.invoke(new Api.upload.GetFile({ location: fileLocation, offset: offset, limit: CHUNK }));
          } catch (err) { console.error('[GetFile Error]', err.message); break; }
          if (!res || !res.bytes || res.bytes.length === 0) break;
          offset += res.bytes.length;
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
          Metadata: { originalname: encodeURIComponent(fileName) },
        },
        queueSize: isLarge ? 4 : 1, partSize: isLarge ? 10 * 1024 * 1024 : 5 * 1024 * 1024,
      });
      await upload.done();

      const shortId = crypto.randomBytes(4).toString('hex');
      await saveMeta(shortId, { name: fileName, mime, r2Key, size, ts: Date.now() });

      const token = signVideo(shortId, 720);
      const playUrl = `${BASE_URL}/v/${shortId}?t=${token}`;

      await client.deleteMessages(chatId, [status.id], { revoke: true }).catch(() => {});
      await client.sendMessage(chatId, {
        message: `✅ <b>Ready — App Only</b>\n\n📌 <b>${escapeHtml(fileName)}</b>\n📦 ${(size / 1024 / 1024).toFixed(2)} MB\n\n🔒 <b>Sirf app me play hoga</b>\n\n▶️ <b>Player Link:</b>\n${playUrl}\n\n<i>Link 30 din tak valid hai.</i>`,
        parseMode: 'html',
      });
    } catch (e) {
      console.error('[Error]', e.stack || e.message);
      if (status) await client.deleteMessages(chatId, [status.id], { revoke: true }).catch(() => {});
      await client.sendMessage(chatId, { message: `❌ ${escapeHtml(e.message)}`, parseMode: 'html' });
    }
  }, new NewMessage({}));

  console.log('Handlers ready — API + App-only mode');
})();
