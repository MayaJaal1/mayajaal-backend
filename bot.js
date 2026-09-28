require('dotenv').config();

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');

// 1. Express Server
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('MayaJaal Bot is running and alive!');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});

// 2. Config
const TOKEN = process.env.BOT_TOKEN;
const B2_KEY_ID = process.env.B2_KEY_ID;
const B2_APP_KEY = process.env.B2_APP_KEY;
const B2_BUCKET = process.env.B2_BUCKET;
const B2_ENDPOINT = process.env.B2_ENDPOINT || 's3.us-east-005.backblazeb2.com';
const B2_REGION = process.env.B2_REGION || 'us-east-005';

if (!TOKEN || !B2_KEY_ID || !B2_APP_KEY || !B2_BUCKET) {
  console.error('❌ Missing env variables!');
  process.exit(1);
}

// 3. B2 Client
const s3 = new S3Client({
  region: B2_REGION,
  endpoint: `https://${B2_ENDPOINT}`,
  credentials: {
    accessKeyId: B2_KEY_ID,
    secretAccessKey: B2_APP_KEY,
  },
});

// 4. Bot
const bot = new TelegramBot(TOKEN, { polling: true });

// 5. Helpers
function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function pickFile(msg) {
  if (msg.video) return msg.video;
  if (msg.document) return msg.document;
  if (msg.audio) return msg.audio;
  if (Array.isArray(msg.photo) && msg.photo.length) return msg.photo[msg.photo.length - 1];
  return null;
}

// 6. URL Shortener — Multi-provider fallback
async function shortenUrl(longUrl) {
  // Provider 1: TinyURL
  try {
    const res = await axios.get('https://tinyurl.com/api-create.php', {
      params: { url: longUrl },
      timeout: 8000,
    });
    const s = String(res.data).trim();
    if (s.startsWith('http') && s.length < longUrl.length) {
      console.log('✅ Shortened via TinyURL:', s);
      return s;
    }
  } catch (e) {
    console.error('TinyURL failed:', e.message);
  }

  // Provider 2: is.gd
  try {
    const res = await axios.get('https://is.gd/create.php', {
      params: { format: 'simple', url: longUrl },
      timeout: 8000,
    });
    const s = String(res.data).trim();
    if (s.startsWith('http') && s.length < longUrl.length) {
      console.log('✅ Shortened via is.gd:', s);
      return s;
    }
  } catch (e) {
    console.error('is.gd failed:', e.message);
  }

  // Provider 3: v.gd
  try {
    const res = await axios.get('https://v.gd/create.php', {
      params: { format: 'simple', url: longUrl },
      timeout: 8000,
    });
    const s = String(res.data).trim();
    if (s.startsWith('http') && s.length < longUrl.length) {
      console.log('✅ Shortened via v.gd:', s);
      return s;
    }
  } catch (e) {
    console.error('v.gd failed:', e.message);
  }

  // Provider 4: clck.ru
  try {
    const res = await axios.get('https://clck.ru/--', {
      params: { url: longUrl },
      timeout: 8000,
    });
    const s = String(res.data).trim();
    if (s.startsWith('http') && s.length < longUrl.length) {
      console.log('✅ Shortened via clck.ru:', s);
      return s;
    }
  } catch (e) {
    console.error('clck.ru failed:', e.message);
  }

  // Sab fail — original bhej do
  console.error('❌ All shorteners failed, using original URL');
  return longUrl;
}

// 7. /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from.first_name || 'User';

  const welcomeText =
    `🎬 <b>Welcome to MayaJaal, ${escapeHtml(firstName)}!</b>\n\n` +
    `⚡ Send any Video, Movie, or Document — I'll give you a streaming link.\n\n` +
    `📂 <b>How to use:</b>\n` +
    `Just send any media file here, and I'll upload it and give you a direct link.\n\n` +
    `⏰ <i>Note: Links valid for 24 hours only.</i>`;

  bot.sendMessage(chatId, welcomeText, { parse_mode: 'HTML' });
});

// 8. Media Handler
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  if (msg.text && msg.text.startsWith('/start')) return;

  const file = pickFile(msg);
  if (!file) return;

  let processingMsg = null;

  try {
    const rawName = file.file_name || msg.caption || `video_${Date.now()}.mp4`;
    const fileName = rawName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);

    processingMsg = await bot.sendMessage(
      chatId,
      '🔄 <i>Uploading to cloud, please wait...</i>',
      { parse_mode: 'HTML' }
    );

    const fileInfo = await bot.getFile(file.file_id);
    const tgFileUrl = `https://api.telegram.org/file/bot${TOKEN}/${fileInfo.file_path}`;

    const fileResponse = await axios.get(tgFileUrl, {
      responseType: 'arraybuffer',
      timeout: 120000,
      maxContentLength: 100 * 1024 * 1024,
      maxBodyLength: 100 * 1024 * 1024,
    });

    const fileBuffer = Buffer.from(fileResponse.data);
    const uniqueKey = `videos/${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${fileName}`;

    await s3.send(new PutObjectCommand({
      Bucket: B2_BUCKET,
      Key: uniqueKey,
      Body: fileBuffer,
      ContentType: file.mime_type || 'video/mp4',
      ContentLength: fileBuffer.byteLength,
    }));

    const signedUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: B2_BUCKET, Key: uniqueKey }),
      { expiresIn: 86400 }
    );

    const shortUrl = await shortenUrl(signedUrl);

    if (processingMsg) {
      await bot.deleteMessage(chatId, processingMsg.message_id).catch(() => {});
      processingMsg = null;
    }

    const successText =
      `✨ <b>MayaJaal Media Link Generated!</b> ✨\n\n` +
      `📌 <b>File:</b> ${escapeHtml(fileName)}\n\n` +
      `🔗 <b>Stream Link:</b>\n${shortUrl}\n\n` +
      `⏰ <i>Valid for 24 hours. File will be auto-deleted after that.</i>`;

    await bot.sendMessage(chatId, successText, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

  } catch (error) {
    console.error('Upload error:', error.message);

    if (processingMsg) {
      await bot.deleteMessage(chatId, processingMsg.message_id).catch(() => {});
    }

    bot.sendMessage(
      chatId,
      '❌ Failed to upload media. Please try again later.'
    ).catch(() => {});
  }
});

// 9. Errors
bot.on('polling_error', (error) => {
  console.log('Polling error:', error.code, error.message);
});

bot.on('error', (error) => {
  console.log('General bot error:', error.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message);
});

console.log('🚀 MayaJaal Telegram Bot chal pada hai...');
