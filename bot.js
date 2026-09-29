require('dotenv').config();

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');

// ═══════════════════════════════════════════
// 0. REDIS + CONFIG
// ═══════════════════════════════════════════
const redis = Redis.fromEnv();

const WEB_PAGE_URL = process.env.WEB_PAGE_URL || 'https://matrix-api-seven.vercel.app';
const BACKEND_URL = process.env.BACKEND_URL || 'https://mayajaal-backend.vercel.app';
const TERABOX_API = process.env.TERABOX_API || 'https://terabox.hnn.workers.dev/api';

// ═══════════════════════════════════════════
// 1. EXPRESS SERVER
// ═══════════════════════════════════════════
const app = express();
const PORT = process.env.PORT || 3000;

const linkStore = new Map();
const LINK_TTL_MS = 24 * 60 * 60 * 1000;

const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : process.env.BASE_URL || `http://localhost:${PORT}`;

app.get('/', (req, res) => res.send('MayaJaal Bot is running!'));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.get('/v/:id', (req, res) => {
  const data = linkStore.get(req.params.id);
  if (!data) {
    return res.status(404).send(`
      <html><body style="background:#0a0a0a;color:#fff;font-family:sans-serif;text-align:center;padding:80px 20px;">
      <h1 style="color:#00ff88;">MayaJaal</h1>
      <h2>🔗 Link Not Found</h2>
      <p>Ye link invalid hai ya expire ho chuka hai.</p>
      </body></html>
    `);
  }
  if (Date.now() > data.expiresAt) {
    linkStore.delete(req.params.id);
    return res.status(410).send(`
      <html><body style="background:#0a0a0a;color:#fff;font-family:sans-serif;text-align:center;padding:80px 20px;">
      <h1 style="color:#00ff88;">MayaJaal</h1>
      <h2>⏰ Link Expired</h2>
      <p>Ye link sirf 24 ghante ke liye valid tha.</p>
      </body></html>
    `);
  }
  res.redirect(data.url);
});

app.get('/tb/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const data = await redis.get(`terabox:${id}`);

    if (!data) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>MayaJaal</title>
        <style>body{background:#000;color:#fff;font-family:sans-serif;text-align:center;padding:50px}h2{color:#00ff88;text-shadow:0 0 10px #00ff88}</style></head>
        <body><h2>MayaJaal</h2><p>File not found or expired.</p></body></html>
      `);
    }

    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    const videoUrl = parsed.url;
    const fileName = parsed.name || 'MayaJaal Video';

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${fileName} · MayaJaal</title>
        <style>
          html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: #000; overflow: hidden; font-family: 'Courier New', monospace; }
          #player-wrap { position: relative; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; background: #000; }
          video { width: 100%; height: 100%; object-fit: contain; background: #000; }
          .brand-tag { position: fixed; top: 10px; left: 50%; transform: translateX(-50%); color: #00ff88; font-size: 11px; letter-spacing: 3px; text-transform: uppercase; text-shadow: 0 0 8px #00ff88; opacity: 0.75; z-index: 100; pointer-events: none; }
          .loading { color: #00ff88; font-size: 14px; letter-spacing: 2px; position: absolute; z-index: 5; }
        </style>
      </head>
      <body>
        <div class="brand-tag">● MAYA JAAL PLAYER</div>
        <div id="player-wrap">
          <div class="loading" id="loadingTxt">loading stream...</div>
          <video id="player" controls autoplay playsinline preload="metadata" style="display:none;">
            <source src="${videoUrl}">
          </video>
        </div>
        <script>
          const video = document.getElementById('player');
          const loading = document.getElementById('loadingTxt');
          video.addEventListener('loadedmetadata', function() { loading.style.display = 'none'; video.style.display = 'block'; });
          video.addEventListener('error', function() { loading.textContent = '❌ Stream unavailable'; loading.style.color = '#ff5555'; });
          setTimeout(function() { if (video.readyState < 2) { loading.textContent = '⚠️ Stream slow hai, wait karein...'; } }, 5000);
        </script>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('TB play error:', err.message);
    res.status(500).send(`
      <!DOCTYPE html>
      <html><head><meta charset="UTF-8"><title>MayaJaal</title>
      <style>body{background:#000;color:#fff;font-family:sans-serif;text-align:center;padding:50px}h2{color:#00ff88}</style></head>
      <body><h2>MayaJaal</h2><p>Error loading media.</p></body></html>
    `);
  }
});

// ═══════════════════════════════════════════
// ANDROID APP LINKS VERIFICATION
// ═══════════════════════════════════════════
app.get('/.well-known/assetlinks.json', (req, res) => {
  res.set('Content-Type', 'application/json');
  res.json([{
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: "com.example.mayajaall",
      sha256_cert_fingerprints: [
        "EB:95:67:4F:97:47:5F:B9:DD:59:8F:D3:2D:97:B1:66:87:FB:8E:4F:43:B5:EC:AE:45:CB:EE:CE:85:A3:92:14"
      ]
    }
  }]);
});

// ═══════════════════════════════════════════
// APP KE LIYE JSON API (direct video URL)
// ═══════════════════════════════════════════
app.get('/api/tb/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const data = await redis.get(`terabox:${id}`);

    if (!data) {
      return res.status(404).json({ error: 'Not found or expired' });
    }

    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    res.json({
      video_url: parsed.url,
      file_name: parsed.name || 'MayaJaal Video'
    });
  } catch (err) {
    console.error('API tb error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
  console.log(`🌐 Base URL: ${BASE_URL}`);
});

// ═══════════════════════════════════════════
// 2. CONFIG
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

// ═══════════════════════════════════════════
// 3. B2 CLIENT
// ═══════════════════════════════════════════
const s3 = new S3Client({
  region: B2_REGION,
  endpoint: `https://${B2_ENDPOINT}`,
  credentials: {
    accessKeyId: B2_KEY_ID,
    secretAccessKey: B2_APP_KEY,
  },
});

// ═══════════════════════════════════════════
// 4. USER SETTINGS
// ═══════════════════════════════════════════
const userSettings = new Map();

function getUser(chatId) {
  if (!userSettings.has(chatId)) {
    userSettings.set(chatId, {
      apiToken: null,
      header: null,
      footer: null,
      bold: false,
      enableText: true,
    });
  }
  return userSettings.get(chatId);
}

// ═══════════════════════════════════════════
// 5. BOT
// ═══════════════════════════════════════════
const bot = new TelegramBot(TOKEN, { polling: true });

// ═══════════════════════════════════════════
// 6. HELPERS
// ═══════════════════════════════════════════
function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function createShortLink(signedUrl) {
  const id = crypto.randomBytes(4).toString('hex');
  linkStore.set(id, {
    url: signedUrl,
    expiresAt: Date.now() + LINK_TTL_MS,
  });
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

// Cleanup expired short links
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
}, 10 * 60 * 1000);// ═══════════════════════════════════════════
// 9. SET BOT COMMANDS
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

// ═══════════════════════════════════════════
// 10. WELCOME
// ═══════════════════════════════════════════
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

// ═══════════════════════════════════════════
// 11. /api COMMAND
// ═══════════════════════════════════════════
bot.onText(/\/api(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const token = match[1]?.trim();
  const user = getUser(chatId);

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

// ═══════════════════════════════════════════
// 12. OTHER COMMANDS
// ═══════════════════════════════════════════
bot.onText(/\/add_header(?:\s+([\s\S]+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  const text = match[1]?.trim();
  if (!text) {
    return bot.sendMessage(chatId, `❌ <b>Usage:</b>\n<code>/add_header YOUR TEXT</code>`, { parse_mode: 'HTML' });
  }
  getUser(chatId).header = text;
  bot.sendMessage(chatId, `✅ <b>Header added:</b>\n${escapeHtml(text)}`, { parse_mode: 'HTML' });
});

bot.onText(/\/remove_header/, (msg) => {
  getUser(msg.chat.id).header = null;
  bot.sendMessage(msg.chat.id, '✅ Header removed.');
});

bot.onText(/\/add_footer(?:\s+([\s\S]+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  const text = match[1]?.trim();
  if (!text) {
    return bot.sendMessage(chatId, `❌ <b>Usage:</b>\n<code>/add_footer YOUR TEXT</code>`, { parse_mode: 'HTML' });
  }
  getUser(chatId).footer = text;
  bot.sendMessage(chatId, `✅ <b>Footer added:</b>\n${escapeHtml(text)}`, { parse_mode: 'HTML' });
});

bot.onText(/\/remove_footer/, (msg) => {
  getUser(msg.chat.id).footer = null;
  bot.sendMessage(msg.chat.id, '✅ Footer removed.');
});

bot.onText(/\/enable_text/, (msg) => {
  getUser(msg.chat.id).enableText = true;
  bot.sendMessage(msg.chat.id, '✅ <b>Surrounding text enabled.</b>', { parse_mode: 'HTML' });
});

bot.onText(/\/disable_text/, (msg) => {
  getUser(msg.chat.id).enableText = false;
  bot.sendMessage(msg.chat.id, '✅ <b>Surrounding text disabled.</b>', { parse_mode: 'HTML' });
});

bot.onText(/\/enable_bold/, (msg) => {
  getUser(msg.chat.id).bold = true;
  bot.sendMessage(msg.chat.id, '✅ <b>Bold enabled</b>.', { parse_mode: 'HTML' });
});

bot.onText(/\/disable_bold/, (msg) => {
  getUser(msg.chat.id).bold = false;
  bot.sendMessage(msg.chat.id, '✅ Bold disabled.');
});

// ═══ /logout command ═══
bot.onText(/\/logout/, (msg) => {
  const chatId = msg.chat.id;
  const user = getUser(chatId);

  if (!user.apiToken) {
    return bot.sendMessage(chatId,
      `❌ <b>Aap logged in nahi ho.</b>\n\nLogin: <code>/api</code>`,
      { parse_mode: 'HTML' }
    );
  }

  user.apiToken = null;
  bot.sendMessage(chatId,
    `👋 <b>Logged out successfully!</b>\n\nDobara login: <code>/api</code>`,
    { parse_mode: 'HTML' }
  );
});

// ═══════════════════════════════════════════
// 13. /settings COMMAND
// ═══════════════════════════════════════════
bot.onText(/\/settings/, (msg) => {
  const chatId = msg.chat.id;
  const u = getUser(chatId);
  const text =
    `⚙️ <b>Your MayaJaal Settings</b>\n\n` +
    `🔑 <b>Matrix Key:</b> ${u.apiToken ? '✅ Linked' : '❌ Not linked'}\n` +
    `📝 <b>Header:</b> ${u.header ? escapeHtml(u.header) : '<i>(none)</i>'}\n` +
    `📝 <b>Footer:</b> ${u.footer ? escapeHtml(u.footer) : '<i>(none)</i>'}\n` +
    `💬 <b>Surrounding text:</b> ${u.enableText ? 'ON' : 'OFF'}\n` +
    `🅱️ <b>Bold:</b> ${u.bold ? 'ON' : 'OFF'}`;

  const opts = { parse_mode: 'HTML' };
  if (u.apiToken) {
    opts.reply_markup = {
      inline_keyboard: [[
        { text: '🚪 Logout', callback_data: 'logout_user' }
      ]]
    };
  }

  bot.sendMessage(chatId, text, opts);
});

// ═══ Logout button handler ═══
bot.on('callback_query', (query) => {
  if (query.data === 'logout_user') {
    const chatId = query.message.chat.id;
    const user = getUser(chatId);
    user.apiToken = null;
    bot.answerCallbackQuery(query.id, { text: '✅ Logged out!' });
    bot.sendMessage(chatId,
      `👋 <b>Logged out successfully.</b>\n\nDobara login: <code>/api</code>`,
      { parse_mode: 'HTML' }
    );
  }
});

// ═══════════════════════════════════════════
// 14. BUILD SUCCESS MESSAGE
// ═══════════════════════════════════════════
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
                             }// ═══════════════════════════════════════════
// 15. MEDIA HANDLER
// ═══════════════════════════════════════════
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || '';

  if (text.startsWith('/')) return;

  const user = getUser(chatId);

  if (!user.apiToken) {
    const fileCheck = pickFile(msg);
    const isUrl = /^https?:\/\//i.test(text) || text.startsWith('magnet:?');
    if (fileCheck || isUrl) {
      const keyboard = {
        inline_keyboard: [[
          { text: '🔑 Get Matrix Key', url: `${WEB_PAGE_URL}?tg=${chatId}` }
        ]]
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
    // ═══ CASE 1: TERABOX LINK ═══
    const isTerabox = /(terabox|terasharefile|1024tera|teraboxapp|teraboxshare|teraboxlink|tibibox|momerybox|mirrorbox|4funbox|dubox|freeterabox|nekopoi)/i.test(text);

    if (isTerabox && /^https?:\/\//i.test(text)) {
      statusMsg = await bot.sendMessage(chatId,
        `🔄 <i>Extracting Terabox link...</i>`,
        { parse_mode: 'HTML' }
      );

      const extracted = await extractTeraboxLink(text);

      if (!extracted || !extracted.url) {
        await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
        return bot.sendMessage(chatId,
          `❌ <b>Terabox link extract nahi ho paya.</b>\n\n` +
          `Possible reasons:\n` +
          `• Link private hai\n` +
          `• Link expire ho gaya\n` +
          `• API temporarily down hai\n\n` +
          `Kripya dusra link try karein.`,
          { parse_mode: 'HTML' }
        );
      }

      const shortId = crypto.randomBytes(4).toString('hex');
      await redis.set(
        `terabox:${shortId}`,
        JSON.stringify({ url: extracted.url, name: extracted.name }),
        { ex: 86400 }
      );

      const myLink = `${BASE_URL}/tb/${shortId}`;

      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      statusMsg = null;

      await bot.sendMessage(chatId,
        buildSuccessMessage(user, extracted.name, null, myLink),
        { parse_mode: 'HTML', disable_web_page_preview: true }
      );
      return;
    }

    // ═══ CASE 2: DISKWALA LINK ═══
    const isDiskwala = /diskwala\.com/i.test(text);

    if (isDiskwala && /^https?:\/\//i.test(text)) {
      statusMsg = await bot.sendMessage(chatId,
        `🔄 <i>Extracting Diskwala link...</i>`,
        { parse_mode: 'HTML' }
      );

      const extracted = await extractDiskwalaLink(text);

      if (!extracted || !extracted.url) {
        await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
        return bot.sendMessage(chatId,
          `❌ <b>Diskwala link extract nahi ho paya.</b>\n\n` +
          `Possible reasons:\n` +
          `• Link private hai\n` +
          `• Link expire ho gaya\n` +
          `• Page structure change ho gaya\n\n` +
          `Kripya dusra link try karein.`,
          { parse_mode: 'HTML' }
        );
      }

      const shortId = crypto.randomBytes(4).toString('hex');
      await redis.set(
        `terabox:${shortId}`,
        JSON.stringify({ url: extracted.url, name: extracted.name }),
        { ex: 86400 }
      );

      const myLink = `${BASE_URL}/tb/${shortId}`;

      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      statusMsg = null;

      await bot.sendMessage(chatId,
        buildSuccessMessage(user, extracted.name, null, myLink),
        { parse_mode: 'HTML', disable_web_page_preview: true }
      );
      return;
    }

    // ═══ CASE 3: Telegram file ═══
    const file = pickFile(msg);

    if (file) {
      if (file.file_size && file.file_size > 20 * 1024 * 1024) {
        return bot.sendMessage(chatId,
          `❌ <b>File is too big!</b>\n\n` +
          `Telegram Bot API ki limit <b>20 MB</b> hai.\n` +
          `Aapki file: <b>${(file.file_size / 1024 / 1024).toFixed(2)} MB</b>\n\n` +
          `Kripya chhoti file bhejein ya direct URL use karein.`,
          { parse_mode: 'HTML' }
        );
      }

      const rawName = file.file_name || msg.caption || `file_${Date.now()}`;
      const fileName = rawName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);

      statusMsg = await bot.sendMessage(chatId,
        `🔄 <i>Downloading from Telegram...</i>`,
        { parse_mode: 'HTML' }
      );

      const fileInfo = await bot.getFile(file.file_id);
      const tgFileUrl = `https://api.telegram.org/file/bot${TOKEN}/${fileInfo.file_path}`;

      const response = await axios.get(tgFileUrl, {
        responseType: 'arraybuffer',
        timeout: 300000,
        maxContentLength: 500 * 1024 * 1024,
        maxBodyLength: 500 * 1024 * 1024,
      });

      const buffer = Buffer.from(response.data);
      const sizeMB = (buffer.byteLength / 1024 / 1024).toFixed(2);

      await bot.editMessageText(
        `⬆️ <i>Uploading to MayaJaal cloud (${sizeMB} MB)...</i>`,
        { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML' }
      );

      const uniqueKey = `uploads/${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${fileName}`;
      await s3.send(new PutObjectCommand({
        Bucket: B2_BUCKET,
        Key: uniqueKey,
        Body: buffer,
        ContentType: file.mime_type || 'application/octet-stream',
        ContentLength: buffer.byteLength,
      }));

      const signedUrl = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: B2_BUCKET, Key: uniqueKey }),
        { expiresIn: 86400 }
      );

      const shortUrl = createShortLink(signedUrl);

      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      statusMsg = null;

      await bot.sendMessage(chatId, buildSuccessMessage(user, fileName, sizeMB, shortUrl), {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
      return;
    }

    // ═══ CASE 4: Direct URL / Magnet ═══
    const isMagnet = text.startsWith('magnet:?');
    const isTorrentUrl = /\.torrent(\?|$)/i.test(text);
    const isHttpUrl = /^https?:\/\//i.test(text);

    if (!isMagnet && !isTorrentUrl && !isHttpUrl) return;

    if (isMagnet || isTorrentUrl) {
      return bot.sendMessage(chatId,
        `🧲 <b>Torrent support coming soon!</b>`,
        { parse_mode: 'HTML' }
      );
    }

    statusMsg = await bot.sendMessage(chatId,
      `🔄 <i>Downloading from URL...</i>`,
      { parse_mode: 'HTML' }
    );

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
      maxContentLength: 500 * 1024 * 1024,
      maxBodyLength: 500 * 1024 * 1024,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
      },
    });

    const buffer = Buffer.from(response.data);
    const contentType = response.headers['content-type'] || 'application/octet-stream';
    const sizeMB = (buffer.byteLength / 1024 / 1024).toFixed(2);

    await bot.editMessageText(
      `⬆️ <i>Uploading to MayaJaal cloud (${sizeMB} MB)...</i>`,
      { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML' }
    );

    const uniqueKey = `uploads/${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${fileName}`;
    await s3.send(new PutObjectCommand({
      Bucket: B2_BUCKET,
      Key: uniqueKey,
      Body: buffer,
      ContentType: contentType,
      ContentLength: buffer.byteLength,
    }));

    const signedUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: B2_BUCKET, Key: uniqueKey }),
      { expiresIn: 86400 }
    );

    const shortUrl = createShortLink(signedUrl);

    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    statusMsg = null;

    await bot.sendMessage(chatId, buildSuccessMessage(user, fileName, sizeMB, shortUrl), {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

  } catch (error) {
    console.error('Upload error:', error.message);
    if (statusMsg) {
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    }
    bot.sendMessage(chatId,
      `❌ <b>Error:</b>\n<code>${escapeHtml(error.message)}</code>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }
});

// ═══════════════════════════════════════════
// 16. ERRORS
// ═══════════════════════════════════════════
bot.on('polling_error', (error) => console.log('Polling error:', error.code, error.message));
bot.on('error', (error) => console.log('Bot error:', error.message));
process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e.message));

// ═══════════════════════════════════════════
// 17. STARTUP
// ═══════════════════════════════════════════
(async () => {
  await setupBotCommands();
  console.log('🚀 MayaJaal Remote URL Uploader Bot chal pada hai...');
})();
