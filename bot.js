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

// Web Player Route (Direct Cloudflare R2 Player)
app.get('/v/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let data = linkStore.get(id);

    if (!data) {
      const raw = (await redis.get(`video:${id}`)) || (await redis.get(`diskwala:${id}`));
      if (raw) data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    }

    if (!data || !data.r2Key) {
      return res.status(404).send('Video not found or still processing on Cloudflare R2');
    }

    const streamUrl = `${BASE_URL}/stream/${id}`;
    const videoTitle = data.name || 'Diskwala Video Player';

    res.send(`
      <!DOCTYPE html>
      <html lang="hi">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${videoTitle}</title>
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body { background: #000; color: #fff; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; padding: 12px; }
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

// Domain Streaming Route
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
// 4. Diskwala Stream Resolver (Extracts from JSON state & API)
async function fetchDiskwalaStream(rawUrl) {
  let target = rawUrl.trim();

  // Extract ID (e.g., 6ac117542a52418b2481f290)
  const idMatch = target.match(/\/(?:app|file|share|d)\/([a-zA-Z0-9]+)/i);
  const fileId = idMatch ? idMatch[1] : '';

  if (!fileId) {
    console.error('[Diskwala]: ID parse nahi ho saki:', target);
    return null;
  }

  let directUrl = '';
  let fileName = `diskwala_${fileId}.mp4`;

  // Method 1: Fetch Page HTML and parse Next.js / React initial state
  try {
    const pageResp = await axios.get(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      timeout: 15000
    });

    const html = pageResp.data || '';

    // Next.js hydration script parser
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i);
    if (nextDataMatch && nextDataMatch[1]) {
      try {
        const nextJson = JSON.parse(nextDataMatch[1]);
        const pageProps = nextJson?.props?.pageProps || {};
        const fileData = pageProps?.file || pageProps?.data || pageProps;

        directUrl = fileData?.downloadUrl || fileData?.fileUrl || fileData?.url || fileData?.streamUrl || '';
        if (fileData?.name || fileData?.title) {
          fileName = fileData.name || fileData.title;
        }
      } catch (e) {}
    }

    // Direct JSON regex fallback
    if (!directUrl) {
      const urlMatch = html.match(/"(?:downloadUrl|fileUrl|stream_url|direct_url)":\s*"([^"]+)"/i);
      if (urlMatch && urlMatch[1]) {
        directUrl = urlMatch[1].replace(/\\u0026/g, '&');
      }
    }
  } catch (err) {
    console.error('[Diskwala HTML Error]:', err.message);
  }

  // Method 2: Diskwala Backend API call fallback
  if (!directUrl) {
    const apiEndpoints = [
      `https://www.diskwala.com/api/v1/file/${fileId}`,
      `https://www.diskwala.com/api/file/${fileId}`,
      `https://diskwala.com/api/v1/file/${fileId}`
    ];

    for (const ep of apiEndpoints) {
      try {
        const apiRes = await axios.get(ep, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': target
          },
          timeout: 8000
        });

        const resData = apiRes.data?.data || apiRes.data;
        if (resData?.downloadUrl || resData?.fileUrl || resData?.url) {
          directUrl = resData.downloadUrl || resData.fileUrl || resData.url;
          if (resData.name || resData.title) fileName = resData.name || resData.title;
          break;
        }
      } catch (e) {}
    }
  }

  // Stream fetch & connect to R2
  if (directUrl) {
    try {
      console.log(`[Diskwala Stream]: Fetching file stream from ${directUrl}`);
      const stream = await axios.get(directUrl, {
        responseType: 'stream',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': target
        },
        timeout: 60000
      });

      if (!fileName.endsWith('.mp4') && !fileName.includes('.')) {
        fileName += '.mp4';
      }

      return {
        stream: stream.data,
        fileName: fileName
      };
    } catch (streamErr) {
      console.error('[Diskwala Stream Error]:', streamErr.message);
    }
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
    `• <b>Direct Video:</b> File bhejein, R2 bucket me direct store hogi.\n` +
    `• <b>Diskwala Link:</b> Link bhejein, video Cloudflare R2 me upload hokar domain play link banega.`,
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

  const targetUrl = urls[0];

  if (targetUrl.includes('diskwala.com')) {
    const statusMsg = await bot.sendMessage(chatId, `⏳ <i>Diskwala video fetch aur Cloudflare R2 par upload ho rahi hai... Kripya thoda intezar karein.</i>`, { parse_mode: 'HTML' });

    try {
      const streamData = await fetchDiskwalaStream(targetUrl);

      if (!streamData || !streamData.stream) {
        await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
        return bot.sendMessage(chatId, `❌ <b>Error:</b> Diskwala se direct download stream nahi mil paayi. Link check karein.`, { parse_mode: 'HTML' });
      }

      const fileExt = path.extname(streamData.fileName) || '.mp4';
      const r2Key = `diskwala/${crypto.randomBytes(8).toString('hex')}${fileExt}`;

      // Uploading directly into Cloudflare R2
      const parallelUpload = new Upload({
        client: r2Client,
        params: {
          Bucket: R2_BUCKET_NAME,
          Key: r2Key,
          Body: streamData.stream,
          ContentType: 'video/mp4',
        },
        queueSize: 4,
        partSize: 1024 * 1024 * 5,
      });

      await parallelUpload.done();

      const shortId = crypto.randomBytes(4).toString('hex');
      const payload = {
        name: streamData.fileName,
        r2Key: r2Key,
        uploader: uploaderName
      };

      linkStore.set(shortId, payload);
      await redis.set(`video:${shortId}`, JSON.stringify(payload), { ex: 30 * 86400 });

      const playUrl = `${BASE_URL}/v/${shortId}`;
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});

      const reply = `✨ <b>Cloudflare R2 Par Video Upload Safal!</b>\n\n` +
                    `📌 <b>File:</b> ${escapeHtml(streamData.fileName)}\n\n` +
                    `🔗 <b>Aapka Player Link:</b>\n${playUrl}`;

      return bot.sendMessage(chatId, reply, { parse_mode: 'HTML', disable_web_page_preview: false });

    } catch (err) {
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      return bot.sendMessage(chatId, `❌ <b>Transfer Error:</b> <code>${escapeHtml(err.message)}</code>`, { parse_mode: 'HTML' });
    }
  }
});
