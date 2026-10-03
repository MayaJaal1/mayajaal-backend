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

// 1. Redis Cache Setup
let redis;
try {
  redis = Redis.fromEnv();
} catch (e) {
  redis = { get: async () => null, set: async () => null };
}

const linkStore = new Map();
const TOKEN = (process.env.BOT_TOKEN || '').trim();
const BASE_URL = process.env.CUSTOM_DOMAIN 
  ? (process.env.CUSTOM_DOMAIN.startsWith('http') ? process.env.CUSTOM_DOMAIN : `https://${process.env.CUSTOM_DOMAIN}`)
  : 'https://mayajaal.online';

// 2. Cloudflare R2 S3 Client Setup
const R2_ACCOUNT_ID = String(process.env.R2_ACCOUNT_ID || '9a17e6f8a4af372b6b0ab1ad1cdb982d').trim();
const R2_ACCESS_KEY_ID = String(process.env.R2_ACCESS_KEY_ID || 'fe0370e7a3f380c0dee831d6c37fd851').trim();
const R2_SECRET_ACCESS_KEY = String(process.env.R2_SECRET_ACCESS_KEY || '').trim();
const R2_BUCKET_NAME = String(process.env.R2_BUCKET_NAME || '').trim();

const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

console.log('✅ Cloudflare R2 Initialized');

// 3. Express Web Engine
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

app.get('/', (req, res) => res.send('Stream Engine Online - 2GB Local Render API Active'));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// HTML5 Video Player
app.get('/v/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let data = linkStore.get(id);

    if (!data) {
      const raw = await redis.get(`video:${id}`);
      if (raw) data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    }

    if (!data || !data.r2Key) {
      return res.status(404).send('Video not found or processing on Cloudflare R2');
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
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body { background: #000; color: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; padding: 12px; }
          .player-box { width: 100%; max-width: 900px; padding: 10px; }
          video { width: 100%; max-height: 80vh; border-radius: 12px; background: #111; outline: none; box-shadow: 0 10px 30px rgba(0,0,0,0.8); }
          .title { margin-top: 15px; font-size: 1.1rem; color: #00ff88; word-break: break-all; }
        </style>
      </head>
      <body>
        <div class="player-box">
          <video controls autoplay playsinline preload="metadata">
            <source src="${streamUrl}" type="video/mp4">
            Aapka browser video play karne me samarth nahi hai.
          </video>
          <div class="title">🎬 ${videoTitle}</div>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Player error: ' + err.message);
  }
});

// Domain Range Streaming Route
app.get('/stream/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let data = linkStore.get(id);

    if (!data) {
      const raw = await redis.get(`video:${id}`);
      if (raw) data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    }

    if (!data || !data.r2Key) return res.status(404).send('Stream not found');

    const range = req.headers.range;
    const command = new GetObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: data.r2Key,
      Range: range || undefined,
    });

    const response = await r2Client.send(command);

    res.status(range ? 206 : 200);
    res.setHeader('Content-Type', response.ContentType || 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    if (response.ContentRange) res.setHeader('Content-Range', response.ContentRange);
    if (response.ContentLength) res.setHeader('Content-Length', response.ContentLength);

    return response.Body.pipe(res);
  } catch (err) {
    if (!res.headersSent) res.status(500).send('Streaming error');
  }
});

app.listen(PORT, () => console.log(`🚀 Web Server running on port ${PORT}`));
// 4. Render Local Bot API Client (Unlocks 2GB Limit)
const LOCAL_API_URL = process.env.LOCAL_BOT_API_URL 
  ? process.env.LOCAL_BOT_API_URL.trim().replace(/\/$/, '') 
  : 'https://tg-local-api-gxrv.onrender.com';

const botOptions = {
  polling: { autoStart: true, params: { timeout: 10 } },
  baseApiUrl: LOCAL_API_URL
};

console.log(`🔗 Connecting to 2GB Local Bot API Server: ${LOCAL_API_URL}`);

const bot = new TelegramBot(TOKEN, botOptions);

bot.on('polling_error', async (error) => {
  if (error.message && error.message.includes('409 Conflict')) {
    await new Promise(r => setTimeout(r, 4000));
  }
});

function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `🎬 <b>MayaJaal Stream Converter Bot (2GB Active)</b>\n\n` +
    `⚡ <b>Local API Server Connected!</b>\n` +
    `Ab aap <b>50MB, 500MB, 1GB ya 2GB tak</b> ki video file direct Telegram par bhejein, direct Cloudflare R2 par upload hokar play link banegi!`,
    { parse_mode: 'HTML' }
  );
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const uploaderName = msg.from?.username ? `@${msg.from.username}` : (msg.from?.first_name || 'User');

  const videoObj = msg.video || msg.document || (msg.animation ? msg.animation : null);
  if (videoObj) {
    const fileId = videoObj.file_id;
    const fileName = videoObj.file_name || `video_${Date.now()}.mp4`;

    const statusMsg = await bot.sendMessage(chatId, `⚡ <i>Video fetch karke Cloudflare R2 par upload ho rahi hai... (2GB Limit Allowed)</i>`, { parse_mode: 'HTML' });

    try {
      const fileLink = await bot.getFileLink(fileId);
      console.log(`[Media Download]: Fetching file -> ${fileLink}`);

      const videoDownloadStream = await axios.get(fileLink, {
        responseType: 'stream',
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });

      const fileExt = path.extname(fileName) || '.mp4';
      const r2Key = `uploads/${crypto.randomBytes(8).toString('hex')}${fileExt}`;

      console.log(`[Cloudflare R2]: Uploading to R2 key ${r2Key}...`);

      const parallelUpload = new Upload({
        client: r2Client,
        params: {
          Bucket: R2_BUCKET_NAME,
          Key: r2Key,
          Body: videoDownloadStream.data,
          ContentType: videoObj.mime_type || 'video/mp4',
        },
        queueSize: 4,
        partSize: 1024 * 1024 * 10,
      });

      await parallelUpload.done();

      const shortId = crypto.randomBytes(4).toString('hex');
      const payload = { name: fileName, r2Key: r2Key, uploader: uploaderName };
      
      linkStore.set(shortId, payload);
      await redis.set(`video:${shortId}`, JSON.stringify(payload), { ex: 30 * 86400 });

      const playUrl = `${BASE_URL}/v/${shortId}`;
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});

      const reply = `✨ <b>Video Ready (Cloudflare R2)!</b>\n\n` +
                    `📌 <b>File:</b> ${escapeHtml(fileName)}\n\n` +
                    `🔗 <b>Aapka Domain Player Link:</b>\n${playUrl}`;

      return bot.sendMessage(chatId, reply, { parse_mode: 'HTML', disable_web_page_preview: false });

    } catch (err) {
      console.error('[Upload Error]:', err.message);
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      return bot.sendMessage(chatId, `❌ <b>Upload Error:</b> <code>${escapeHtml(err.message)}</code>`, { parse_mode: 'HTML' });
    }
  }
});
