require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const path = require('path');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');

process.on('uncaughtException', (err) => console.error('[UncaughtException]:', err.message));
process.on('unhandledRejection', (reason) => console.error('[UnhandledRejection]:', reason));

let redis;
try {
  redis = Redis.fromEnv();
} catch (e) {
  redis = { get: async () => null, set: async () => null };
}

const linkStore = new Map();
const BASE_URL = process.env.CUSTOM_DOMAIN 
  ? (process.env.CUSTOM_DOMAIN.startsWith('http') ? process.env.CUSTOM_DOMAIN : `https://${process.env.CUSTOM_DOMAIN}`)
  : 'https://mayajaal.online';

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

app.get('/', (req, res) => res.send('Stream Engine Online - GramJS 2GB Pipeline Active'));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

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
// Telegram MTProto Client Setup (Full 2GB Support)
const apiId = parseInt(process.env.TELEGRAM_API_ID || '35399167');
const apiHash = String(process.env.TELEGRAM_API_HASH || '88a34526e5e73078110072770dd85e5b').trim();
const botToken = String(process.env.BOT_TOKEN || '').trim();

const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
  connectionRetries: 5,
});

function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function initBot() {
  if (!botToken) {
    console.error('❌ BOT_TOKEN variable missing hai!');
    return;
  }

  await client.start({
    botAuthToken: botToken,
  });
  console.log('✅ GramJS 2GB MTProto Bot Client Active!');

  client.addEventHandler(async (event) => {
    const message = event.message;
    if (!message) return;

    const chatId = message.chatId;

    if (message.message && message.message.startsWith('/start')) {
      return client.sendMessage(chatId, {
        message: `🎬 <b>Stream Converter Bot (2GB Support Active)</b>\n\n` +
                 `Ab Telegram ke andar 20MB wali koi pabandi nahi hai.\n` +
                 `Aap <b>100MB, 500MB ya 2GB tak</b> ki koi bhi video direct Telegram par bhejein, woh seedha Cloudflare R2 par upload hokar play link banegi!`,
        parseMode: 'html',
      });
    }

    // Media Handling (Video & Document)
    if (message.media && (message.media.document || message.media.video)) {
      let fileName = `video_${Date.now()}.mp4`;

      if (message.media.document?.attributes) {
        for (const attr of message.media.document.attributes) {
          if (attr.fileName) fileName = attr.fileName;
        }
      }

      const statusMsg = await client.sendMessage(chatId, {
        message: `⚡ <i>Video Telegram se fetch karke Cloudflare R2 par upload ho rahi hai... (2GB Limit Allowed)</i>`,
        parseMode: 'html',
      });

      try {
        console.log(`[MTProto]: Downloading media ${fileName}...`);

        // Direct stream download to buffer (bypasses Bot API 20MB restriction)
        const mediaBuffer = await client.downloadMedia(message.media, {
          workers: 4,
        });

        if (!mediaBuffer) throw new Error('File download nahi ho paayi');

        const fileExt = fileName.includes('.') ? fileName.substring(fileName.lastIndexOf('.')) : '.mp4';
        const r2Key = `uploads/${crypto.randomBytes(8).toString('hex')}${fileExt}`;

        console.log(`[Cloudflare R2]: Uploading: ${r2Key}`);

        const parallelUpload = new Upload({
          client: r2Client,
          params: {
            Bucket: R2_BUCKET_NAME,
            Key: r2Key,
            Body: mediaBuffer,
            ContentType: 'video/mp4',
          },
          queueSize: 4,
          partSize: 1024 * 1024 * 10,
        });

        await parallelUpload.done();

        const shortId = crypto.randomBytes(4).toString('hex');
        const payload = { name: fileName, r2Key: r2Key };

        linkStore.set(shortId, payload);
        await redis.set(`video:${shortId}`, JSON.stringify(payload), { ex: 30 * 86400 });

        const playUrl = `${BASE_URL}/v/${shortId}`;
        await client.deleteMessages(chatId, [statusMsg.id]);

        const reply = `✨ <b>Video Ready (Cloudflare R2)!</b>\n\n` +
                      `📌 <b>File:</b> ${escapeHtml(fileName)}\n\n` +
                      `🔗 <b>Aapka Domain Player Link:</b>\n${playUrl}`;

        return client.sendMessage(chatId, {
          message: reply,
          parseMode: 'html',
        });

      } catch (err) {
        console.error('[Upload Error]:', err.message);
        await client.deleteMessages(chatId, [statusMsg.id]).catch(() => {});
        return client.sendMessage(chatId, {
          message: `❌ <b>Upload Error:</b> <code>${escapeHtml(err.message)}</code>`,
          parseMode: 'html',
        });
      }
    }
  }, new NewMessage({}));
}

initBot().catch((e) => console.error('[Bot Init Error]:', e.message));
