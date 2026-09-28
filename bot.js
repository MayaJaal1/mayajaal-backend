require('dotenv').config();

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// ─────────────────────────────────────────────
// 1. Express Server (Railway/Render port binding)
// ─────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('MayaJaal Bot is running and alive!');
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});

// ─────────────────────────────────────────────
// 2. Config (ENV se — hardcode nahi)
// ─────────────────────────────────────────────
const TOKEN = process.env.BOT_TOKEN;
const BACKEND_URL = process.env.BACKEND_URL || 'https://mayajaal-backend-git-main-ajayr0201-9102.vercel.app';
const STORAGE_CHANNEL = process.env.STORAGE_CHANNEL || '@maya_jaal1';

if (!TOKEN) {
  console.error('❌ BOT_TOKEN environment variable is missing!');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

// ─────────────────────────────────────────────
// 3. Helpers
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
// 4. /start Command
// ─────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from.id);
  const firstName = msg.from.first_name || 'User';

  try {
    await axios.get(`${BACKEND_URL}/?id=${telegramId}&name=${encodeURIComponent(firstName)}`, {
      timeout: 10000,
    });

    const welcomeText =
      `🎬 <b>Welcome to MayaJaal, ${escapeHtml(firstName)}!</b>\n\n` +
      `⚡ Your personal high-speed streaming portal is now successfully linked.\n\n` +
      `📂 <b>How to use:</b>\n` +
      `Simply send any Video, Movie, or Document here, and MayaJaal will instantly generate a direct streaming link for your app!`;

    bot.sendMessage(chatId, welcomeText, { parse_mode: 'HTML' });
  } catch (error) {
    console.error('Start error:', error.message);
    bot.sendMessage(chatId, '⚠️ MayaJaal server connection error. Please try again later.');
  }
});

// ─────────────────────────────────────────────
// 5. Media Handler
// ─────────────────────────────────────────────
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

  // /start alag se handle hota hai
  if (msg.text && msg.text.startsWith('/start')) return;

  const file = pickFile(msg);
  if (!file) return;

  let processingMsg = null;

  try {
    const rawName = file.file_name || msg.caption || 'MayaJaal_Media_File';
    const fileName = rawName.length > 60 ? rawName.slice(0, 59) + '…' : rawName;

    // Processing notice
    processingMsg = await bot.sendMessage(
      chatId,
      '🔄 <i>Processing your media through MayaJaal core...</i>',
      { parse_mode: 'HTML' }
    );

    // Forward file to private storage channel
    const forwardedMsg = await bot.forwardMessage(STORAGE_CHANNEL, chatId, msg.message_id);
    const fileMessageId = forwardedMsg.message_id;

    // Stream link
    const accessLink = `${BACKEND_URL}/stream?msgId=${fileMessageId}`;

    // Delete processing message
    await bot.deleteMessage(chatId, processingMsg.message_id).catch(() => {});
    processingMsg = null;

    const successText =
      `✨ <b>MayaJaal Media Link Generated!</b> ✨\n\n` +
      `📌 <b>File:</b> ${escapeHtml(fileName)}\n\n` +
      `🔗 <b>Stream Link:</b>\n${accessLink}\n\n` +
      `💡 <i>Click the link above to stream directly inside your MayaJaal app!</i>`;

    await bot.sendMessage(chatId, successText, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

  } catch (error) {
    console.error('File processing error:', error.message);

    if (processingMsg) {
      await bot.deleteMessage(chatId, processingMsg.message_id).catch(() => {});
    }

    bot.sendMessage(
      chatId,
      '❌ Failed to process media. Please ensure the bot is Admin in the storage channel and the MayaJaal backend is running.'
    ).catch(() => {});
  }
});

// ─────────────────────────────────────────────
// 6. Error Handlers
// ─────────────────────────────────────────────
bot.on('polling_error', (err) => {
  console.error('[polling_error]', err.code, err.message);
});

bot.on('webhook_error', (err) => {
  console.error('[webhook_error]', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message);
});

// ─────────────────────────────────────────────
// 7. Graceful Shutdown
// ─────────────────────────────────────────────
function shutdown(signal) {
  console.log(`\n${signal} received. Shutting down...`);
  bot.stopPolling().catch(() => {});
  setTimeout(() => process.exit(0), 2000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

console.log('🚀 MayaJaal Telegram Bot chal pada hai...');
