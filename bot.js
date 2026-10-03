require('dotenv').config();

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const bigInt = require('big-integer');
const axios = require('axios');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const path = require('path');
const fs = require('fs');

process.on('uncaughtException', (err) => console.error('[UncaughtException]:', err.message));
process.on('unhandledRejection', (reason) => console.error('[UnhandledRejection]:', reason));

// ═══════════════════════════════════════════
// 0. CONFIG & STORAGE
// ═══════════════════════════════════════════
const redis = Redis.fromEnv();
const linkStore = new Map();

const TOKEN = process.env.BOT_TOKEN;
const rawApiId = process.env.TELEGRAM_API_ID || process.env.API_ID || '35399167';
const API_ID = parseInt(String(rawApiId).trim(), 10);
const API_HASH = String(process.env.TELEGRAM_API_HASH || process.env.API_HASH || '88a34526a5e73078110072770dd85e5b').trim();
const STORAGE_CHANNEL_ID = String(process.env.STORAGE_CHANNEL_ID || process.env.CHANNEL_ID || '').trim();

const BASE_URL = process.env.CUSTOM_DOMAIN 
  ? (process.env.CUSTOM_DOMAIN.startsWith('http') ? process.env.CUSTOM_DOMAIN : `https://${process.env.CUSTOM_DOMAIN}`)
  : 'https://mayajaal.online';

if (!TOKEN) {
  console.error('❌ BOT_TOKEN missing!');
  process.exit(1);
}

// ═══════════════════════════════════════════
// 1. GRAMJS BOT-TOKEN MTPROTO AUTH
// ═══════════════════════════════════════════
let tgClient = null;

if (!isNaN(API_ID) && API_ID > 0 && API_HASH && TOKEN) {
  tgClient = new TelegramClient(
    new StringSession(''),
    API_ID,
    API_HASH,
    { connectionRetries: 5 }
  );

  (async () => {
    try {
      await tgClient.start({ botAuthToken: TOKEN });
      console.log('✅ Telegram MTProto Bot Vault Connected! 2GB Superfast Active!');
    } catch (e) {
      console.error('❌ MTProto Auth Error:', e.message);
    }
  })();
}

// ═══════════════════════════════════════════
// 2. EXPRESS HTTP SERVER & WEB PLAYER
// ═══════════════════════════════════════════
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

app.get('/', (req, res) => res.send('MayaJaal Telegram-Cloudflare Vault Active!'));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.get(['/version.json', '/check-update', '/api/check-update'], (req, res) => {
  res.json({
    latestVersionCode: 2,
    latestVersionName: "v1.2.0",
    updateUrl: "https://mayajaal.online/download.html",
    forceUpdate: false,
    changelog: "⚡ 2GB zero-buffer MTProto stream active"
  });
});

app.get('/logo.jpg', (req, res) => res.sendFile(path.join(__dirname, 'logo.jpg')));
app.get('/key', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get(['/download', '/download.html'], (req, res) => {
  const dlPath = path.join(__dirname, 'download.html');
  if (fs.existsSync(dlPath)) return res.sendFile(dlPath);
  res.status(404).send('download.html not found');
});

// Matrix Key APIs
app.post('/save-key', async (req, res) => {
  try {
    const { telegram_id, key } = req.body;
    if (!telegram_id || !key) return res.status(400).json({ success: false });
    await redis.set(`matrix_key:${key}`, String(telegram_id), { ex: 30 * 86400 });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/verify-key/:key', async (req, res) => {
  try {
    const tgId = await redis.get(`matrix_key:${req.params.key}`);
    res.json({ valid: !!tgId, telegram_id: tgId || null });
  } catch (err) {
    res.status(500).json({ valid: false, error: err.message });
  }
});
// Web Player UI
function servePlayerPage(req, res) {
  const id = req.params.id;
  const playerFile = path.join(__dirname, 'player.html');
  if (fs.existsSync(playerFile)) return res.sendFile(playerFile);

  res.send(`
    <!DOCTYPE html>
    <html lang="hi">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>MayaJaal Fast Stream</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #07090e; color: #00ff88; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; padding: 16px; }
        .card { width: 100%; max-width: 850px; background: #0f172a; border: 1px solid #1e293b; border-radius: 16px; padding: 16px; }
        video { width: 100%; border-radius: 10px; background: #000; outline: none; aspect-ratio: 16/9; max-height: 70vh; }
        .badge { display: inline-block; background: #00ff8822; color: #00ff88; padding: 4px 10px; border-radius: 6px; font-size: 12px; margin-bottom: 12px; }
      </style>
    </head>
    <body>
      <div class="card">
        <span class="badge">⚡ TELEGRAM VAULT + CLOUDFLARE RANGE STREAM</span>
        <video id="player" controls autoplay playsinline preload="auto">
          <source src="/stream/${id}" type="video/mp4">
        </video>
      </div>
    </body>
    </html>
  `);
}

app.get('/v/:id', (req, res) => servePlayerPage(req, res));
app.get('/tb/:id', (req, res) => servePlayerPage(req, res));

// ───────────────────────────────────────────
// 3. TELEGRAM CHUNK STREAMER (FIXED BIGINT ERROR)
// ───────────────────────────────────────────
app.get('/stream/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let data = linkStore.get(id);

    if (!data) {
      const raw = await redis.get(`video:${id}`);
      if (raw) data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    }

    if (!data) return res.status(404).send('Video not found');

    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Accept-Ranges', 'bytes');

    // Case 1: Telegram Vault 2GB Streamer
    if (data.channel_id && data.msg_id && tgClient && tgClient.connected) {
      try {
        const rawPeer = String(data.channel_id).trim();
        const peerEntity = await tgClient.getEntity(
          rawPeer.startsWith('@') ? rawPeer : (rawPeer.startsWith('-100') ? BigInt(rawPeer) : rawPeer)
        );

        const messages = await tgClient.getMessages(peerEntity, { ids: [parseInt(data.msg_id, 10)] });
        const media = messages?.[0]?.media;
        const doc = media?.document || media?.video;

        if (doc) {
          const fileSize = Number(doc.size);
          const range = req.headers.range;

          let start = 0;
          let end = fileSize - 1;

          if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            start = parseInt(parts[0], 10);
            end = parts[1] ? parseInt(parts[1], 10) : end;
          }

          const chunkSize = (end - start) + 1;
          res.writeHead(range ? 206 : 200, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': doc.mimeType || 'video/mp4',
            'Cache-Control': 'public, max-age=86400'
          });

          const fileLocation = new Api.InputDocumentFileLocation({
            id: doc.id,
            accessHash: doc.accessHash,
            fileReference: doc.fileReference,
            thumbSize: ""
          });

          // DIRECT TELEGRAM API CHUNK STREAMER (No iterDownload, 100% Stable)
          const CHUNK_SIZE = 512 * 1024;
          let currentOffset = start;

          while (currentOffset <= end && !res.writableEnded && !res.destroyed) {
            const bytesToFetch = Math.min(CHUNK_SIZE, end - currentOffset + 1);

            const result = await tgClient.invoke(
              new Api.upload.GetFile({
                location: fileLocation,
                offset: bigInt(currentOffset),
                limit: bytesToFetch,
                precise: true
              })
            );

            if (!result || !result.bytes || result.bytes.length === 0) break;

            res.write(result.bytes);
            currentOffset += result.bytes.length;

            if (result.bytes.length < bytesToFetch) break;
          }
          return res.end();
        }
      } catch (tgErr) {
        console.error('[Telegram Vault Stream Error]:', tgErr.message);
      }
    }

    // Case 2: Fallback direct URL (Terabox / Web Stream)
    if (data.url) {
      const videoStream = await axios.get(data.url, {
        responseType: 'stream',
        headers: req.headers.range ? { Range: req.headers.range } : {},
        timeout: 60000
      });
      res.status(videoStream.status);
      res.setHeader('Content-Type', videoStream.headers['content-type'] || 'video/mp4');
      videoStream.data.pipe(res);
      return;
    }

    return res.status(404).send('Stream unavailable');
  } catch (err) {
    if (!res.headersSent) res.status(500).send('Streaming error');
  }
});

app.listen(PORT, () => console.log(`✅ MayaJaal Web Engine running on port ${PORT}`));
// ═══════════════════════════════════════════
// 4. TELEGRAM BOT (AUTO-SAVE TO STORAGE CHANNEL)
// ═══════════════════════════════════════════
const bot = new TelegramBot(TOKEN, {
  polling: {
    autoStart: true,
    params: { timeout: 10 }
  }
});

bot.on('polling_error', async (error) => {
  if (error.message && error.message.includes('409 Conflict')) {
    await new Promise(r => setTimeout(r, 4000));
  }
});

async function getUser(chatId) {
  try {
    const data = await redis.get(`user_settings:${chatId}`);
    if (data) return typeof data === 'string' ? JSON.parse(data) : data;
  } catch (err) {}
  return { apiToken: null, header: null, footer: null, bold: false, enableText: true };
}

async function saveUser(chatId, data) {
  try {
    await redis.set(`user_settings:${chatId}`, JSON.stringify(data));
  } catch (err) {}
}

function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `🎬 <b>MayaJaal Superfast Telegram Vault Streamer</b>\n\n` +
    `• <b>Direct Upload:</b> Kitni bhi badi video bhejein, channel vault mein save hokar Cloudflare se fast play hogi\n` +
    `• <b>API Setup:</b> <code>/api</code> command se connect karein`,
    { parse_mode: 'HTML' }
  );
});

bot.onText(/\/api(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const token = match[1] ? match[1].trim() : null;

  if (token) {
    const user = await getUser(chatId);
    user.apiToken = token;
    await saveUser(chatId, user);
    return bot.sendMessage(chatId, `✅ <b>API Token Connected:</b> <code>${escapeHtml(token)}</code>`, { parse_mode: 'HTML' });
  }

  const keyUrl = `${BASE_URL}/key?tg=${chatId}`;
  bot.sendMessage(chatId,
    `🔑 <b>MayaJaal API Portal:</b>\n\n` +
    `Tap karein apni key pane ke liye:\n${keyUrl}\n\n` +
    `Key milne par send karein:\n<code>/api YOUR_KEY</code>`,
    { parse_mode: 'HTML', disable_web_page_preview: true }
  );
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const user = await getUser(chatId);
  const videoObj = msg.video || msg.document || (msg.animation ? msg.animation : null);

  // Jab user Telegram par video upload kare
  if (videoObj) {
    const fileName = videoObj.file_name || `video_${Date.now()}.mp4`;
    const statusMsg = await bot.sendMessage(chatId, `⚡ <i>Video Telegram Storage Vault mein save ho rahi hai...</i>`, { parse_mode: 'HTML' });

    try {
      let channelMsgId = null;

      // File ko Storage Channel mein forward karein
      if (STORAGE_CHANNEL_ID) {
        const rawPeer = STORAGE_CHANNEL_ID.trim();
        const peer = rawPeer.startsWith('@') ? rawPeer : (rawPeer.startsWith('-100') ? parseInt(rawPeer, 10) : rawPeer);
        const forwarded = await bot.forwardMessage(peer, chatId, msg.message_id);
        channelMsgId = forwarded.message_id;
      }

      const shortId = crypto.randomBytes(4).toString('hex');
      const payload = {
        name: fileName,
        channel_id: STORAGE_CHANNEL_ID,
        msg_id: channelMsgId,
        uploader: msg.from?.first_name || 'MayaJaal User'
      };

      linkStore.set(shortId, payload);
      await redis.set(`video:${shortId}`, JSON.stringify(payload), { ex: 30 * 86400 });

      const playUrl = `${BASE_URL}/v/${shortId}`;
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});

      let reply = `✨ <b>MayaJaal Superfast 2GB Stream Ready!</b>\n\n`;
      if (user.header && user.enableText) reply = `<b>${escapeHtml(user.header)}</b>\n\n` + reply;
      reply += `📌 <b>File:</b> ${escapeHtml(fileName)}\n\n🔗 <b>Cloudflare Player Link:</b>\n${playUrl}\n\n⚡ <i>Telegram Vault Saved & Zero-Buffer Cloudflare Active!</i>`;
      if (user.footer && user.enableText) reply += `\n\n<b>${escapeHtml(user.footer)}</b>`;

      return bot.sendMessage(chatId, reply, { parse_mode: 'HTML', disable_web_page_preview: false });
    } catch (err) {
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      return bot.sendMessage(chatId, `❌ <b>Error:</b> <code>${escapeHtml(err.message)}</code>`, { parse_mode: 'HTML' });
    }
  }
});
                                                                    
