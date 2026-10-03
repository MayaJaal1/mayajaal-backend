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

// Web Player Route
app.get('/v/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let data = linkStore.get(id);

    if (!data) {
      const raw = (await redis.get(`video:${id}`)) || (await redis.get(`terabox:${id}`));
      if (raw) data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    }

    if (!data) return res.status(404).send('Video not found or link expired');

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
          body { background: #000; color: #fff; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; }
          .player-box { width: 100%; max-width: 900px; padding: 16px; }
          video { width: 100%; max-height: 80vh; border-radius: 12px; background: #111; outline: none; box-shadow: 0 10px 30px rgba(0,0,0,0.8); }
          .title { margin-top: 15px; font-size: 1.1rem; color: #00ff88; word-break: break-all; }
        </style>
      </head>
      <body>
        <div class="player-box">
          <video controls autoplay playsinline preload="metadata">
            <source src="${streamUrl}" type="video/mp4">
            Aapka browser HTML5 video support nahi karta.
          </video>
          <div class="title">${videoTitle}</div>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Player error: ' + err.message);
  }
});

// Domain Streaming Route
app.get('/stream/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let data = linkStore.get(id);

    if (!data) {
      const raw = (await redis.get(`video:${id}`)) || (await redis.get(`terabox:${id}`));
      if (raw) data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    }

    if (!data) return res.status(404).send('Stream not found');

    if (data.r2Key) {
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
    }

    return res.status(404).send('Stream not found');
  } catch (err) {
    if (!res.headersSent) res.status(500).send('Streaming error');
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
const DEFAULT_COOKIE = 'ndus=Yzdpm64teHuiTpyF1tSZ-m4ANxhFN7shhUG1hMNu;';

// 4. Multi-Engine Link Resolver
async function extractTeraboxLink(rawUrl) {
  let target = rawUrl.trim();

  // Step 1: Follow full redirect agar short link ho
  try {
    const headResp = await axios.get(target, {
      maxRedirects: 10,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      },
      timeout: 10000
    });
    if (headResp.request?.res?.responseUrl) {
      target = headResp.request.res.responseUrl;
    }
  } catch (e) {}

  // Step 2: Try Direct Public Proxy Extractor (Fastest & No IP Ban)
  const apis = [
    `https://teraboxvideodownloader.nepcoderdevs.workers.dev/?url=${encodeURIComponent(target)}`,
    `https://yt-video-production.up.railway.app/terabox?url=${encodeURIComponent(target)}`,
    `https://terabox-api-lake.vercel.app/api?url=${encodeURIComponent(target)}`
  ];

  for (const apiUrl of apis) {
    try {
      const res = await axios.get(apiUrl, { timeout: 12000 });
      const dl = res.data?.download_link || res.data?.dlink || res.data?.direct_link || (res.data?.response && res.data.response[0]?.resolutions?.['Fast Download']);
      const fn = res.data?.file_name || res.data?.title || `video_${Date.now()}.mp4`;

      if (dl) {
        return { url: dl, name: fn };
      }
    } catch (e) {}
  }

  // Step 3: Direct Terabox API (Cookie Fallback)
  try {
    const match = target.match(/\/(?:s|sharing\/link\?surl=)([a-zA-Z0-9_-]+)/i) || 
                  target.match(/[?&]surl=([a-zA-Z0-9_-]+)/i) ||
                  rawUrl.match(/\/(?:s|sharing\/link\?surl=)([a-zA-Z0-9_-]+)/i);

    let shorturl = match ? match[1] : '';
    if (!shorturl && target.includes('/s/')) {
      const parts = target.split('/s/')[1];
      if (parts) shorturl = parts.split(/[?&#/]/)[0];
    }

    if (shorturl) {
      const formattedKey = shorturl.startsWith('1') ? shorturl.substring(1) : shorturl;
      let finalCookie = process.env.TERABOX_COOKIE || DEFAULT_COOKIE;
      if (!finalCookie.includes('ndus=')) finalCookie = `ndus=${finalCookie.trim()};`;

      const endpoints = [
        `https://www.1024tera.com/share/list?app_id=250528&shorturl=${formattedKey}&root=1`,
        `https://www.terabox.app/share/list?app_id=250528&shorturl=${formattedKey}&root=1`,
        `https://www.terabox.com/share/list?app_id=250528&shorturl=${shorturl}&root=1`
      ];

      for (const endpoint of endpoints) {
        try {
          const res = await axios.get(endpoint, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
              'Referer': 'https://www.1024tera.com/',
              'Cookie': finalCookie
            },
            timeout: 10000
          });

          if (res.data?.errno === 0 && res.data?.list?.length > 0) {
            const file = res.data.list[0];
            const streamUrl = file.dlink || file.direct_link || file.url;
            if (streamUrl) {
              return { url: streamUrl, name: file.server_filename || `video_${Date.now()}.mp4` };
            }
          }
        } catch (e) {}
      }
    }
  } catch (e) {}

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
    `• <b>Video Upload:</b> Direct file bhejein, R2 par save ho jayegi.\n` +
    `• <b>Terabox Link:</b> Link bhejein, R2 bucket me transfer hokar permanent link banega.`,
    { parse_mode: 'HTML' }
  );
});

// Video direct Cloudflare R2 par upload
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

  // Link Receive & Transfer to R2
  const incomingText = (msg.text || '').trim();
  if (!incomingText || incomingText.startsWith('/')) return;

  const urlRegex = /(https?:\/\/[^\s<>"']+)/gi;
  const urls = incomingText.match(urlRegex) || [];
  if (urls.length === 0) return;

  const statusMsg = await bot.sendMessage(chatId, `🔄 <i>Terabox video fetch aur R2 par transfer ho rahi hai...</i>`, { parse_mode: 'HTML' });

  try {
    const targetUrl = urls[0];
    const extracted = await extractTeraboxLink(targetUrl);

    if (!extracted || !extracted.url) {
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      return bot.sendMessage(chatId, `❌ <b>Error:</b> Terabox se direct link fetch nahi ho saki. Link expired ho sakti hai.`, { parse_mode: 'HTML' });
    }

    let finalCookie = process.env.TERABOX_COOKIE || DEFAULT_COOKIE;
    if (!finalCookie.includes('ndus=')) finalCookie = `ndus=${finalCookie.trim()};`;

    // Download stream from Terabox
    const videoStream = await axios.get(extracted.url, {
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Cookie': finalCookie,
        'Accept': '*/*'
      },
      timeout: 45000
    });

    const fileExt = path.extname(extracted.name) || '.mp4';
    const r2Key = `terabox/${crypto.randomBytes(8).toString('hex')}${fileExt}`;

    // Upload to Cloudflare R2
    const parallelUpload = new Upload({
      client: r2Client,
      params: {
        Bucket: R2_BUCKET_NAME,
        Key: r2Key,
        Body: videoStream.data,
        ContentType: 'video/mp4',
      },
      queueSize: 4,
      partSize: 1024 * 1024 * 5,
    });

    await parallelUpload.done();

    const shortId = crypto.randomBytes(4).toString('hex');
    const payload = { name: extracted.name, r2Key: r2Key, uploader: uploaderName };
    
    linkStore.set(shortId, payload);
    await redis.set(`video:${shortId}`, JSON.stringify(payload), { ex: 30 * 86400 });

    const playUrl = `${BASE_URL}/v/${shortId}`;
    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});

    const reply = `✨ <b>Terabox Video Ready!</b>\n\n` +
                  `📌 <b>File:</b> ${escapeHtml(extracted.name)}\n\n` +
                  `🔗 <b>Aapka Player Link:</b>\n${playUrl}`;

    bot.sendMessage(chatId, reply, { parse_mode: 'HTML', disable_web_page_preview: false });

  } catch (err) {
    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    bot.sendMessage(chatId, `❌ <b>Transfer Error:</b> <code>${escapeHtml(err.message)}</code>`, { parse_mode: 'HTML' });
  }
});
