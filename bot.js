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

// 1. Initial Storage Setup
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

// Web Player Route (Zero-Iframe Native HTML5 Video Streamer)
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
    const streamUrl = `${BASE_URL}/stream/${id}`;
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
          body { background: #000; color: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; padding: 12px; }
          .player-box { width: 100%; max-width: 950px; background: #111; border-radius: 14px; overflow: hidden; box-shadow: 0 10px 40px rgba(0,0,0,0.9); }
          .video-wrapper { position: relative; width: 100%; padding-top: 56.25%; background: #000; }
          video { position: absolute; top: 0; left: 0; width: 100%; height: 100%; outline: none; }
          .status-layer { position: absolute; top: 0; left: 0; width: 100%; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; background: rgba(0,0,0,0.85); z-index: 10; gap: 12px; }
          .spinner { width: 42px; height: 42px; border: 4px solid #333; border-top-color: #00ff88; border-radius: 50%; animation: spin 0.8s linear infinite; }
          @keyframes spin { to { transform: rotate(360deg); } }
          .info-bar { padding: 15px 18px; border-top: 1px solid #222; }
          .title { font-size: 1.05rem; font-weight: 500; color: #00ff88; word-break: break-all; }
        </style>
      </head>
      <body>
        <div class="player-box">
          <div class="video-wrapper">
            <video id="player" controls playsinline preload="auto" poster=""></video>
            <div id="loader" class="status-layer">
              <div class="spinner"></div>
              <p id="statusText">Video load ho rahi hai, kripya intezar karein...</p>
            </div>
          </div>
          <div class="info-bar">
            <div class="title">🎬 ${videoTitle}</div>
          </div>
        </div>

        <script>
          const video = document.getElementById('player');
          const loader = document.getElementById('loader');
          const statusText = document.getElementById('statusText');
          const isR2 = ${isR2};
          const r2Url = "${streamUrl}";
          const tbKey = "${teraboxKey}";

          async function startStream() {
            if (isR2) {
              video.src = r2Url;
              video.play().catch(() => {});
              loader.style.display = 'none';
              return;
            }

            // Direct Extractor APIs on client-side (Datacenter IP ban bypass)
            const apis = [
              'https://terabox-api-lake.vercel.app/api?url=https://terabox.app/s/1' + tbKey,
              'https://teraboxvideodownloader.nepcoderdevs.workers.dev/?url=https://1024terabox.com/s/1' + tbKey,
              'https://yt-video-production.up.railway.app/terabox?url=https://terabox.com/s/1' + tbKey
            ];

            let streamFound = false;
            for (const api of apis) {
              try {
                statusText.innerText = "Stream link generate ho rahi hai...";
                const res = await fetch(api);
                const data = await res.json();
                const directUrl = data.download_link || data.dlink || data.direct_link || (data.response && data.response[0]?.resolutions?.['Fast Download']);

                if (directUrl) {
                  video.src = directUrl;
                  video.play().catch(() => {});
                  loader.style.display = 'none';
                  streamFound = true;
                  break;
                }
              } catch (e) {}
            }

            if (!streamFound) {
              // Direct backup mirror stream
              video.src = 'https://www.1024tera.com/share/streaming?surl=' + tbKey;
              loader.style.display = 'none';
            }
          }

          video.addEventListener('canplay', () => { loader.style.display = 'none'; });
          video.addEventListener('error', () => {
            statusText.innerText = "Video stream hone me dikkat hui. Refresh karein.";
            loader.style.display = 'flex';
          });

          startStream();
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
// 4. Clean Terabox Key Parser (Supports 1Spe7... and all variants)
function parseTeraboxKey(rawUrl) {
  let target = rawUrl.trim();

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
    `• <b>Direct Video:</b> Video file bhejein, R2 bucket me save hokar direct fast stream hogi.\n` +
    `• <b>Terabox Link:</b> Terabox / Terashare link bhejein, aapke custom player link me live chalegi.`,
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
      return bot.sendMessage(chatId, `❌ <b>Error:</b> Link format samajh nahi aaya. Kripya valid Terabox link bhejein.`, { parse_mode: 'HTML' });
    }

    const shortId = crypto.randomBytes(4).toString('hex');
    const payload = {
      name: `Terabox Stream`,
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
