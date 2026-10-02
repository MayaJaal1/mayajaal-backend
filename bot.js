require('dotenv').config();

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const path = require('path');
const fs = require('fs');

process.on('uncaughtException', (err) => console.error('[UncaughtException]:', err.message));
process.on('unhandledRejection', (reason) => console.error('[UnhandledRejection]:', reason));

// ═══════════════════════════════════════════
// 0. CONFIG & REDIS
// ═══════════════════════════════════════════
const redis = Redis.fromEnv();
const linkStore = new Map();

const TOKEN = process.env.BOT_TOKEN;
const BASE_URL = process.env.CUSTOM_DOMAIN 
  ? (process.env.CUSTOM_DOMAIN.startsWith('http') ? process.env.CUSTOM_DOMAIN : `https://${process.env.CUSTOM_DOMAIN}`)
  : 'https://mayajaal.online';

if (!TOKEN) {
  console.error('❌ BOT_TOKEN missing hai!');
  process.exit(1);
}

// ═══════════════════════════════════════════
// 1. EXPRESS HTTP SERVER
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

app.get('/', (req, res) => res.send('MayaJaal Stream Engine Active!'));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// Embedded Video Player Page
function servePlayerPage(req, res) {
  const id = req.params.id;
  const playerFile = path.join(__dirname, 'player.html');
  
  if (fs.existsSync(playerFile)) {
    return res.sendFile(playerFile);
  }

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>MayaJaal Stream Player</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #07090e; color: #00ff88; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; padding: 15px; }
        .player-card { width: 100%; max-width: 850px; background: #0f172a; border: 1px solid #1e293b; border-radius: 16px; padding: 15px; box-shadow: 0 10px 30px rgba(0, 255, 136, 0.2); }
        video { width: 100%; border-radius: 10px; background: #000; outline: none; aspect-ratio: 16/9; max-height: 70vh; }
        .title { margin-top: 14px; font-size: 16px; font-weight: bold; color: #f8fafc; }
        .badge { display: inline-block; background: #00ff8822; color: #00ff88; padding: 4px 10px; border-radius: 6px; font-size: 12px; margin-bottom: 10px; font-weight: 600; }
      </style>
    </head>
    <body>
      <div class="player-card">
        <span class="badge">MAYAJAAL FAST STREAM</span>
        <video id="player" controls autoplay playsinline preload="auto">
          <source src="/stream/${id}" type="video/mp4">
          Browser video tag support nahi karta.
        </video>
        <div class="title" id="vidTitle">MayaJaal Streaming Video</div>
      </div>
      <script>
        fetch('/api/stream-info/${id}')
          .then(r => r.json())
          .then(d => {
            if(d.title) document.getElementById('vidTitle').innerText = d.title;
          }).catch(()=>{});
      </script>
    </body>
    </html>
  `);
}

app.get('/v/:id', (req, res) => servePlayerPage(req, res));
app.get('/tb/:id', (req, res) => servePlayerPage(req, res));

// Direct Fast Playback Route (HTTP 302 Instant Stream)
app.get('/stream/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let data = linkStore.get(id);

    if (!data) {
      const raw = await redis.get(`video:${id}`);
      if (raw) data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    }

    if (!data || !data.url) {
      return res.status(404).send('Video link expired ya exist nahi karta');
    }

    // Direct redirect to CDN (Zero lag, full speed stream)
    return res.redirect(302, data.url);
  } catch (err) {
    console.error('[Stream Route Error]:', err.message);
    if (!res.headersSent) res.status(500).send('Streaming error: ' + err.message);
  }
});

app.get(['/api/stream-info/:id', '/api/v/:id'], async (req, res) => {
  try {
    const id = req.params.id;
    let data = linkStore.get(id);
    if (!data) {
      const raw = await redis.get(`video:${id}`);
      if (raw) data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    }

    if (!data || !data.url) return res.status(404).json({ success: false, message: 'Video not found' });

    res.json({
      success: true,
      url: `${BASE_URL}/stream/${id}`,
      video_url: `${BASE_URL}/stream/${id}`,
      title: data.name || 'MayaJaal Stream Video',
      file_name: data.name || 'MayaJaal Stream Video',
      uploader: data.uploader || 'MayaJaal User',
      id: id
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ MayaJaal Web Server active on port ${PORT}`);
});
// ═══════════════════════════════════════════
// 2. BOT CONTROLLER (Direct Upload Engine)
// ═══════════════════════════════════════════
const bot = new TelegramBot(TOKEN, { polling: { autoStart: true, params: { timeout: 10 } } });

bot.on('polling_error', (error) => {
  if (error.message && error.message.includes('409 Conflict')) {
    console.error('⚠️ [409 Conflict]: Ek se zyada bot instances chal rahe hain.');
  }
});

function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `🎬 <b>MayaJaal Direct Video Streamer</b>\n\n` +
    `Seedha koi bhi <b>Video file upload</b> karein yahan.\n` +
    `Aapko turant link milega jo aapke video player mein live chalega!`,
    { parse_mode: 'HTML' }
  );
});

// ═══════════════════════════════════════════
// 3. DIRECT VIDEO / FILE UPLOAD HANDLER
// ═══════════════════════════════════════════
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

  // Agar video, document, ya animation (GIF/Video) hai
  const videoObj = msg.video || msg.document || (msg.animation ? msg.animation : null);

  if (!videoObj) {
    if (msg.text && !msg.text.startsWith('/')) {
      bot.sendMessage(chatId, `📌 Kripya koi <b>Video file upload</b> karein stream link paane ke liye.`, { parse_mode: 'HTML' });
    }
    return;
  }

  const fileName = videoObj.file_name || `video_${Date.now()}.mp4`;
  const fileId = videoObj.file_id;
  const uploaderName = msg.from?.username ? `@${msg.from.username}` : (msg.from?.first_name || 'MayaJaal User');

  const statusMsg = await bot.sendMessage(chatId, `⚡ <i>Video process ho rahi hai, link ban raha hai...</i>`, { parse_mode: 'HTML' });

  try {
    // Direct Telegram CDN stream link lena
    const directTelegramUrl = await bot.getFileLink(fileId);

    const shortId = crypto.randomBytes(4).toString('hex');
    const payload = {
      url: directTelegramUrl,
      name: fileName,
      uploader: uploaderName
    };

    // Redis aur Local cache dono mein save karein (30 din ke liye)
    linkStore.set(shortId, payload);
    await redis.set(`video:${shortId}`, JSON.stringify(payload), { ex: 30 * 86400 });

    const playUrl = `${BASE_URL}/v/${shortId}`;

    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});

    // Turant link send karein
    await bot.sendMessage(
      chatId,
      `✨ <b>MayaJaal Stream Ready!</b>\n\n` +
      `📌 <b>File:</b> ${escapeHtml(fileName)}\n\n` +
      `🔗 <b>Player Link:</b>\n${playUrl}\n\n` +
      `⚡ <i>Link par click karke direct player mein play karein!</i>`,
      {
        parse_mode: 'HTML',
        disable_web_page_preview: false
      }
    );
  } catch (err) {
    console.error('[Upload Error]:', err.message);
    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    bot.sendMessage(chatId, `❌ <b>Error:</b> <code>${escapeHtml(err.message)}</code>`, { parse_mode: 'HTML' });
  }
});
