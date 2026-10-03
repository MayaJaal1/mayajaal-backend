require('dotenv').config();

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const path = require('path');
const fs = require('fs');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

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
  console.error('❌ BOT_TOKEN missing!');
  process.exit(1);
}

// ═══════════════════════════════════════════
// 1. CLOUDFLARE R2 CLIENT SETUP
// ═══════════════════════════════════════════
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_DOMAIN = process.env.R2_PUBLIC_DOMAIN;

const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

console.log('✅ Cloudflare R2 Engine Initialized!');

// ═══════════════════════════════════════════
// 2. EXPRESS HTTP SERVER CONFIG
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

app.get('/', (req, res) => res.send('MayaJaal Fast Stream Engine Live!'));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

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

app.get('/key', async (req, res) => {
  try {
    const tgId = req.query.tg;
    if (!tgId) return res.status(400).send('Telegram ID missing in URL');
    
    const key = crypto.randomBytes(16).toString('hex');
    await redis.set(`matrix_key:${key}`, String(tgId), { ex: 30 * 86400 });
    
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>MayaJaal API Key</title>
        <style>
          body { background: #07090e; color: #00ff88; font-family: sans-serif; text-align: center; padding: 50px; }
          .card { background: #0f172a; border: 1px solid #1e293b; border-radius: 16px; padding: 24px; display: inline-block; max-width: 90%; }
          .key-box { background: #1e293b; padding: 15px; border-radius: 8px; font-size: 16px; margin: 20px 0; word-break: break-all; color: #fff; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>🔑 MayaJaal API Key Generated!</h2>
          <div class="key-box"><code>${key}</code></div>
          <p>Is key ko bot par bhejein: <code>/api ${key}</code></p>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Error generating key: ' + err.message);
  }
});

// 3. Streaming Engine
app.get('/stream/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let data = linkStore.get(id);

    if (!data) {
      const raw = (await redis.get(`video:${id}`)) || (await redis.get(`terabox:${id}`));
      if (raw) data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    }

    if (!data || !data.url) return res.status(404).send('Stream not found');

    const targetUrl = data.url;

    if (targetUrl.includes('r2.cloudflarestorage.com') || (R2_PUBLIC_DOMAIN && targetUrl.includes(R2_PUBLIC_DOMAIN))) {
      return res.redirect(targetUrl);
    }

    let rawCookie = process.env.TERABOX_COOKIE || '';
    if (rawCookie && !rawCookie.includes('ndus=')) {
      rawCookie = `ndus=${rawCookie.trim()};`;
    }

    const isTerabox = 
      targetUrl.includes('terabox') || targetUrl.includes('1024tera') || 
      targetUrl.includes('baidupcs') || targetUrl.includes('terasharefile') || 
      targetUrl.includes('terasharelink') || targetUrl.includes('teraboxlink');

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Referer': isTerabox ? 'https://www.1024tera.com/' : (targetUrl.includes('diskwala') ? 'https://diskwala.com/' : 'https://mayajaal.online/'),
      'Cookie': rawCookie,
      'Accept': '*/*'
    };

    if (req.headers.range) headers['Range'] = req.headers.range;

    const videoStream = await axios.get(targetUrl, {
      responseType: 'stream',
      headers: headers,
      maxRedirects: 10,
      timeout: 60000
    });

    res.status(videoStream.status);
    res.setHeader('Content-Type', videoStream.headers['content-type'] || 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    if (videoStream.headers['content-range']) res.setHeader('Content-Range', videoStream.headers['content-range']);
    if (videoStream.headers['content-length']) res.setHeader('Content-Length', videoStream.headers['content-length']);

    videoStream.data.pipe(res);
  } catch (err) {
    if (!res.headersSent) res.status(500).send('Streaming error');
  }
});

app.listen(PORT, () => console.log(`✅ MayaJaal Web Engine running on port ${PORT}`));
// ═══════════════════════════════════════════
// 4. LINK RESOLVERS
// ═══════════════════════════════════════════
async function extractTeraboxLink(rawUrl) {
  try {
    let resolvedUrl = rawUrl;
    try {
      const resp = await axios.get(rawUrl, {
        maxRedirects: 5,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        timeout: 8000
      });
      if (resp.request?.res?.responseUrl) resolvedUrl = resp.request.res.responseUrl;
    } catch (e) {}

    const match = resolvedUrl.match(/\/(s|sharing\/link\?surl=)([a-zA-Z0-9_-]+)/i) || 
                  resolvedUrl.match(/surl=([a-zA-Z0-9_-]+)/i) ||
                  rawUrl.match(/\/s\/([a-zA-Z0-9_-]+)/i);

    let shorturl = match ? (match[2] || match[1]) : '';
    if (!shorturl && resolvedUrl.includes('/s/')) shorturl = resolvedUrl.split('/s/')[1].split(/[?&#]/)[0];
    if (!shorturl && rawUrl.includes('/s/')) shorturl = rawUrl.split('/s/')[1].split(/[?&#]/)[0];
    if (!shorturl) return null;

    const formattedKey = shorturl.startsWith('1') ? shorturl.substring(1) : shorturl;
    let rawCookie = process.env.TERABOX_COOKIE || '';
    if (rawCookie && !rawCookie.includes('ndus=')) rawCookie = `ndus=${rawCookie.trim()};`;

    for (const k of [formattedKey, shorturl]) {
      try {
        const res = await axios.get(`https://www.1024tera.com/share/list?app_id=250528&shorturl=${k}&root=1`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://www.1024tera.com/',
            'Cookie': rawCookie,
            'Accept': 'application/json, text/plain, */*'
          },
          timeout: 8000
        });

        if (res.data?.errno === 0 && res.data?.list?.length > 0) {
          const file = res.data.list[0];
          const streamUrl = file.dlink || file.direct_link || file.url;
          if (streamUrl) return { url: streamUrl, name: file.server_filename || 'Terabox Video' };
        }
      } catch (err) {}
    }

    try {
      const gw = await axios.get(`https://terabox-api.graydeveloper.workers.dev/?url=${encodeURIComponent(rawUrl)}`, { timeout: 9000 });
      if (gw.data && (gw.data.direct_link || gw.data.download_link || gw.data.stream_url)) {
        return { url: gw.data.direct_link || gw.data.download_link || gw.data.stream_url, name: gw.data.file_name || 'Terabox Video' };
      }
    } catch (e) {}
  } catch (e) {}
  return null;
}

async function extractDiskwalaLink(diskwalaUrl) {
  try {
    const match = diskwalaUrl.match(/\/(app|view|file|p|post|d)\/([a-zA-Z0-9_-]+)/i) || diskwalaUrl.match(/diskwala\.com\/([a-zA-Z0-9_-]+)/i);
    const fileId = match ? (match[2] || match[1]) : null;
    if (!fileId) return null;
    const baseHeaders = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Referer': 'https://diskwala.com/' };
    try {
      const pageRes = await axios.get(diskwalaUrl, { headers: baseHeaders, timeout: 6000 });
      if (typeof pageRes.data === 'string') {
        const streamMatch = pageRes.data.match(/"(https?:\/\/[^"]+\.(mp4|m3u8)[^"]*)"/i) || pageRes.data.match(/src=["'](https?:\/\/[^"']+)["']/i);
        if (streamMatch && streamMatch[1]) return { url: streamMatch[1], name: 'Diskwala Video' };
      }
    } catch (e) {}
    return null;
  } catch (e) { return null; }
}

// ═══════════════════════════════════════════
// 5. TELEGRAM BOT CONTROLLER
// ═══════════════════════════════════════════
const bot = new TelegramBot(TOKEN, { polling: { autoStart: true, params: { timeout: 10 } } });

bot.on('polling_error', async (error) => {
  if (error.message && error.message.includes('409 Conflict')) await new Promise(r => setTimeout(r, 4000));
});

async function getUser(chatId) {
  try {
    const data = await redis.get(`user_settings:${chatId}`);
    if (data) return typeof data === 'string' ? JSON.parse(data) : data;
  } catch (err) {}
  return { apiToken: null, header: null, footer: null, bold: false, enableText: true };
}

async function saveUser(chatId, data) {
  try { await redis.set(`user_settings:${chatId}`, JSON.stringify(data)); } catch (err) {}
}

function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `🎬 <b>MayaJaal Ultra Stream Engine</b>\n\n` +
    `• <b>Bulk Converter:</b> Terabox, Terasharefile, Diskwala links bhejein\n` +
    `• <b>Cloudflare Upload:</b> Video send karein seedhe R2 par upload hogi\n` +
    `• <b>API Setup:</b> <code>/api</code> command use karein`,
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
    `Key pane ke liye link kholein:\n${keyUrl}\n\n` +
    `Key milne par bhein:\n<code>/api YOUR_KEY</code>`,
    { parse_mode: 'HTML', disable_web_page_preview: true }
  );
});

// Video Handler (Uploads directly to Cloudflare R2)
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const user = await getUser(chatId);
  const uploaderName = msg.from?.username ? `@${msg.from.username}` : (msg.from?.first_name || 'MayaJaal Cloud');

  const videoObj = msg.video || msg.document || (msg.animation ? msg.animation : null);
  if (videoObj) {
    const fileId = videoObj.file_id;
    const fileName = videoObj.file_name || `video_${Date.now()}.mp4`;
    const statusMsg = await bot.sendMessage(chatId, `⚡ <i>Video Cloudflare R2 par upload ho rahi hai...</i>`, { parse_mode: 'HTML' });

    try {
      const fileLink = await bot.getFileLink(fileId);
      const videoStream = await axios.get(fileLink, { responseType: 'stream' });

      const fileExt = path.extname(fileName) || '.mp4';
      const r2Key = `videos/${crypto.randomBytes(8).toString('hex')}${fileExt}`;

      const uploadCommand = new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: r2Key,
        Body: videoStream.data,
        ContentType: videoObj.mime_type || 'video/mp4',
      });

      await r2Client.send(uploadCommand);

      const r2PublicUrl = R2_PUBLIC_DOMAIN 
        ? `https://${R2_PUBLIC_DOMAIN.replace(/^https?:\/\//, '')}/${r2Key}`
        : `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET_NAME}/${r2Key}`;

      const shortId = crypto.randomBytes(4).toString('hex');
      const payload = { name: fileName, url: r2PublicUrl, uploader: uploaderName };
      linkStore.set(shortId, payload);
      await redis.set(`video:${shortId}`, JSON.stringify(payload), { ex: 30 * 86400 });

      const playUrl = `${BASE_URL}/v/${shortId}`;
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});

      let reply = `✨ <b>MayaJaal Stream Ready!</b>\n\n`;
      if (user.header && user.enableText) reply = `<b>${escapeHtml(user.header)}</b>\n\n` + reply;
      reply += `📌 <b>File:</b> ${escapeHtml(fileName)}\n\n🔗 <b>Cloudflare Player Link:</b>\n${playUrl}\n\n⚡ <i>Cloudflare R2 Ultra-Fast Streaming Active!</i>`;
      if (user.footer && user.enableText) reply += `\n\n<b>${escapeHtml(user.footer)}</b>`;
      return bot.sendMessage(chatId, reply, { parse_mode: 'HTML', disable_web_page_preview: false });

    } catch (err) {
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      return bot.sendMessage(chatId, `❌ <b>Upload Error:</b> <code>${escapeHtml(err.message)}</code>`, { parse_mode: 'HTML' });
    }
  }

  // URL Converter
  const incomingText = (msg.text || msg.caption || '').trim();
  if (!incomingText || incomingText.startsWith('/')) return;

  const urlRegex = /(https?:\/\/[^\s<>"']+)/gi;
  const urls = incomingText.match(urlRegex) || [];
  if (urls.length === 0) return;

  const statusMsg = await bot.sendMessage(chatId, `🔄 <i>${urls.length} link(s) process ho rahe hain...</i>`, { parse_mode: 'HTML' });

  try {
    const resolveLink = async (targetUrl) => {
      let extracted = null;
      if (/(terabox|1024tera|teraboxlink|terasharelink|terasharefile|terashare)/i.test(targetUrl)) {
        extracted = await extractTeraboxLink(targetUrl);
      } else if (/diskwala/i.test(targetUrl)) {
        extracted = await extractDiskwalaLink(targetUrl);
      } else {
        extracted = { url: targetUrl, name: 'Web Stream Video' };
      }

      if (extracted && extracted.url) {
        const shortId = crypto.randomBytes(4).toString('hex');
        const payload = { name: extracted.name || 'Stream Video', url: extracted.url, uploader: uploaderName };
        linkStore.set(shortId, payload);
        await redis.set(`video:${shortId}`, JSON.stringify(payload), { ex: 30 * 86400 });
        return { success: true, name: payload.name, playUrl: `${BASE_URL}/v/${shortId}` };
      }
      return { success: false, url: targetUrl };
    };

    const results = await Promise.allSettled(urls.map(url => resolveLink(url)));
    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});

    let successList = [];
    let failedCount = 0;
    results.forEach((res) => {
      if (res.status === 'fulfilled' && res.value.success) {
        successList.push(`📌 <b>${escapeHtml(res.value.name)}</b>\n🔗 ${res.value.playUrl}`);
      } else { failedCount++; }
    });

    if (successList.length === 0) {
      return bot.sendMessage(chatId, `❌ <b>Links convert nahi ho sake.</b>`, { parse_mode: 'HTML' });
    }

    let finalMsg = `✨ <b>Converted Stream Links (${successList.length}):</b>\n\n` + successList.join('\n\n');
    if (failedCount > 0) finalMsg += `\n\n⚠️ <i>${failedCount} link(s) fail ho gaye.</i>`;
    bot.sendMessage(chatId, finalMsg, { parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (err) {
    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    bot.sendMessage(chatId, `❌ <b>Error:</b> <code>${escapeHtml(err.message)}</code>`, { parse_mode: 'HTML' });
  }
});
    
