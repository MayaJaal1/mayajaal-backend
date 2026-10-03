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

// Web Player Route (Direct HTML5 Player + Client Resolver)
app.get('/v/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let data = linkStore.get(id);

    if (!data) {
      const raw = (await redis.get(`video:${id}`)) || (await redis.get(`terabox:${id}`));
      if (raw) data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    }

    if (!data) return res.status(404).send('Video not found or link expired');

    const videoTitle = data.name || 'Video Player';
    const isR2 = Boolean(data.r2Key);
    const r2StreamUrl = `${BASE_URL}/stream/${id}`;
    const teraboxKey = data.teraboxKey || '';

    res.send(`
      <!DOCTYPE html>
      <html lang="hi">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${videoTitle}</title>
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body { background: #0b0c10; color: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; padding: 15px; }
          .player-wrapper { width: 100%; max-width: 960px; background: #1f2833; border-radius: 16px; overflow: hidden; box-shadow: 0 12px 40px rgba(0,0,0,0.8); }
          .video-container { position: relative; width: 100%; padding-top: 56.25%; background: #000; }
          video, iframe { position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: none; outline: none; }
          .info-bar { padding: 16px 20px; display: flex; flex-direction: column; gap: 8px; }
          .title { font-size: 1.1rem; font-weight: 600; color: #66fcf1; word-break: break-all; }
          .loading-text { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #66fcf1; font-size: 14px; font-weight: 500; }
        </style>
      </head>
      <body>
        <div class="player-wrapper">
          <div class="video-container" id="playerContainer">
            ${isR2 ? `
              <video controls autoplay playsinline preload="metadata">
                <source src="${r2StreamUrl}" type="video/mp4">
              </video>
            ` : `
              <div class="loading-text" id="loadStatus">Video load ho rahi hai...</div>
              <iframe id="streamFrame" allowfullscreen allow="autoplay; fullscreen"></iframe>
            `}
          </div>
          <div class="info-bar">
            <div class="title">🎬 ${videoTitle}</div>
          </div>
        </div>

        ${!isR2 ? `
        <script>
          const key = "${teraboxKey}";
          const frame = document.getElementById('streamFrame');
          const status = document.getElementById('loadStatus');

          // Multi-proxy auto player loader
          const playUrls = [
            'https://yt-video-production.up.railway.app/player?surl=' + key,
            'https://www.1024tera.com/sharing/embed?surl=' + key,
            'https://terabox.app/sharing/embed?surl=' + key
          ];

          let curr = 0;
          function tryNext() {
            if (curr < playUrls.length) {
              frame.src = playUrls[curr++];
            } else {
              status.innerText = "Video load nahi ho saki. Kripya reload karein.";
            }
          }
          frame.onload = () => { status.style.display = 'none'; };
          frame.onerror = tryNext;
          tryNext();
        </script>
        ` : ''}
      </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Player error: ' + err.message);
  }
});

// Domain Streaming Route (For R2 Files)
app.get('/stream/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let data = linkStore.get(id);

    if (!data) {
      const raw = (await redis.get(`video:${id}`)) || (await redis.get(`terabox:${id}`));
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
// 4. Accurate Terabox Key Extractor
function parseTeraboxKey(rawUrl) {
  let target = rawUrl.trim();

  // Sabhi standard Terabox domains aur short format match karein
  const match = target.match(/\/s\/1?([a-zA-Z0-9_-]+)/i) ||
                target.match(/[?&]surl=1?([a-zA-Z0-9_-]+)/i) ||
                target.match(/\/(?:s|sharing\/link\?surl=)1?([a-zA-Z0-9_-]+)/i);

  if (match && match[1]) {
    return match[1];
  }

  if (target.includes('/s/')) {
    let part = target.split('/s/')[1].split(/[?&#/]/)[0];
    if (part.startsWith('1')) part = part.substring(1);
    return part;
  }

  return null;
}

// 5. Telegram Bot Handlers
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
    `• <b>Video File:</b> File bhejein, direct aapke Cloudflare R2 se fast stream hogi.\n` +
    `• <b>Terabox Link:</b> Terabox / Terasharefile link bhejein, aapke custom domain player me turant open hogi.`,
    { parse_mode: 'HTML' }
  );
});

// Video direct Cloudflare R2 Upload
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const uploaderName = msg.from?.username ? `@${msg.from.username}` : (msg.from?.first_name || 'User');

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
      const payload = { name: fileName, r2Key: r2Key, uploader: uploaderName };
      
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

  // Link Receive
  const incomingText = (msg.text || '').trim();
  if (!incomingText || incomingText.startsWith('/')) return;

  const urlRegex = /(https?:\/\/[^\s<>"']+)/gi;
  const urls = incomingText.match(urlRegex) || [];
  if (urls.length === 0) return;

  const statusMsg = await bot.sendMessage(chatId, `🔄 <i>Stream link ban raha hai...</i>`, { parse_mode: 'HTML' });

  try {
    const targetUrl = urls[0];
    const extractedKey = parseTeraboxKey(targetUrl);

    if (!extractedKey) {
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      return bot.sendMessage(chatId, `❌ <b>Error:</b> Terabox link format pehchaan nahi paaya. Link check karein.`, { parse_mode: 'HTML' });
    }

    const shortId = crypto.randomBytes(4).toString('hex');
    const payload = {
      name: `Terabox Video`,
      teraboxKey: extractedKey,
      uploader: uploaderName
    };

    linkStore.set(shortId, payload);
    await redis.set(`video:${shortId}`, JSON.stringify(payload), { ex: 30 * 86400 });

    const playUrl = `${BASE_URL}/v/${shortId}`;
    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});

    const reply = `✨ <b>Stream Link Ready!</b>\n\n` +
                  `🔗 <b>Aapka Player Link:</b>\n${playUrl}`;

    bot.sendMessage(chatId, reply, { parse_mode: 'HTML', disable_web_page_preview: false });

  } catch (err) {
    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    bot.sendMessage(chatId, `❌ <b>Error:</b> <code>${escapeHtml(err.message)}</code>`, { parse_mode: 'HTML' });
  }
});
