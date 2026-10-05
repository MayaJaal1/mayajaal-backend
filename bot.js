require('dotenv').config();

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const path = require('path');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

process.on('uncaughtException', (err) => console.error('[UncaughtException]:', err.message));
process.on('unhandledRejection', (reason) => console.error('[UnhandledRejection]:', reason));

// ================= Redis =================
let redis;
try {
  redis = Redis.fromEnv();
} catch (e) {
  redis = { get: async () => null, set: async () => null };
}

const linkStore = new Map();

// ================= ENV =================
const TOKEN = (process.env.BOT_TOKEN || '').trim();
const BASE_URL = process.env.CUSTOM_DOMAIN
  ? (process.env.CUSTOM_DOMAIN.startsWith('http')
      ? process.env.CUSTOM_DOMAIN
      : `https://${process.env.CUSTOM_DOMAIN}`)
  : 'https://mayajaal.online';

const LOCAL_API_URL = (process.env.LOCAL_BOT_API_URL || 'https://tg-local-api-gxrv.onrender.com')
  .trim().replace(/\/$/, '');

const R2_ACCOUNT_ID          = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID       = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY   = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME         = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_URL          = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
const MAX_FILE_SIZE          = parseInt(process.env.MAX_FILE_SIZE || '2147483648', 10);

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
  throw new Error('❌ R2 env vars missing. Check .env');
}

// ================= R2 Client =================
const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

console.log('✅ Cloudflare R2 Initialized');

// ================= Express =================
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static(__dirname));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/', (req, res) => res.send('Stream Engine Online'));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ================= Player Page =================
app.get('/v/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let data = linkStore.get(id);

    if (!data) {
      const raw = await redis.get(`video:${id}`);
      if (raw) data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    }

    if (!data || !data.r2Key) {
      return res.status(404).send('Video not found or processing');
    }

    const streamUrl = `${BASE_URL}/stream/${id}`;
    const videoTitle = data.name || 'Video Player';

    res.send(`
      <!DOCTYPE html>
      <html lang="hi">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${videoTitle}</title>
        <link rel="stylesheet" href="https://cdn.plyr.io/3.7.8/plyr.css" />
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body { background:#000; color:#fff; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; min-height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:12px; }
          .player-box { width:100%; max-width:900px; padding:10px; }
          video { width:100%; max-height:80vh; border-radius:12px; background:#111; outline:none; }
          .title { margin-top:15px; font-size:1.05rem; color:#00ff88; word-break:break-all; }
        </style>
      </head>
      <body>
        <div class="player-box">
          <video id="player" controls autoplay playsinline preload="metadata">
            <source src="${streamUrl}" type="video/mp4">
          </video>
          <div class="title">🎬 ${videoTitle}</div>
        </div>
        <script src="https://cdn.plyr.io/3.7.8/plyr.polyfilled.js"></script>
        <script>new Plyr('#player');</script>
      </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Player error: ' + err.message);
  }
});

// ================= R2 Range Streaming =================
app.get('/stream/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let data = linkStore.get(id);

    if (!data) {
      const raw = await redis.get(`video:${id}`);
      if (raw) data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    }
    if (!data?.r2Key) return res.status(404).send('Not found');

    const range = req.headers.range;

    const out = await r2Client.send(new GetObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: data.r2Key,
      Range: range || undefined,
    }));

    res.status(range ? 206 : 200);
    res.setHeader('Content-Type', out.ContentType || data.mime || 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    if (out.ContentRange)  res.setHeader('Content-Range', out.ContentRange);
    if (out.ContentLength) res.setHeader('Content-Length', out.ContentLength);
    if (out.ETag)          res.setHeader('ETag', out.ETag);

    out.Body.on('error', (e) => {
      console.error('[R2 stream error]', e.message);
      if (!res.headersSent) res.status(500);
      res.end();
    });

    out.Body.pipe(res);
  } catch (err) {
    console.error('[stream]', err.message);
    if (!res.headersSent) res.status(500).send('Streaming error');
  }
});

app.listen(PORT, () => console.log(`🚀 Web Server running on port ${PORT}`));
// ================= Bot Init =================
const bot = new TelegramBot(TOKEN, {
  polling: { autoStart: true, params: { timeout: 10 } },
  baseApiUrl: LOCAL_API_URL,
});

bot.on('polling_error', async (error) => {
  if (error.message && error.message.includes('409 Conflict')) {
    await new Promise(r => setTimeout(r, 4000));
  }
});

function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])
  );
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `🎬 <b>MayaJaal Stream Converter Bot</b>\n\n` +
    `⚡ Direct file send karein, streaming link ban jayegi!`,
    { parse_mode: 'HTML' }
  );
});

// ================= File Upload Handler =================
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const uploader = msg.from?.username
    ? `@${msg.from.username}`
    : (msg.from?.first_name || 'User');

  const mediaObj = msg.video || msg.document || msg.audio || msg.animation || null;
  if (!mediaObj) return;

  const fileId   = mediaObj.file_id;
  const fileName = mediaObj.file_name || `file_${Date.now()}.mp4`;
  const mime     = mediaObj.mime_type || 'application/octet-stream';
  const size     = mediaObj.file_size || 0;

  if (size && size > MAX_FILE_SIZE) {
    return bot.sendMessage(
      chatId,
      `❌ File too large. Max ${(MAX_FILE_SIZE/1024/1024).toFixed(0)} MB allowed.`
    );
  }

  const statusMsg = await bot.sendMessage(
    chatId,
    `⚡ <i>Telegram → Cloudflare R2 direct upload chal raha hai...</i>`,
    { parse_mode: 'HTML' }
  );

  try {
    const fileInfo = await bot.getFile(fileId);
    if (!fileInfo?.file_path) throw new Error('Telegram file_path nahi mila');

    let filePath = fileInfo.file_path;
    if (filePath.includes(TOKEN)) filePath = filePath.split(TOKEN).pop();
    filePath = filePath.replace(/^\/+/, '');

    const urls = [
      `https://api.telegram.org/file/bot${TOKEN}/${filePath}`,
      `${LOCAL_API_URL}/file/bot${TOKEN}/${filePath}`,
    ];

    let stream = null, lastErr = null;
    for (const url of urls) {
      try {
        const r = await axios.get(url, {
          responseType: 'stream',
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          timeout: 0,
          validateStatus: (s) => s >= 200 && s < 400,
        });
        stream = r.data;
        stream.on('error', (e) => console.error('[TG stream error]', e.message));
        break;
      } catch (e) {
        lastErr = e;
        console.warn(`[Download fail] ${url} → ${e.message}`);
      }
    }
    if (!stream) throw new Error(`Download failed: ${lastErr?.message}`);

    const ext = path.extname(fileName) || (mime.startsWith('video') ? '.mp4' : '');
    const r2Key = `uploads/${crypto.randomBytes(8).toString('hex')}${ext}`;

    const isLarge = size > 100 * 1024 * 1024;

    const uploaderS3 = new Upload({
      client: r2Client,
      params: {
        Bucket: R2_BUCKET_NAME,
        Key: r2Key,
        Body: stream,
        ContentType: mime,
        CacheControl: 'public, max-age=31536000, immutable',
        Metadata: { uploader, originalName: encodeURIComponent(fileName) },
      },
      queueSize: isLarge ? 4 : 1,
      partSize: isLarge ? 10 * 1024 * 1024 : 5 * 1024 * 1024,
      leavePartsOnError: false,
    });

    await uploaderS3.done();

    const shortId = crypto.randomBytes(4).toString('hex');
    const payload = { name: fileName, mime, r2Key, uploader, size, ts: Date.now() };

    linkStore.set(shortId, payload);
    await redis.set(`video:${shortId}`, JSON.stringify(payload), { ex: 30 * 86400 });

    const playUrl = `${BASE_URL}/v/${shortId}`;
    const direct  = R2_PUBLIC_URL ? `${R2_PUBLIC_URL}/${r2Key}` : null;

    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});

    let reply = `✨ <b>Upload complete</b>\n\n` +
                `📌 <b>File:</b> ${escapeHtml(fileName)}\n` +
                `📦 <b>Size:</b> ${(size/1024/1024).toFixed(2)} MB\n\n` +
                `▶️ <b>Player:</b>\n${playUrl}`;
    if (direct) reply += `\n\n⬇️ <b>Direct:</b>\n${direct}`;

    return bot.sendMessage(chatId, reply, { parse_mode: 'HTML' });

  } catch (err) {
    console.error('[Upload Error]:', err.stack || err.message);
    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    return bot.sendMessage(
      chatId,
      `❌ <b>Upload Error:</b>\n<code>${escapeHtml(err.message)}</code>`,
      { parse_mode: 'HTML' }
    );
  }
});
