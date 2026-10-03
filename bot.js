require('dotenv').config();

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const path = require('path');
const fs = require('fs');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

process.on('uncaughtException', (err) => console.error('[UncaughtException]:', err.message));
process.on('unhandledRejection', (reason) => console.error('[UnhandledRejection]:', reason));

// 1. Storage Setup
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

// 2. Cloudflare R2 Client Setup
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

console.log('✅ Cloudflare R2 Client Initialized');

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

app.get('/', (req, res) => res.send('Stream Engine Online'));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// Web Player Route (Direct Native HTML5 Player with Auto-Redirect Fallback)
app.get('/v/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let data = linkStore.get(id);

    if (!data) {
      const raw = (await redis.get(`video:${id}`)) || (await redis.get(`diskwala:${id}`));
      if (raw) data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    }

    if (!data) return res.status(404).send('Video not found or link expired');

    const videoTitle = data.name || 'Video Player';
    const isDiskwala = Boolean(data.isDiskwala);
    const diskwalaUrl = data.diskwalaUrl || '';
    const r2StreamUrl = `${BASE_URL}/stream/${id}`;

    res.send(`
      <!DOCTYPE html>
      <html lang="hi">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${videoTitle}</title>
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body { background: #0a0a0c; color: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; padding: 12px; }
          .player-card { width: 100%; max-width: 950px; background: #141419; border-radius: 16px; overflow: hidden; box-shadow: 0 15px 40px rgba(0,0,0,0.9); border: 1px solid #23232e; }
          .media-container { position: relative; width: 100%; padding-top: 56.25%; background: #000; }
          video { position: absolute; top: 0; left: 0; width: 100%; height: 100%; outline: none; }
          .status-layer { position: absolute; top: 0; left: 0; width: 100%; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; background: rgba(10,10,12,0.92); z-index: 10; gap: 14px; padding: 20px; text-align: center; }
          .spinner { width: 45px; height: 45px; border: 4px solid #2a2a35; border-top-color: #00ff88; border-radius: 50%; animation: spin 0.8s linear infinite; }
          @keyframes spin { to { transform: rotate(360deg); } }
          .play-btn { background: #00ff88; color: #000; font-weight: bold; border: none; padding: 12px 24px; border-radius: 8px; font-size: 1rem; cursor: pointer; text-decoration: none; display: inline-block; }
          .info-area { padding: 16px 20px; }
          .title { font-size: 1.05rem; font-weight: 600; color: #00ff88; word-break: break-all; }
        </style>
      </head>
      <body>
        <div class="player-card">
          <div class="media-container">
            <video id="videoElement" controls playsinline preload="auto"></video>
            <div id="loaderLayer" class="status-layer">
              <div class="spinner" id="spin"></div>
              <p id="msg">Video stream shuru ho rahi hai...</p>
              <a id="directBtn" href="#" class="play-btn" style="display:none;" target="_blank">Direct Web Player Mein Dekhein</a>
            </div>
          </div>
          <div class="info-area">
            <div class="title">🎬 ${videoTitle}</div>
          </div>
        </div>

        <script>
          const video = document.getElementById('videoElement');
          const loader = document.getElementById('loaderLayer');
          const spin = document.getElementById('spin');
          const msg = document.getElementById('msg');
          const directBtn = document.getElementById('directBtn');

          const isDiskwala = ${isDiskwala};
          const r2Url = "${r2StreamUrl}";
          const targetUrl = "${diskwalaUrl}";

          if (!isDiskwala) {
            // Direct Cloudflare R2 Stream
            video.src = r2Url;
            video.addEventListener('canplay', () => { loader.style.display = 'none'; });
            video.play().catch(() => {});
          } else {
            // Diskwala Smart Stream Resolver
            directBtn.href = targetUrl;
            directBtn.style.display = 'inline-block';
            spin.style.display = 'none';
            msg.innerHTML = "Diskwala security ke kaaran iframe block karta hai.<br>Seedha niche diye gaye button par click karke stream karein:";

            // Client-side auto redirect for seamless mobile playback
            setTimeout(() => {
              window.location.href = targetUrl;
            }, 1200);
          }
        </script>
      </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Player error: ' + err.message);
  }
});

// Domain Streaming Route (R2 Chunk Streaming)
app.get('/stream/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let data = linkStore.get(id);

    if (!data) {
      const raw = (await redis.get(`video:${id}`)) || (await redis.get(`diskwala:${id}`));
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

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
// 4. Telegram Bot Handlers
const bot = new TelegramBot(TOKEN, { polling: { autoStart: true, params: { timeout: 10 } } });

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
    `🎬 <b>Stream Converter Bot</b>\n\n` +
    `• <b>Direct Video:</b> File bhejein, R2 par save hokar direct play link banega.\n` +
    `• <b>Diskwala Link:</b> Link bhejein, aapke custom domain player me turant convert ho jayega.`,
    { parse_mode: 'HTML' }
  );
});

// Video direct Cloudflare R2 Upload
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const uploaderName = msg.from?.username ? `@${msg.from.username}` : (msg.from?.first_name || 'User');

  // Direct Telegram Video File
  const videoObj = msg.video || msg.document || (msg.animation ? msg.animation : null);
  if (videoObj) {
    const fileId = videoObj.file_id;
    const fileName = videoObj.file_name || `video_${Date.now()}.mp4`;
    const statusMsg = await bot.sendMessage(chatId, `⚡ <i>Video Cloudflare R2 par upload ho rahi hai...</i>`, { parse_mode: 'HTML' });

    try {
      const fileLink = await bot.getFileLink(fileId);
      const videoDownloadStream = await axios.get(fileLink, { responseType: 'stream' });

      const fileExt = path.extname(fileName) || '.mp4';
      const r2Key = `uploads/${crypto.randomBytes(8).toString('hex')}${fileExt}`;

      const parallelUpload = new Upload({
        client: r2Client,
        params: {
          Bucket: R2_BUCKET_NAME,
          Key: r2Key,
          Body: videoDownloadStream.data,
          ContentType: videoObj.mime_type || 'video/mp4',
        },
        queueSize: 4,
        partSize: 1024 * 1024 * 5,
      });

      await parallelUpload.done();

      const shortId = crypto.randomBytes(4).toString('hex');
      const payload = { name: fileName, r2Key: r2Key, isDiskwala: false, uploader: uploaderName };
      
      linkStore.set(shortId, payload);
      await redis.set(`video:${shortId}`, JSON.stringify(payload), { ex: 30 * 86400 });

      const playUrl = `${BASE_URL}/v/${shortId}`;
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});

      const reply = `✨ <b>Video Ready!</b>\n\n` +
                    `📌 <b>File:</b> ${escapeHtml(fileName)}\n\n` +
                    `🔗 <b>Aapka Domain Player Link:</b>\n${playUrl}`;

      return bot.sendMessage(chatId, reply, { parse_mode: 'HTML', disable_web_page_preview: false });

    } catch (err) {
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      return bot.sendMessage(chatId, `❌ <b>Upload Error:</b> <code>${escapeHtml(err.message)}</code>`, { parse_mode: 'HTML' });
    }
  }

  // Link receive
  const incomingText = (msg.text || '').trim();
  if (!incomingText || incomingText.startsWith('/')) return;

  const urlRegex = /(https?:\/\/[^\s<>"']+)/gi;
  const urls = incomingText.match(urlRegex) || [];
  if (urls.length === 0) return;

  const targetUrl = urls[0];

  // Diskwala Instant Link Engine
  if (targetUrl.includes('diskwala.com')) {
    const statusMsg = await bot.sendMessage(chatId, `⚡ <i>Diskwala stream link generate ho rahi hai...</i>`, { parse_mode: 'HTML' });

    try {
      const idMatch = targetUrl.match(/\/(?:app|file|share|d)\/([a-zA-Z0-9]+)/i);
      const fileId = idMatch ? idMatch[1] : '';

      if (!fileId) {
        await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
        return bot.sendMessage(chatId, `❌ <b>Error:</b> Diskwala link se ID extract nahi ho saki.`, { parse_mode: 'HTML' });
      }

      const diskwalaWebUrl = `https://www.diskwala.com/app/${fileId}`;
      const shortId = crypto.randomBytes(4).toString('hex');

      const payload = {
        name: `Diskwala Video (${fileId})`,
        isDiskwala: true,
        diskwalaUrl: diskwalaWebUrl,
        uploader: uploaderName
      };

      linkStore.set(shortId, payload);
      await redis.set(`video:${shortId}`, JSON.stringify(payload), { ex: 30 * 86400 });

      const playUrl = `${BASE_URL}/v/${shortId}`;
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});

      const reply = `✨ <b>Diskwala Stream Ready!</b>\n\n` +
                    `🔗 <b>Aapka Custom Player Link:</b>\n${playUrl}`;

      return bot.sendMessage(chatId, reply, { parse_mode: 'HTML', disable_web_page_preview: false });

    } catch (err) {
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      return bot.sendMessage(chatId, `❌ <b>Error:</b> <code>${escapeHtml(err.message)}</code>`, { parse_mode: 'HTML' });
    }
  }
});
