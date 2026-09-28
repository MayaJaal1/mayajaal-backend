const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// Express Server
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('MayaJaal Bot is running and alive!');
});

app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});

// Telegram Bot Configuration
const TOKEN = process.env.BOT_TOKEN;
const BACKEND_URL =
  process.env.BACKEND_URL ||
  'https://mayajaal-backend.vercel.app';

const STORAGE_CHANNEL = '@maya_jaal1';

if (!TOKEN) {
  console.error('BOT_TOKEN environment variable is missing!');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

// /start Command
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from.first_name || 'User';

  try {
    await axios.get(
      `${BACKEND_URL}/?id=${msg.from.id}&name=${encodeURIComponent(firstName)}`
    );

    const welcomeText =
      `🎬 **Welcome to MayaJaal, ${firstName}!**\n\n` +
      `⚡ Your personal high-speed streaming portal is now successfully linked.\n\n` +
      `📂 **How to use:**\n` +
      `Simply send any Video, Movie, or Document here, and MayaJaal will instantly generate a clickable streaming link!`;

    await bot.sendMessage(chatId, welcomeText, {
      parse_mode: 'Markdown'
    });

  } catch (error) {
    console.error('Start error:', error.message);

    await bot.sendMessage(
      chatId,
      '⚠️ MayaJaal server connection error. Please try again later.'
    );
  }
});

// File Message Handling
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

  if (msg.text && msg.text.startsWith('/start')) {
    return;
  }

  const file =
    msg.video ||
    msg.document ||
    msg.audio ||
    (msg.photo && msg.photo[msg.photo.length - 1]);

  if (!file) {
    return;
  }

  try {
    const fileName =
      file.file_name ||
      msg.caption ||
      'MayaJaal_Media_File';

    // Processing message
    const processingMsg = await bot.sendMessage(
      chatId,
      '🔄 *Processing your media through MayaJaal core...*',
      { parse_mode: 'Markdown' }
    );

    // IMPORTANT:
    // Save the ORIGINAL Telegram file_id
    const originalFileId = file.file_id;

    // Forward file to storage channel
    const forwardedMsg = await bot.forwardMessage(
      STORAGE_CHANNEL,
      chatId,
      msg.message_id
    );

    const fileMessageId = forwardedMsg.message_id;

    // Save message ID -> file ID in backend Redis
    await axios.post(`${BACKEND_URL}/save`, {
      msgId: fileMessageId,
      fileId: originalFileId
    });

    // ✅ fileId ke saath link banao
    const accessLink =
      `${BACKEND_URL}/maya/${fileMessageId}?fileId=${originalFileId}`;

    // Delete processing message
    await bot.deleteMessage(
      chatId,
      processingMsg.message_id
    );

    const successText =
      `✨ **MayaJaal Media Link Generated!** ✨\n\n` +
      `📌 **File:** ${fileName}\n\n` +
      `🔗 **Stream Link:**\n${accessLink}\n\n` +
      `💡 *Click the link above to stream directly!*`;

    await bot.sendMessage(chatId, successText, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });

  } catch (error) {
    console.error('File processing error:', error.response?.data || error.message);

    await bot.sendMessage(
      chatId,
      '❌ Failed to process media. Please ensure the bot is Admin in the storage channel and the MayaJaal backend is running.'
    );
  }
});

// Error Handlers
bot.on('polling_error', (error) => {
  console.log('Polling error:', error.code);
});

bot.on('error', (error) => {
  console.log('General bot error:', error.message);
});

console.log('MayaJaal Telegram Bot chal pada hai...');
