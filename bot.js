require('dotenv').config();

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');

// ═══════════════════════════════════════════
// 1. EXPRESS SERVER
// ═══════════════════════════════════════════
const app = express();
const PORT = process.env.PORT || 3000;

const linkStore = new Map();
const LINK_TTL_MS = 24 * 60 * 60 * 1000; // 24h

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
      <h1 style="color:#8b5cf6;">MayaJaal</h1>
      <h2>🔗 Link Not Found</h2>
      <p>Ye link invalid hai ya expire ho chuka hai.</p>
      </body></html>
    `);
  }
  if (Date.now() > data.expiresAt) {
    linkStore.delete(req.params.id);
    return res.status(410).send(`
      <html><body style="background:#0a0a0a;color:#fff;font-family:sans-serif;text-align:center;padding:80px 20px;">
      <h1 style="color:#8b5cf6;">MayaJaal</h1>
      <h2>⏰ Link Expired</h2>
      <p>Ye link sirf 24 ghante ke liye valid tha.</p>
      </body></html>
    `);
  }
  res.redirect(data.url);
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
// 4. USER SETTINGS STORE
// ═══════════════════════════════════════════
const userSettings = new Map();
// chatId -> { apiToken, header, footer, bold }

function getUser(chatId) {
  if (!userSettings.has(chatId)) {
    userSettings.set(chatId, {
      apiToken: null,
      header: null,
      footer: null,
      bold: false,
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

// Expired links cleanup
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
// 7. WELCOME MESSAGE
// ═══════════════════════════════════════════
const WELCOME_TEXT =
  `🎬 <b>Welcome to MayaJaal Uploader Bot!</b>\n\n` +
  `Send me any of the following and I'll upload the content and return a shareable link:\n\n` +
  `• <b>Direct file URL</b> (e.g. https://example.com/video.mp4)\n` +
  `• <b>Magnet link</b> (magnet:?xt=urn:btih:…)\n` +
  `• <b>.torrent URL</b>\n\n` +
  `<b>Commands:</b>\n` +
  `/api TOKEN — Link your MayaJaal account\n` +
  `/add_header TEXT — Add text above your link\n` +
  `/remove_header — Remove header\n` +
  `/add_footer TEXT — Add text below your link\n` +
  `/remove_footer — Remove footer\n` +
  `/enable_bold — Make header & footer bold\n` +
  `/disable_bold — Normal text\n` +
  `/settings — View current settings`;

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, WELCOME_TEXT, { parse_mode: 'HTML' });
});

// ═══════════════════════════════════════════
// 8. COMMANDS
// ═══════════════════════════════════════════

// /api TOKEN
bot.onText(/\/api(?:\s+(.+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  const token = match[1]?.trim();
  const user = getUser(chatId);

  if (!token) {
    if (user.apiToken) {
      const masked = user.apiToken.slice(0, 6) + '...' + user.apiToken.slice(-4);
      return bot.sendMessage(
        chatId,
        `✅ <b>API Token already linked:</b>\n<code>${escapeHtml(masked)}</code>\n\n` +
        `Use <code>/api NEW_TOKEN</code> to update.`,
        { parse_mode: 'HTML' }
      );
    }
    return bot.sendMessage(
      chatId,
      `❌ <b>No API token linked.</b>\n\nUse:\n<code>/api YOUR_TOKEN</code>`,
      { parse_mode: 'HTML' }
    );
  }

  user.apiToken = token;
  bot.sendMessage(chatId,
    `✅ <b>API Token linked successfully!</b>\n\nYou can now upload files.`,
    { parse_mode: 'HTML' }
  );
});

// /add_header TEXT
bot.onText(/\/add_header(?:\s+(.+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  const text = match[1]?.trim();
  if (!text) {
    return bot.sendMessage(chatId,
      `❌ <b>Usage:</b>\n<code>/add_header YOUR TEXT</code>`,
      { parse_mode: 'HTML' }
    );
  }
  getUser(chatId).header = text;
  bot.sendMessage(chatId,
    `✅ <b>Header added:</b>\n${escapeHtml(text)}`,
    { parse_mode: 'HTML' }
  );
});

// /remove_header
bot.onText(/\/remove_header/, (msg) => {
  getUser(msg.chat.id).header = null;
  bot.sendMessage(msg.chat.id, '✅ Header removed.');
});

// /add_footer TEXT
bot.onText(/\/add_footer(?:\s+(.+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  const text = match[1]?.trim();
  if (!text) {
    return bot.sendMessage(chatId,
      `❌ <b>Usage:</b>\n<code>/add_footer YOUR TEXT</code>`,
      { parse_mode: 'HTML' }
    );
  }
  getUser(chatId).footer = text;
  bot.sendMessage(chatId,
    `✅ <b>Footer added:</b>\n${escapeHtml(text)}`,
    { parse_mode: 'HTML' }
  );
});

// /remove_footer
bot.onText(/\/remove_footer/, (msg) => {
  getUser(msg.chat.id).footer = null;
  bot.sendMessage(msg.chat.id, '✅ Footer removed.');
});

// /enable_bold
bot.onText(/\/enable_bold/, (msg) => {
  getUser(msg.chat.id).bold = true;
  bot.sendMessage(msg.chat.id,
    '✅ <b>Bold enabled</b> for header & footer.',
    { parse_mode: 'HTML' }
  );
});

// /disable_bold
bot.onText(/\/disable_bold/, (msg) => {
  getUser(msg.chat.id).bold = false;
  bot.sendMessage(msg.chat.id, '✅ Bold disabled.');
});

// /settings
bot.onText(/\/settings/, (msg) => {
  const chatId = msg.chat.id;
  const u = getUser(chatId);
  const text =
    `⚙️ <b>Your MayaJaal Settings</b>\n\n` +
    `🔑 <b>API Token:</b> ${u.apiToken ? '✅ Linked' : '❌ Not linked'}\n` +
    `📝 <b>Header:</b> ${u.header ? escapeHtml(u.header) : '<i>(none)</i>'}\n` +
    `📝 <b>Footer:</b> ${u.footer ? escapeHtml(u.footer) : '<i>(none)</i>'}\n` +
    `🅱️ <b>Bold:</b> ${u.bold ? 'ON' : 'OFF'}`;
  bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
});

// ═══════════════════════════════════════════
// 9. URL / MAGNET / TORRENT HANDLER
// ═══════════════════════════════════════════
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || '';

  if (text.startsWith('/')) return;

  const isMagnet = text.startsWith('magnet:?');
  const isTorrentUrl = /\.torrent(\?|$)/i.test(text);
  const isHttpUrl = /^https?:\/\//i.test(text);

  if (!isMagnet && !isTorrentUrl && !isHttpUrl) return;

  const user = getUser(chatId);

  // API token required
  if (!user.apiToken) {
    return bot.sendMessage(chatId,
      `❌ <b>Pehle apna API token link karo:</b>\n\n<code>/api YOUR_TOKEN</code>`,
      { parse_mode: 'HTML' }
    );
  }

  let statusMsg = null;

  try {
    // Torrent — coming soon
    if (isMagnet || isTorrentUrl) {
      return bot.sendMessage(chatId,
        `🧲 <b>Torrent support coming soon!</b>\n\nAbhi ke liye direct URL bhejo.`,
        { parse_mode: 'HTML' }
      );
    }

    // Direct URL
    statusMsg = await bot.sendMessage(chatId,
      `🔄 <i>Downloading from URL...</i>`,
      { parse_mode: 'HTML' }
    );

    // Filename nikaalo
    let fileName = 'file_' + Date.now();
    try {
      const urlObj = new URL(text);
      const last = urlObj.pathname.split('/').pop();
      if (last) fileName = decodeURIComponent(last);
    } catch (e) {}
    fileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'file_' + Date.now();

    // Download
    const response = await axios.get(text, {
      responseType: 'arraybuffer',
      timeout: 300000,
      maxContentLength: 500 * 1024 * 1024,
      maxBodyLength: 500 * 1024 * 1024,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      },
    });

    const buffer = Buffer.from(response.data);
    const contentType = response.headers['content-type'] || 'application/octet-stream';
    const sizeMB = (buffer.byteLength / 1024 / 1024).toFixed(2);

    // Upload status
    await bot.editMessageText(
      `⬆️ <i>Uploading to MayaJaal cloud (${sizeMB} MB)...</i>`,
      { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML' }
    );

    // B2 upload
    const uniqueKey = `uploads/${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${fileName}`;
    await s3.send(new PutObjectCommand({
      Bucket: B2_BUCKET,
      Key: uniqueKey,
      Body: buffer,
      ContentType: contentType,
      ContentLength: buffer.byteLength,
    }));

    // Signed URL
    const signedUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: B2_BUCKET, Key: uniqueKey }),
      { expiresIn: 86400 }
    );

    // Short link
    const shortUrl = createShortLink(signedUrl);

    // Status delete
    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    statusMsg = null;

    // Final message with header/footer
    const parts = [];

    if (user.header) {
      parts.push(user.bold ? `<b>${escapeHtml(user.header)}</b>` : escapeHtml(user.header));
      parts.push('');
    }

    parts.push(`✨ <b>MayaJaal Upload Complete!</b>`);
    parts.push('');
    parts.push(`📌 <b>File:</b> ${escapeHtml(fileName)}`);
    parts.push(`📦 <b>Size:</b> ${sizeMB} MB`);
    parts.push('');
    parts.push(`🔗 <b>Link:</b>\n${shortUrl}`);

    if (user.footer) {
      parts.push('');
      parts.push(user.bold ? `<b>${escapeHtml(user.footer)}</b>` : escapeHtml(user.footer));
    }

    parts.push('');
    parts.push(`⏰ <i>Valid 24 hours</i>`);

    await bot.sendMessage(chatId, parts.join('\n'), {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

  } catch (error) {
    console.error('Upload error:', error.message);
    if (statusMsg) {
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    }
    bot.sendMessage(chatId,
      `❌ <b>Upload failed:</b>\n<code>${escapeHtml(error.message)}</code>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }
});

// ═══════════════════════════════════════════
// 10. ERRORS
// ═══════════════════════════════════════════
bot.on('polling_error', (error) => console.log('Polling error:', error.code, error.message));
bot.on('error', (error) => console.log('Bot error:', error.message));
process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e.message));

console.log('🚀 MayaJaal Uploader Bot chal pada hai...');
