require('dotenv').config();

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const path = require('path');
const fs = require('fs');

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

process.on('uncaughtException', (err) => console.error('[UncaughtException]:', err.message));
process.on('unhandledRejection', (reason) => console.error('[UnhandledRejection]:', reason));

// ═══════════════════════════════════════════
// 0. CONFIG & REDIS
// ═══════════════════════════════════════════
const redis = Redis.fromEnv();
const linkStore = new Map();

const TOKEN = process.env.BOT_TOKEN;
const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID || '';
const API_ID = parseInt(process.env.TELEGRAM_API_ID || '35399167', 10);
const API_HASH = process.env.TELEGRAM_API_HASH || '88a34526a5e73078110072770dd85e5b';

const WEB_PAGE_URL = process.env.WEB_PAGE_URL || 'https://mayajaal.online/key';
const BASE_URL = process.env.CUSTOM_DOMAIN 
  ? (process.env.CUSTOM_DOMAIN.startsWith('http') ? process.env.CUSTOM_DOMAIN : `https://${process.env.CUSTOM_DOMAIN}`)
  : 'https://mayajaal.online';

if (!TOKEN) {
  console.error('❌ BOT_TOKEN missing hai!');
  process.exit(1);
}

// ═══════════════════════════════════════════
// 1. MTPROTO 2GB CLIENT
// ═══════════════════════════════════════════
const mtprotoClient = new TelegramClient(new StringSession(''), API_ID, API_HASH, {
  connectionRetries: 5
});

(async () => {
  try {
    await mtprotoClient.start({ botAuthToken: TOKEN });
    console.log('✅ MTProto 2GB Upload Engine Connected to Telegram!');
  } catch (err) {
    console.error('❌ MTProto Connect Error:', err.message);
  }
})();

// ═══════════════════════════════════════════
// 2. EXPRESS HTTP SERVER
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

app.get('/', (req, res) => res.send('MayaJaal 2GB Stream Engine Active!'));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.get(['/version.json', '/check-update', '/api/check-update'], (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.json({
    latestVersionCode: 2,
    latestVersionName: "v1.1.0",
    updateUrl: "https://mayajaal.online/download.html",
    forceUpdate: false,
    changelog: "⚡ Fast player, Terabox & Diskwala streaming active!"
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
    </head><body><h2>MAYAJAAL STREAM NODE</h2><p>Please open link in MayaJaal App</p></body></html>
  `);
}

app.get('/v/:id', (req, res) => servePlayerPage(req, res));
app.get('/tb/:id', (req, res) => servePlayerPage(req, res));

app.get(['/api/stream-info/:id', '/api/tb/:id', '/api/v/:id'], async (req, res) => {
  try {
    const id = req.params.id;
    let data = linkStore.get(id);
    if (!data) {
      const raw = (await redis.get(`terabox:${id}`)) || (await redis.get(`video:${id}`));
      if (raw) data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    }

    if (!data || !data.url) return res.status(404).json({ success: false, message: 'Stream not found' });

    res.json({
      success: true,
      url: data.url,
      video_url: data.url,
      title: data.name || 'MayaJaal Stream Video',
      file_name: data.name || 'MayaJaal Stream Video',
      uploader: data.uploader || 'Matrix Ghost Node',
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
// 3. BOT CONTROLLER & EXTRACTORS
// ═══════════════════════════════════════════
const bot = new TelegramBot(TOKEN, { polling: { autoStart: true, params: { timeout: 10 } } });

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
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildSuccessMessage(user, fileName, shortUrl, backedUp = false) {
  const parts = [];
  if (user && user.enableText && user.header) {
    parts.push(user.bold ? `<b>${escapeHtml(user.header)}</b>` : escapeHtml(user.header));
    parts.push('');
  }
  parts.push(backedUp ? `✨ <b>MayaJaal Stream Ready (Vault Backup)!</b>` : `✨ <b>MayaJaal Stream Ready!</b>`);
  parts.push('');
  parts.push(`📌 <b>File:</b> ${escapeHtml(fileName)}`);
  parts.push('');
  parts.push(`🔗 <b>Stream Link:</b>\n${shortUrl}`);
  if (user && user.enableText && user.footer) {
    parts.push('');
    parts.push(user.bold ? `<b>${escapeHtml(user.footer)}</b>` : escapeHtml(user.footer));
  }
  parts.push('');
  parts.push(`⚡ <i>Permanent Cloud Playback</i>`);
  return parts.join('\n');
}

// ───────────────────────────────────────────
// A. DISKWALA STREAM EXTRACTOR
// ───────────────────────────────────────────
async function extractDiskwalaLink(diskwalaUrl) {
  try {
    const match = diskwalaUrl.match(/\/(app|view|file|p|post|d)\/([a-zA-Z0-9_-]+)/i) || diskwalaUrl.match(/diskwala\.com\/([a-zA-Z0-9_-]+)/i);
    const fileId = match ? (match[2] || match[1]) : null;

    if (!fileId) return null;

    const baseHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Referer': 'https://diskwala.com/'
    };

    const apis = [
      `https://www.diskwala.com/api/post/${fileId}`,
      `https://diskwala.com/api/post/stream/${fileId}`,
      `https://diskwala.com/api/file/${fileId}`,
      `https://diskwala.com/api/v1/post/get?id=${fileId}`
    ];

    for (const ep of apis) {
      try {
        const res = await axios.get(ep, { headers: baseHeaders, timeout: 6000 });
        const d = res.data;
        if (d) {
          const direct = d.stream_url || d.video_url || d.url || d.download_url || d.file?.url || d.post?.video_url;
          if (direct) return { url: direct, name: d.name || d.title || d.post?.title || 'Diskwala Video' };
        }
      } catch (e) {}
    }

    const targetPages = [`https://www.diskwala.com/embed/${fileId}`, diskwalaUrl];
    for (const pUrl of targetPages) {
      try {
        const page = await axios.get(pUrl, { headers: baseHeaders, timeout: 8000 });
        const html = typeof page.data === 'string' ? page.data : JSON.stringify(page.data);

        const m = html.match(/(https?:\/\/[^\s"'<>]+\.(?:m3u8|mp4)[^\s"'<>]*)/i) ||
                  html.match(/src:\s*["']([^"']+)["']/i) ||
                  html.match(/source:\s*["']([^"']+)["']/i) ||
                  html.match(/file:\s*["']([^"']+)["']/i);

        if (m && m[1]) {
          const titleM = html.match(/<title>([^<]+)<\/title>/i);
          const name = titleM ? titleM[1].replace(/-\s*Diskwala.*/i, '').trim() : 'Diskwala Video';
          return { url: m[1], name };
        }
      } catch (err) {}
    }
  } catch (err) {
    console.error('[Diskwala Global Error]:', err.message);
  }
  return null;
}

// ───────────────────────────────────────────
// B. UNIVERSAL TERABOX EXTRACTOR (Redirect & Domain Auto-Fix)
// ───────────────────────────────────────────
async function extractTeraboxLink(teraboxUrl) {
  const rawCookie = process.env.TERABOX_COOKIE || 'ndus=Yzdpm64teHuiTpyF1tSZ-m4ANxhFN7shhUG1hMNu;';
  const cookie = rawCookie.includes('ndus=') ? rawCookie : `ndus=${rawCookie};`;

  // Step 1: Follow redirects to find the canonical 1024tera / terabox URL
  let targetCleanUrl = teraboxUrl;
  try {
    const head = await axios.get(teraboxUrl, {
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      },
      timeout: 8000
    });
    if (head.request?.res?.responseUrl) {
      targetCleanUrl = head.request.res.responseUrl;
    }
  } catch (e) {}

  // Step 2: Extract Surl Key correctly
  const match = targetCleanUrl.match(/(\/s\/|surl=)([a-zA-Z0-9_-]+)/) || teraboxUrl.match(/(\/s\/|surl=)([a-zA-Z0-9_-]+)/);
  if (match) {
    const rawCode = match[2];
    // Test both full code and stripped leading-1 code
    const surlVariants = [
      rawCode.startsWith('1') ? rawCode.substring(1) : rawCode,
      rawCode
    ];

    for (const surl of surlVariants) {
      try {
        const sharePageUrl = `https://www.terabox1024.com/sharing/link?surl=${surl}`;
        const pageRes = await axios.get(sharePageUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Cookie': cookie,
            'Referer': 'https://www.terabox1024.com/'
          },
          timeout: 10000
        });

        const pageHtml = pageRes.data || '';
        const jsTokenMatch = pageHtml.match(/fn%28%22(.*?)%22%29/) || pageHtml.match(/jsToken":"(.*?)"/) || pageHtml.match(/jsToken = "(.*?)"/);
        const jsToken = jsTokenMatch ? jsTokenMatch[1] : '';

        const listApi = `https://www.terabox1024.com/share/list?app_id=250528&shorturl=${surl}&root=1${jsToken ? `&jsToken=${jsToken}` : ''}`;
        const listRes = await axios.get(listApi, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Cookie': cookie,
            'Referer': sharePageUrl
          },
          timeout: 10000
        });

        if (listRes.data && listRes.data.errno === 0 && listRes.data.list && listRes.data.list.length > 0) {
          const file = listRes.data.list[0];
          if (file.dlink) {
            console.log(`[Terabox Native] Extracted: ${file.server_filename}`);
            return { url: file.dlink, name: file.server_filename || 'Terabox Video' };
          }
        }
      } catch (err) {}
    }
  }

  // Step 3: Reliable Multi-Gateway Fallbacks
  const shortCode = match ? match[2] : '';
  const fallbackUrls = [
    `https://terabox-api-direct.onrender.com/api?url=${encodeURIComponent(teraboxUrl)}`,
    `https://ytbvideolyrics.com/api/tb?url=${encodeURIComponent(teraboxUrl)}`,
    `https://terabox-dl.qtcloud.workers.dev/api/get-info?shorturl=${shortCode}`
  ];

  for (const endpoint of fallbackUrls) {
    try {
      const res = await axios.get(endpoint, { timeout: 10000 });
      const d = res.data;
      const direct = d?.download_url || d?.dlink || d?.direct_link || d?.downloadLink;
      if (direct) {
        console.log(`[Terabox Fallback] Extracted via gateway`);
        return {
          url: direct,
          name: d.file_name || d.title || d.fileName || 'Terabox Video'
        };
      }
    } catch (e) {}
  }

  console.error('[Terabox Extractor] All extraction methods failed for:', teraboxUrl);
  return null;
}

// ───────────────────────────────────────────
// C. 2GB MTPROTO FAST BACKUP (403 BYPASS)
// ───────────────────────────────────────────
async function uploadToStorageChannel2GB(videoUrl, fileName, caption) {
  if (!STORAGE_CHANNEL_ID) return null;

  const tempFilePath = path.join('/tmp', `${Date.now()}_clean.mp4`);
  const rawCookie = process.env.TERABOX_COOKIE || 'ndus=Yzdpm64teHuiTpyF1tSZ-m4ANxhFN7shhUG1hMNu;';
  const cookie = rawCookie.includes('ndus=') ? rawCookie : `ndus=${rawCookie};`;

  try {
    console.log(`[Vault] 1. Downloading direct stream to disk...`);
    const writer = fs.createWriteStream(tempFilePath);

    const streamRes = await axios.get(videoUrl, {
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': 'https://www.terabox1024.com/',
        'Cookie': cookie,
        'Accept': '*/*'
      },
      timeout: 180000
    });

    await new Promise((resolve, reject) => {
      streamRes.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    const stats = fs.statSync(tempFilePath);
    const mbSize = (stats.size / (1024 * 1024)).toFixed(2);
    console.log(`[Vault] 2. Download finished. Size: ${mbSize} MB`);

    if (stats.size === 0) {
      console.error('[Vault] Error: File is 0 bytes! Aborting.');
      try { fs.unlinkSync(tempFilePath); } catch (e) {}
      return null;
    }

    let peer = STORAGE_CHANNEL_ID.trim();
    if (/^-100\d+$/.test(peer)) {
      peer = BigInt(peer);
    }

    console.log(`[Vault] 3. Starting MTProto 2GB chunk upload...`);
    const result = await mtprotoClient.sendFile(peer, {
      file: tempFilePath,
      caption: caption,
      workers: 4,
      supportsStreaming: true
    });

    try { fs.unlinkSync(tempFilePath); } catch (e) {}
    console.log(`[Vault] 4. Success! Uploaded to channel. Msg ID: ${result.id}`);
    return result;
  } catch (err) {
    console.error(`[Vault Upload Failed]:`, err.message);
    try { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch (e) {}
    return null;
  }
}

// ───────────────────────────────────────────
// D. BOT COMMANDS
// ───────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `🎬 <b>Welcome to MayaJaal Converter Bot!</b>\n\n` +
    `Bhejo koi bhi <b>Diskwala ya Terabox link</b> aur turant 2GB permanent stream link pao.\n\n` +
    `<b>Commands:</b>\n` +
    `/api - Matrix key link karein\n` +
    `/logout - Disconnect karein\n` +
    `/add_header TEXT - Custom header set karein\n` +
    `/add_footer TEXT - Custom footer set karein`,
    { parse_mode: 'HTML' }
  );
});

bot.onText(/\/api(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const token = match[1]?.trim();
  const user = await getUser(chatId);

  if (!token) {
    return bot.sendMessage(chatId,
      `🔐 <b>Matrix Key Linking</b>\n\nApni key yahan se lein: ${WEB_PAGE_URL}?tg=${chatId}\nPhir bhejein: <code>/api YOUR_KEY</code>`,
      { parse_mode: 'HTML' }
    );
  }

  const valid = await redis.get(`matrix_key:${token}`);
  if (!valid || String(valid) !== String(chatId)) {
    return bot.sendMessage(chatId, `❌ Invalid ya unauthorized Matrix Key!`, { parse_mode: 'HTML' });
  }

  user.apiToken = token;
  await saveUser(chatId, user);
  bot.sendMessage(chatId, `✅ <b>Matrix Key successfully linked!</b>`, { parse_mode: 'HTML' });
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
  if (!text) return bot.sendMessage(chatId, `❌ Usage: <code>/add_header TEXT</code>`, { parse_mode: 'HTML' });
  const user = await getUser(chatId);
  user.header = text;
  await saveUser(chatId, user);
  bot.sendMessage(chatId, `✅ Header updated!`, { parse_mode: 'HTML' });
});

bot.onText(/\/add_footer(?:\s+([\s\S]+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const text = match[1]?.trim();
  if (!text) return bot.sendMessage(chatId, `❌ Usage: <code>/add_footer TEXT</code>`, { parse_mode: 'HTML' });
  const user = await getUser(chatId);
  user.footer = text;
  await saveUser(chatId, user);
  bot.sendMessage(chatId, `✅ Footer updated!`, { parse_mode: 'HTML' });
});

// ═══════════════════════════════════════════
// 4. MASTER HANDLER (2GB SECURE BACKUP)
// ═══════════════════════════════════════════
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const incomingContent = (msg.text || msg.caption || '').trim();

  if (!incomingContent || incomingContent.startsWith('/')) return;

  const urlRegex = /(https?:\/\/[^\s<>"']+)/gi;
  const matches = incomingContent.match(urlRegex) || [];
  
  const targetUrl = matches.find(url => 
    /(diskwala|terabox|terasharefile|1024tera|teraboxapp|teraboxshare|teraboxlink|tibibox|momerybox|mirrorbox|4funbox|dubox|freeterabox)/i.test(url)
  );

  if (!targetUrl) return;

  const user = await getUser(chatId);
  if (!user || !user.apiToken) {
    return bot.sendMessage(
      chatId,
      `❌ <b>Pehle Matrix Key link karein!</b>\n\nKey lein: ${WEB_PAGE_URL}?tg=${chatId}\nPhir <code>/api YOUR_KEY</code> bhejein.`,
      { parse_mode: 'HTML' }
    );
  }

  const uploaderName = msg.from?.username ? `@${msg.from.username}` : (msg.from?.first_name || 'Matrix User');

  let statusMsg = null;
  try {
    statusMsg = await bot.sendMessage(chatId, `🔄 <i>Securing video to Vault (up to 2GB)...</i>`, { parse_mode: 'HTML' });
  } catch (e) {}

  try {
    console.log(`[Bot] Incoming targetUrl: ${targetUrl}`);

    let extracted = null;
    if (/diskwala/i.test(targetUrl)) {
      extracted = await extractDiskwalaLink(targetUrl);
    } else {
      extracted = await extractTeraboxLink(targetUrl);
    }

    if (!extracted || !extracted.url) {
      if (statusMsg) await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      return bot.sendMessage(chatId, `❌ <b>Link convert nahi ho saka (Link expired ya unsupported).</b>`, { parse_mode: 'HTML' });
    }

    let finalPlayUrl = extracted.url;
    let isBackedUp = false;

    // MTPROTO 2GB BACKUP TO CHANNEL
    if (STORAGE_CHANNEL_ID) {
      const uploadResult = await uploadToStorageChannel2GB(
        extracted.url,
        extracted.name,
        `📁 <b>${escapeHtml(extracted.name)}</b>\n👤 Added by: ${uploaderName}\n🔗 Original: ${targetUrl}`
      );

      if (uploadResult && uploadResult.media) {
        isBackedUp = true;
      }
    }

    const shortId = crypto.randomBytes(4).toString('hex');
    const payload = {
      url: finalPlayUrl,
      name: extracted.name,
      uploader: uploaderName,
    };

    linkStore.set(shortId, payload);
    await redis.set(`terabox:${shortId}`, JSON.stringify(payload), { ex: 30 * 86400 });

    const playUrl = `${BASE_URL}/tb/${shortId}`;

    if (statusMsg) await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    await bot.sendMessage(chatId, buildSuccessMessage(user, extracted.name, playUrl, isBackedUp), {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error('[Bot Error]:', err.message);
    if (statusMsg) await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    bot.sendMessage(chatId, `❌ <b>Error:</b> <code>${escapeHtml(err.message)}</code>`, { parse_mode: 'HTML' });
  }
});
      
