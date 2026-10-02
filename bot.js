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
// 2. EXPRESS HTTP SERVER & DIRECT STREAM PROXY
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
    changelog: "⚡ Fast player streaming active!"
  });
});

app.get('/logo.jpg', (req, res) => res.sendFile(path.join(__dirname, 'logo.jpg')));
app.get('/key', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get(['/download', '/download.html'], (req, res) => {
  const dlPath = path.join(__dirname, 'download.html');
  if (fs.existsSync(dlPath)) return res.sendFile(dlPath);
  res.status(404).send('download.html not found');
});

// Custom Embedded Player with Auto-Fallback
function servePlayerPage(req, res) {
  const id = req.params.id;
  const playerFile = path.join(__dirname, 'player.html');
  
  if (fs.existsSync(playerFile)) {
    return res.sendFile(playerFile);
  }

  // Inline Fallback Web Player
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>MayaJaal Stream Player</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #07090e; color: #00ff88; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; padding: 15px; }
        .player-card { width: 100%; max-width: 900px; background: #0f172a; border: 1px solid #1e293b; border-radius: 16px; padding: 15px; box-shadow: 0 10px 30px rgba(0, 255, 136, 0.15); }
        video { width: 100%; border-radius: 10px; background: #000; outline: none; aspect-ratio: 16/9; max-height: 70vh; }
        .title { margin-top: 12px; font-size: 16px; font-weight: bold; color: #f8fafc; }
        .badge { display: inline-block; background: #00ff8822; color: #00ff88; padding: 4px 10px; border-radius: 6px; font-size: 12px; margin-bottom: 10px; font-weight: 600; }
      </style>
    </head>
    <body>
      <div class="player-card">
        <span class="badge">MAYAJAAL CLOUD PLAYER</span>
        <video id="player" controls autoplay playsinline preload="auto">
          <source src="/stream/${id}" type="video/mp4">
          Aapka browser video tag support nahi karta.
        </video>
        <div class="title" id="vidTitle">MayaJaal Streaming Video</div>
      </div>
      <script>
        fetch('/api/stream-info/${id}')
          .then(r => r.json())
          .then(d => {
            if(d.title) document.getElementById('vidTitle').innerText = d.title;
          }).catch(()=>{});
      </script>
    </body>
    </html>
  `);
}

app.get('/v/:id', (req, res) => servePlayerPage(req, res));
app.get('/tb/:id', (req, res) => servePlayerPage(req, res));

// ───────────────────────────────────────────
// DIRECT STREAM ENGINE (Playable Fast Route)
// ───────────────────────────────────────────
app.get('/stream/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let data = linkStore.get(id);

    if (!data) {
      const raw = await redis.get(`video:${id}`) || await redis.get(`terabox:${id}`);
      if (raw) data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    }

    if (!data || !data.url) {
      return res.status(404).send('Stream link missing or expired');
    }

    const targetUrl = data.url;

    // 1. Agar Telegram ka direct file URL hai, toh redirect kar dein taaki fast stream ho sake
    if (targetUrl.includes('api.telegram.org') || targetUrl.includes('telegram')) {
      return res.redirect(302, targetUrl);
    }

    // 2. Terabox aur Diskwala ke liye range proxy headers
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
      validateStatus: (status) => status >= 200 && status < 400,
      timeout: 120000
    });

    res.status(videoStream.status);
    res.setHeader('Content-Type', videoStream.headers['content-type'] || 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    if (videoStream.headers['content-range']) res.setHeader('Content-Range', videoStream.headers['content-range']);
    if (videoStream.headers['content-length']) res.setHeader('Content-Length', videoStream.headers['content-length']);

    videoStream.data.pipe(res);
  } catch (err) {
    console.error('[Stream Error]:', err.message);
    if (!res.headersSent) {
      // Fallback: direct redirect agar proxy pipe fail ho jaye
      try {
        let fallbackData = linkStore.get(req.params.id);
        if (fallbackData && fallbackData.url) return res.redirect(302, fallbackData.url);
      } catch (e) {}
      res.status(500).send('Streaming error: ' + err.message);
    }
  }
});

app.get(['/api/stream-info/:id', '/api/tb/:id', '/api/v/:id'], async (req, res) => {
  try {
    const id = req.params.id;
    let data = linkStore.get(id);
    if (!data) {
      const raw = await redis.get(`video:${id}`) || await redis.get(`terabox:${id}`);
      if (raw) data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    }

    if (!data || !data.url) return res.status(404).json({ success: false, message: 'Stream not found' });

    const directStreamUrl = `${BASE_URL}/stream/${id}`;

    res.json({
      success: true,
      url: directStreamUrl,
      video_url: directStreamUrl,
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

bot.on('polling_error', (error) => {
  if (error.message && error.message.includes('409 Conflict')) {
    console.error('⚠️ [409 Conflict]: Ek se zyada bot instances active hain.');
  }
});

async function getUser(chatId) {
  try {
    const data = await redis.get(`user_settings:${chatId}`);
    if (data) return typeof data === 'string' ? JSON.parse(data) : data;
  } catch (err) {}
  return { apiToken: null, header: null, footer: null, bold: false, enableText: true };
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
// A. MAYAJAAL LINK RESOLVER
// ───────────────────────────────────────────
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

    if (data && data.url) {
      return {
        url: data.url,
        name: data.name || 'MayaJaal Video'
      };
    }
  } catch (e) {
    console.error('[MayaJaal Extract Error]:', e.message);
  }
  return null;
}

// ───────────────────────────────────────────
// B. DISKWALA & TERABOX EXTRACTORS
// ───────────────────────────────────────────
async function extractDiskwalaLink(diskwalaUrl) {
  try {
    const match = diskwalaUrl.match(/\/(app|view|file|p|post|d)\/([a-zA-Z0-9_-]+)/i) || diskwalaUrl.match(/diskwala\.com\/([a-zA-Z0-9_-]+)/i);
    const fileId = match ? (match[2] || match[1]) : null;
    if (!fileId) return null;

    const baseHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Referer': 'https://diskwala.com/'
    };

    // Scrape HTML for direct video source
    try {
      const pageRes = await axios.get(diskwalaUrl, { headers: baseHeaders, timeout: 8000 });
      const html = pageRes.data;
      if (typeof html === 'string') {
        const streamMatch = html.match(/"(https?:\/\/[^"]+\.(mp4|m3u8)[^"]*)"/i) || 
                            html.match(/src=["'](https?:\/\/[^"']+)["']/i);
        if (streamMatch && streamMatch[1]) {
          return { url: streamMatch[1], name: 'Diskwala Video' };
        }
      }
    } catch (e) {}

    const apis = [
      `https://www.diskwala.com/api/post/${fileId}`,
      `https://diskwala.com/api/file/${fileId}`,
      `https://diskwala.com/api/v1/post/get?id=${fileId}`
    ];

    for (const ep of apis) {
      try {
        const res = await axios.get(ep, { headers: baseHeaders, timeout: 6000 });
        const d = res.data;
        if (d) {
          const direct = d.stream_url || d.video_url || d.url || d.download_url || d.file?.url || d.post?.video_url;
          if (direct) return { url: direct, name: d.name || d.title || 'Diskwala Video' };
        }
      } catch (e) {}
    }
  } catch (err) {
    console.error('[Diskwala Error]:', err.message);
  }
  return null;
}

async function extractTeraboxLink(teraboxUrl) {
  const rawCookie = process.env.TERABOX_COOKIE || 'ndus=Yzdpm64teHuiTpyF1tSZ-m4ANxhFN7shhUG1hMNu;';
  const cookie = rawCookie.includes('ndus=') ? rawCookie : `ndus=${rawCookie};`;

  const match = teraboxUrl.match(/\/s\/([a-zA-Z0-9_-]+)/i);
  let shorturl = match ? match[1] : '';
  if (!shorturl) return null;

  const tryKeys = [shorturl, shorturl.startsWith('1') ? shorturl.substring(1) : shorturl];

  for (const key of tryKeys) {
    try {
      const res = await axios.get(`https://www.1024tera.com/share/list?app_id=250528&shorturl=${key}&root=1`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Referer': 'https://www.1024tera.com/',
          'Cookie': cookie
        },
        timeout: 12000
      });

      if (res.data?.errno === 0 && res.data?.list?.length > 0) {
        const file = res.data.list[0];
        const streamUrl = file.dlink || file.direct_link || file.url;
        if (streamUrl) return { url: streamUrl, name: file.server_filename || 'Terabox Video' };
      }
    } catch (e) {}
  }
  return null;
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `🎬 <b>Welcome to MayaJaal Stream Engine!</b>\n\n` +
    `• Koi bhi <b>Video file upload</b> karein\n` +
    `• Ya <b>MayaJaal, Terabox, Diskwala</b> ka link bhejein\n\n` +
    `Aapko working cloud streaming link mil jayega jo seedha player mein chalega!`,
    { parse_mode: 'HTML' }
  );
});

// ═══════════════════════════════════════════
// 4. MASTER BOT MESSAGE HANDLER
// ═══════════════════════════════════════════
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const user = await getUser(chatId);
  const uploaderName = msg.from?.username ? `@${msg.from.username}` : (msg.from?.first_name || 'Matrix User');

  // Case A: Direct Video / Document Upload
  const videoObj = msg.video || msg.document || (msg.animation ? msg.animation : null);
  if (videoObj) {
    const fileName = videoObj.file_name || `video_${Date.now()}.mp4`;
    const statusMsg = await bot.sendMessage(chatId, `⚡ <i>Video cloud se connect ho rahi hai...</i>`, { parse_mode: 'HTML' });

    try {
      const directUrl = await bot.getFileLink(videoObj.file_id);
      let isBackedUp = false;

      if (STORAGE_CHANNEL_ID) {
        try {
          await bot.forwardMessage(STORAGE_CHANNEL_ID, chatId, msg.message_id);
          isBackedUp = true;
        } catch (e) {}
      }

      const shortId = crypto.randomBytes(4).toString('hex');
      const payload = { url: directUrl, name: fileName, uploader: uploaderName };

      linkStore.set(shortId, payload);
      await redis.set(`video:${shortId}`, JSON.stringify(payload), { ex: 30 * 86400 });

      const playUrl = `${BASE_URL}/v/${shortId}`;
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      return bot.sendMessage(chatId, buildSuccessMessage(user, fileName, playUrl, isBackedUp), {
        parse_mode: 'HTML',
        disable_web_page_preview: false
      });
    } catch (err) {
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      return bot.sendMessage(chatId, `❌ <b>Error:</b> <code>${escapeHtml(err.message)}</code>`, { parse_mode: 'HTML' });
    }
  }

  // Case B: Link Conversion (MayaJaal, Terabox, Diskwala, or Any MP4 Link)
  const incomingText = (msg.text || msg.caption || '').trim();
  if (!incomingText || incomingText.startsWith('/')) return;

  const urlRegex = /(https?:\/\/[^\s<>"']+)/gi;
  const matches = incomingText.match(urlRegex) || [];
  
  if (matches.length === 0) return;
  const targetUrl = matches[0];

  const statusMsg = await bot.sendMessage(chatId, `🔄 <i>Link convert kiya ja raha hai...</i>`, { parse_mode: 'HTML' });

  try {
    let extracted = null;

    if (/mayajaal/i.test(targetUrl)) {
      extracted = await extractMayaJaalLink(targetUrl);
    } else if (/diskwala/i.test(targetUrl)) {
      extracted = await extractDiskwalaLink(targetUrl);
    } else if (/(terabox|1024tera|teraboxlink)/i.test(targetUrl)) {
      extracted = await extractTeraboxLink(targetUrl);
    } else {
      // Direct playable link support
      extracted = { url: targetUrl, name: 'Web Stream Video' };
    }

    if (!extracted || !extracted.url) {
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      return bot.sendMessage(chatId, `❌ <b>Link convert nahi ho saka (Link invalid ya expired hai).</b>`, { parse_mode: 'HTML' });
    }

    const shortId = crypto.randomBytes(4).toString('hex');
    const payload = { url: extracted.url, name: extracted.name, uploader: uploaderName };

    // Redis aur memory dono me save karein taaki instantly load ho sake
    linkStore.set(shortId, payload);
    await redis.set(`video:${shortId}`, JSON.stringify(payload), { ex: 30 * 86400 });

    const playUrl = `${BASE_URL}/v/${shortId}`;
    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    await bot.sendMessage(chatId, buildSuccessMessage(user, extracted.name, playUrl, true), {
      parse_mode: 'HTML',
      disable_web_page_preview: false
    });
  } catch (err) {
    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    bot.sendMessage(chatId, `❌ <b>Error:</b> <code>${escapeHtml(err.message)}</code>`, { parse_mode: 'HTML' });
  }
});
                    
