const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// Express server taaki Render port timeout error na de
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('MayaJaal Bot is running and alive!');
});

app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});

// Telegram Bot Details
const TOKEN = '8697090840:AAHuAlkm2mmbHx_pCtu9ZDy5kfpVtvVQ8ZA';
const BACKEND_URL = 'https://mayajaal-backend-git-main-ajayr0201-9102.vercel.app';
const STORAGE_CHANNEL = '@maya_jaal1';

const bot = new TelegramBot(TOKEN, { polling: true });

// 1. /start command handle karne ke liye
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id.toString();
  const firstName = msg.from.first_name || 'User';

  try {
    const response = await axios.get(`${BACKEND_URL}/?id=${telegramId}&name=${encodeURIComponent(firstName)}`);
    bot.sendMessage(chatId, `Namaste ${firstName}! MayaJaal me aapka swagat hai.\n\nAapka account successfully connect ho gaya hai!`);
  } catch (error) {
    console.error(error);
    bot.sendMessage(chatId, "Backend se connect karne me kuch samasya aayi hai.");
  }
});

// 2. Files, Videos, ya Photos receive karne ke liye
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

  if (msg.text && msg.text.startsWith('/start')) {
    return;
  }

  const file = msg.video || msg.document || msg.audio || msg.photo;

  if (file) {
    try {
      const fileName = file.file_name || msg.caption || 'MayaJaal_Media_File';

      // File ko private channel par forward karo
      await bot.forwardMessage(STORAGE_CHANNEL, chatId, msg.message_id);

      // User ko success message aur link do
      bot.sendMessage(chatId, `✅ File successfully upload ho gayi hai!\n\n📁 **File Name:** ${fileName}\n🔗 **Storage Channel:** ${STORAGE_CHANNEL}\n\nAapka link taiyar hai!`);
    } catch (error) {
      console.error("File forwarding error:", error);
      bot.sendMessage(chatId, "File upload karne mein kuch samasya aayi. Kripya dobara koshish karein.");
    }
  }
});

console.log("MayaJaal Telegram Bot chal pada hai...");
