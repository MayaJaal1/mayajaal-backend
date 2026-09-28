require('dotenv').config();

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────
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

// B2 (S3-compatible) client
const s3 = new S3Client({
  region: B2_REGION,
  endpoint: `https://${B2_ENDPOINT}`,
  credentials: {
    accessKeyId: B2_KEY_ID,
    secretAccessKey: B2_APP_KEY,
  },
});

const bot = new TelegramBot(TOKEN, { polling: true });

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('MayaJaal Bot is alive!'));
app.listen(PORT, () => console.log(`Server is listening on port ${PORT}`));

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
// /start
// ─────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from.first_name || 'User';

  const welcomeText =
    `🎬 <b>Welcome to MayaJaal, ${escapeHtml(firstName)}!</b>\n\n` +
    `⚡ Send any Video, Movie, or Document — I'll give you a streaming link.\n\n` +
    `⏰ <i>Links valid for 24 hours only.</i>`;

  bot.sendMessage(chatId, welcomeText, { parse_mode: 'HTML' });
});

// ─────────────────────────────────────────────
// Media handler
// ─────────────────────────────────────────────
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

    // 1. Telegram se file URL lo
    const fileInfo = await bot.getFile(file.file_id);
    const tgFileUrl = `https://api.telegram.org/file/bot${TOKEN}/${fileInfo.file_path}`;

    // 2. File download (stream)
    const fileResponse = await axios.get(tgFileUrl, {
      responseType: 'stream',
      timeout: 120000,
    });

    // 3. B2 pe upload karo
    const uniqueKey = `videos/${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${fileName}`;

    await s3.send(new PutObjectCommand({
      Bucket: B2_BUCKET,
      Key: uniqueKey,
      Body: fileResponse.data,
      ContentType: file.mime_type || 'video/mp4',
    }));

    // 4. Signed URL banao (24 hours = 86400 seconds)
    const signedUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: B2_BUCKET, Key: uniqueKey }),
      { expiresIn: 86400 }
    );

    // 5. Processing message delete karo
    await bot.deleteMessage(chatId, processingMsg.message_id).catch(() => {});
    processingMsg = null;

    // 6. Success message
    const successText =
      `✨ <b>MayaJaal Media Link Generated!</b> ✨\n\n` +
      `📌 <b>File:</b> ${escapeHtml(fileName)}\n\n` +
      `🔗 <b>Stream Link:</b>\n${signedUrl}\n\n` +
      `⏰ <i>Valid for 24 hours.</i>`;

    await bot.sendMessage(chatId, successText, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

  } catch (error) {
    console.error('Upload error:', error.message);

    if (processingMsg) {
      await bot.deleteMessage(chatId, processingMsg.message_id).catch(() => {});
    }

    bot.sendMessage(chatId, '❌ Failed to upload media. Please try again.').catch(() => {});
  }
});

// ─────────────────────────────────────────────
// Error handlers
// ─────────────────────────────────────────────
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err.message));

console.log('🚀 MayaJaal Bot chal pada hai...');
