require('dotenv').config();

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const path = require('path');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

process.on('uncaughtException', (err) => console.error('[UncaughtException]:', err.message));
process.on('unhandledRejection', (reason) => console.error('[UnhandledRejection]:', reason));

let redis;
try {
  redis = Redis.fromEnv();
} catch (e) {
  redis = { get: async () => null, set: async () => null };
}

const linkStore = new Map();
const TOKEN = (process.env.BOT_TOKEN || '').trim();
const BASE_URL = process.env.CUSTOM_DOMAIN 
  ? (process.env.CUSTOM_DOMAIN.startsWith('http') ? process.env.CUSTOM_DOMAIN : `https://${process.env.CUSTOM_DOMAIN}`)
  : 'https://mayajaal.online';

const R2_ACCOUNT_ID = String(process.env.R2_ACCOUNT_ID || '9a17e6f8a4af372b6b0ab1ad1cdb982d').trim();
const R2_ACCESS_KEY_ID = String(process.env.R2_ACCESS_KEY_ID || 'fe0370e7a3f380c0dee831d6c37fd851').trim();
const R2_SECRET_ACCESS_KEY = String(process.env.R2_SECRET_ACCESS_KEY || '').trim();
const R2_BUCKET_NAME = String(process.env.R2_BUCKET_NAME || '').trim();

const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

console.log('✅ Cloudflare R2 Initialized');

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

app.get('/', (req, res) => res.send('Stream Engine Online - Stable Build'));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// 2GB Web Ingestion Page (Telegram 20MB limit bypass portal)
app.get('/upload', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="hi">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>MayaJaal 2GB Fast Video Uploader</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #090a0f; color: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 15px; }
        .upload-card { width: 100%; max-width: 480px; background: #12141d; border: 1px solid #1e2230; border-radius: 16px; padding: 24px; box-shadow: 0 10px 40px rgba(0,0,0,0.8); text-align: center; }
        h2 { color: #00ff88; margin-bottom: 8px; }
        p { color: #8f9bb3; font-size: 0.95rem; margin-bottom: 20px; }
        .file-box { border: 2px dashed #2b334a; border-radius: 12px; padding: 30px 15px; cursor: pointer; transition: 0.3s; margin-bottom: 20px; display: block; }
        .file-box:hover { border-color: #00ff88; }
        input[type="file"] { display: none; }
        .upload-btn { width: 100%; background: #00ff88; color: #000; font-weight: bold; border: none; padding: 14px; border-radius: 10px; font-size: 1rem; cursor: pointer; }
        .progress-bar-wrap { width: 100%; height: 10px; background: #1e2230; border-radius: 5px; margin-top: 15px; overflow: hidden; display: none; }
        .progress-fill { width: 0%; height: 100%; background: #00ff88; transition: width 0.2s; }
        .result-box { margin-top: 20px; padding: 15px; background: #181c28; border-radius: 10px; display: none; word-break: break-all; }
        .link-text { color: #00ff88; font-weight: bold; text-decoration: none; display: block; margin-top: 8px; }
      </style>
    </head>
    <body>
      <div class="upload-card">
        <h2>⚡ MayaJaal Fast Uploader</h2>
        <p>Bina 20MB limit ke 2GB tak ki video yahan se upload karein.</p>
        <label class="file-box" for="fileInput" id="dropLabel">
          📁 <span id="fileNameDisplay">Video file select karein (Max 2GB)</span>
        </label>
        <input type="file" id="fileInput" accept="video/*">
        <button class="upload-btn" id="uploadBtn" onclick="startUpload()">Cloudflare R2 Par Upload Karein</button>
        <div class="progress-bar-wrap" id="progWrap">
          <div class="progress-fill" id="progFill"></div>
        </div>
        <div class="result-box" id="resultBox">
          <span>✅ Video Ready! Stream Link:</span>
          <a class="link-text" id="finalLink" href="#" target="_blank"></a>
        </div>
      </div>

      <script>
        const fileInput = document.getElementById('fileInput');
        const fileNameDisplay = document.getElementById('fileNameDisplay');
        const progWrap = document.getElementById('progWrap');
        const progFill = document.getElementById('progFill');
        const resultBox = document.getElementById('resultBox');
        const finalLink = document.getElementById('finalLink');
        const uploadBtn = document.getElementById('uploadBtn');

        fileInput.addEventListener('change', () => {
          if (fileInput.files[0]) {
            fileNameDisplay.innerText = fileInput.files[0].name + ' (' + (fileInput.files[0].size / (1024*1024)).toFixed(1) + ' MB)';
          }
        });

        async function startUpload() {
          const file = fileInput.files[0];
          if (!file) return alert('Kripya pehle video file select karein');

          uploadBtn.disabled = true;
          uploadBtn.innerText = 'Uploading to Cloudflare R2...';
          progWrap.style.display = 'block';
          resultBox.style.display = 'none';

          const xhr = new XMLHttpRequest();
          xhr.open('POST', '/api/upload-direct');

          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              const percent = Math.round((e.loaded / e.total) * 100);
              progFill.style.width = percent + '%';
            }
          };

          xhr.onload = () => {
            uploadBtn.disabled = false;
            uploadBtn.innerText = 'Cloudflare R2 Par Upload Karein';
            if (xhr.status === 200) {
              const res = JSON.parse(xhr.responseText);
              resultBox.style.display = 'block';
              finalLink.href = res.playUrl;
              finalLink.innerText = res.playUrl;
            } else {
              alert('Upload fail: ' + xhr.responseText);
            }
          };

          xhr.onerror = () => {
            uploadBtn.disabled = false;
            uploadBtn.innerText = 'Cloudflare R2 Par Upload Karein';
            alert('Upload connection fail hui');
          };

          xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
          xhr.setRequestHeader('Content-Type', file.type || 'video/mp4');
          xhr.send(file);
        }
      </script>
    </body>
    </html>
  `);
});

// Direct Stream Ingestion API
app.post('/api/upload-direct', async (req, res) => {
  try {
    const rawName = decodeURIComponent(req.headers['x-file-name'] || `video_${Date.now()}.mp4`);
    const fileExt = path.extname(rawName) || '.mp4';
    const r2Key = `web_uploads/${crypto.randomBytes(8).toString('hex')}${fileExt}`;

    const parallelUpload = new Upload({
      client: r2Client,
      params: {
        Bucket: R2_BUCKET_NAME,
        Key: r2Key,
        Body: req,
        ContentType: req.headers['content-type'] || 'video/mp4',
      },
      queueSize: 4,
      partSize: 1024 * 1024 * 10,
    });

    await parallelUpload.done();

    const shortId = crypto.randomBytes(4).toString('hex');
    const payload = { name: rawName, r2Key: r2Key };

    linkStore.set(shortId, payload);
    await redis.set(`video:${shortId}`, JSON.stringify(payload), { ex: 30 * 86400 });

    const playUrl = `${BASE_URL}/v/${shortId}`;
    return res.json({ success: true, playUrl });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// HTML5 Range Video Player
app.get('/v/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let data = linkStore.get(id);

    if (!data) {
      const raw = await redis.get(`video:${id}`);
      if (raw) data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    }

    if (!data || !data.r2Key) {
      return res.status(404).send('Video not found or processing on Cloudflare R2');
    }

    const streamUrl = `${BASE_URL}/stream/${id}`;
    const videoTitle = data.name || 'Video Player';

    res.send(`
      <!DOCTYPE html>
      <html lang="hi">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${videoTitle}</title>
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body { background: #000; color: #fff; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; padding: 12px; }
          .player-box { width: 100%; max-width: 900px; padding: 10px; }
          video { width: 100%; max-height: 80vh; border-radius: 12px; background: #111; outline: none; }
          .title { margin-top: 15px; font-size: 1.1rem; color: #00ff88; word-break: break-all; }
        </style>
      </head>
      <body>
        <div class="player-box">
          <video controls autoplay playsinline preload="metadata">
            <source src="${streamUrl}" type="video/mp4">
          </video>
          <div class="title">🎬 ${videoTitle}</div>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Player error: ' + err.message);
  }
});

// Range Stream Route
app.get('/stream/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let data = linkStore.get(id);

    if (!data) {
      const raw = await redis.get(`video:${id}`);
      if (raw) data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    }

    if (!data || !data.r2Key) return res.status(404).send('Stream not found');

    const range = req.headers.range;
    const command = new GetObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: data.r2Key,
      Range: range || undefined,
    });

    const response = await r2Client.send(command);

    res.status(range ? 206 : 200);
    res.setHeader('Content-Type', response.ContentType || 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    if (response.ContentRange) res.setHeader('Content-Range', response.ContentRange);
    if (response.ContentLength) res.setHeader('Content-Length', response.ContentLength);

    return response.Body.pipe(res);
  } catch (err) {
    if (!res.headersSent) res.status(500).send('Streaming error');
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
require('dotenv').config();

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const path = require('path');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

process.on('uncaughtException', (err) => console.error('[UncaughtException]:', err.message));
process.on('unhandledRejection', (reason) => console.error('[UnhandledRejection]:', reason));

let redis;
try {
  redis = Redis.fromEnv();
} catch (e) {
  redis = { get: async () => null, set: async () => null };
}

const linkStore = new Map();
const TOKEN = (process.env.BOT_TOKEN || '').trim();
const BASE_URL = process.env.CUSTOM_DOMAIN 
  ? (process.env.CUSTOM_DOMAIN.startsWith('http') ? process.env.CUSTOM_DOMAIN : `https://${process.env.CUSTOM_DOMAIN}`)
  : 'https://mayajaal.online';

const R2_ACCOUNT_ID = String(process.env.R2_ACCOUNT_ID || '9a17e6f8a4af372b6b0ab1ad1cdb982d').trim();
const R2_ACCESS_KEY_ID = String(process.env.R2_ACCESS_KEY_ID || 'fe0370e7a3f380c0dee831d6c37fd851').trim();
const R2_SECRET_ACCESS_KEY = String(process.env.R2_SECRET_ACCESS_KEY || '').trim();
const R2_BUCKET_NAME = String(process.env.R2_BUCKET_NAME || '').trim();

const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

console.log('✅ Cloudflare R2 Initialized');

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

app.get('/', (req, res) => res.send('Stream Engine Online - Stable Build'));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// 2GB Web Ingestion Page (Telegram 20MB limit bypass portal)
app.get('/upload', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="hi">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>MayaJaal 2GB Fast Video Uploader</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #090a0f; color: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 15px; }
        .upload-card { width: 100%; max-width: 480px; background: #12141d; border: 1px solid #1e2230; border-radius: 16px; padding: 24px; box-shadow: 0 10px 40px rgba(0,0,0,0.8); text-align: center; }
        h2 { color: #00ff88; margin-bottom: 8px; }
        p { color: #8f9bb3; font-size: 0.95rem; margin-bottom: 20px; }
        .file-box { border: 2px dashed #2b334a; border-radius: 12px; padding: 30px 15px; cursor: pointer; transition: 0.3s; margin-bottom: 20px; display: block; }
        .file-box:hover { border-color: #00ff88; }
        input[type="file"] { display: none; }
        .upload-btn { width: 100%; background: #00ff88; color: #000; font-weight: bold; border: none; padding: 14px; border-radius: 10px; font-size: 1rem; cursor: pointer; }
        .progress-bar-wrap { width: 100%; height: 10px; background: #1e2230; border-radius: 5px; margin-top: 15px; overflow: hidden; display: none; }
        .progress-fill { width: 0%; height: 100%; background: #00ff88; transition: width 0.2s; }
        .result-box { margin-top: 20px; padding: 15px; background: #181c28; border-radius: 10px; display: none; word-break: break-all; }
        .link-text { color: #00ff88; font-weight: bold; text-decoration: none; display: block; margin-top: 8px; }
      </style>
    </head>
    <body>
      <div class="upload-card">
        <h2>⚡ MayaJaal Fast Uploader</h2>
        <p>Bina 20MB limit ke 2GB tak ki video yahan se upload karein.</p>
        <label class="file-box" for="fileInput" id="dropLabel">
          📁 <span id="fileNameDisplay">Video file select karein (Max 2GB)</span>
        </label>
        <input type="file" id="fileInput" accept="video/*">
        <button class="upload-btn" id="uploadBtn" onclick="startUpload()">Cloudflare R2 Par Upload Karein</button>
        <div class="progress-bar-wrap" id="progWrap">
          <div class="progress-fill" id="progFill"></div>
        </div>
        <div class="result-box" id="resultBox">
          <span>✅ Video Ready! Stream Link:</span>
          <a class="link-text" id="finalLink" href="#" target="_blank"></a>
        </div>
      </div>

      <script>
        const fileInput = document.getElementById('fileInput');
        const fileNameDisplay = document.getElementById('fileNameDisplay');
        const progWrap = document.getElementById('progWrap');
        const progFill = document.getElementById('progFill');
        const resultBox = document.getElementById('resultBox');
        const finalLink = document.getElementById('finalLink');
        const uploadBtn = document.getElementById('uploadBtn');

        fileInput.addEventListener('change', () => {
          if (fileInput.files[0]) {
            fileNameDisplay.innerText = fileInput.files[0].name + ' (' + (fileInput.files[0].size / (1024*1024)).toFixed(1) + ' MB)';
          }
        });

        async function startUpload() {
          const file = fileInput.files[0];
          if (!file) return alert('Kripya pehle video file select karein');

          uploadBtn.disabled = true;
          uploadBtn.innerText = 'Uploading to Cloudflare R2...';
          progWrap.style.display = 'block';
          resultBox.style.display = 'none';

          const xhr = new XMLHttpRequest();
          xhr.open('POST', '/api/upload-direct');

          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              const percent = Math.round((e.loaded / e.total) * 100);
              progFill.style.width = percent + '%';
            }
          };

          xhr.onload = () => {
            uploadBtn.disabled = false;
            uploadBtn.innerText = 'Cloudflare R2 Par Upload Karein';
            if (xhr.status === 200) {
              const res = JSON.parse(xhr.responseText);
              resultBox.style.display = 'block';
              finalLink.href = res.playUrl;
              finalLink.innerText = res.playUrl;
            } else {
              alert('Upload fail: ' + xhr.responseText);
            }
          };

          xhr.onerror = () => {
            uploadBtn.disabled = false;
            uploadBtn.innerText = 'Cloudflare R2 Par Upload Karein';
            alert('Upload connection fail hui');
          };

          xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
          xhr.setRequestHeader('Content-Type', file.type || 'video/mp4');
          xhr.send(file);
        }
      </script>
    </body>
    </html>
  `);
});

// Direct Stream Ingestion API
app.post('/api/upload-direct', async (req, res) => {
  try {
    const rawName = decodeURIComponent(req.headers['x-file-name'] || `video_${Date.now()}.mp4`);
    const fileExt = path.extname(rawName) || '.mp4';
    const r2Key = `web_uploads/${crypto.randomBytes(8).toString('hex')}${fileExt}`;

    const parallelUpload = new Upload({
      client: r2Client,
      params: {
        Bucket: R2_BUCKET_NAME,
        Key: r2Key,
        Body: req,
        ContentType: req.headers['content-type'] || 'video/mp4',
      },
      queueSize: 4,
      partSize: 1024 * 1024 * 10,
    });

    await parallelUpload.done();

    const shortId = crypto.randomBytes(4).toString('hex');
    const payload = { name: rawName, r2Key: r2Key };

    linkStore.set(shortId, payload);
    await redis.set(`video:${shortId}`, JSON.stringify(payload), { ex: 30 * 86400 });

    const playUrl = `${BASE_URL}/v/${shortId}`;
    return res.json({ success: true, playUrl });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// HTML5 Range Video Player
app.get('/v/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let data = linkStore.get(id);

    if (!data) {
      const raw = await redis.get(`video:${id}`);
      if (raw) data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    }

    if (!data || !data.r2Key) {
      return res.status(404).send('Video not found or processing on Cloudflare R2');
    }

    const streamUrl = `${BASE_URL}/stream/${id}`;
    const videoTitle = data.name || 'Video Player';

    res.send(`
      <!DOCTYPE html>
      <html lang="hi">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${videoTitle}</title>
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body { background: #000; color: #fff; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; padding: 12px; }
          .player-box { width: 100%; max-width: 900px; padding: 10px; }
          video { width: 100%; max-height: 80vh; border-radius: 12px; background: #111; outline: none; }
          .title { margin-top: 15px; font-size: 1.1rem; color: #00ff88; word-break: break-all; }
        </style>
      </head>
      <body>
        <div class="player-box">
          <video controls autoplay playsinline preload="metadata">
            <source src="${streamUrl}" type="video/mp4">
          </video>
          <div class="title">🎬 ${videoTitle}</div>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Player error: ' + err.message);
  }
});

// Range Stream Route
app.get('/stream/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let data = linkStore.get(id);

    if (!data) {
      const raw = await redis.get(`video:${id}`);
      if (raw) data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    }

    if (!data || !data.r2Key) return res.status(404).send('Stream not found');

    const range = req.headers.range;
    const command = new GetObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: data.r2Key,
      Range: range || undefined,
    });

    const response = await r2Client.send(command);

    res.status(range ? 206 : 200);
    res.setHeader('Content-Type', response.ContentType || 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    if (response.ContentRange) res.setHeader('Content-Range', response.ContentRange);
    if (response.ContentLength) res.setHeader('Content-Length', response.ContentLength);

    return response.Body.pipe(res);
  } catch (err) {
    if (!res.headersSent) res.status(500).send('Streaming error');
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
