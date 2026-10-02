require('dotenv').config();

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const path = require('path');
const fs = require('fs');

// ═══════════════════════════════════════════
// 0. CONFIG & REDIS
// ═══════════════════════════════════════════
const redis = Redis.fromEnv();

const TOKEN = process.env.BOT_TOKEN;
const WEB_PAGE_URL = process.env.WEB_PAGE_URL || 'https://mayajaal.online/key';
const BACKEND_URL = process.env.BACKEND_URL || 'https://mayajaal.online';
const TERABOX_API = process.env.TERABOX_API || 'https://terabox.hnn.workers.dev/api';

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
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(__dirname));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/', (req, res) => res.send('MayaJaal Terabox Converter Engine is Active!'));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.get(['/version.json', '/check-update', '/api/check-update'], (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.json({
    latestVersionCode: 2,
    latestVersionName: "v1.1.0",
    updateUrl: "https://mayajaal.online/download.html",
    forceUpdate: false,
    changelog: "⚡ Fast Terabox Converter Active!"
  });
});

app.get('/logo.jpg', (req, res) => res.sendFile(path.join(__dirname, 'logo.jpg')));
app.get('/key', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get(['/download', '/download.html'], (req, res) => {
  const dlPath = path.join(__dirname, 'download.html');
  if (fs.existsSync(dlPath)) return res.sendFile(dlPath);
  res.status(404).send('download.html not found');
});

app.get('/.well-known/assetlinks.json', (req, res) => {
  res.set('Content-Type', 'application/json');
  res.json([{
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: "com.example.mayajaall",
      sha256_cert_fingerprints: [
        "11:EE:5A:9A:37:60:BB:80:3F:5E:4F:9B:3B:88:C4:C2:14:6A:C4:2E:D0:60:B1:98:20:9E:58:F8:2D:7F:ED:74"
      ]
    }
  }]);
});

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

app.post('/api/history/save', async (req, res) => {
  try {
    const { telegram_id, video } = req.body;
    if (!telegram_id || !video) return res.status(400).json({ success: false });
    const key = `user_history:${telegram_id}`;
    let history = await redis.get(key);
    history = history ? (typeof history === 'string' ? JSON.parse(history) : history) : [];
    history = history.filter(item => item.url !== video.url);
    history.unshift({ ...video, watchedAt: Date.now() });
    if (history.length > 50) history.pop();
    await redis.set(key, JSON.stringify(history));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/history/:telegram_id', async (req, res) => {
  try {
    const key = `user_history:${req.params.telegram_id}`;
    let history = await redis.get(key);
    res.json({
      success: true,
      history: history ? (typeof history === 'string' ? JSON.parse(history) : history) : []
    });
  } catch (err) {
    res.status(500).json({ success: false, history: [] });
  }
});

function servePlayerPage(req, res) {
  const playerFile = path.join(__dirname, 'player.html');
  if (fs.existsSync(playerFile)) return res.sendFile(playerFile);
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>MayaJaal Stream</title>
    <style>body{background:#000;color:#00ff88;font-family:monospace;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;}</style>
    </head><body><h2>MAYAJAAL TERABOX NODE</h2><p>Please open link in MayaJaal App</p></body></html>
  `);
}

app.get('/v/:id', (req, res) => servePlayerPage(req, res));
app.get('/tb/:id', (req, res) => servePlayerPage(req, res));

// Stream Info For Android App Player
app.get(['/api/stream-info/:id', '/api/v/:id', '/api/tb/:id'], async (req, res) => {
  try {
    const id = req.params.id;
    let data = await redis.get(`terabox:${id}`);
    if (!data) data = await redis.get(`video:${id}`);

    if (!data) return res.status(404).json({ success: false, message: 'Stream not found' });

    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    res.json({
      success: true,
      url: parsed.url,
      video_url: parsed.url,
      title: parsed.name || 'MayaJaal Video',
      file_name: parsed.name || 'MayaJaal Video',
      uploader: parsed.uploader || 'Terabox Converter',
      id: id
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Web Server active on port ${PORT}`);
});// ═══════════════════════════════════════════
// 2. TELEGRAM BOT ENGINE (ZERO-BANDWIDTH CONVERTER)
// ═══════════════════════════════════════════
const bot = new TelegramBot(TOKEN, { polling: true });

async function getUser(chatId) {
  try {
    const data = await redis.get(`user_settings:${chatId}`);
    if (data) return typeof data === 'string' ? JSON.parse(data) : data;
  } catch (err) {}
  return { apiToken: null, header: null, footer: null, bold: false, enableText: true };
}

async function saveUser(chatId, settings) {
  try {
    await redis.set(`user_settings:${chatId}`, JSON.stringify(settings));
  } catch (err) {}
}

function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildSuccessMessage(user, fileName, sizeMB, shortUrl) {
  const parts = [];
  if (user.enableText && user.header) {
    parts.push(user.bold ? `<b>${escapeHtml(user.header)}</b>` : escapeHtml(user.header));
    parts.push('');
  }
  parts.push(`✨ <b>MayaJaal Stream Link Generated!</b>`);
  parts.push('');
  parts.push(`📌 <b>File:</b> ${escapeHtml(fileName)}`);
  if (sizeMB) parts.push(`📦 <b>Size:</b> ${sizeMB} MB`);
  parts.push('');
  parts.push(`🔗 <b>Direct Player Link:</b>\n${shortUrl}`);
  if (user.enableText && user.footer) {
    parts.push('');
    parts.push(user.bold ? `<b>${escapeHtml(user.footer)}</b>` : escapeHtml(user.footer));
  }
  parts.push('');
  parts.push(`⚡ <i>Instant Cloud Play • Zero Server Storage</i>`);
  return parts.join('\n');
}

async function extractTeraboxLink(teraboxUrl) {
  try {
    const res = await axios.get(TERABOX_API, {
      params: { url: teraboxUrl },
      timeout: 60000,
    });

    if (!res.data || !res.data.success || !res.data.files || !res.data.files.length) {
      return null;
    }

    const file = res.data.files[0];
    const streamUrl = file.streaming_url || file.download_url;

    if (!streamUrl) return null;

    let sizeMB = null;
    if (file.file_size) {
      sizeMB = (file.file_size / (1024 * 1024)).toFixed(2);
    }

    return {
      url: streamUrl,
      name: file.file_name || 'Terabox Video',
      sizeMB: sizeMB,
    };
  } catch (err) {
    console.error('Terabox extract error:', err.message);
    return null;
  }
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `🎬 <b>Welcome to MayaJaal Terabox Converter!</b>\n\n` +
    `Mujhe koi bhi <b>Terabox link</b> bhejein (terabox.com, 1024tera, etc.).\n` +
    `Mai use direct fast <b>MayaJaal App Player link</b> mein convert kar dunga!\n\n` +
    `Commands:\n` +
    `/api — Matrix Key link karein\n` +
    `/logout — Disconnect karein\n` +
    `/add_header TEXT — Custom header lagayein\n` +
    `/add_footer TEXT — Custom footer lagayein`,
    { parse_mode: 'HTML' }
  );
});

bot.onText(/\/api(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const token = match[1]?.trim();
  const user = await getUser(chatId);

  if (!token) {
    const keyboard = {
      inline_keyboard: [[{ text: '🔑 Get Matrix Key', url: `${WEB_PAGE_URL}?tg=${chatId}` }]]
    };
    return bot.sendMessage(chatId,
      `🔐 <b>MayaJaal Account Linking</b>\n\nNiche button se apni Matrix Key lein aur bhejein:\n<code>/api YOUR_KEY</code>`,
      { parse_mode: 'HTML', reply_markup: keyboard }
    );
  }

  const valid = await redis.get(`matrix_key:${token}`);
  if (!valid || String(valid) !== String(chatId)) {
    return bot.sendMessage(chatId, `❌ Invalid ya unauthorized Matrix Key!`, { parse_mode: 'HTML' });
  }

  user.apiToken = token;
  await saveUser(chatId, user);
  bot.sendMessage(chatId, `✅ <b>Matrix Key linked successfully!</b>\n\nAb Terabox links bhejna start karein. 🚀`, { parse_mode: 'HTML' });
});

bot.onText(/\/logout/, async (msg) => {
  const chatId = msg.chat.id;
  const user = await getUser(chatId);
  user.apiToken = null;
  await saveUser(chatId, user);
  bot.sendMessage(chatId, `👋 Logged out successfully!`, { parse_mode: 'HTML' });
});

bot.onText(/\/add_header(?:\s+([\s\S]+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const text = match[1]?.trim();
  if (!text) return bot.sendMessage(chatId, `❌ Usage: <code>/add_header YOUR TEXT</code>`, { parse_mode: 'HTML' });
  const user = await getUser(chatId);
  user.header = text;
  await saveUser(chatId, user);
  bot.sendMessage(chatId, `✅ Header updated!`, { parse_mode: 'HTML' });
});

bot.onText(/\/add_footer(?:\s+([\s\S]+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const text = match[1]?.trim();
  if (!text) return bot.sendMessage(chatId, `❌ Usage: <code>/add_footer YOUR TEXT</code>`, { parse_mode: 'HTML' });
  const user = await getUser(chatId);
  user.footer = text;
  await saveUser(chatId, user);
  bot.sendMessage(chatId, `✅ Footer updated!`, { parse_mode: 'HTML' });
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  if (text.startsWith('/')) return;

  const user = await getUser(chatId);
  const uploaderName = msg.from?.username ? `@${msg.from.username}` : (msg.from?.first_name || 'Matrix User');

  const isTerabox = /(terabox|terasharefile|1024tera|teraboxapp|teraboxshare|teraboxlink|tibibox|momerybox|mirrorbox|4funbox|dubox|freeterabox|nekopoi)/i.test(text);

  if (!isTerabox || !/^https?:\/\//i.test(text)) {
    return;
  }

  if (!user.apiToken) {
    const keyboard = {
      inline_keyboard: [[{ text: '🔑 Get Matrix Key', url: `${WEB_PAGE_URL}?tg=${chatId}` }]]
    };
    return bot.sendMessage(chatId, `❌ <b>Pehle apna Matrix Key link karo!</b>\n\nNiche button par click karein:`, { parse_mode: 'HTML', reply_markup: keyboard });
  }

  const statusMsg = await bot.sendMessage(chatId, `⚡ <i>Converting Terabox link to MayaJaal Stream...</i>`, { parse_mode: 'HTML' });

  try {
    const extracted = await extractTeraboxLink(text);

    if (!extracted || !extracted.url) {
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      return bot.sendMessage(chatId, `❌ <b>Terabox direct stream extract nahi ho paya.</b> Link public aur active honi chahiye.`, { parse_mode: 'HTML' });
    }

    const shortId = crypto.randomBytes(4).toString('hex');
    const payload = {
      url: extracted.url,
      name: extracted.name,
      uploader: uploaderName,
    };

    // Save to Redis (30 days persistence)
    await redis.set(`terabox:${shortId}`, JSON.stringify(payload), { ex: 30 * 86400 });
    await redis.set(`video:${shortId}`, JSON.stringify(payload), { ex: 30 * 86400 });

    const playUrl = `${BASE_URL}/v/${shortId}`;

    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    await bot.sendMessage(chatId, buildSuccessMessage(user, extracted.name, extracted.sizeMB, playUrl), {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });

  } catch (err) {
    console.error('Terabox conversion error:', err);
    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    await bot.sendMessage(chatId, `❌ <b>Error:</b>\n<code>${escapeHtml(err.message)}</code>`, { parse_mode: 'HTML' });
  }
});

bot.on('polling_error', (err) => console.log('Polling error:', err.message));
process.on('uncaughtException', (err) => console.error('[UncaughtException]:', err.message));
process.on('unhandledRejection', (reason) => console.error('[UnhandledRejection]:', reason));

console.log('🚀 MayaJaal Zero-Bandwidth Terabox Converter Bot ready!');
