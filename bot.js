require('dotenv').config();

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const path = require('path');
const fs = require('fs');

// ═══════════════════════════════════════════
// 0. REDIS + CONFIG
// ═══════════════════════════════════════════
const redis = Redis.fromEnv();

const WEB_PAGE_URL = process.env.WEB_PAGE_URL || 'https://mayajaal.online/key';
const BACKEND_URL = process.env.BACKEND_URL || 'https://mayajaal.online';
const TERABOX_API = process.env.TERABOX_API || 'https://terabox.hnn.workers.dev/api';

// ═══════════════════════════════════════════
// 1. EXPRESS SERVER
// ═══════════════════════════════════════════
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(__dirname));

const linkStore = new Map();
const LINK_TTL_MS = 24 * 60 * 60 * 1000;

const BASE_URL = process.env.CUSTOM_DOMAIN 
  ? (process.env.CUSTOM_DOMAIN.startsWith('http') ? process.env.CUSTOM_DOMAIN : `https://${process.env.CUSTOM_DOMAIN}`)
  : 'https://mayajaal.online';

app.get('/', (req, res) => res.send('MayaJaal Bot is running!'));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// 🌟 APP UPDATE VERSION CHECK ROUTE (FIXED)
app.get(['/version.json', '/check-update', '/api/check-update'], (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.json({
    latestVersionCode: 2,
    latestVersionName: "v1.1.0",
    updateUrl: "https://mayajaal.online/download.html",
    forceUpdate: false,
    changelog: "⚡ Fast player and auto-update test success!"
  });
});

app.get('/logo.jpg', (req, res) => {
  res.sendFile(path.join(__dirname, 'logo.jpg'));
});

// 🌟 MATRIX KEY FRONTEND PAGE ROUTE
app.get('/key', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 🌟 DOWNLOAD PAGE ROUTE
app.get(['/download', '/download.html'], (req, res) => {
  const dlPath = path.join(__dirname, 'download.html');
  if (fs.existsSync(dlPath)) {
    return res.sendFile(dlPath);
  }
  res.status(404).send('download.html not found');
});

// 🌟 MATRIX KEY SAVE API
app.post('/save-key', async (req, res) => {
  try {
    const { telegram_id, key } = req.body;
    if (!telegram_id || !key) {
      return res.status(400).json({ success: false, message: 'Missing parameters' });
    }
    await redis.set(`matrix_key:${key}`, String(telegram_id), { ex: 30 * 86400 });
    res.json({ success: true });
  } catch (err) {
    console.error('Save key error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});
// 🌟 MATRIX KEY VERIFY API
app.get('/verify-key/:key', async (req, res) => {
  try {
    const key = req.params.key;
    const tgId = await redis.get(`matrix_key:${key}`);
    if (tgId) {
      return res.json({ valid: true, telegram_id: tgId });
    }
    res.json({ valid: false });
  } catch (err) {
    console.error('Verify key error:', err.message);
    res.status(500).json({ valid: false, error: err.message });
  }
});

// 🌟 HELPER TO SERVE TERABOX STYLE PLAYER.HTML
function servePlayerPage(req, res) {
  const playerFile = path.join(__dirname, 'player.html');
  if (fs.existsSync(playerFile)) {
    return res.sendFile(playerFile);
  }
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>MayaJaal Stream</title>
    <style>body{background:#000;color:#00ff88;font-family:monospace;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;}</style>
    </head><body><h2>MAYAJAAL STREAM NODE</h2><p>Please open link in MayaJaal App</p></body></html>
  `);
}

// ═══════════════════════════════════════════
// 🌟 FIXED ROUTES (/v/:id & /tb/:id)
// ═══════════════════════════════════════════
app.get('/v/:id', (req, res) => {
  servePlayerPage(req, res);
});

app.get('/tb/:id', (req, res) => {
  servePlayerPage(req, res);
});

// ═══════════════════════════════════════════
// ANDROID APP VERIFICATION
// ═══════════════════════════════════════════
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

// ═══════════════════════════════════════════
// NATIVE APP DIRECT VIDEO LINK RESOLVER
// ═══════════════════════════════════════════
app.get('/api/v/:id', async (req, res) => {
  const id = req.params.id;
  const memoryData = linkStore.get(id);
  if (memoryData && memoryData.url) {
    return res.json({ success: true, url: memoryData.url });
  }

  const redisData = await redis.get(`video:${id}`);
  if (redisData) {
    const parsed = typeof redisData === 'string' ? JSON.parse(redisData) : redisData;
    return res.json({ success: true, url: parsed.url || parsed });
  }

  const tbData = await redis.get(`terabox:${id}`);
  if (tbData) {
    const parsed = typeof tbData === 'string' ? JSON.parse(tbData) : tbData;
    return res.json({ success: true, url: parsed.url || parsed });
  }

  res.status(404).json({ error: 'Stream not found' });
});

app.get('/api/tb/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const data = await redis.get(`terabox:${id}`);
    if (!data) return res.status(404).json({ error: 'Not found or expired' });
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    res.json({
      video_url: parsed.url,
      file_name: parsed.name || 'MayaJaal Video'
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
  console.log(`🌐 Base URL: ${BASE_URL}`);
});
// ═══════════════════════════════════════════
// 2. CONFIG & PERMANENT REDIS USER STATE
// ═══════════════════════════════════════════
const TOKEN = process.env.BOT_TOKEN;
const B2_KEY_ID = process.env.B2_KEY_ID;
const B2_APP_KEY = process.env.B2_APP_KEY;
const B2_BUCKET = process.env.B2_BUCKET;
const B2_ENDPOINT = process.env.B2_ENDPOINT || 's3.us-east-005.backblazeb2.com';
const B2_REGION = process.env.B2_REGION || 'us-east-005';

if (!TOKEN || !B2_KEY_ID || !B2_APP_KEY || !B2_BUCKET) {
  console.error('❌ Missing env variables!');
  process.exit(1);
}

const s3 = new S3Client({
  region: B2_REGION,
  endpoint: `https://${B2_ENDPOINT}`,
  credentials: {
    accessKeyId: B2_KEY_ID,
    secretAccessKey: B2_APP_KEY,
  },
});

// 🌟 PERMANENT USER PERSISTENCE VIA REDIS
async function getUser(chatId) {
  try {
    const data = await redis.get(`user_settings:${chatId}`);
    if (data) {
      return typeof data === 'string' ? JSON.parse(data) : data;
    }
  } catch (err) {
    console.error('Redis get user error:', err.message);
  }
  return {
    apiToken: null,
    header: null,
    footer: null,
    bold: false,
    enableText: true,
  };
}

async function saveUser(chatId, settings) {
  try {
    await redis.set(`user_settings:${chatId}`, JSON.stringify(settings));
  } catch (err) {
    console.error('Redis save user error:', err.message);
  }
}

const bot = new TelegramBot(TOKEN, { polling: true });

// ═══════════════════════════════════════════
// 6. HELPERS
// ═══════════════════════════════════════════
function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function createShortLink(signedUrl, fileName) {
  const id = crypto.randomBytes(4).toString('hex');
  linkStore.set(id, {
    url: signedUrl,
    name: fileName,
    expiresAt: Date.now() + LINK_TTL_MS,
  });
  
  redis.set(`video:${id}`, JSON.stringify({ url: signedUrl, name: fileName }), { ex: 86400 }).catch(() => {});
  return `${BASE_URL}/v/${id}`;
}

function pickFile(msg) {
  if (msg.video) return msg.video;
  if (msg.document) return msg.document;
  if (msg.audio) return msg.audio;
  if (Array.isArray(msg.photo) && msg.photo.length) return msg.photo[msg.photo.length - 1];
  return null;
}

// ═══════════════════════════════════════════
// 7. TERABOX EXTRACTOR
// ═══════════════════════════════════════════
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

    return {
      url: streamUrl,
      name: file.file_name || 'Terabox Video',
      size: file.file_size || null,
    };
  } catch (err) {
    console.error('Terabox extract error:', err.message);
    return null;
  }
}

// ═══════════════════════════════════════════
// 8. DISKWALA EXTRACTOR
// ═══════════════════════════════════════════
async function extractDiskwalaLink(diskwalaUrl) {
  try {
    const res = await axios.get(diskwalaUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.diskwala.com/'
      },
      timeout: 30000,
      maxRedirects: 5
    });

    const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);

    const b2Match = html.match(/https?:\/\/[^"'\s\\]+\.backblazeb2\.com[^"'\s\\]*/i);
    if (b2Match) {
      return { url: b2Match[0], name: 'Diskwala Video', size: null };
    }

    const patterns = [
      /"downloadUrl"\s*:\s*"([^"]+)"/i,
      /"fileUrl"\s*:\s*"([^"]+)"/i,
      /"videoUrl"\s*:\s*"([^"]+)"/i,
      /"url"\s*:\s*"(https?:\/\/[^"]+\.mp4[^"]*)"/i,
      /https?:\/\/[^"'\s]+\.(mp4|m3u8|mkv|webm)[^"'\s]*/i
    ];

    for (const p of patterns) {
      const m = html.match(p);
      if (m) {
        const u = m[1] || m[0];
        if (u && u.startsWith('http')) {
          return { url: u, name: 'Diskwala Video', size: null };
        }
      }
    }

    return null;
  } catch (err) {
    console.error('Diskwala extract error:', err.message);
    return null;
  }
}

setInterval(() => {
  const now = Date.now();
  let removed = 0;
  for (const [id, data] of linkStore.entries()) {
    if (now > data.expiresAt) {
      linkStore.delete(id);
      removed++;
    }
  }
  if (removed > 0) console.log(`🧹 Cleaned ${removed} expired links`);
}, 10 * 60 * 1000);
    // ═══════════════════════════════════════════
// 9. BOT COMMANDS & SETUP
// ═══════════════════════════════════════════
async function setupBotCommands() {
  const commands = [
    { command: 'start', description: 'Get started & view all commands' },
    { command: 'api', description: 'Get your Matrix Key & link account' },
    { command: 'logout', description: 'Disconnect your account' },
    { command: 'add_header', description: 'Add text above your links' },
    { command: 'remove_header', description: 'Remove header text' },
    { command: 'add_footer', description: 'Add text below your links' },
    { command: 'remove_footer', description: 'Remove footer text' },
    { command: 'enable_text', description: 'Keep surrounding text in messages' },
    { command: 'disable_text', description: 'Remove surrounding text from messages' },
    { command: 'enable_bold', description: 'Make header & footer bold' },
    { command: 'disable_bold', description: 'Make header & footer normal' },
    { command: 'settings', description: 'View your current settings' },
  ];

  try {
    await bot.setMyCommands(commands);
    console.log('✅ Bot commands menu set successfully');
  } catch (err) {
    console.error('❌ Failed to set commands menu:', err.message);
  }
}

const WELCOME_TEXT =
  `🎬 <b>Welcome to MayaJaal Uploader Bot!</b>\n\n` +
  `Send me any of the following:\n\n` +
  `• <b>Telegram file</b> (video, document, audio)\n` +
  `• <b>Direct file URL</b> (e.g. https://example.com/video.mp4)\n` +
  `• <b>Terabox link</b> (terabox.com / terasharefile.com)\n` +
  `• <b>Diskwala link</b> (diskwala.com)\n` +
  `• <b>Magnet link</b> (magnet:?xt=urn:btih:…)\n\n` +
  `<b>Commands:</b>\n` +
  `/api — Get your Matrix Key & link account\n` +
  `/logout — Disconnect your account\n` +
  `/add_header TEXT — Add text above your link\n` +
  `/remove_header — Remove header\n` +
  `/add_footer TEXT — Add text below your link\n` +
  `/remove_footer — Remove footer\n` +
  `/enable_text — Keep surrounding text\n` +
  `/disable_text — Remove surrounding text\n` +
  `/enable_bold — Make bold\n` +
  `/disable_bold — Normal text\n` +
  `/settings — View your settings`;

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, WELCOME_TEXT, { parse_mode: 'HTML' });
});

bot.onText(/\/api(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const token = match[1]?.trim();
  const user = await getUser(chatId);

  if (!token) {
    const keyboard = {
      inline_keyboard: [[
        { text: '🔑 Get Matrix Key', url: `${WEB_PAGE_URL}?tg=${chatId}` }
      ]]
    };

    if (user.apiToken) {
      const masked = user.apiToken.slice(0, 6) + '...' + user.apiToken.slice(-4);
      return bot.sendMessage(chatId,
        `✅ <b>Matrix Key already linked:</b>\n<code>${escapeHtml(masked)}</code>\n\n` +
        `Naya key lene ke liye niche button dabayein 👇\n` +
        `Disconnect karne ke liye: <code>/logout</code>`,
        { parse_mode: 'HTML', reply_markup: keyboard }
      );
    }

    return bot.sendMessage(chatId,
      `🔐 <b>MayaJaal Account Linking</b>\n\n` +
      `Apni <b>Matrix Key</b> lene ke liye niche button dabayein 👇\n\n` +
      `<b>📌 Steps:</b>\n` +
      `1️⃣ Button par tap karein\n` +
      `2️⃣ Matrix Key copy karein\n` +
      `3️⃣ Yahan bhejein: <code>/api YOUR_KEY</code>`,
      { parse_mode: 'HTML', reply_markup: keyboard }
    );
  }

  try {
    const verifyRes = await axios.get(
      `${BACKEND_URL}/verify-key/${encodeURIComponent(token)}`
    );

    if (!verifyRes.data.valid) {
      return bot.sendMessage(chatId,
        `❌ <b>Invalid Matrix Key</b>\n\n` +
        `Sahi key lene ke liye <code>/api</code> bhejein.`,
        { parse_mode: 'HTML' }
      );
    }

    if (String(verifyRes.data.telegram_id) !== String(chatId)) {
      return bot.sendMessage(chatId,
        `❌ <b>Ye key kisi aur user ki hai.</b>\n\n` +
        `Apni khud ki key lene ke liye <code>/api</code> bhejein.`,
        { parse_mode: 'HTML' }
      );
    }

    user.apiToken = token;
    await saveUser(chatId, user);

    bot.sendMessage(chatId,
      `✅ <b>Matrix Key linked successfully!</b>\n\n` +
      `Ab aap files upload kar sakte hain. 🚀\n\n` +
      `Disconnect karne ke liye: <code>/logout</code>`,
      { parse_mode: 'HTML' }
    );

  } catch (err) {
    console.error('Verify error:', err.message);
    bot.sendMessage(chatId,
      `❌ <b>Verification failed.</b>\n\nThodi der baad try karein.`,
      { parse_mode: 'HTML' }
    );
  }
});

bot.onText(/\/add_header(?:\s+([\s\S]+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const text = match[1]?.trim();
  if (!text) {
    return bot.sendMessage(chatId, `❌ <b>Usage:</b>\n<code>/add_header YOUR TEXT</code>`, { parse_mode: 'HTML' });
  }
  const user = await getUser(chatId);
  user.header = text;
  await saveUser(chatId, user);
  bot.sendMessage(chatId, `✅ <b>Header added:</b>\n${escapeHtml(text)}`, { parse_mode: 'HTML' });
});

bot.onText(/\/remove_header/, async (msg) => {
  const chatId = msg.chat.id;
  const user = await getUser(chatId);
  user.header = null;
  await saveUser(chatId, user);
  bot.sendMessage(chatId, '✅ Header removed.');
});

bot.onText(/\/add_footer(?:\s+([\s\S]+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const text = match[1]?.trim();
  if (!text) {
    return bot.sendMessage(chatId, `❌ <b>Usage:</b>\n<code>/add_footer YOUR TEXT</code>`, { parse_mode: 'HTML' });
  }
  const user = await getUser(chatId);
  user.footer = text;
  await saveUser(chatId, user);
  bot.sendMessage(chatId, `✅ <b>Footer added:</b>\n${escapeHtml(text)}`, { parse_mode: 'HTML' });
});

bot.onText(/\/remove_footer/, async (msg) => {
  const chatId = msg.chat.id;
  const user = await getUser(chatId);
  user.footer = null;
  await saveUser(chatId, user);
  bot.sendMessage(chatId, '✅ Footer removed.');
});

bot.onText(/\/enable_text/, async (msg) => {
  const chatId = msg.chat.id;
  const user = await getUser(chatId);
  user.enableText = true;
  await saveUser(chatId, user);
  bot.sendMessage(chatId, '✅ <b>Surrounding text enabled.</b>', { parse_mode: 'HTML' });
});

bot.onText(/\/disable_text/, async (msg) => {
  const chatId = msg.chat.id;
  const user = await getUser(chatId);
  user.enableText = false;
  await saveUser(chatId, user);
  bot.sendMessage(chatId, '✅ <b>Surrounding text disabled.</b>', { parse_mode: 'HTML' });
});

bot.onText(/\/enable_bold/, async (msg) => {
  const chatId = msg.chat.id;
  const user = await getUser(chatId);
  user.bold = true;
  await saveUser(chatId, user);
  bot.sendMessage(chatId, '✅ <b>Bold enabled</b>.', { parse_mode: 'HTML' });
});

bot.onText(/\/disable_bold/, async (msg) => {
  const chatId = msg.chat.id;
  const user = await getUser(chatId);
  user.bold = false;
  await saveUser(chatId, user);
  bot.sendMessage(chatId, '✅ Bold disabled.');
});

bot.onText(/\/logout/, async (msg) => {
  const chatId = msg.chat.id;
  const user = await getUser(chatId);
  if (!user.apiToken) {
    return bot.sendMessage(chatId, `❌ <b>Aap logged in nahi ho.</b>\n\nLogin: <code>/api</code>`, { parse_mode: 'HTML' });
  }
  user.apiToken = null;
  await saveUser(chatId, user);
  bot.sendMessage(chatId, `👋 <b>Logged out successfully!</b>\n\nDobara login: <code>/api</code>`, { parse_mode: 'HTML' });
});

bot.onText(/\/settings/, async (msg) => {
  const chatId = msg.chat.id;
  const u = await getUser(chatId);
  const text =
    `⚙️ <b>Your MayaJaal Settings</b>\n\n` +
    `🔑 <b>Matrix Key:</b> ${u.apiToken ? '✅ Linked' : '❌ Not linked'}\n` +
    `📝 <b>Header:</b> ${u.header ? escapeHtml(u.header) : '<i>(none)</i>'}\n` +
    `📝 <b>Footer:</b> ${u.footer ? escapeHtml(u.footer) : '<i>(none)</i>'}\n` +
    `💬 <b>Surrounding text:</b> ${u.enableText ? 'ON' : 'OFF'}\n` +
    `🅱️️ <b>Bold:</b> ${u.bold ? 'ON' : 'OFF'}`;

  const opts = { parse_mode: 'HTML' };
  if (u.apiToken) {
    opts.reply_markup = {
      inline_keyboard: [[{ text: '🚪 Logout', callback_data: 'logout_user' }]]
    };
  }
  bot.sendMessage(chatId, text, opts);
});

bot.on('callback_query', async (query) => {
  if (query.data === 'logout_user') {
    const chatId = query.message.chat.id;
    const user = await getUser(chatId);
    user.apiToken = null;
    await saveUser(chatId, user);
    bot.answerCallbackQuery(query.id, { text: '✅ Logged out!' });
    bot.sendMessage(chatId, `👋 <b>Logged out successfully.</b>\n\nDobara login: <code>/api</code>`, { parse_mode: 'HTML' });
  }
});
  function buildSuccessMessage(user, fileName, sizeMB, shortUrl) {
  const parts = [];
  if (user.enableText && user.header) {
    parts.push(user.bold ? `<b>${escapeHtml(user.header)}</b>` : escapeHtml(user.header));
    parts.push('');
  }
  parts.push(`✨ <b>MayaJaal Upload Complete!</b>`);
  parts.push('');
  parts.push(`📌 <b>File:</b> ${escapeHtml(fileName)}`);
  if (sizeMB) parts.push(`📦 <b>Size:</b> ${sizeMB} MB`);
  parts.push('');
  parts.push(`🔗 <b>Link:</b>\n${shortUrl}`);
  if (user.enableText && user.footer) {
    parts.push('');
    parts.push(user.bold ? `<b>${escapeHtml(user.footer)}</b>` : escapeHtml(user.footer));
  }
  parts.push('');
  parts.push(`⏰ <i>Valid 24 hours</i>`);
  return parts.join('\n');
}

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || '';
  if (text.startsWith('/')) return;

  const user = await getUser(chatId);
  if (!user.apiToken) {
    const fileCheck = pickFile(msg);
    const isUrl = /^https?:\/\//i.test(text) || text.startsWith('magnet:?');
    if (fileCheck || isUrl) {
      const keyboard = {
        inline_keyboard: [[{ text: '🔑 Get Matrix Key', url: `${WEB_PAGE_URL}?tg=${chatId}` }]]
      };
      return bot.sendMessage(chatId,
        `❌ <b>Pehle apna Matrix Key link karo!</b>\n\n` +
        `Niche button se Matrix Key lein, phir <code>/api YOUR_KEY</code> bhejein.`,
        { parse_mode: 'HTML', reply_markup: keyboard }
      );
    }
    return;
  }

  let statusMsg = null;
  try {
    const isTerabox = /(terabox|terasharefile|1024tera|teraboxapp|teraboxshare|teraboxlink|tibibox|momerybox|mirrorbox|4funbox|dubox|freeterabox|nekopoi)/i.test(text);

    if (isTerabox && /^https?:\/\//i.test(text)) {
      statusMsg = await bot.sendMessage(chatId, `🔄 <i>Extracting Terabox link...</i>`, { parse_mode: 'HTML' });
      const extracted = await extractTeraboxLink(text);

      if (!extracted || !extracted.url) {
        await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
        return bot.sendMessage(chatId, `❌ <b>Terabox link extract nahi ho paya.</b>`, { parse_mode: 'HTML' });
      }

      const shortId = crypto.randomBytes(4).toString('hex');
      await redis.set(`terabox:${shortId}`, JSON.stringify({ url: extracted.url, name: extracted.name }), { ex: 86400 });
      const myLink = `${BASE_URL}/tb/${shortId}`;

      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      statusMsg = null;
      await bot.sendMessage(chatId, buildSuccessMessage(user, extracted.name, null, myLink), { parse_mode: 'HTML', disable_web_page_preview: true });
      return;
    }

    const isDiskwala = /diskwala\.com/i.test(text);
    if (isDiskwala && /^https?:\/\//i.test(text)) {
      statusMsg = await bot.sendMessage(chatId, `🔄 <i>Extracting Diskwala link...</i>`, { parse_mode: 'HTML' });
      const extracted = await extractDiskwalaLink(text);

      if (!extracted || !extracted.url) {
        await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
        return bot.sendMessage(chatId, `❌ <b>Diskwala link extract nahi ho paya.</b>`, { parse_mode: 'HTML' });
      }

      const shortId = crypto.randomBytes(4).toString('hex');
      await redis.set(`terabox:${shortId}`, JSON.stringify({ url: extracted.url, name: extracted.name }), { ex: 86400 });
      const myLink = `${BASE_URL}/tb/${shortId}`;

      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      statusMsg = null;
      await bot.sendMessage(chatId, buildSuccessMessage(user, extracted.name, null, myLink), { parse_mode: 'HTML', disable_web_page_preview: true });
      return;
    }

    const file = pickFile(msg);
    if (file) {
      if (file.file_size && file.file_size > 20 * 1024 * 1024) {
        return bot.sendMessage(chatId, `❌ <b>File is too big! Telegram limit: 20MB</b>`, { parse_mode: 'HTML' });
      }

      const rawName = file.file_name || msg.caption || `file_${Date.now()}`;
      const fileName = rawName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);

      statusMsg = await bot.sendMessage(chatId, `🔄 <i>Downloading from Telegram...</i>`, { parse_mode: 'HTML' });
      const fileInfo = await bot.getFile(file.file_id);
      const tgFileUrl = `https://api.telegram.org/file/bot${TOKEN}/${fileInfo.file_path}`;

      const response = await axios.get(tgFileUrl, { responseType: 'arraybuffer', timeout: 300000 });
      const buffer = Buffer.from(response.data);
      const sizeMB = (buffer.byteLength / 1024 / 1024).toFixed(2);

      await bot.editMessageText(`⬆️ <i>Uploading to MayaJaal cloud (${sizeMB} MB)...</i>`, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML' });

      const uniqueKey = `uploads/${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${fileName}`;
      await s3.send(new PutObjectCommand({
        Bucket: B2_BUCKET,
        Key: uniqueKey,
        Body: buffer,
        ContentType: file.mime_type || 'application/octet-stream',
        ContentLength: buffer.byteLength,
      }));

      const signedUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: B2_BUCKET, Key: uniqueKey }), { expiresIn: 86400 });
      const shortUrl = createShortLink(signedUrl, fileName);

      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      statusMsg = null;
      await bot.sendMessage(chatId, buildSuccessMessage(user, fileName, sizeMB, shortUrl), { parse_mode: 'HTML', disable_web_page_preview: true });
      return;
    }

    const isMagnet = text.startsWith('magnet:?');
    const isTorrentUrl = /\.torrent(\?|$)/i.test(text);
    const isHttpUrl = /^https?:\/\//i.test(text);

    if (!isMagnet && !isTorrentUrl && !isHttpUrl) return;

    if (isMagnet || isTorrentUrl) {
      return bot.sendMessage(chatId, `🧲 <b>Torrent support coming soon!</b>`, { parse_mode: 'HTML' });
    }

    statusMsg = await bot.sendMessage(chatId, `🔄 <i>Downloading from URL...</i>`, { parse_mode: 'HTML' });

    let fileName = 'file_' + Date.now();
    try {
      const urlObj = new URL(text);
      const last = urlObj.pathname.split('/').pop();
      if (last) fileName = decodeURIComponent(last);
    } catch (e) {}
    fileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'file_' + Date.now();

    const response = await axios.get(text, {
      responseType: 'arraybuffer',
      timeout: 300000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });

    const buffer = Buffer.from(response.data);
    const contentType = response.headers['content-type'] || 'application/octet-stream';
    const sizeMB = (buffer.byteLength / 1024 / 1024).toFixed(2);

    await bot.editMessageText(`⬆ <i>Uploading to MayaJaal cloud (${sizeMB} MB)...</i>`, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML' });

    const uniqueKey = `uploads/${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${fileName}`;
    await s3.send(new PutObjectCommand({
      Bucket: B2_BUCKET,
      Key: uniqueKey,
      Body: buffer,
      ContentType: contentType,
      ContentLength: buffer.byteLength,
    }));

    const signedUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: B2_BUCKET, Key: uniqueKey }), { expiresIn: 86400 });
    const shortUrl = createShortLink(signedUrl, fileName);

    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    statusMsg = null;
    await bot.sendMessage(chatId, buildSuccessMessage(user, fileName, sizeMB, shortUrl), { parse_mode: 'HTML', disable_web_page_preview: true });

  } catch (error) {
    console.error('Upload error:', error.message);
    if (statusMsg) await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    bot.sendMessage(chatId, `❌ <b>Error:</b>\n<code>${escapeHtml(error.message)}</code>`, { parse_mode: 'HTML' }).catch(() => {});
  }
});

bot.on('polling_error', (error) => console.log('Polling error:', error.code, error.message));
bot.on('error', (error) => console.log('Bot error:', error.message));
process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e.message));

(async () => {
  await setupBotCommands();
  console.log('🚀 MayaJaal Remote URL Uploader Bot chal pada hai...');
})();
                                        
