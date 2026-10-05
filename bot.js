require('dotenv').config();

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const { Redis } = require('@upstash/redis');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

process.on('uncaughtException', (e) => console.error('[Uncaught]', e.stack || e.message));
process.on('unhandledRejection', (e) => console.error('[Unhandled]', e?.stack || e));

// ================= ENV =================
const TOKEN = (process.env.BOT_TOKEN || '').trim();
const BASE_URL = process.env.CUSTOM_DOMAIN
  ? (process.env.CUSTOM_DOMAIN.startsWith('http')
      ? process.env.CUSTOM_DOMAIN
      : `https://${process.env.CUSTOM_DOMAIN}`)
  : 'https://mayajaal.online';

const LOCAL_API_URL = (process.env.LOCAL_API_URL || '').trim().replace(/\/$/, '');

const R2_ACCOUNT_ID = (process.env.R2_ACCOUNT_ID || '').trim();
const R2_ACCESS_KEY_ID = (process.env.R2_ACCESS_KEY_ID || '').trim();
const R2_SECRET_ACCESS_KEY = (process.env.R2_SECRET_ACCESS_KEY || '').trim();
const R2_BUCKET_NAME = (process.env.R2_BUCKET_NAME || '').trim();
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').trim().replace(/\/$/, '');
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || '2147483648', 10);
const PORT = parseInt(process.env.PORT || '8080', 10);

const TERABOX_COOKIE = (process.env.TERABOX_COOKIE || '').trim();

// Debug
console.log('=== ENV CHECK ===');
console.log('BOT_TOKEN:', !!TOKEN);
console.log('R2 ready:', !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET_NAME));
console.log('Terabox cookie:', !!TERABOX_COOKIE);
console.log('=================');

if (!TOKEN) throw new Error('❌ BOT_TOKEN missing');
if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
  throw new Error('❌ R2 config missing');
}

// ================= REDIS =================
let redis;
try {
  redis = Redis.fromEnv();
  console.log('✅ Redis connected');
} catch (e) {
  console.warn('⚠️ Redis not available');
  redis = { get: async () => null, set: async () => null };
}

const memStore = new Map();

async function saveMeta(id, payload) {
  memStore.set(id, payload);
  try { await redis.set(`v:${id}`, JSON.stringify(payload), { ex: 30 * 86400 }); } catch (e) { }
}

async function getMeta(id) {
  if (memStore.has(id)) return memStore.get(id);
  try {
    const raw = await redis.get(`v:${id}`);
    if (raw) {
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      memStore.set(id, data);
      return data;
    }
  } catch (e) { }
  return null;
}

// ================= R2 =================
const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});
console.log('✅ R2 initialized:', R2_BUCKET_NAME);

// ================= EXPRESS =================
const app = express();
app.use(express.json());

app.get('/', (req, res) => res.send('MayaJaal Stream Engine Online'));
app.get('/health', (req, res) => res.json({
  ok: true,
  uptime: process.uptime(),
  r2Ready: true,
  teraboxCookie: !!TERABOX_COOKIE,
}));

// Player page
app.get('/v/:id', async (req, res) => {
  try {
    const meta = await getMeta(req.params.id);
    if (!meta) return res.status(404).send('Not found');

    const streamUrl = `${BASE_URL}/stream/${req.params.id}`;
    const title = escapeHtml(meta.name || 'Video');

    res.send(`<!DOCTYPE html>
<html lang="hi"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="https://cdn.plyr.io/3.7.8/plyr.css">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0a;color:#fff;font-family:-apple-system,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:12px}
.box{width:100%;max-width:960px}
video{width:100%;max-height:80vh;border-radius:14px;background:#000}
.t{margin-top:14px;font-size:1rem;color:#00ff88;word-break:break-all;opacity:.9}
</style></head><body>
<div class="box">
<video id="p" controls autoplay playsinline preload="metadata">
<source src="${streamUrl}" type="${meta.mime || 'video/mp4'}">
</video>
<div class="t">🎬 ${title}</div>
</div>
<script src="https://cdn.plyr.io/3.7.8/plyr.polyfilled.js"></script>
<script>new Plyr('#p');</script>
</body></html>`);
  } catch (e) {
    res.status(500).send('err: ' + e.message);
  }
});

// Stream from R2
app.get('/stream/:id', async (req, res) => {
  try {
    const meta = await getMeta(req.params.id);
    if (!meta?.r2Key) return res.status(404).send('Not found');

    const out = await r2.send(new GetObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: meta.r2Key,
      Range: req.headers.range || undefined,
    }));

    res.status(req.headers.range ? 206 : 200);
    res.setHeader('Content-Type', out.ContentType || meta.mime || 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    if (out.ContentRange) res.setHeader('Content-Range', out.ContentRange);
    if (out.ContentLength) res.setHeader('Content-Length', out.ContentLength);
    if (out.ETag) res.setHeader('ETag', out.ETag);

    out.Body.on('error', () => { if (!res.headersSent) res.status(500); res.end(); });
    out.Body.pipe(res);
  } catch (e) {
    console.error('[stream]', e.message);
    if (!res.headersSent) res.status(500).send('err');
  }
});

app.listen(PORT, () => console.log(`🚀 Web on port ${PORT}`));

// ================= HELPERS =================
function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function pickMedia(msg) {
  return msg.video || msg.document || msg.audio || msg.animation || null;
}

function detectTeraboxUrl(text) {
  if (!text) return null;
  const regex = /https?:\/\/[^\s]*(terabox\.(app|com|link|club|fun|app)|1024tera\.com|4funbox\.com|mirrobox\.com|nephobox\.com|momerybox\.com|tibibox\.com|teraboxapp\.com|terasharelink\.com)[^\s]*/i;
  const m = text.match(regex);
  return m ? m[0] : null;
}

// ================= TERABOX DIRECT LINK =================
async function getTeraboxDirectLink(shareUrl) {
  console.log('[Terabox] Fetching:', shareUrl);

  const pageResp = await axios.get(shareUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Cookie': TERABOX_COOKIE,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    timeout: 30000,
    maxRedirects: 5,
  });

  const html = pageResp.data;
  console.log('[Terabox] HTML length:', html.length);

  // yunData nikaalo
  const yunMatch = html.match(/window\.yunData\s*=\s*(\{[\s\S]+?\});?\s*<\/script>/);
  if (!yunMatch) {
    throw new Error('yunData nahi mila. Cookie expire ya invalid link.');
  }

  let yunData;
  try {
    yunData = JSON.parse(yunMatch[1]);
  } catch (e) {
    // kabhi kabhi string escaped hoti hai
    throw new Error('yunData parse fail');
  }

  const shareid = yunData.shareid;
  const uk = yunData.uk;
  const sign = yunData.sign;
  const timestamp = yunData.timestamp;
  const fileList = yunData.file_list || [];
  const firstFile = fileList[0];

  if (!shareid || !uk || !firstFile) {
    throw new Error('Share info incomplete. Cookie refresh karo.');
  }

  const fs_id = firstFile.fs_id;
  const fileName = firstFile.server_filename || `terabox_${Date.now()}.mp4`;
  const size = firstFile.size || 0;

  console.log(`[Terabox] File: ${fileName} (${(size/1024/1024).toFixed(2)} MB)`);

  // Direct link API
  const params = new URLSearchParams({
    shareid: shareid,
    uk: uk,
    sign: sign,
    timestamp: timestamp,
    fs_id: fs_id,
    channel: 'dubox',
    web: '1',
    app_id: '250528',
  });

  const dlResp = await axios.get(`https://www.terabox.com/share/download?${params}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Cookie': TERABOX_COOKIE,
      'Referer': shareUrl,
      'Accept': 'application/json, text/plain, */*',
    },
    timeout: 30000,
  });

  const dlink = dlResp.data?.dlink;
  if (!dlink) {
    throw new Error('Direct link nahi mila. Cookie expire ho gayi.');
  }

  const finalUrl = Array.isArray(dlink) ? dlink[0] : dlink;
  console.log('[Terabox] Direct link mil gaya');

  return { url: finalUrl, fileName, size };
}

// ================= BOT =================
const bot = new TelegramBot(TOKEN, {
  polling: { autoStart: true, params: { timeout: 10 } },
});

bot.on('polling_error', async (e) => {
  console.error('[polling_error]', e.message);
  if (e.message?.includes('409')) await new Promise(r => setTimeout(r, 4000));
});

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `🎬 <b>MayaJaal Stream Bot</b>\n\n` +
    `📤 <b>2 tarike:</b>\n` +
    `1️⃣ Direct file/video bhejo (20MB tak)\n` +
    `2️⃣ Terabox link paste karo\n\n` +
    `⚡ Dono ka player link milega!`,
    { parse_mode: 'HTML' });
});

// ================= MAIN HANDLER =================
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || '';

  // ========== TERABOX LINK ==========
  const teraboxUrl = detectTeraboxUrl(text);
  if (teraboxUrl) {
    if (!TERABOX_COOKIE) {
      return bot.sendMessage(chatId, '❌ Terabox cookie set nahi hai. Admin se bolo.');
    }

    const status = await bot.sendMessage(chatId,
      `🔍 <i>Terabox link detect hua, direct link nikal raha hoon...</i>`,
      { parse_mode: 'HTML' });

    try {
      const info = await getTeraboxDirectLink(teraboxUrl);

      await bot.editMessageText(
        `⬇️ <i>Download + upload chal raha hai...</i>\n📌 ${escapeHtml(info.fileName)}\n📦 ${(info.size/1024/1024).toFixed(2)} MB`,
        { chat_id: chatId, message_id: status.message_id, parse_mode: 'HTML' }
      );

      // Stream download from Terabox
      const resp = await axios.get(info.url, {
        responseType: 'stream',
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 0,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Cookie': TERABOX_COOKIE,
          'Referer': teraboxUrl,
        },
      });

      const ext = path.extname(info.fileName) || '.mp4';
      const r2Key = `uploads/${crypto.randomBytes(8).toString('hex')}${ext}`;
      const isLarge = info.size > 100 * 1024 * 1024;

      console.log('[⬆️] R2 upload:', r2Key);

      const upload = new Upload({
        client: r2,
        params: {
          Bucket: R2_BUCKET_NAME,
          Key: r2Key,
          Body: resp.data,
          ContentType: 'video/mp4',
          CacheControl: 'public, max-age=31536000, immutable',
          Metadata: {
            source: 'terabox',
            uploader: msg.from?.username || 'user',
            originalname: encodeURIComponent(info.fileName),
          },
        },
        queueSize: isLarge ? 4 : 1,
        partSize: isLarge ? 10 * 1024 * 1024 : 5 * 1024 * 1024,
        leavePartsOnError: false,
      });

      await upload.done();
      console.log('[✅] R2 upload done');

      const shortId = crypto.randomBytes(4).toString('hex');
      await saveMeta(shortId, {
        name: info.fileName,
        mime: 'video/mp4',
        r2Key,
        uploader: msg.from?.username || 'user',
        size: info.size,
        ts: Date.now(),
        source: 'terabox',
      });

      const playUrl = `${BASE_URL}/v/${shortId}`;
      const directUrl = R2_PUBLIC_URL ? `${R2_PUBLIC_URL}/${r2Key}` : null;

      await bot.deleteMessage(chatId, status.message_id).catch(() => {});

      let reply = `✅ <b>Terabox → Your Domain Ready!</b>\n\n` +
                  `📌 <b>${escapeHtml(info.fileName)}</b>\n` +
                  `📦 ${(info.size/1024/1024).toFixed(2)} MB\n\n` +
                  `▶️ <b>Player Link:</b>\n${playUrl}`;
      if (directUrl) reply += `\n\n⬇️ <b>Direct:</b>\n${directUrl}`;

      return bot.sendMessage(chatId, reply, { parse_mode: 'HTML' });

    } catch (e) {
      console.error('[Terabox Error]', e.stack || e.message);
      await bot.deleteMessage(chatId, status.message_id).catch(() => {});
      return bot.sendMessage(chatId,
        `❌ <b>Terabox Error:</b>\n<code>${escapeHtml(e.message)}</code>`,
        { parse_mode: 'HTML' });
    }
  }

  // ========== DIRECT TELEGRAM FILE ==========
  const media = pickMedia(msg);
  if (!media) return;

  const uploader = msg.from?.username
    ? `@${msg.from.username}`
    : (msg.from?.first_name || 'User');

  const fileId = media.file_id;
  const fileName = media.file_name || `file_${Date.now()}.mp4`;
  const mime = media.mime_type || 'application/octet-stream';
  const size = media.file_size || 0;

  if (size && size > MAX_FILE_SIZE) {
    return bot.sendMessage(chatId,
      `❌ File too large. Max ${(MAX_FILE_SIZE / 1024 / 1024).toFixed(0)} MB.`);
  }

  const status = await bot.sendMessage(chatId, `⚡ <i>Uploading...</i>`, { parse_mode: 'HTML' });

  try {
    const info = await bot.getFile(fileId);
    if (!info?.file_path) throw new Error('file_path not returned');

    let fp = info.file_path.split(TOKEN).pop();
    fp = fp.replace(/^\/+/, '');

    const urlsToTry = [
      `https://api.telegram.org/file/bot${TOKEN}/${fp}`,
    ];
    if (LOCAL_API_URL) {
      urlsToTry.push(`${LOCAL_API_URL}/file/bot${TOKEN}/${fp}`);
    }

    let stream = null;
    let lastErr = null;

    for (const url of urlsToTry) {
      try {
        console.log('[⬇️] Trying:', url);
        const resp = await axios.get(url, {
          responseType: 'stream',
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          timeout: 120000,
          validateStatus: (s) => s >= 200 && s < 400,
        });
        stream = resp.data;
        stream.on('error', (e) => console.error('[TG stream err]', e.message));
        console.log('[✅] Download from:', url);
        break;
      } catch (e) {
        lastErr = e;
        console.warn('[❌] Failed:', url, '→', e.message);
      }
    }

    if (!stream) {
      throw new Error(`Download failed: ${lastErr?.message || 'All URLs failed'}`);
    }

    const ext = path.extname(fileName) || (mime.startsWith('video') ? '.mp4' : '');
    const r2Key = `uploads/${crypto.randomBytes(8).toString('hex')}${ext}`;
    const isLarge = size > 100 * 1024 * 1024;

    console.log('[⬆️] R2:', r2Key);

    const upload = new Upload({
      client: r2,
      params: {
        Bucket: R2_BUCKET_NAME,
        Key: r2Key,
        Body: stream,
        ContentType: mime,
        CacheControl: 'public, max-age=31536000, immutable',
        Metadata: {
          uploader,
          originalname: encodeURIComponent(fileName),
        },
      },
      queueSize: isLarge ? 4 : 1,
      partSize: isLarge ? 10 * 1024 * 1024 : 5 * 1024 * 1024,
      leavePartsOnError: false,
    });

    await upload.done();

    const shortId = crypto.randomBytes(4).toString('hex');
    await saveMeta(shortId, {
      name: fileName, mime, r2Key,
      uploader, size, ts: Date.now(),
    });

    const playUrl = `${BASE_URL}/v/${shortId}`;
    const directUrl = R2_PUBLIC_URL ? `${R2_PUBLIC_URL}/${r2Key}` : null;

    await bot.deleteMessage(chatId, status.message_id).catch(() => {});

    let reply = `✅ <b>Upload complete</b>\n\n` +
      `📌 <b>${escapeHtml(fileName)}</b>\n` +
      `📦 ${(size / 1024 / 1024).toFixed(2)} MB\n\n` +
      `▶️ <b>Player:</b>\n${playUrl}`;
    if (directUrl) reply += `\n\n⬇️ <b>Direct:</b>\n${directUrl}`;

    bot.sendMessage(chatId, reply, { parse_mode: 'HTML' });

  } catch (e) {
    console.error('[❌]', e.stack || e.message);
    await bot.deleteMessage(chatId, status.message_id).catch(() => {});
    bot.sendMessage(chatId,
      `❌ <b>Error:</b>\n<code>${escapeHtml(e.message)}</code>`,
      { parse_mode: 'HTML' });
  }
});

console.log('🤖 Bot started');
