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
// 0. CONFIG & REDIS
// ═══════════════════════════════════════════
const redis = Redis.fromEnv();
const linkStore = new Map();

const TOKEN = process.env.BOT_TOKEN;
const WEB_PAGE_URL = process.env.WEB_PAGE_URL || 'https://mayajaal.online/key';
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

app.get('/', (req, res) => res.send('MayaJaal Stream Engine is Active!'));
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
// 2. BOT CONTROLLER & EXTRACTORS
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
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildSuccessMessage(user, fileName, shortUrl) {
  const parts = [];
  if (user && user.enableText && user.header) {
    parts.push(user.bold ? `<b>${escapeHtml(user.header)}</b>` : escapeHtml(user.header));
    parts.push('');
  }
  parts.push(`✨ <b>MayaJaal Stream Ready!</b>`);
  parts.push('');
  parts.push(`📌 <b>File:</b> ${escapeHtml(fileName)}`);
  parts.push('');
  parts.push(`🔗 <b>Stream Link:</b>\n${shortUrl}`);
  if (user && user.enableText && user.footer) {
    parts.push('');
    parts.push(user.bold ? `<b>${escapeHtml(user.footer)}</b>` : escapeHtml(user.footer));
  }
  parts.push('');
  parts.push(`⚡ <i>Instant Cloud Playback</i>`);
  return parts.join('\n');
}

// ───────────────────────────────────────────
// A. DISKWALA ADVANCED EXTRACTOR
// ───────────────────────────────────────────
async function extractDiskwalaLink(diskwalaUrl) {
  try {
    const match = diskwalaUrl.match(/\/(app|view|file|p|post|d)\/([a-zA-Z0-9_-]+)/i) || diskwalaUrl.match(/diskwala\.com\/([a-zA-Z0-9_-]+)/i);
    const fileId = match ? (match[2] || match[1]) : null;

    if (!fileId) return null;

    const baseHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Referer': diskwalaUrl,
      'Accept': '*/*'
    };

    // Strategy 1: Post API Endpoint
    const apiEndpoints = [
      `https://www.diskwala.com/api/post/${fileId}`,
      `https://diskwala.com/api/post/${fileId}`,
      `https://www.diskwala.com/api/file/${fileId}`,
      `https://diskwala.com/api/v1/post/get?id=${fileId}`,
      `https://diskwala.com/api/v1/files/${fileId}`
    ];

    for (const ep of apiEndpoints) {
      try {
        const apiRes = await axios.get(ep, { headers: baseHeaders, timeout: 7000 });
        const d = apiRes.data;
        if (d) {
          const directUrl = d.stream_url || d.url || d.download_url || d.file?.url || d.post?.video_url || d.data?.url || d.data?.stream_url;
          if (directUrl) {
            return {
              url: directUrl,
              name: d.name || d.title || d.post?.title || d.data?.title || 'Diskwala Video'
            };
          }
        }
      } catch (e) {}
    }

    // Strategy 2: Web page scrape with Next.js state extraction
    const pageRes = await axios.get(diskwalaUrl, { headers: baseHeaders, timeout: 10000 });
    const html = typeof pageRes.data === 'string' ? pageRes.data : JSON.stringify(pageRes.data);

    // Look for embedded JSON payload or direct streams
    const jsonMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i);
    if (jsonMatch && jsonMatch[1]) {
      try {
        const nextData = JSON.parse(jsonMatch[1]);
        const postData = nextData?.props?.pageProps?.post || nextData?.props?.pageProps?.file || nextData?.props?.pageProps?.data;
        if (postData) {
          const streamUrl = postData.stream_url || postData.url || postData.video_url || postData.download_url;
          if (streamUrl) {
            return {
              url: streamUrl,
              name: postData.title || postData.name || 'Diskwala Video'
            };
          }
        }
      } catch (e) {}
    }

    // Direct stream match (m3u8, mp4)
    const mediaMatch = html.match(/source:\s*["']([^"']+)["']/i) ||
                       html.match(/file:\s*["']([^"']+)["']/i) ||
                       html.match(/<source[^>]+src=["']([^"']+)["']/i) ||
                       html.match(/["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)["']/i);

    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    const cleanTitle = titleMatch ? titleMatch[1].replace(/-\s*Diskwala.*/i, '').trim() : 'Diskwala Video';

    if (mediaMatch && mediaMatch[1]) {
      return { url: mediaMatch[1], name: cleanTitle };
    }
  } catch (err) {
    console.error('[Diskwala Extractor Error]:', err.message);
  }
  return null;
}

// ───────────────────────────────────────────
// B. TERABOX EXTRACTOR
// ───────────────────────────────────────────
async function extractTeraboxLink(teraboxUrl) {
  const rawCookie = process.env.TERABOX_COOKIE || 'ndus=Yzdpm64teHuiTpyF1tSZ-m4ANxhFN7shhUG1hMNu;';
  const cookie = rawCookie.includes('ndus=') ? rawCookie : `ndus=${rawCookie};`;

  try {
    const match = teraboxUrl.match(/(\/s\/|surl=)([a-zA-Z0-9_-]+)/);
    if (match) {
      let rawKey = match[2];
      const surl = rawKey.startsWith('1') ? rawKey.substring(1) : rawKey;
      const sharePageUrl = `https://www.terabox1024.com/sharing/link?surl=${surl}`;

      const pageRes = await axios.get(sharePageUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Cookie': cookie
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
        if (file.dlink) return { url: file.dlink, name: file.server_filename || 'Terabox Video' };
      }
    }
  } catch (err) {
    console.error('[Extractor Native]', err.message);
  }

  const fallbackApis = [
    `https://terabox-api-direct.onrender.com/api?url=${encodeURIComponent(teraboxUrl)}`,
    `https://ytbvideolyrics.com/api/tb?url=${encodeURIComponent(teraboxUrl)}`
  ];

  for (const endpoint of fallbackApis) {
    try {
      const res = await axios.get(endpoint, { timeout: 10000 });
      if (res.data?.download_url || res.data?.dlink || res.data?.direct_link) {
        return {
          url: res.data.download_url || res.data.dlink || res.data.direct_link,
          name: res.data.file_name || res.data.title || 'Terabox Video'
        };
      }
    } catch (e) {}
  }

  return null;
}

// ───────────────────────────────────────────
// C. BOT COMMANDS
// ───────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `🎬 <b>Welcome to MayaJaal Converter Bot!</b>\n\n` +
    `Bhejo koi bhi <b>Diskwala ya Terabox link</b> aur turant stream link pao.\n\n` +
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
// 3. MASTER HANDLER
// ═══════════════════════════════════════════
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const incomingContent = (msg.text || msg.caption || '').trim();

  if (!incomingContent || incomingContent.startsWith('/')) return;

  // Extract URLs
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
    statusMsg = await bot.sendMessage(chatId, `🔄 <i>Converting Link to MayaJaal Stream...</i>`, { parse_mode: 'HTML' });
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

    const shortId = crypto.randomBytes(4).toString('hex');
    const payload = {
      url: extracted.url,
      name: extracted.name,
      uploader: uploaderName,
    };

    linkStore.set(shortId, payload);
    await redis.set(`terabox:${shortId}`, JSON.stringify(payload), { ex: 30 * 86400 });

    const playUrl = `${BASE_URL}/tb/${shortId}`;

    if (statusMsg) await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    await bot.sendMessage(chatId, buildSuccessMessage(user, extracted.name, playUrl), {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error('[Bot Error]:', err.message);
    if (statusMsg) await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    bot.sendMessage(chatId, `❌ <b>Error:</b> <code>${escapeHtml(err.message)}</code>`, { parse_mode: 'HTML' });
  }
});
