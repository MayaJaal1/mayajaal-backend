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

// ✅ NAYA: API Key Generation Page (Jo missing tha)
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
          .btn { background: #00ff88; color: #000; padding: 10px 20px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block; margin-top: 10px;}
        </style>
      </head>
      <body>
        <div class="card">
          <h2>🔑 MayaJaal API Key Generated!</h2>
          <p>Aapki API Key yeh hai:</p>
          <div class="key-box"><code>${key}</code></div>
          <p>Is key ko copy karke bot par bhejein:</p>
          <code>/api ${key}</code>
          <br><br>
          <a href="https://t.me/YourBotUsername" class="btn">Bot Kholo</a>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Error generating key: ' + err.message);
  }
});// ───────────────────────────────────────────
// 3. ZERO-BUFFER RANGE 206 STREAMING ENGINE
// ───────────────────────────────────────────
app.get('/stream/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let data = linkStore.get(id);

    if (!data) {
      const raw = (await redis.get(`video:${id}`)) || (await redis.get(`terabox:${id}`));
      if (raw) data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    }

    if (!data) return res.status(404).send('Stream not found');

    // ═══════════════════════════════════════
    // Case 1: Telegram Channel 2GB MTProto Chunk Streamer
    // ═══════════════════════════════════════
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
        console.error('[Telegram Stream Error]:', tgErr.message);
      }
    }

    // ═══════════════════════════════════════
    // Case 2: External Proxy Stream (Terabox / Terasharefile / Diskwala)
    // ═══════════════════════════════════════
    if (!data.url) return res.status(404).send('Stream expired');

    const targetUrl = data.url;
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

app.listen(PORT, () => console.log(`✅ MayaJaal Web Engine running on port ${PORT}`));// ═══════════════════════════════════════════
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
    `• <b>Telegram Video Upload:</b> Vault storage + fast Cloudflare 206 play\n` +
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
  const uploaderName = msg.from?.username ? `@${msg.from.username}` : (msg.from?.first_name || 'MayaJaal Cloud');

  // 1. Direct Video / File Upload (Telegram Storage Vault)
  const videoObj = msg.video || msg.document || (msg.animation ? msg.animation : null);
  if (videoObj) {
    const fileName = videoObj.file_name || `video_${Date.now()}.mp4`;
    const statusMsg = await bot.sendMessage(chatId, `⚡ <i>Video Telegram Storage Vault mein save ho rahi hai...</i>`, { parse_mode: 'HTML' });
    try {
      let channelMsgId = null;
      if (STORAGE_CHANNEL_ID) {
        const rawPeer = STORAGE_CHANNEL_ID.trim();
        const peer = rawPeer.startsWith('@') ? rawPeer : (rawPeer.startsWith('-100') ? parseInt(rawPeer, 10) : rawPeer);
        const forwarded = await bot.forwardMessage(peer, chatId, msg.message_id);
        channelMsgId = forwarded.message_id;
      }
      const shortId = crypto.randomBytes(4).toString('hex');
      const payload = { name: fileName, channel_id: STORAGE_CHANNEL_ID, msg_id: channelMsgId, uploader: uploaderName };
      linkStore.set(shortId, payload);
      await redis.set(`video:${shortId}`, JSON.stringify(payload), { ex: 30 * 86400 });

      const playUrl = `${BASE_URL}/v/${shortId}`;
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      let reply = `✨ <b>MayaJaal Stream Ready!</b>\n\n`;
      if (user.header && user.enableText) reply = `<b>${escapeHtml(user.header)}</b>\n\n` + reply;
      reply += `📌 <b>File:</b> ${escapeHtml(fileName)}\n\n🔗 <b>Cloudflare Player Link:</b>\n${playUrl}\n\n⚡ <i>Telegram Vault Saved & Zero-Buffer Playback Active!</i>`;
      if (user.footer && user.enableText) reply += `\n\n<b>${escapeHtml(user.footer)}</b>`;
      return bot.sendMessage(chatId, reply, { parse_mode: 'HTML', disable_web_page_preview: false });
    } catch (err) {
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      return bot.sendMessage(chatId, `❌ <b>Error:</b> <code>${escapeHtml(err.message)}</code>`, { parse_mode: 'HTML' });
    }
  }

  // 2. Parallel Bulk Link Converter
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
      return bot.sendMessage(chatId, `❌ <b>Links convert nahi ho sake (Link invalid ya expired hai).</b>`, { parse_mode: 'HTML' });
    }

    let finalMsg = `✨ <b>Converted Stream Links (${successList.length}):</b>\n\n` + successList.join('\n\n');
    if (failedCount > 0) finalMsg += `\n\n⚠️ <i>${failedCount} link(s) fail ho gaye.</i>`;
    bot.sendMessage(chatId, finalMsg, { parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (err) {
    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    bot.sendMessage(chatId, `❌ <b>Error:</b> <code>${escapeHtml(err.message)}</code>`, { parse_mode: 'HTML' });
  }
});
