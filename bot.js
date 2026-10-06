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
  if (!dlink) throw new Error('Direct link nahi mili');
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

  // ===== WELCOME MENU =====
  async function sendWelcome(chatId, uid, editMsgId = null) {
    const userData = await getUserKey(uid);
    const status = userData ? '✅ API Connected' : '⚠️ API Not Connected';

    const text =
      `<b>╔══════════════════════╗</b>\n` +
      `<b>   🎬  M A Y A  J A A L  🎬</b>\n` +
      `<b>╚══════════════════════╝</b>\n\n` +
      `<b>🚀 OFFICIAL STREAM BOT</b>\n` +
      `<i>Fast • Secure • App-Only Streaming</i>\n\n` +
      `<b>━━━━━━━━━━━━━━━━━━━━━━</b>\n` +
      `<b>📖 About This Bot</b>\n` +
      `<b>━━━━━━━━━━━━━━━━━━━━━━</b>\n\n` +
      `Ye bot aapki videos ko <b>secure cloud</b> pe upload karta hai aur ek <b>signed player link</b> deta hai.\n\n` +
      `<b>🔐 Security Features:</b>\n` +
      `├ ✅ HMAC-signed links (koi copy nahi kar sakta)\n` +
      `├ ✅ Sirf MayaJaal App me play hoga\n` +
      `├ ✅ Browser playback disabled\n` +
      `└ ✅ 30-day link validity\n\n` +
      `<b>━━━━━━━━━━━━━━━━━━━━━━</b>\n` +
      `<b>📌 Status:</b> ${status}\n` +
      `<b>━━━━━━━━━━━━━━━━━━━━━━</b>\n\n` +
      `<b>🎯 How to Use:</b>\n` +
      `<b>1.</b> API Connect karo (ek baar)\n` +
      `<b>2.</b> Video ya Terabox link bhejo\n` +
      `<b>3.</b> Signed player link milega\n` +
      `<b>4.</b> App me play karo\n\n` +
      `<i>Neeche buttons se navigate karo 👇</i>`;

    const rows = [
      [{ text: '🔑 API Connect', callback_data: 'menu_api' }, { text: '📖 How to Use', callback_data: 'menu_help' }],
      [{ text: '🤖 All Bots', callback_data: 'menu_allbots' }, { text: '📊 Account', callback_data: 'menu_account' }],
      [{ text: '🚪 Logout', callback_data: 'menu_logout' }],
    ];

    if (editMsgId) {
      try {
        await client.editMessage(chatId, { message: editMsgId, text, parseMode: 'html', buttons: keyboard(rows) });
        return;
      } catch (e) { }
    }
    await client.sendMessage(chatId, { message: text, parseMode: 'html', buttons: keyboard(rows) });
  }

  // ===== MESSAGE HANDLER =====
  client.addEventHandler(async (event) => {
    try {
      const msg = event.message;
      if (!msg) return;
      const chatId = msg.chatId;
      const text = (msg.message || '').trim();
      const uid = msg.senderId || (msg.fromId && msg.fromId.userId) || 0;

      // /start
      if (text === '/start') {
        await sendWelcome(chatId, uid);
        return;
      }

      // /api KEY
      if (text.startsWith('/api ')) {
        const key = text.replace('/api ', '').trim();
        if (key.length < 12) {
          await client.sendMessage(chatId, { message: `❌ <b>Invalid API key</b>\n\nKey at least 12 characters honi chahiye.`, parseMode: 'html' });
          return;
        }
        await saveUserKey(uid, key);
        await client.sendMessage(chatId, {
          message: `✅ <b>API Key Connected!</b>\n\n🔑 <code>${escapeHtml(key.substring(0, 8))}...</code>\n\n📤 <b>Ab video bhejo ya Terabox link paste karo</b>`,
          parseMode: 'html',
        });
        return;
      }

      // /logout
      if (text === '/logout') {
        const userData = await getUserKey(uid);
        if (!userData) {
          await client.sendMessage(chatId, { message: `⚠️ Aap already logged out ho.`, parseMode: 'html' });
          return;
        }
        await deleteUserKey(uid);
        await client.sendMessage(chatId, {
          message: `✅ <b>Logout Successful!</b>\n\nAapki API key disconnect ho gayi.\nDobara connect karne ke liye <code>/start</code> bhejo.`,
          parseMode: 'html',
        });
        return;
      }

      // /help
      if (text === '/help') {
        await client.sendMessage(chatId, {
          message: `📖 <b>MayaJaal Bot — Help</b>\n\n` +
            `<b>Commands:</b>\n` +
            `/start — Main menu\n` +
            `/api KEY — Connect API key\n` +
            `/logout — Disconnect API\n` +
            `/help — Show this help\n\n` +
            `<b>How to use:</b>\n` +
            `1. /start → API Connect button\n` +
            `2. Copy key from browser\n` +
            `3. Send /api YOUR_KEY\n` +
            `4. Send video or Terabox link\n` +
            `5. Get signed player link\n` +
            `6. Play in MayaJaal App`,
          parseMode: 'html',
        });
        return;
      }

      // /allbots
      if (text === '/allbots') {
        await sendAllBots(chatId);
        return;
      }

      // API CHECK
      const userData = await getUserKey(uid);
      const teraboxUrl = detectTeraboxUrl(text);
      const hasMedia = !!msg.media;

      if (!userData && (hasMedia || teraboxUrl)) {
        await client.sendMessage(chatId, {
          message: `🔒 <b>API Key Required</b>\n\nPehle API key connect karo:\n\n1. <code>/start</code> bhejo\n2. "🔑 API Connect" button dabao\n3. Key copy karke bhejo: <code>/api YOUR_KEY</code>`,
          parseMode: 'html',
          buttons: keyboard([[{ text: '🔑 API Connect', url: `${BASE_URL}/index.html?tg=${uid}` }]]),
        });
        return;
      }

      // TERABOX
      if (teraboxUrl) {
        const status = await client.sendMessage(chatId, { message: `🔍 <i>Terabox link mila, process ho raha hai...</i>`, parseMode: 'html' });
        try {
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
            message: `✅ <b>Ready — App Only</b>\n\n📌 <b>${escapeHtml(info.fileName)}</b>\n📦 ${(info.size / 1024 / 1024).toFixed(2)} MB\n\n🔒 <b>Sirf app me play hoga</b>\n\n▶️ <b>Player Link:</b>\n${playUrl}`,
            parseMode: 'html',
          });
        } catch (e) {
          console.error('[Terabox Error]', e.message);
          await client.deleteMessages(chatId, [status.id], { revoke: true }).catch(() => {});
          await client.sendMessage(chatId, { message: `❌ ${escapeHtml(e.message)}`, parseMode: 'html' });
        }
        return;
      }

      // DIRECT FILE
      if (!msg.media) return;
      const doc = msg.media.document;
      if (!doc) {
        console.log('[NO DOC]', msg.media.className);
        return;
      }
      console.log('[DOC]', doc.className, '| size:', doc.size);

      let fileName = 'video.mp4', mime = 'application/octet-stream', size = 0;
      size = Number(doc.size) || 0;
      mime = doc.mimeType || (msg.video ? 'video/mp4' : 'application/octet-stream');
      const attr = (doc.attributes || []).find(a => a.className === 'DocumentAttributeFilename');
      if (attr && attr.fileName) fileName = attr.fileName;
      else if (msg.video) fileName = `video_${Date.now()}.mp4`;

      if (size && size > MAX_FILE_SIZE) {
        await client.sendMessage(chatId, { message: `❌ Max ${(MAX_FILE_SIZE / 1024 / 1024).toFixed(0)} MB` });
        return;
      }

      const status = await client.sendMessage(chatId, {
        message: `⚡ <i>Uploading...</i>\n📌 ${escapeHtml(fileName)}\n📦 ${(size / 1024 / 1024).toFixed(2)} MB`,
        parseMode: 'html',
      });

      try {
        const fileLocation = new Api.InputDocumentFileLocation({
          id: doc.id, accessHash: doc.accessHash, fileReference: doc.fileReference, thumbSize: '',
        });
        const CHUNK = 512 * 1024;
        const stream = Readable.from((async function* () {
          let offset = 0;
          while (offset < size) {
            let res;
            try {
              res = await client.invoke(new Api.upload.GetFile({ location: fileLocation, offset, limit: CHUNK }));
            } catch (err) { console.error('[GetFile]', err.message); break; }
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
          params: { Bucket: R2_BUCKET_NAME, Key: r2Key, Body: stream, ContentType: mime, CacheControl: 'public, max-age=31536000' },
          queueSize: isLarge ? 4 : 1, partSize: isLarge ? 10 * 1024 * 1024 : 5 * 1024 * 1024,
        });
        await upload.done();
        const shortId = crypto.randomBytes(4).toString('hex');
        await saveMeta(shortId, { name: fileName, mime, r2Key, size, ts: Date.now() });
        const token = signVideo(shortId, 720);
        const playUrl = `${BASE_URL}/v/${shortId}?t=${token}`;
        await client.deleteMessages(chatId, [status.id], { revoke: true }).catch(() => {});
        await client.sendMessage(chatId, {
          message: `✅ <b>Ready — App Only</b>\n\n📌 <b>${escapeHtml(fileName)}</b>\n📦 ${(size / 1024 / 1024).toFixed(2)} MB\n\n🔒 <b>Sirf app me play hoga</b>\n\n▶️ <b>Player Link:</b>\n${playUrl}`,
          parseMode: 'html',
        });
      } catch (e) {
        console.error('[Upload Error]', e.message);
        await client.deleteMessages(chatId, [status.id], { revoke: true }).catch(() => {});
        await client.sendMessage(chatId, { message: `❌ ${escapeHtml(e.message)}`, parseMode: 'html' });
      }
    } catch (err) {
      console.error('[HANDLER ERROR]', err.stack || err.message);
    }
  }, new NewMessage({}));

  // ===== CALLBACK BUTTONS =====
  client.addEventHandler(async (event) => {
    const q = event.query;
    if (!q) return;
    try { await q.answer(); } catch (e) { }
    const data = q.data.toString();
    const chatId = q.chatId || q.userId;
    const uid = q.userId;
    const msgId = q.msgId;

    if (data === 'menu_api') {
      const userData = await getUserKey(uid);
      if (userData) {
        await client.editMessage(chatId, {
          message: msgId,
          text: `🔑 <b>API Status</b>\n\n✅ <b>Already Connected</b>\n\n🔐 Key: <code>${escapeHtml(userData.apiKey.substring(0, 8))}...${escapeHtml(userData.apiKey.slice(-4))}</code>\n📅 Connected: ${new Date(userData.connectedAt).toLocaleString()}\n\nNayi key chahiye toh niche button dabao:`,
          parseMode: 'html',
          buttons: keyboard([
            [{ text: '🔄 Generate New Key', url: `${BASE_URL}/index.html?tg=${uid}` }],
            [{ text: '⬅️ Main Menu', callback_data: 'main_menu' }],
          ]),
        });
      } else {
        await client.editMessage(chatId, {
          message: msgId,
          text: `🔑 <b>API Connect</b>\n\nAPI key connect karne ke liye:\n\n<b>Step 1:</b> Niche button dabao\n<b>Step 2:</b> Key generate hogi browser me\n<b>Step 3:</b> Key copy karo\n<b>Step 4:</b> Yahan bhejo: <code>/api YOUR_KEY</code>`,
          parseMode: 'html',
          buttons: keyboard([
            [{ text: '🔑 Generate API Key', url: `${BASE_URL}/index.html?tg=${uid}` }],
            [{ text: '⬅️ Main Menu', callback_data: 'main_menu' }],
          ]),
        });
      }
      return;
    }

    if (data === 'menu_help') {
      await client.editMessage(chatId, {
        message: msgId,
        text: `📖 <b>How to Use MayaJaal Bot</b>\n\n` +
          `<b>Step 1 — API Connect (Ek baar):</b>\n` +
          `├ "🔑 API Connect" button dabao\n` +
          `├ Browser me API key milegi\n` +
          `├ Key copy karo\n` +
          `└ Bot me bhejo: <code>/api YOUR_KEY</code>\n\n` +
          `<b>Step 2 — Video Upload:</b>\n` +
          `├ Direct video/file bhejo (2GB tak)\n` +
          `└ Ya Terabox link paste karo\n\n` +
          `<b>Step 3 — Player Link:</b>\n` +
          `├ Bot signed link dega\n` +
          `├ Us link ko kholo\n` +
          `└ Play button → App download\n\n` +
          `<b>Step 4 — App Install:</b>\n` +
          `├ APK download karo\n` +
          `└ Install karke video dekho\n\n` +
          `<b>🔐 Security:</b>\n` +
          `├ HMAC-signed links\n` +
          `├ Browser playback disabled\n` +
          `└ 30-day link validity`,
        parseMode: 'html',
        buttons: keyboard([[{ text: '⬅️ Main Menu', callback_data: 'main_menu' }]]),
      });
      return;
    }

    if (data === 'menu_allbots') {
      await client.editMessage(chatId, {
        message: msgId,
        text: `🤖 <b>All MayaJaal Bots</b>\n\n` +
          `<b>1. 🎬 Stream Bot</b>\n` +
          `<i>Video upload + player link</i>\n` +
          `Status: ✅ Active\n\n` +
          `<b>2. 🔗 Link Converter Bot</b>\n` +
          `<i>Short link generator + earning</i>\n` +
          `Status: ✅ Active\n\n` +
          `<b>3. 📝 Content Bot</b>\n` +
          `<i>Coming soon</i>\n` +
          `Status: ⏳ Soon\n\n` +
          `<b>4. 🌐 Web Bot</b>\n` +
          `<i>Coming soon</i>\n` +
          `Status: ⏳ Soon\n\n` +
          `<i>Sabka data safe hai 🔒</i>`,
        parseMode: 'html',
        buttons: keyboard([[{ text: '⬅️ Main Menu', callback_data: 'main_menu' }]]),
      });
      return;
    }

    if (data === 'menu_account') {
      const userData = await getUserKey(uid);
      await client.editMessage(chatId, {
        message: msgId,
        text: `📊 <b>Your Account</b>\n\n` +
          `<b>User ID:</b> <code>${uid}</code>\n` +
          `<b>API Status:</b> ${userData ? '✅ Connected' : '❌ Not Connected'}\n` +
          (userData ? `<b>Connected Since:</b> ${new Date(userData.connectedAt).toLocaleString()}\n` : '') +
          `\n<b>Bot Version:</b> v2.0.0`,
        parseMode: 'html',
        buttons: keyboard([[{ text: '⬅️ Main Menu', callback_data: 'main_menu' }]]),
      });
      return;
    }

    if (data === 'menu_logout') {
      await client.editMessage(chatId, {
        message: msgId,
        text: `🚪 <b>Logout</b>\n\nKya aap API disconnect karna chahte hain?\n\nAapka data safe rahega.`,
        parseMode: 'html',
        buttons: keyboard([
          [{ text: '✅ Confirm Logout', callback_data: 'confirm_logout' }],
          [{ text: '❌ Cancel', callback_data: 'main_menu' }],
        ]),
      });
      return;
    }

    if (data === 'confirm_logout') {
      await deleteUserKey(uid);
      await client.editMessage(chatId, {
        message: msgId,
        text: `✅ <b>Logout Successful!</b>\n\nAPI key disconnect ho gayi.\n\nDobara connect karne ke liye /start bhejo.`,
        parseMode: 'html',
      });
      return;
    }

    if (data === 'main_menu') {
      await sendWelcome(chatId, uid, msgId);
      return;
    }
  }, new CallbackQuery({}));

  console.log('Bot ready — API + App-only mode');
})();
