require('dotenv').config();

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const { Redis } = require('@upstash/redis');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

process.on('uncaughtException', (e) => console.error('[Uncaught]', e.stack || e.message));
process.on('unhandledRejection', (e) => console.error('[Unhandled]', e?.stack || e));

// ================= ENV CHECK =================
console.log('=== ENV DEBUG START ===');
console.log('PORT:', process.env.PORT);
console.log('BOT_TOKEN set?', !!process.env.BOT_TOKEN);
console.log('CUSTOM_DOMAIN:', process.env.CUSTOM_DOMAIN);
console.log('LOCAL_API_URL:', process.env.LOCAL_API_URL);
console.log('R2_ACCOUNT_ID set?', !!process.env.R2_ACCOUNT_ID);
console.log('R2_ACCESS_KEY_ID set?', !!process.env.R2_ACCESS_KEY_ID);
console.log('R2_SECRET_ACCESS_KEY set?', !!process.env.R2_SECRET_ACCESS_KEY);
console.log('R2_BUCKET_NAME set?', !!process.env.R2_BUCKET_NAME);
console.log('=== ENV DEBUG END ===');

// ================= CONFIG =================
const TOKEN = (process.env.BOT_TOKEN || '').trim();
const BASE_URL = process.env.CUSTOM_DOMAIN
  ? (process.env.CUSTOM_DOMAIN.startsWith('http')
      ? process.env.CUSTOM_DOMAIN
      : `https://${process.env.CUSTOM_DOMAIN}`)
  : 'https://mayajaal.online';

const LOCAL_API_URL = (process.env.LOCAL_API_URL || '').trim().replace(/\/$/, '');

const R2_ACCOUNT_ID = (process.env.R2_ACCOUNT_ID || '').trim();
const R2_ACCESS_KEY_ID = (process.env.R2_ACCESS_KEY_ID || '').trim();
const R2_SECRET_ACCESS_KEY = (process.env.R2_SECRET_ACCESS_KEY || '').trim();
const R2_BUCKET_NAME = (process.env.R2_BUCKET_NAME || '').trim();
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').trim().replace(/\/$/, '');
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || '2147483648', 10);
const PORT = parseInt(process.env.PORT || '8080', 10);

if (!TOKEN) console.error('⚠️ BOT_TOKEN missing');
if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
  console.error('⚠️ R2 config incomplete');
}

// ================= REDIS =================
let redis;
try {
  redis = Redis.fromEnv();
  console.log('✅ Redis connected');
} catch (e) {
  redis = { get: async () => null, set: async () => null };
}

const memStore = new Map();

async function saveMeta(id, payload) {
  memStore.set(id, payload);
  try { await redis.set(`v:${id}`, JSON.stringify(payload), { ex: 30 * 86400 }); } catch (e) { }
}

async function getMeta(id) {
  if (memStore.has(id)) return memStore.get(id);
  try {
    const raw = await redis.get(`v:${id}`);
    if (raw) {
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      memStore.set(id, data);
      return data;
    }
  } catch (e) { }
  return null;
}

// ================= R2 CLIENT =================
let r2 = null;
if (R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET_NAME) {
  r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
  console.log('✅ R2 initialized for bucket:', R2_BUCKET_NAME);
} else {
  console.error('❌ R2 NOT initialized');
}

// ================= EXPRESS =================
const app = express();
app.use(express.json());

app.get('/', (req, res) => res.send('Stream Engine Online'));
app.get('/health', (req, res) => res.json({
  ok: true,
  uptime: process.uptime(),
  r2Ready: !!r2,
  env: {
    botToken: !!TOKEN,
    r2Account: !!R2_ACCOUNT_ID,
    r2AccessKey: !!R2_ACCESS_KEY_ID,
    r2Secret: !!R2_SECRET_ACCESS_KEY,
    r2Bucket: !!R2_BUCKET_NAME,
  },
}));

// ================= PLAYER PAGE =================
app.get('/v/:id', async (req, res) => {
  try {
    const meta = await getMeta(req.params.id);
    if (!meta) return res.status(404).send('Not found');

    const streamUrl = `${BASE_URL}/stream/${req.params.id}`;
    const title = escapeHtml(meta.name || 'Video');

    res.send(`<!DOCTYPE html>
<html lang="hi"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="https://cdn.plyr.io/3.7.8/plyr.css">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0a;color:#fff;font-family:-apple-system,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:12px}
.box{width:100%;max-width:960px}
video{width:100%;max-height:80vh;border-radius:14px;background:#000}
.t{margin-top:14px;font-size:1rem;color:#00ff88;word-break:break-all;opacity:.9}
</style></head><body>
<div class="box">
<video id="p" controls autoplay playsinline preload="metadata">
<source src="${streamUrl}" type="${meta.mime || 'video/mp4'}">
</video>
<div class="t">🎬 ${title}</div>
</div>
<script src="https://cdn.plyr.io/3.7.8/plyr.polyfilled.js"></script>
<script>new Plyr('#p');</script>
</body></html>`);
  } catch (e) {
    res.status(500).send('err: ' + e.message);
  }
});

// ================= STREAM FROM R2 =================
app.get('/stream/:id', async (req, res) => {
  try {
    if (!r2) return res.status(500).send('R2 not configured');
    const meta = await getMeta(req.params.id);
    if (!meta?.r2Key) return res.status(404).send('Not found');

    const out = await r2.send(new GetObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: meta.r2Key,
      Range: req.headers.range || undefined,
    }));

    res.status(req.headers.range ? 206 : 200);
    res.setHeader('Content-Type', out.ContentType || meta.mime || 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    if (out.ContentRange) res.setHeader('Content-Range', out.ContentRange);
    if (out.ContentLength) res.setHeader('Content-Length', out.ContentLength);
    if (out.ETag) res.setHeader('ETag', out.ETag);

    out.Body.on('error', () => { if (!res.headersSent) res.status(500); res.end(); });
    out.Body.pipe(res);
  } catch (e) {
    console.error('[stream]', e.message);
    if (!res.headersSent) res.status(500).send('err');
  }
});

app.listen(PORT, () => console.log(`🚀 Web on port ${PORT}`));

// ================= HELPERS =================
function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function pickMedia(msg) {
  return msg.video || msg.document || msg.audio || msg.animation || null;
}

// ================= BOT =================
if (!TOKEN) {
  console.error('❌ BOT_TOKEN missing');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, {
  polling: { autoStart: true, params: { timeout: 10 } },
});

bot.on('polling_error', async (e) => {
  console.error('[polling_error]', e.message);
  if (e.message?.includes('409')) await new Promise(r => setTimeout(r, 4000));
});

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `🎬 <b>MayaJaal Stream Bot</b>\n\n` +
    `⚡ File bhejo → R2 direct upload.`,
    { parse_mode: 'HTML' });
});

// ================= UPLOAD HANDLER =================
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const media = pickMedia(msg);
  if (!media) return;

  if (!r2) {
    return bot.sendMessage(chatId, '❌ R2 config missing.');
  }

  const uploader = msg.from?.username
    ? `@${msg.from.username}`
    : (msg.from?.first_name || 'User');

  const fileId = media.file_id;
  const fileName = media.file_name || `file_${Date.now()}.mp4`;
  const mime = media.mime_type || 'application/octet-stream';
  const size = media.file_size || 0;

  if (size && size > MAX_FILE_SIZE) {
    return bot.sendMessage(chatId,
      `❌ File too large. Max ${(MAX_FILE_SIZE / 1024 / 1024).toFixed(0)} MB.`);
  }

  const status = await bot.sendMessage(chatId, `⚡ <i>Uploading...</i>`, { parse_mode: 'HTML' });

  try {
    // Step 1: Telegram se file path lo
    const info = await bot.getFile(fileId);
    if (!info?.file_path) throw new Error('file_path not returned');

    let fp = info.file_path.split(TOKEN).pop();
    fp = fp.replace(/^\/+/, '');

    // Step 2: File download karo — pehle official, phir local
    const urlsToTry = [
      `https://api.telegram.org/file/bot${TOKEN}/${fp}`,
    ];
    if (LOCAL_API_URL) {
      urlsToTry.push(`${LOCAL_API_URL}/file/bot${TOKEN}/${fp}`);
    }

    let stream = null;
    let lastErr = null;

    for (const url of urlsToTry) {
      try {
        console.log('[⬇️] Trying:', url);
        const resp = await axios.get(url, {
          responseType: 'stream',
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          timeout: 120000,
          validateStatus: (s) => s >= 200 && s < 400,
        });
        stream = resp.data;
        stream.on('error', (e) => console.error('[TG stream err]', e.message));
        console.log('[✅] Download from:', url);
        break;
      } catch (e) {
        lastErr = e;
        console.warn('[❌] Failed:', url, '→', e.message);
      }
    }

    if (!stream) {
      throw new Error(`Download failed: ${lastErr?.message || 'All URLs failed'}`);
    }

    // Step 3: R2 pe upload karo
    const ext = path.extname(fileName) || (mime.startsWith('video') ? '.mp4' : '');
    const r2Key = `uploads/${crypto.randomBytes(8).toString('hex')}${ext}`;
    const isLarge = size > 100 * 1024 * 1024;

    console.log('[⬆️] Uploading to R2:', r2Key, `(${(size / 1024 / 1024).toFixed(2)} MB)`);

    const upload = new Upload({
      client: r2,
      params: {
        Bucket: R2_BUCKET_NAME,
        Key: r2Key,
        Body: stream,
        ContentType: mime,
        CacheControl: 'public, max-age=31536000, immutable',
        Metadata: {
          uploader,
          originalname: encodeURIComponent(fileName),
        },
      },
      queueSize: isLarge ? 4 : 1,
      partSize: isLarge ? 10 * 1024 * 1024 : 5 * 1024 * 1024,
      leavePartsOnError: false,
    });

    await upload.done();
    console.log('[✅] Uploaded to R2:', r2Key);

    // Step 4: Metadata save karo
    const shortId = crypto.randomBytes(4).toString('hex');
    await saveMeta(shortId, {
      name: fileName, mime, r2Key,
      uploader, size, ts: Date.now(),
    });

    const playUrl = `${BASE_URL}/v/${shortId}`;
    const directUrl = R2_PUBLIC_URL ? `${R2_PUBLIC_URL}/${r2Key}` : null;

    await bot.deleteMessage(chatId, status.message_id).catch(() => { });

    let reply = `✅ <b>Upload complete</b>\n\n` +
      `📌 <b>${escapeHtml(fileName)}</b>\n` +
      `📦 ${(size / 1024 / 1024).toFixed(2)} MB\n\n` +
      `▶️ <b>Player:</b>\n${playUrl}`;
    if (directUrl) reply += `\n\n⬇️ <b>Direct:</b>\n${directUrl}`;

    bot.sendMessage(chatId, reply, { parse_mode: 'HTML' });

  } catch (e) {
    console.error('[❌]', e.stack || e.message);
    await bot.deleteMessage(chatId, status.message_id).catch(() => { });
    bot.sendMessage(chatId,
      `❌ <b>Error:</b>\n<code>${escapeHtml(e.message)}</code>`,
      { parse_mode: 'HTML' });
  }
});

console.log('🤖 Bot started');
