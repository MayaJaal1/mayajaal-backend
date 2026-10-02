require('dotenv').config();

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
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

// Credentials Auto-Detection
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
// 1. GRAMJS BOT-TOKEN MTPROTO AUTH (NO SESSION STRING NEEDED)
// ═══════════════════════════════════════════
let tgClient = null;

if (!isNaN(API_ID) && API_ID > 0 && API_HASH && TOKEN) {
  tgClient = new TelegramClient(
    new StringSession(''), // Bot token direct login
    API_ID,
    API_HASH,
    { connectionRetries: 5 }
  );

  (async () => {
    try {
      await tgClient.start({
        botAuthToken: TOKEN
      });
      console.log('✅ GramJS Connected via BOT_TOKEN! 2GB Cloudflare Zero-Buffer Active!');
    } catch (e) {
      console.error('❌ GramJS Bot Token Auth Error:', e.message);
    }
  })();
} else {
  console.warn('⚠️ API_ID, API_HASH ya BOT_TOKEN missing hai.');
}

// ═══════════════════════════════════════════
// 2. EXPRESS HTTP SERVER & STREAMING ENGINE
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

app.get('/', (req, res) => res.send('MayaJaal 2GB Ultra Stream Engine Active!'));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.get(['/version.json', '/check-update', '/api/check-update'], (req, res) => {
  res.json({
    latestVersionCode: 2,
    latestVersionName: "v1.2.0",
    updateUrl: "https://mayajaal.online/download.html",
    forceUpdate: false,
    changelog: "⚡ 2GB zero-buffer MTProto stream active"
  });
});

app.get('/logo.jpg', (req, res) => res.sendFile(path.join(__dirname, 'logo.jpg')));
app.get('/key', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

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
        <span class="badge">⚡ 2GB ZERO-BUFFER CLOUDFLARE EDGE STREAM</span>
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

// ───────────────────────────────────────────
// 3. ZERO-BUFFER RANGE 206 ENGINE (FIXED INPUT LOCATION)
// ───────────────────────────────────────────
app.get('/stream/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let data = linkStore.get(id);

    if (!data) {
      const raw = (await redis.get(`video:${id}`)) || (await redis.get(`terabox:${id}`));
      if (raw) data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    }

    if (!data) return res.status(404).send('Stream unavailable');

    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Accept-Ranges', 'bytes');

    // Case 1: Telegram Channel 2GB MTProto Chunk Streamer
    if (data.channel_id && data.msg_id && tgClient && tgClient.connected) {
      try {
        const rawPeer = String(data.channel_id).trim();
        const peerEntity = await tgClient.getEntity(
          rawPeer.startsWith('@') ? rawPeer : (rawPeer.startsWith('-100') ? BigInt(rawPeer) : rawPeer)
        );

        const messages = await tgClient.getMessages(peerEntity, { ids: [parseInt(data.msg_id, 10)] });
        const targetMsg = messages && messages[0];
        const media = targetMsg?.media;

        if (media && (media.document || media.video)) {
          const doc = media.document || media.video;
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

          // FIXED: Correct Api.InputDocumentFileLocation mapping for GramJS
          const fileLocation = new Api.InputDocumentFileLocation({
            id: doc.id,
            accessHash: doc.accessHash,
            fileReference: doc.fileReference,
            thumbSize: ""
          });

          for await (const chunk of tgClient.iterDownload({
            file: fileLocation,
            dcId: doc.dcId,
            offset: BigInt(start),
            limit: chunkSize,
            chunkSize: 512 * 1024,
            requestSize: 512 * 1024
          })) {
            if (res.writableEnded || res.destroyed) break;
            res.write(chunk);
          }
          return res.end();
        }
      } catch (tgErr) {
        console.error('[GramJS Stream Error]:', tgErr.message);
      }
    }

    // Case 2: External Link Stream (Diskwala / Terabox / Web Stream)
    if (!data.url) return res.status(404).send('Stream expired');

    const targetUrl = data.url;
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

    if (!data) return res.status(404).json({ success: false });

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

app.listen(PORT, () => console.log(`✅ MayaJaal Cloudflare-Backed Web Server active on port ${PORT}`));
                  
