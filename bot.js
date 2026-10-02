require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { Redis } = require('@upstash/redis');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');

// Crash Prevention Guards
process.on('uncaughtException', (err) => console.error('[UncaughtException Caught]:', err.message));
process.on('unhandledRejection', (reason) => console.error('[UnhandledRejection Caught]:', reason));

// ═══════════════════════════════════════════
// 0. CONFIG & REDIS
// ═══════════════════════════════════════════
const redis = Redis.fromEnv();
const videoStore = new Map();

const API_ID = parseInt(process.env.TELEGRAM_API_ID || '35399167', 10);
const API_HASH = process.env.TELEGRAM_API_HASH || '88a34526a5e73078110072770dd85e5b';
const BOT_TOKEN = process.env.BOT_TOKEN;
const RAW_CHANNEL_ID = String(process.env.STORAGE_CHANNEL_ID || '').trim();

const WEB_PAGE_URL = process.env.WEB_PAGE_URL || 'https://mayajaal.online/key';
const BASE_URL = process.env.CUSTOM_DOMAIN 
  ? (process.env.CUSTOM_DOMAIN.startsWith('http') ? process.env.CUSTOM_DOMAIN : `https://${process.env.CUSTOM_DOMAIN}`)
  : 'https://mayajaal.online';

if (!BOT_TOKEN || !RAW_CHANNEL_ID) {
  console.error('❌ BOT_TOKEN ya STORAGE_CHANNEL_ID missing hain!');
  process.exit(1);
}

// ═══════════════════════════════════════════
// 1. EXPRESS HTTP SERVER (STREAM ENGINE)
// ═══════════════════════════════════════════
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(__dirname));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.header('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/', (req, res) => res.send('MayaJaal 2GB MTProto Engine is Active!'));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.get(['/version.json', '/check-update', '/api/check-update'], (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.json({
    latestVersionCode: 2,
    latestVersionName: "v1.1.0",
    updateUrl: "https://mayajaal.online/download.html",
    forceUpdate: false,
    changelog: "⚡ 2GB Fast Streaming Active!"
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

app.get('/v/:id', (req, res) => {
  const playerFile = path.join(__dirname, 'player.html');
  if (fs.existsSync(playerFile)) return res.sendFile(playerFile);
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head><meta charset="UTF-8"><title>MayaJaal Player</title></head>
    <body style="background:#000;color:#00ff88;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;">
      <video controls autoplay style="max-width:95%;max-height:85vh;" src="/stream/${req.params.id}"></video>
    </body></html>
  `);
});

app.get('/api/stream-info/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let data = videoStore.get(id);
    if (!data) {
      const redisData = await redis.get(`video:${id}`);
      if (redisData) data = typeof redisData === 'string' ? JSON.parse(redisData) : redisData;
    }

    if (!data) return res.status(404).json({ success: false, message: 'Stream not found' });

    res.json({
      success: true,
      url: `${BASE_URL}/stream/${id}`,
      title: data.name || 'MayaJaal Video',
      uploader: data.uploader || 'Matrix Node',
      id: id
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});let cachedTargetEntity = null;
async function getStorageEntity() {
  if (cachedTargetEntity) return cachedTargetEntity;
  try {
    let clean = RAW_CHANNEL_ID.trim();
    if (clean.startsWith('-100')) {
      clean = clean.substring(4);
    } else if (clean.startsWith('-')) {
      clean = clean.substring(1);
    }
    const channelIdBigInt = BigInt(clean);
    cachedTargetEntity = await tgClient.getInputEntity(new Api.PeerChannel({ channelId: channelIdBigInt }));
    return cachedTargetEntity;
  } catch (e) {
    cachedTargetEntity = await tgClient.getInputEntity(RAW_CHANNEL_ID);
    return cachedTargetEntity;
  }
}

// 🌟 Reliable 2GB Streaming Endpoint for ExoPlayer & Web
app.get('/stream/:id', async (req, res) => {
  const id = req.params.id;
  try {
    let meta = videoStore.get(id);
    if (!meta) {
      const rawData = await redis.get(`video:${id}`);
      if (rawData) meta = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
    }

    if (!meta || !meta.messageId) {
      return res.status(404).send('Video not found or expired');
    }

    const channelPeer = await getStorageEntity();
    const messages = await tgClient.getMessages(channelPeer, { ids: [Number(meta.messageId)] });
    const targetMsg = messages && messages.length ? messages[0] : null;

    if (!targetMsg || !targetMsg.media) {
      return res.status(404).send('Media not found on Telegram');
    }

    const totalSize = Number(meta.size);
    const mimeType = meta.mimeType || 'video/mp4';
    const rangeHeader = req.headers.range;

    let start = 0;
    let end = totalSize - 1;

    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, '').split('-');
      start = parseInt(parts[0], 10);
      if (parts[1]) end = parseInt(parts[1], 10);

      if (start >= totalSize || end >= totalSize) {
        res.status(416).set('Content-Range', `bytes */${totalSize}`).end();
        return;
      }

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${totalSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': (end - start) + 1,
        'Content-Type': mimeType,
        'Cache-Control': 'no-cache',
      });
    } else {
      res.writeHead(200, {
        'Content-Length': totalSize,
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      });
    }

    const requestedLimit = (end - start) + 1;
    const downloadIterator = tgClient.iterDownload({
      file: targetMsg.media,
      offset: BigInt(start),
      limit: requestedLimit,
      requestSize: 1024 * 128,
    });

    req.on('close', () => {
      if (downloadIterator && downloadIterator.return) downloadIterator.return();
    });

    for await (const chunk of downloadIterator) {
      if (res.writableEnded || res.destroyed) break;
      res.write(chunk);
    }

    if (!res.writableEnded) res.end();

  } catch (err) {
    console.error('[Stream] Error:', err.message);
    if (!res.headersSent) res.status(500).send('Stream connection error');
  }
});

app.listen(PORT, () => {
  console.log(`✅ Web Server active on port ${PORT}`);
});

// ═══════════════════════════════════════════
// 2. GRAMJS MTPROTO CLIENT (FLOOD SAFE)
// ═══════════════════════════════════════════
const tgClient = new TelegramClient(new StringSession(''), API_ID, API_HASH, {
  connectionRetries: 10,
  autoReconnect: true,
  floodSleepThreshold: 300, // 300 seconds tak Telegram flood wait handle karega
  useWSS: false,
});

async function getUser(chatId) {
  try {
    const data = await redis.get(`user_settings:${chatId}`);
    if (data) return typeof data === 'string' ? JSON.parse(data) : data;
  } catch (e) {}
  return { apiToken: null, header: null, footer: null, bold: false, enableText: true };
}

async function saveUser(chatId, settings) {
  try {
    await redis.set(`user_settings:${chatId}`, JSON.stringify(settings));
  } catch (e) {}
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
  parts.push(`✨ <b>MayaJaal 2GB Storage Complete!</b>`);
  parts.push('');
  parts.push(`📌 <b>File:</b> ${escapeHtml(fileName)}`);
  if (sizeMB) parts.push(`📦 <b>Size:</b> ${sizeMB} MB`);
  parts.push('');
  parts.push(`🔗 <b>Stream Link:</b>\n${shortUrl}`);
  if (user.enableText && user.footer) {
    parts.push('');
    parts.push(user.bold ? `<b>${escapeHtml(user.footer)}</b>` : escapeHtml(user.footer));
  }
  parts.push('');
  parts.push(`⚡ <i>Unlimited Telegram Cloud Storage</i>`);
  return parts.join('\n');
}

tgClient.addEventHandler(async (event) => {
  const message = event.message;
  if (!message) return;

  const chatId = message.chatId ? message.chatId.toString() : '';
  const text = (message.message || '').trim();
  const sender = await message.getSender();
  const uploaderName = sender?.username ? `@${sender.username}` : (sender?.firstName || 'User');
  const user = await getUser(chatId);

  if (text === '/start') {
    return tgClient.sendMessage(chatId, {
      message: `🎬 <b>Welcome to MayaJaal 2GB Cloud Bot!</b>\n\n` +
               `Direct <b>2GB tak ki video ya document</b> bhej sakte hain.\n\n` +
               `Files Telegram cloud mein save hongi aur instant play link milega.\n\n` +
               `<b>Commands:</b>\n` +
               `/api - Matrix key link karein\n` +
               `/logout - Disconnect karein\n` +
               `/add_header TEXT - Custom header add karein\n` +
               `/add_footer TEXT - Custom footer add karein`,
      parseMode: 'html',
    });
  }

  if (text.startsWith('/api')) {
    const token = text.replace('/api', '').trim();
    if (!token) {
      return tgClient.sendMessage(chatId, {
        message: `🔐 <b>Matrix Key Linking</b>\n\nApni key verify karne ke liye bhejein:\n<code>/api YOUR_KEY</code>\n\nKey lene ke liye: ${WEB_PAGE_URL}?tg=${chatId}`,
        parseMode: 'html',
      });
    }
    const valid = await redis.get(`matrix_key:${token}`);
    if (!valid || String(valid) !== String(chatId)) {
      return tgClient.sendMessage(chatId, { message: `❌ Invalid ya unauthorized Matrix Key!`, parseMode: 'html' });
    }
    user.apiToken = token;
    await saveUser(chatId, user);
    return tgClient.sendMessage(chatId, { message: `✅ Matrix Key successfully linked!`, parseMode: 'html' });
  }

  if (text === '/logout') {
    user.apiToken = null;
    await saveUser(chatId, user);
    return tgClient.sendMessage(chatId, { message: `👋 Logged out successfully!`, parseMode: 'html' });
  }

  if (text.startsWith('/add_header')) {
    const header = text.replace('/add_header', '').trim();
    user.header = header || null;
    await saveUser(chatId, user);
    return tgClient.sendMessage(chatId, { message: `✅ Header updated!`, parseMode: 'html' });
  }

  if (text.startsWith('/add_footer')) {
    const footer = text.replace('/add_footer', '').trim();
    user.footer = footer || null;
    await saveUser(chatId, user);
    return tgClient.sendMessage(chatId, { message: `✅ Footer updated!`, parseMode: 'html' });
  }

  if (message.media) {
    if (!user.apiToken) {
      return tgClient.sendMessage(chatId, {
        message: `❌ <b>Pehle Matrix Key link karein!</b>\n\nKey lene ke liye yahan click karein: ${WEB_PAGE_URL}?tg=${chatId}\nPhir <code>/api YOUR_KEY</code> bhejein.`,
        parseMode: 'html',
      });
    }

    const statusMsg = await tgClient.sendMessage(chatId, {
      message: `⚡ <i>Processing 2GB file & storing in Telegram Cloud...</i>`,
      parseMode: 'html',
    });

    try {
      const channelPeer = await getStorageEntity();

      const stored = await tgClient.forwardMessages(channelPeer, {
        messages: [message.id],
        fromPeer: chatId,
      });

      let targetMessageId = null;
      if (Array.isArray(stored) && stored.length > 0) {
        targetMessageId = stored[0]?.id;
      } else if (stored && stored.id) {
        targetMessageId = stored.id;
      }

      if (!targetMessageId) {
        throw new Error('Message ID nahi mil saki');
      }

      const doc = message.media.document;
      const sizeBytes = doc ? Number(doc.size) : 0;
      const sizeMB = sizeBytes ? (sizeBytes / (1024 * 1024)).toFixed(2) : null;

      let fileName = 'video_' + Date.now() + '.mp4';
      if (doc && doc.attributes) {
        for (const attr of doc.attributes) {
          if (attr.fileName) fileName = attr.fileName;
        }
      }

      const shortId = crypto.randomBytes(4).toString('hex');
      const payload = {
        messageId: Number(targetMessageId),
        size: sizeBytes,
        mimeType: doc?.mimeType || 'video/mp4',
        name: fileName,
        uploader: uploaderName,
      };

      videoStore.set(shortId, payload);
      await redis.set(`video:${shortId}`, JSON.stringify(payload), { ex: 30 * 86400 });

      console.log(`✅ Stored Video shortId: ${shortId} -> MsgID: ${targetMessageId}`);

      const playUrl = `${BASE_URL}/v/${shortId}`;

      await tgClient.deleteMessages(chatId, [statusMsg.id], { revoke: true }).catch(() => {});

      await tgClient.sendMessage(chatId, {
        message: buildSuccessMessage(user, fileName, sizeMB, playUrl),
        parseMode: 'html',
      });
    } catch (err) {
      console.error('File storage error:', err);
      await tgClient.deleteMessages(chatId, [statusMsg.id], { revoke: true }).catch(() => {});
      await tgClient.sendMessage(chatId, {
        message: `❌ <b>Error:</b>\n<code>${escapeHtml(err.message)}</code>`,
        parseMode: 'html',
      });
    }
  }
}, new NewMessage({ incoming: true }));

(async () => {
  try {
    await tgClient.start({
      botAuthToken: BOT_TOKEN,
    });
    console.log('🚀 MayaJaal 2GB GramJS Engine successfully logged in and running!');
  } catch (err) {
    console.error('Telegram start error (waiting before retry):', err.message);
  }
})();
