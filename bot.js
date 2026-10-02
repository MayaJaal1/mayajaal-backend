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
const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID || '';
const BASE_URL = process.env.CUSTOM_DOMAIN 
  ? (process.env.CUSTOM_DOMAIN.startsWith('http') ? process.env.CUSTOM_DOMAIN : `https://${process.env.CUSTOM_DOMAIN}`)
  : 'https://mayajaal.online';

if (!TOKEN) {
  console.error('❌ BOT_TOKEN missing!');
  process.exit(1);
}

// ═══════════════════════════════════════════
// 1. EXPRESS SERVER
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

app.get('/', (req, res) => res.send('MayaJaal Ultra Edge Stream Engine Active!'));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.get(['/version.json', '/check-update', '/api/check-update'], (req, res) => {
  res.json({
    latestVersionCode: 2,
    latestVersionName: "v1.1.0",
    updateUrl: "https://mayajaal.online/download.html",
    forceUpdate: false,
    changelog: "⚡ Fast conversion active"
  });
});

app.get('/logo.jpg', (req, res) => res.sendFile(path.join(__dirname, 'logo.jpg')));
app.get('/key', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get(['/download', '/download.html'], (req, res) => {
  const dlPath = path.join(__dirname, 'download.html');
  if (fs.existsSync(dlPath)) return res.sendFile(dlPath);
  res.status(404).send('download.html not found');
});

// Matrix Key
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

// Embedded Responsive Player
function servePlayerPage(req, res) {
  const id = req.params.id;
  const playerFile = path.join(__dirname, 'player.html');
  if (fs.existsSync(playerFile)) return res.sendFile(playerFile);

  res.send(`
    <!DOCTYPE html>
    <html lang="hi">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>MayaJaal Player</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #07090e; color: #00ff88; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; padding: 16px; }
        .card { width: 100%; max-width: 850px; background: #0f172a; border: 1px solid #1e293b; border-radius: 16px; padding: 16px; }
        video { width: 100%; border-radius: 10px; background: #000; outline: none; aspect-ratio: 16/9; max-height: 70vh; }
        .title { margin-top: 14px; font-size: 16px; font-weight: bold; color: #f8fafc; }
        .badge { display: inline-block; background: #00ff8822; color: #00ff88; padding: 4px 10px; border-radius: 6px; font-size: 12px; margin-bottom: 12px; }
      </style>
    </head>
    <body>
      <div class="card">
        <span class="badge">⚡ DIRECT ZERO-BUFFER STREAM</span>
        <video id="player" controls autoplay playsinline preload="auto">
          <source src="/stream/${id}" type="video/mp4">
        </video>
        <div class="title" id="vidTitle">MayaJaal Stream</div>
      </div>
      <script>
        fetch('/api/stream-info/${id}')
          .then(r => r.json())
          .then(d => { if(d.title) document.getElementById('vidTitle').innerText = d.title; })
          .catch(()=>{});
      </script>
    </body>
    </html>
  `);
}

app.get('/v/:id', (req, res) => servePlayerPage(req, res));
app.get('/tb/:id', (req, res) => servePlayerPage(req, res));

// Direct Range 206 Streaming Engine
app.get('/stream/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let data = linkStore.get(id);

    if (!data) {
      const raw = (await redis.get(`video:${id}`)) || (await redis.get(`terabox:${id}`));
      if (raw) data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    }

    if (!data || !data.url) return res.status(404).send('Stream unavailable');

    const targetUrl = data.url;

    // Telegram CDN files direct 302 instant redirect
    if (targetUrl.includes('api.telegram.org')) {
      return res.redirect(302, targetUrl);
    }

    const rawCookie = process.env.TERABOX_COOKIE || 'ndus=Yzdpm64teHuiTpyF1tSZ-m4ANxhFN7shhUG1hMNu;';
    const cookie = rawCookie.includes('ndus=') ? rawCookie : `ndus=${rawCookie};`;
    const isTerabox = targetUrl.includes('terabox') || targetUrl.includes('1024tera') || targetUrl.includes('baidupcs');

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Referer': isTerabox ? 'https://www.1024tera.com/' : (targetUrl.includes('diskwala') ? 'https://diskwala.com/' : 'https://mayajaal.online/'),
      'Cookie': cookie,
      'Accept': '*/*'
    };

    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    const videoStream = await axios.get(targetUrl, {
      responseType: 'stream',
      headers: headers,
      maxRedirects: 10,
      timeout: 120000
    });

    res.status(videoStream.status);
    res.setHeader('Content-Type', videoStream.headers['content-type'] || 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    if (videoStream.headers['content-range']) res.setHeader('Content-Range', videoStream.headers['content-range']);
    if (videoStream.headers['content-length']) res.setHeader('Content-Length', videoStream.headers['content-length']);

    videoStream.data.pipe(res);
  } catch (err) {
    try {
      const fb = linkStore.get(req.params.id);
      if (fb && fb.url) return res.redirect(302, fb.url);
    } catch (e) {}
    if (!res.headersSent) res.status(500).send('Streaming error');
  }
});

app.get(['/api/stream-info/:id', '/api/tb/:id', '/api/v/:id'], async (req, res) => {
  try {
    const id = req.params.id;
    let data = linkStore.get(id);
    if (!data) {
      const raw = (await redis.get(`video:${id}`)) || (await redis.get(`terabox:${id}`));
      if (raw) data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    }

    if (!data || !data.url) return res.status(404).json({ success: false });

    res.json({
      success: true,
      url: `${BASE_URL}/stream/${id}`,
      video_url: `${BASE_URL}/stream/${id}`,
      title: data.name || 'MayaJaal Video',
      id: id
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`✅ MayaJaal Web Server active on port ${PORT}`));
// ═══════════════════════════════════════════
// 2. BOT CONTROLLER (Auto-Recovering Polling)
// ═══════════════════════════════════════════
const bot = new TelegramBot(TOKEN, {
  polling: {
    autoStart: true,
    params: { timeout: 10 }
  }
});

bot.on('polling_error', async (error) => {
  if (error.message && error.message.includes('409 Conflict')) {
    // Gracefully wait for old container to shutdown
    await new Promise(r => setTimeout(r, 4000));
  }
});

async function getUser(chatId) {
  try {
    const data = await redis.get(`user_settings:${chatId}`);
    if (data) return typeof data === 'string' ? JSON.parse(data) : data;
  } catch (err) {}
  return { apiToken: null, header: null, footer: null, bold: false, enableText: true };
}

async function saveUser(chatId, data) {
  try {
    await redis.set(`user_settings:${chatId}`, JSON.stringify(data));
  } catch (err) {}
}

function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ───────────────────────────────────────────
// A. MULTI-LINK RESOLVERS (Teraboxlink Fix)
// ───────────────────────────────────────────
async function extractTeraboxLink(rawUrl) {
  try {
    let resolvedUrl = rawUrl;
    
    // Step 1: Follow any 301/302 short link redirects (teraboxlink.com fix)
    try {
      const resp = await axios.get(rawUrl, {
        maxRedirects: 5,
        validateStatus: (status) => status >= 200 && status < 400,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
        },
        timeout: 7000
      });
      if (resp.request?.res?.responseUrl) {
        resolvedUrl = resp.request.res.responseUrl;
      }
    } catch (e) {}

    // Step 2: Grab the unique share key
    const match = resolvedUrl.match(/\/(s|sharing\/link\?surl=)([a-zA-Z0-9_-]+)/i) || 
                  resolvedUrl.match(/surl=([a-zA-Z0-9_-]+)/i) ||
                  rawUrl.match(/\/s\/([a-zA-Z0-9_-]+)/i);

    let shorturl = match ? (match[2] || match[1]) : '';
    if (!shorturl && resolvedUrl.includes('/s/')) {
      shorturl = resolvedUrl.split('/s/')[1].split(/[?&#]/)[0];
    }
    if (!shorturl && rawUrl.includes('/s/')) {
      shorturl = rawUrl.split('/s/')[1].split(/[?&#]/)[0];
    }
    if (!shorturl) return null;

    const formattedKey = shorturl.startsWith('1') ? shorturl.substring(1) : shorturl;
    const rawCookie = process.env.TERABOX_COOKIE || 'ndus=Yzdpm64teHuiTpyF1tSZ-m4ANxhFN7shhUG1hMNu;';
    const cookie = rawCookie.includes('ndus=') ? rawCookie : `ndus=${rawCookie};`;

    // Step 3: Official 1024tera / Terabox internal endpoints
    const keysToTry = [formattedKey, shorturl];
    for (const k of keysToTry) {
      try {
        const res = await axios.get(`https://www.1024tera.com/share/list?app_id=250528&shorturl=${k}&root=1`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            'Referer': 'https://www.1024tera.com/',
            'Cookie': cookie,
            'Accept': 'application/json, text/plain, */*'
          },
          timeout: 8000
        });

        if (res.data?.errno === 0 && res.data?.list?.length > 0) {
          const file = res.data.list[0];
          const streamUrl = file.dlink || file.direct_link || file.url;
          if (streamUrl) {
            return {
              url: streamUrl,
              name: file.server_filename || 'Terabox Video'
            };
          }
        }
      } catch (err) {}
    }

    // Step 4: Rapid Gateway Fallback
    try {
      const gw = await axios.get(`https://terabox-api.graydeveloper.workers.dev/?url=${encodeURIComponent(rawUrl)}`, { timeout: 8000 });
      if (gw.data && (gw.data.direct_link || gw.data.download_link || gw.data.stream_url)) {
        return {
          url: gw.data.direct_link || gw.data.download_link || gw.data.stream_url,
          name: gw.data.file_name || 'Terabox Video'
        };
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

    const baseHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://diskwala.com/'
    };

    try {
      const pageRes = await axios.get(diskwalaUrl, { headers: baseHeaders, timeout: 6000 });
      const html = pageRes.data;
      if (typeof html === 'string') {
        const streamMatch = html.match(/"(https?:\/\/[^"]+\.(mp4|m3u8)[^"]*)"/i) || html.match(/src=["'](https?:\/\/[^"']+)["']/i);
        if (streamMatch && streamMatch[1]) return { url: streamMatch[1], name: 'Diskwala Video' };
      }
    } catch (e) {}

    const apis = [`https://www.diskwala.com/api/post/${fileId}`, `https://diskwala.com/api/file/${fileId}`];
    for (const ep of apis) {
      try {
        const res = await axios.get(ep, { headers: baseHeaders, timeout: 5000 });
        if (res.data) {
          const direct = res.data.stream_url || res.data.video_url || res.data.url;
          if (direct) return { url: direct, name: res.data.title || 'Diskwala Video' };
        }
      } catch (e) {}
    }
  } catch (e) {}
  return null;
}

async function extractMayaJaalLink(mayaUrl) {
  try {
    const match = mayaUrl.match(/\/(v|tb|stream)\/([a-zA-Z0-9_-]+)/i);
    const id = match ? match[2] : null;
    if (!id) return null;

    let data = linkStore.get(id);
    if (!data) {
      const raw = (await redis.get(`video:${id}`)) || (await redis.get(`terabox:${id}`));
      if (raw) data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    }
    if (data && data.url) return { url: data.url, name: data.name || 'MayaJaal Video' };
  } catch (e) {}
  return null;
}

// ───────────────────────────────────────────
// B. BOT COMMANDS & API CONNECT
// ───────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `🎬 <b>MayaJaal Ultra Cloud Streamer</b>\n\n` +
    `• <b>Video file bhejein:</b> Direct zero-buffer stream + Vault save\n` +
    `• <b>Bulk Links:</b> Teraboxlink, Terabox, Diskwala ke kitne bhi links ek sath paste karein\n` +
    `• <b>API Setup:</b> <code>/api</code> bhej kar portal open karein`,
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
    `Unique key generate karne ke liye tap karein:\n${keyUrl}\n\n` +
    `Key milne ke baad send karein:\n<code>/api YOUR_KEY</code>`,
    { parse_mode: 'HTML', disable_web_page_preview: true }
  );
});

// ───────────────────────────────────────────
// C. MASTER MESSAGE HANDLER
// ───────────────────────────────────────────
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const user = await getUser(chatId);
  const uploaderName = msg.from?.username ? `@${msg.from.username}` : (msg.from?.first_name || 'MayaJaal Cloud');

  // 1. Direct Video / Document Upload
  const videoObj = msg.video || msg.document || (msg.animation ? msg.animation : null);
  if (videoObj) {
    const fileName = videoObj.file_name || `video_${Date.now()}.mp4`;
    const statusMsg = await bot.sendMessage(chatId, `⚡ <i>Video direct connect ho rahi hai...</i>`, { parse_mode: 'HTML' });

    try {
      const directTelegramUrl = await bot.getFileLink(videoObj.file_id);

      if (STORAGE_CHANNEL_ID) {
        bot.forwardMessage(STORAGE_CHANNEL_ID, chatId, msg.message_id).catch(() => {});
      }

      const shortId = crypto.randomBytes(4).toString('hex');
      const payload = { url: directTelegramUrl, name: fileName, uploader: uploaderName };

      linkStore.set(shortId, payload);
      await redis.set(`video:${shortId}`, JSON.stringify(payload), { ex: 30 * 86400 });

      const playUrl = `${BASE_URL}/v/${shortId}`;
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});

      let reply = `✨ <b>MayaJaal Stream Ready!</b>\n\n`;
      if (user.header && user.enableText) reply = `<b>${escapeHtml(user.header)}</b>\n\n` + reply;
      reply += `📌 <b>File:</b> ${escapeHtml(fileName)}\n\n🔗 <b>Player Link:</b>\n${playUrl}\n\n⚡ <i>Direct Playback Active</i>`;
      if (user.footer && user.enableText) reply += `\n\n<b>${escapeHtml(user.footer)}</b>`;

      return bot.sendMessage(chatId, reply, { parse_mode: 'HTML', disable_web_page_preview: false });
    } catch (err) {
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      return bot.sendMessage(chatId, `❌ <b>Error:</b> <code>${escapeHtml(err.message)}</code>`, { parse_mode: 'HTML' });
    }
  }

  // 2. Parallel Bulk Link Processing
  const incomingText = (msg.text || msg.caption || '').trim();
  if (!incomingText || incomingText.startsWith('/')) return;

  const urlRegex = /(https?:\/\/[^\s<>"']+)/gi;
  const urls = incomingText.match(urlRegex) || [];
  if (urls.length === 0) return;

  const statusMsg = await bot.sendMessage(chatId, `🔄 <i>${urls.length} links parallel process ho rahe hain...</i>`, { parse_mode: 'HTML' });

  try {
    const resolveLink = async (targetUrl) => {
      let extracted = null;
      if (/mayajaal/i.test(targetUrl)) {
        extracted = await extractMayaJaalLink(targetUrl);
      } else if (/diskwala/i.test(targetUrl)) {
        extracted = await extractDiskwalaLink(targetUrl);
      } else if (/(terabox|1024tera|teraboxlink|terasharelink)/i.test(targetUrl)) {
        extracted = await extractTeraboxLink(targetUrl);
      } else {
        extracted = { url: targetUrl, name: 'Web Stream Video' };
      }

      if (extracted && extracted.url) {
        const shortId = crypto.randomBytes(4).toString('hex');
        const payload = { url: extracted.url, name: extracted.name, uploader: uploaderName };
        linkStore.set(shortId, payload);
        await redis.set(`video:${shortId}`, JSON.stringify(payload), { ex: 30 * 86400 });
        return { success: true, name: extracted.name, playUrl: `${BASE_URL}/v/${shortId}` };
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
      } else {
        failedCount++;
      }
    });

    if (successList.length === 0) {
      return bot.sendMessage(chatId, `❌ <b>Koi bhi link convert nahi ho saka (Links invalid ya expired hain).</b>`, { parse_mode: 'HTML' });
    }

    let finalMsg = `✨ <b>Converted Stream Links (${successList.length}):</b>\n\n` + successList.join('\n\n');
    if (failedCount > 0) finalMsg += `\n\n⚠️ <i>${failedCount} links convert nahi ho sake.</i>`;

    bot.sendMessage(chatId, finalMsg, { parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (err) {
    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    bot.sendMessage(chatId, `❌ <b>Error:</b> <code>${escapeHtml(err.message)}</code>`, { parse_mode: 'HTML' });
  }
});
    
