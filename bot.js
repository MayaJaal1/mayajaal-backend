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

console.log('=== ENV ===');
console.log('BOT_TOKEN:', !!TOKEN, '| API_ID:', !!API_ID, '| API_HASH:', !!API_HASH);
console.log('R2:', !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET_NAME));

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
  const html = pageResp.data;
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

const app = express();
app.use(express.json());
app.get('/', (req, res) => res.send('MayaJaal Online'));
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime(), gramjs: true }));

app.get('/v/:id', async (req, res) => {
  try {
    const meta = await getMeta(req.params.id);
    if (!meta) return res.status(404).send('Not found');
    const streamUrl = `${BASE_URL}/stream/${req.params.id}`;
    const title = escapeHtml(meta.name || 'Video');
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><link rel="stylesheet" href="https://cdn.plyr.io/3.7.8/plyr.css"><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0a;color:#fff;font-family:sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:12px}.box{width:100%;max-width:960px}video{width:100%;max-height:80vh;border-radius:14px;background:#000}.t{margin-top:14px;font-size:1rem;color:#00ff88;word-break:break-all}</style></head><body><div class="box"><video id="p" controls autoplay playsinline preload="metadata"><source src="${streamUrl}" type="${meta.mime || 'video/mp4'}"></video><div class="t">🎬 ${title}</div></div><script src="https://cdn.plyr.io/3.7.8/plyr.polyfilled.js"></script><script>new Plyr('#p');</script></body></html>`);
  } catch (e) { res.status(500).send('err'); }
});

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
        message: `🎬 <b>MayaJaal Stream Bot</b>\n\n📤 File bhejo (2GB tak) ya Terabox link paste karo\n\n⚡ Player link milega!`,
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
        await client.deleteMessages(chatId, [status.id], { revoke: true }).catch(() => {});
        await client.sendMessage(chatId, {
          message: `✅ <b>Ready!</b>\n\n📌 <b>${escapeHtml(info.fileName)}</b>\n📦 ${(info.size / 1024 / 1024).toFixed(2)} MB\n\n▶️ ${playUrl}`,
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

    console.log('[File] className:', fileMedia.className, '| hasId:', !!fileMedia.id, '| hasHash:', !!fileMedia.accessHash, '| hasRef:', !!fileMedia.fileReference);

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

      const stream = Readable.from((async function* () {
        for await (const chunk of client.iterDownload({ file: fileLocation, requestSize: 1024 * 1024 })) {
          yield Buffer.from(chunk);
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
      await client.deleteMessages(chatId, [status.id], { revoke: true }).catch(() => {});
      await client.sendMessage(chatId, {
        message: `✅ <b>Ready!</b>\n\n📌 <b>${escapeHtml(fileName)}</b>\n📦 ${(size / 1024 / 1024).toFixed(2)} MB\n\n▶️ ${playUrl}`,
        parseMode: 'html',
      });
    } catch (e) {
      console.error('[Error]', e.stack || e.message);
      if (status) await client.deleteMessages(chatId, [status.id], { revoke: true }).catch(() => {});
      await client.sendMessage(chatId, { message: `❌ ${escapeHtml(e.message)}`, parseMode: 'html' });
    }
  }, new NewMessage({}));

  console.log('Handlers ready');
})();
