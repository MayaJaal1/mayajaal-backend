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
// 0. CONFIG & STORAGE
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
// 1. EXPRESS SERVER & STREAM ENGINE
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

app.get('/', (req, res) => res.send('MayaJaal Direct Cloud Stream Active!'));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// Embedded Player
function servePlayerPage(req, res) {
  const id = req.params.id;
  const playerFile = path.join(__dirname, 'player.html');
  if (fs.existsSync(playerFile)) {
    return res.sendFile(playerFile);
  }

  res.send(`
    <!DOCTYPE html>
    <html lang="hi">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>MayaJaal Player</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #07090e; color: #00ff88; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; padding: 16px; }
        .card { width: 100%; max-width: 850px; background: #0f172a; border: 1px solid #1e293b; border-radius: 16px; padding: 16px; box-shadow: 0 10px 30px rgba(0, 255, 136, 0.2); }
        video { width: 100%; border-radius: 10px; background: #000; outline: none; aspect-ratio: 16/9; max-height: 70vh; }
        .title { margin-top: 14px; font-size: 16px; font-weight: bold; color: #f8fafc; }
        .badge { display: inline-block; background: #00ff8822; color: #00ff88; padding: 4px 10px; border-radius: 6px; font-size: 12px; margin-bottom: 12px; font-weight: 600; }
      </style>
    </head>
    <body>
      <div class="card">
        <span class="badge">⚡ CLOUDFLARE EDGE STREAM</span>
        <video id="player" controls autoplay playsinline preload="auto">
          <source src="/stream/${id}" type="video/mp4">
          Browser video playback support nahi karta.
        </video>
        <div class="title" id="vidTitle">MayaJaal Video Stream</div>
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

// Direct Fast Range 206 Streaming Engine
app.get('/stream/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let data = linkStore.get(id);

    if (!data) {
      const raw = await redis.get(`video:${id}`);
      if (raw) data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    }

    if (!data || !data.url) {
      return res.status(404).send('Video link expired ya missing hai');
    }

    // Direct HTTP Range forwarding for Cloudflare smooth playback
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*'
    };

    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    const videoStream = await axios.get(data.url, {
      responseType: 'stream',
      headers: headers,
      maxRedirects: 10,
      timeout: 120000
    });

    res.status(videoStream.status);
    res.setHeader('Content-Type', videoStream.headers['content-type'] || 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    if (videoStream.headers['content-range']) res.setHeader('Content-Range', videoStream.headers['content-range']);
    if (videoStream.headers['content-length']) res.setHeader('Content-Length', videoStream.headers['content-length']);

    videoStream.data.pipe(res);
  } catch (err) {
    console.error('[Stream Engine Error]:', err.message);
    if (!res.headersSent) {
      // Fallback: direct redirect
      try {
        const fb = linkStore.get(req.params.id);
        if (fb && fb.url) return res.redirect(302, fb.url);
      } catch (e) {}
      res.status(500).send('Streaming error: ' + err.message);
    }
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

    if (!data || !data.url) return res.status(404).json({ success: false, message: 'Video missing' });

    res.json({
      success: true,
      url: `${BASE_URL}/stream/${id}`,
      video_url: `${BASE_URL}/stream/${id}`,
      title: data.name || 'MayaJaal Stream Video',
      file_name: data.name || 'MayaJaal Stream Video',
      uploader: data.uploader || 'MayaJaal Cloud',
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
// 2. BOT ENGINE (No Channel, No MTProto Wait)
// ═══════════════════════════════════════════
const bot = new TelegramBot(TOKEN, { polling: { autoStart: true, params: { timeout: 10 } } });

bot.on('polling_error', (error) => {
  if (error.message && error.message.includes('409 Conflict')) {
    console.error('⚠️ [409 Conflict]: Dusra bot instance chal raha hai.');
  }
});

function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `🎬 <b>MayaJaal Cloud Streamer</b>\n\n` +
    `Seedha koi bhi <b>Video file upload</b> karein yahan.\n` +
    `Aapko turant MayaJaal player ka working streaming link mil jayega!`,
    { parse_mode: 'HTML' }
  );
});

// ═══════════════════════════════════════════
// 3. INSTANT DIRECT UPLOAD HANDLER
// ═══════════════════════════════════════════
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

  // Video, document, ya GIF/Animation pakdo
  const videoObj = msg.video || msg.document || (msg.animation ? msg.animation : null);

  if (!videoObj) {
    if (msg.text && !msg.text.startsWith('/')) {
      bot.sendMessage(chatId, `📌 Kripya koi <b>Video file bhejein (upload karein)</b> stream link banane ke liye.`, { parse_mode: 'HTML' });
    }
    return;
  }

  const fileName = videoObj.file_name || `video_${Date.now()}.mp4`;
  const fileId = videoObj.file_id;
  const uploaderName = msg.from?.username ? `@${msg.from.username}` : (msg.from?.first_name || 'MayaJaal Cloud');

  const statusMsg = await bot.sendMessage(chatId, `⚡ <i>Video process ho rahi hai, direct Cloudflare link ban raha hai...</i>`, { parse_mode: 'HTML' });

  try {
    // 1. Direct Telegram CDN URL nikalna (Bina channel upload/forward ke)
    const directTelegramUrl = await bot.getFileLink(fileId);

    // 2. Short ID banana aur Redis/Memory mein map karna
    const shortId = crypto.randomBytes(4).toString('hex');
    const payload = {
      url: directTelegramUrl,
      name: fileName,
      uploader: uploaderName
    };

    linkStore.set(shortId, payload);
    await redis.set(`video:${shortId}`, JSON.stringify(payload), { ex: 30 * 86400 });

    // 3. Aapka MayaJaal Domain Player link
    const playUrl = `${BASE_URL}/v/${shortId}`;

    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});

    // 4. User ko turant link bhejo
    await bot.sendMessage(
      chatId,
      `✨ <b>MayaJaal Cloud Stream Ready!</b>\n\n` +
      `📌 <b>File:</b> ${escapeHtml(fileName)}\n\n` +
      `🔗 <b>Player Link:</b>\n${playUrl}\n\n` +
      `⚡ <i>Link par tap karte hi video seedhe player mein fast stream hone lagegi!</i>`,
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
