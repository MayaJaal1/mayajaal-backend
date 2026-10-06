require('dotenv').config();

const express = require('express');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { Readable } = require('stream');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const { Redis } = require('@upstash/redis');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

process.on('uncaughtException', (e) => console.error('[Uncaught]', e.stack || e.message));
process.on('unhandledRejection', (e) => console.error('[Unhandled]', e?.stack || e));

const TOKEN = (process.env.BOT_TOKEN || '').trim();
const API_ID = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
const API_HASH = (process.env.TELEGRAM_API_HASH || '').trim();
const BASE_URL = process.env.CUSTOM_DOMAIN
  ? (process.env.CUSTOM_DOMAIN.startsWith('http') ? process.env.CUSTOM_DOMAIN : `https://${process.env.CUSTOM_DOMAIN}`)
  : 'https://mayajaal.online';
const R2_ACCOUNT_ID = (process.env.R2_ACCOUNT_ID || '').trim();
const R2_ACCESS_KEY_ID = (process.env.R2_ACCESS_KEY_ID || '').trim();
const R2_SECRET_ACCESS_KEY = (process.env.R2_SECRET_ACCESS_KEY || '').trim();
const R2_BUCKET_NAME = (process.env.R2_BUCKET_NAME || '').trim();
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').trim().replace(/\/$/, '');
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || '2147483648', 10);
const PORT = parseInt(process.env.PORT || '8080', 10);

// ===== APP CONFIG =====
const APP_NAME = process.env.APP_NAME || 'MayaJaal';
const APP_SCHEME = process.env.APP_SCHEME || 'mayajaal';
const APP_PACKAGE = process.env.APP_PACKAGE || 'com.mayajaal.app';
const PLAY_STORE_URL = process.env.PLAY_STORE_URL || `https://play.google.com/store/apps/details?id=${APP_PACKAGE}`;
const APP_STORE_URL = process.env.APP_STORE_URL || 'https://apps.apple.com/app/mayajaal/id000000000';
const APP_SHA256 = process.env.APP_SHA256 || 'REPLACE_WITH_YOUR_SHA256';
const APPLE_TEAM_ID = process.env.APPLE_TEAM_ID || 'TEAMID';

console.log('=== ENV ===');
console.log('BOT_TOKEN:', !!TOKEN, '| API_ID:', !!API_ID, '| API_HASH:', !!API_HASH);
console.log('R2:', !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET_NAME));
console.log('APP:', APP_NAME, '| Package:', APP_PACKAGE);

if (!TOKEN || !API_ID || !API_HASH) throw new Error('Missing BOT_TOKEN / API_ID / API_HASH');
if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) throw new Error('Missing R2 config');

let redis;
try { redis = Redis.fromEnv(); } catch (e) { redis = { get: async () => null, set: async () => null }; }

const memStore = new Map();
async function saveMeta(id, payload) {
  memStore.set(id, payload);
  try { await redis.set(`v:${id}`, JSON.stringify(payload), { ex: 30 * 86400 }); } catch (e) { }
}
async function getMeta(id) {
  if (memStore.has(id)) return memStore.get(id);
  try {
    const raw = await redis.get(`v:${id}`);
    if (raw) { const d = typeof raw === 'string' ? JSON.parse(raw) : raw; memStore.set(id, d); return d; }
  } catch (e) { }
  return null;
}

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
});

function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ===== SMART LANDING PAGE =====
function smartLandingPage(videoId, title, streamUrl, meta) {
  const androidIntent = `intent://video/${videoId}#Intent;scheme=${APP_SCHEME};package=${APP_PACKAGE};S.browser_fallback_url=${encodeURIComponent(PLAY_STORE_URL)};end`;
  const iosScheme = `${APP_SCHEME}://video/${videoId}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no">
<title>${escapeHtml(title)} - ${APP_NAME}</title>
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="Watch on ${APP_NAME} app">
<meta property="og:type" content="video.other">
<meta name="twitter:card" content="player">
<meta name="twitter:title" content="${escapeHtml(title)}">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0a;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;text-align:center}
.logo{font-size:40px;font-weight:800;background:linear-gradient(135deg,#00ff88,#00b4ff);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin-bottom:8px}
.tag{font-size:13px;color:#666;margin-bottom:32px}
.spinner{width:70px;height:70px;border:4px solid #1a1a1a;border-top-color:#00ff88;border-radius:50%;animation:spin 1s linear infinite;margin:20px auto 30px}
@keyframes spin{to{transform:rotate(360deg)}}
.title{font-size:16px;color:#ccc;margin-bottom:8px;max-width:90vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 10px}
.msg{font-size:14px;color:#888;margin:14px 0}
.btn{display:inline-block;padding:15px 36px;background:linear-gradient(135deg,#00ff88,#00b4ff);color:#000;text-decoration:none;border-radius:12px;font-weight:700;font-size:15px;margin:6px;border:none;cursor:pointer;transition:transform .15s}
.btn:active{transform:scale(0.96)}
.btn-secondary{background:#1a1a1a;color:#fff;border:1px solid #2a2a2a}
.btn-icon{margin-right:8px}
.actions{margin-top:20px;padding:0 10px}
.actions .btn{display:block;width:100%;max-width:300px;margin:10px auto}
.stores{display:flex;gap:10px;justify-content:center;margin-top:20px;flex-wrap:wrap}
.store{padding:12px 22px;background:#161616;border-radius:10px;color:#fff;text-decoration:none;font-size:12px;border:1px solid #252525;display:flex;align-items:center;gap:8px}
.store:active{background:#1e1e1e}
.hint{font-size:11px;color:#555;margin-top:24px;max-width:280px}
.watch-browser{margin-top:32px;text-decoration:underline;color:#666;font-size:13px;cursor:pointer}
</style>
</head>
<body>
<div class="logo">🎬 ${APP_NAME}</div>
<div class="tag">Fast & Secure Video Player</div>
<div class="title">${escapeHtml(title)}</div>
<div class="spinner" id="spinner"></div>
<div class="msg" id="msg">Opening in ${APP_NAME} app...</div>

<div class="actions" id="actions" style="display:none">
  <a href="${PLAY_STORE_URL}" class="btn">📲 Download Android App</a>
  <a href="${APP_STORE_URL}" class="btn btn-secondary">🍎 Download iOS App</a>
  <a href="${streamUrl}" class="btn btn-secondary">🌐 Watch in Browser</a>
</div>

<div id="desktop-actions" style="display:none">
  <div class="msg">Scan the QR or open this link on your mobile to use the app.</div>
  <a href="${streamUrl}" class="btn">🌐 Watch in Browser</a>
</div>

<div class="hint" id="hint"></div>

<script>
(function(){
  var ua = navigator.userAgent || '';
  var isAndroid = /android/i.test(ua);
  var isIOS = /iphone|ipad|ipod/i.test(ua);
  var isMobile = isAndroid || isIOS;
  var appOpened = false;
  var fallbackTimer;

  document.addEventListener('visibilitychange', function() {
    if (document.hidden) { appOpened = true; clearTimeout(fallbackTimer); }
  });
  window.addEventListener('pagehide', function(){ appOpened = true; });
  window.addEventListener('blur', function() { appOpened = true; });

  function showDownloadFallback() {
    if (appOpened) return;
    document.getElementById('spinner').style.display = 'none';
    document.getElementById('msg').innerHTML = '<b>App not installed?</b><br><small style="color:#666">Download the app for faster playback</small>';
    document.getElementById('actions').style.display = 'block';
    document.getElementById('hint').innerHTML = '🎬 Watch videos 2x faster with zero buffering';
  }

  if (isAndroid) {
    // Android: use intent:// which auto-falls back to Play Store
    window.location.href = '${androidIntent}';
    fallbackTimer = setTimeout(showDownloadFallback, 2500);
  } else if (isIOS) {
    // iOS: try custom scheme, fallback to App Store
    window.location.href = '${iosScheme}';
    fallbackTimer = setTimeout(function(){
      if (!appOpened) {
        window.location.href = '${APP_STORE_URL}';
      }
      setTimeout(showDownloadFallback, 1500);
    }, 2000);
  } else {
    // Desktop
    document.getElementById('spinner').style.display = 'none';
    document.getElementById('msg').style.display = 'none';
    document.getElementById('desktop-actions').style.display = 'block';
  }
})();
</script>
</body>
</html>`;
}

// ===== EXPRESS =====
const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.get('/', (req, res) => res.send('MayaJaal Online'));
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime(), gramjs: true }));

// ===== APP VERIFICATION FILES =====
app.get('/.well-known/assetlinks.json', (req, res) => {
  res.type('application/json').send(JSON.stringify([{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: APP_PACKAGE,
      sha256_cert_fingerprints: [APP_SHA256],
    },
  }], null, 2));
});

app.get('/.well-known/apple-app-site-association', (req, res) => {
  res.type('application/json').send(JSON.stringify({
    applinks: {
      apps: [],
      details: [{
        appID: APPLE_TEAM_ID + '.' + APP_PACKAGE,
        paths: ['*'],
      }],
    },
  }, null, 2));
});

// ===== SMART PLAYER PAGE (replaces old /v/:id) =====
app.get('/v/:id', async (req, res) => {
  try {
    const meta = await getMeta(req.params.id);
    if (!meta) return res.status(404).send('Video not found');
    const title = meta.name || 'Video';
    const streamUrl = `${BASE_URL}/stream/${req.params.id}`;
    return res.send(smartLandingPage(req.params.id, title, streamUrl, meta));
  } catch (e) {
    return res.status(500).send('err');
  }
});

// ===== DIRECT BROWSER PLAYER (bypass landing) =====
app.get('/watch/:id', async (req, res) => {
  try {
    const meta = await getMeta(req.params.id);
    if (!meta) return res.status(404).send('Not found');
    const streamUrl = `${BASE_URL}/stream/${req.params.id}`;
    const title = escapeHtml(meta.name || 'Video');
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><link rel="stylesheet" href="https://cdn.plyr.io/3.7.8/plyr.css"><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0a;color:#fff;font-family:sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:12px}.box{width:100%;max-width:960px}video{width:100%;max-height:80vh;border-radius:14px;background:#000}.t{margin-top:14px;font-size:1rem;color:#00ff88;word-break:break-all}</style></head><body><div class="box"><video id="p" controls autoplay playsinline preload="metadata"><source src="${streamUrl}" type="${meta.mime || 'video/mp4'}"></video><div class="t">🎬 ${title}</div></div><script src="https://cdn.plyr.io/3.7.8/plyr.polyfilled.js"></script><script>new Plyr('#p');</script></body></html>`);
  } catch (e) { res.status(500).send('err'); }
});

// ===== R2 STREAM =====
app.get('/stream/:id', async (req, res) => {
  try {
    const meta = await getMeta(req.params.id);
    if (!meta?.r2Key) return res.status(404).send('Not found');
    const out = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: meta.r2Key, Range: req.headers.range || undefined }));
    res.status(req.headers.range ? 206 : 200);
    res.setHeader('Content-Type', out.ContentType || meta.mime || 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    if (out.ContentRange) res.setHeader('Content-Range', out.ContentRange);
    if (out.ContentLength) res.setHeader('Content-Length', out.ContentLength);
    if (out.ETag) res.setHeader('ETag', out.ETag);
    out.Body.on('error', () => { if (!res.headersSent) res.status(500); res.end(); });
    out.Body.pipe(res);
  } catch (e) { if (!res.headersSent) res.status(500).send('err'); }
});

app.listen(PORT, () => console.log(`Web on ${PORT}`));

// ===== TERABOX DOWNLOADER (unchanged) =====
function detectTeraboxUrl(text) {
  if (!text) return null;
  const domains = ['terabox\\.com','terabox\\.app','terabox\\.link','terabox\\.club','terabox\\.fun','terabox\\.cc','terabox\\.top','terabox\\.online','1024tera\\.com','1024terabox\\.com','4funbox\\.com','4funbox\\.co','mirrobox\\.com','nephobox\\.com','momerybox\\.com','tibibox\\.com','teraboxapp\\.com','teraboxlink\\.com','teraboxshare\\.com','teraboxurl\\.com','teraboxdl\\.com','teraboxdownloader\\.com','terafileshare\\.com','terashare\\.com','terasharelink\\.com','terasharefile\\.com','freeterabox\\.com','gearbox\\.app','teraboxcdn\\.com','terabox\\.store','terabox\\.site','terabox\\.space','terabox\\.website','dubox\\.com','terabox\\.icu','terabox\\.xyz','diskwala\\.com'];
  const regex = new RegExp(`https?:\\/\\/[^\\s]*(${domains.join('|')})[^\\s]*`, 'i');
  const m = text.match(regex);
  return m ? m[0] : null;
}

async function getTeraboxDirectLink(shareUrl) {
  const TERABOX_COOKIE = (process.env.TERABOX_COOKIE || '').trim();
  if (!TERABOX_COOKIE) throw new Error('TERABOX_COOKIE missing');
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  const pageResp = await axios.get(shareUrl, {
    headers: { 'User-Agent': UA, 'Cookie': TERABOX_COOKIE },
    timeout: 30000, maxRedirects: 5,
  });
  const html = String(pageResp.data);
  let shareid = null, uk = null, sign = null, timestamp = null, fs_id = null;
  let server_filename = 'video.mp4', size = 0;

  const match = html.match(/window\.yunData\s*=\s*(\{[\s\S]+?\});?\s*<\/script>/);
  if (match) {
    try {
      const y = JSON.parse(match[1]);
      shareid = y.shareid; uk = y.uk; sign = y.sign; timestamp = y.timestamp;
      const f = y.file_list?.[0];
      if (f) { fs_id = f.fs_id; server_filename = f.server_filename || server_filename; size = f.size || 0; }
    } catch (e) { }
  }
  if (!shareid) { const m2 = html.match(/"shareid"\s*:\s*"?(\d+)"?[\s\S]{0,3000}?"uk"\s*:\s*"?(\d+)"?/); if (m2) { shareid = m2[1]; uk = m2[2]; } }
  if (!sign) { const mS = html.match(/"sign"\s*:\s*"([^"]+)"/); if (mS) sign = mS[1]; }
  if (!timestamp) { const mT = html.match(/"timestamp"\s*:\s*(\d+)/); if (mT) timestamp = mT[1]; }
  if (!fs_id) { const m3 = html.match(/"fs_id"\s*:\s*"?(\d+)"?/); if (m3) fs_id = m3[1]; }
  if (server_filename === 'video.mp4') { const m4 = html.match(/"server_filename"\s*:\s*"([^"]+)"/); if (m4) server_filename = m4[1]; }
  if (!size) { const m5 = html.match(/"size"\s*:\s*(\d+)/); if (m5) size = parseInt(m5[1], 10); }
  if (!shareid || !uk) throw new Error('Share info nahi mili');

  const apiHeaders = { 'User-Agent': UA, 'Cookie': TERABOX_COOKIE, 'Referer': shareUrl };
  if (!fs_id) {
    const shorturl = shareUrl.split('/s/')[1]?.split('?')[0] || '';
    try {
      const lr = await axios.get(`https://www.terabox.com/share/list?shorturl=${shorturl}&root=1&web=1&app_id=250528`, { headers: apiHeaders, timeout: 30000 });
      const f = lr.data?.list?.[0];
      if (f) { fs_id = f.fs_id; server_filename = f.server_filename || server_filename; size = f.size || size; }
    } catch (e) { }
  }
  if (!fs_id) throw new Error('fs_id nahi mila');
  const dlResp = await axios.get(`https://www.terabox.com/share/download?shareid=${shareid}&uk=${uk}&sign=${sign || ''}&timestamp=${timestamp || ''}&fs_id=${fs_id}&channel=dubox&web=1&app_id=250528`, { headers: apiHeaders, timeout: 30000 });
  const dlink = dlResp.data?.dlink;
  if (!dlink) throw new Error('Direct link nahi mila');
  return { url: Array.isArray(dlink) ? dlink[0] : dlink, fileName: server_filename, size };
      }
      // ===== BOT HANDLERS =====
(async () => {
  const client = new TelegramClient(new StringSession(''), API_ID, API_HASH, {
    connectionRetries: 5,
    autoReconnect: true,
  });

  console.log('Connecting MTProto...');
  await client.start({ botAuthToken: TOKEN });
  console.log('GramJS connected - 2GB unlocked!');

  client.addEventHandler(async (event) => {
    const msg = event.message;
    if (!msg) return;
    if ((msg.message || '') === '/start') {
      await client.sendMessage(msg.chatId, {
        message: `🎬 <b>MayaJaal Stream Bot</b>\n\n📤 File bhejo (2GB tak) ya Terabox link paste karo\n\n⚡ Player link milega!\n📱 App installed hai toh direct app khulega`,
        parseMode: 'html',
      });
    }
  }, new NewMessage({}));

  client.addEventHandler(async (event) => {
    const msg = event.message;
    if (!msg) return;
    const chatId = msg.chatId;
    const text = msg.message || '';
    if (text === '/start') return;

    // ========== TERABOX LINK ==========
    const teraboxUrl = detectTeraboxUrl(text);
    if (teraboxUrl) {
      let status;
      try {
        status = await client.sendMessage(chatId, { message: `🔍 <i>Terabox link mila...</i>`, parseMode: 'html' });
        const info = await getTeraboxDirectLink(teraboxUrl);
        await client.editMessage(chatId, {
          message: status.id,
          text: `⬇️ <i>Download + upload...</i>\n📌 ${escapeHtml(info.fileName)}\n📦 ${(info.size / 1024 / 1024).toFixed(2)} MB`,
          parseMode: 'html',
        });
        const TERABOX_COOKIE = (process.env.TERABOX_COOKIE || '').trim();
        const resp = await axios.get(info.url, {
          responseType: 'stream', maxContentLength: Infinity, maxBodyLength: Infinity, timeout: 0,
          headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': TERABOX_COOKIE, 'Referer': teraboxUrl },
        });
        const ext = path.extname(info.fileName) || '.mp4';
        const r2Key = `uploads/${crypto.randomBytes(8).toString('hex')}${ext}`;
        const isLarge = info.size > 100 * 1024 * 1024;
        const upload = new Upload({
          client: r2,
          params: { Bucket: R2_BUCKET_NAME, Key: r2Key, Body: resp.data, ContentType: 'video/mp4', CacheControl: 'public, max-age=31536000', Metadata: { source: 'terabox' } },
          queueSize: isLarge ? 4 : 1, partSize: isLarge ? 10 * 1024 * 1024 : 5 * 1024 * 1024,
        });
        await upload.done();
        const shortId = crypto.randomBytes(4).toString('hex');
        await saveMeta(shortId, { name: info.fileName, mime: 'video/mp4', r2Key, size: info.size, ts: Date.now() });
        const playUrl = `${BASE_URL}/v/${shortId}`;
        const browserUrl = `${BASE_URL}/watch/${shortId}`;
        await client.deleteMessages(chatId, [status.id], { revoke: true }).catch(() => {});
        await client.sendMessage(chatId, {
          message: `✅ <b>Ready!</b>\n\n📌 <b>${escapeHtml(info.fileName)}</b>\n📦 ${(info.size / 1024 / 1024).toFixed(2)} MB\n\n📱 <b>Smart Link (App/Browser):</b>\n${playUrl}\n\n🌐 <b>Direct Browser:</b>\n${browserUrl}`,
          parseMode: 'html',
        });
        return;
      } catch (e) {
        console.error('[Terabox Error]', e.message);
        if (status) await client.deleteMessages(chatId, [status.id], { revoke: true }).catch(() => {});
        await client.sendMessage(chatId, { message: `❌ ${escapeHtml(e.message)}`, parseMode: 'html' });
        return;
      }
    }

    // ========== DIRECT FILE (2GB tak) ==========
    if (!msg.media) return;
    const fileMedia = msg.media.document || msg.document || msg.video;
    if (!fileMedia) return;

    console.log('[File] className:', fileMedia.className, '| hasId:', !!fileMedia.id, '| hasHash:', !!fileMedia.accessHash, '| size:', fileMedia.size);

    let fileName = 'video.mp4', mime = 'application/octet-stream', size = 0;
    size = Number(fileMedia.size) || 0;
    mime = fileMedia.mimeType || (msg.video ? 'video/mp4' : 'application/octet-stream');
    const attr = (fileMedia.attributes || []).find(a => a.className === 'DocumentAttributeFilename');
    if (attr) fileName = attr.fileName;
    if (fileName === 'video.mp4' && msg.video) fileName = `video_${Date.now()}.mp4`;

    if (size && size > MAX_FILE_SIZE) {
      return client.sendMessage(chatId, { message: `❌ Max ${(MAX_FILE_SIZE / 1024 / 1024).toFixed(0)} MB` });
    }

    let status;
    try {
      status = await client.sendMessage(chatId, {
        message: `⚡ <i>Uploading...</i>\n📌 ${escapeHtml(fileName)}\n📦 ${(size / 1024 / 1024).toFixed(2)} MB`,
        parseMode: 'html',
      });

      const fileLocation = new Api.InputDocumentFileLocation({
        id: fileMedia.id,
        accessHash: fileMedia.accessHash,
        fileReference: fileMedia.fileReference,
        thumbSize: '',
      });

      const totalSize = Number(fileMedia.size) || 0;
      const CHUNK = 512 * 1024;

      const stream = Readable.from((async function* () {
        let offset = 0;
        while (offset < totalSize) {
          let res;
          try {
            res = await client.invoke(new Api.upload.GetFile({
              location: fileLocation,
              offset: offset,
              limit: CHUNK,
            }));
          } catch (err) {
            console.error('[GetFile Error]', err.message);
            break;
          }
          if (!res || !res.bytes || res.bytes.length === 0) break;
          offset += res.bytes.length;
          yield Buffer.from(res.bytes);
        }
      })());

      const ext = path.extname(fileName) || '.mp4';
      const r2Key = `uploads/${crypto.randomBytes(8).toString('hex')}${ext}`;
      const isLarge = size > 100 * 1024 * 1024;
      console.log('[R2]', r2Key, `${(size / 1024 / 1024).toFixed(2)} MB`);

      const upload = new Upload({
        client: r2,
        params: {
          Bucket: R2_BUCKET_NAME, Key: r2Key, Body: stream, ContentType: mime,
          CacheControl: 'public, max-age=31536000',
          Metadata: { originalname: encodeURIComponent(fileName) },
        },
        queueSize: isLarge ? 4 : 1, partSize: isLarge ? 10 * 1024 * 1024 : 5 * 1024 * 1024,
      });
      await upload.done();

      const shortId = crypto.randomBytes(4).toString('hex');
      await saveMeta(shortId, { name: fileName, mime, r2Key, size, ts: Date.now() });
      const playUrl = `${BASE_URL}/v/${shortId}`;
      const browserUrl = `${BASE_URL}/watch/${shortId}`;
      await client.deleteMessages(chatId, [status.id], { revoke: true }).catch(() => {});
      await client.sendMessage(chatId, {
        message: `✅ <b>Ready!</b>\n\n📌 <b>${escapeHtml(fileName)}</b>\n📦 ${(size / 1024 / 1024).toFixed(2)} MB\n\n📱 <b>Smart Link (App/Browser):</b>\n${playUrl}\n\n🌐 <b>Direct Browser:</b>\n${browserUrl}`,
        parseMode: 'html',
      });
    } catch (e) {
      console.error('[Error]', e.stack || e.message);
      if (status) await client.deleteMessages(chatId, [status.id], { revoke: true }).catch(() => {});
      await client.sendMessage(chatId, { message: `❌ ${escapeHtml(e.message)}`, parseMode: 'html' });
    }
  }, new NewMessage({}));

  console.log('Handlers ready - Smart App Links enabled');
})();
