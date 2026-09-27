const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// 1. Express Server (Render port binding ke liye)
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('MayaJaal Bot is running and alive!');
});

app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});

// 2. Telegram Bot Configuration & Initialization
const TOKEN = '8697090840:AAEqN02nnWDOeajoR5DEm2EZtR9twopwojI';
const BACKEND_URL = 'https://mayajaal-backend-git-main-ajayr0201-9102.vercel.app';
const STORAGE_CHANNEL = '@maya_jaal1';

const bot = new TelegramBot(TOKEN, { polling: true });

// 3. /start Command Handling (Branded Welcome Message)
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id.toString();
  const firstName = msg.from.first_name || 'User';

  try {
    await axios.get(`${BACKEND_URL}/?id=${telegramId}&name=${encodeURIComponent(firstName)}`);
    
    const welcomeText = `🎬 **Welcome to MayaJaal, ${firstName}!**\n\n` +
      `⚡ Your personal high-speed streaming portal is now successfully linked.\n\n` +
      `📂 **How to use:**\n` +
      `Simply send any Video, Movie, or Document here, and MayaJaal will instantly generate a direct streaming link for your app!`;

    bot.sendMessage(chatId, welcomeText, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error(error);
    bot.sendMessage(chatId, "⚠️ MayaJaal server connection error. Please try again later.");
  }
});

// 4. File, Video, Photo Message Handling & Clickable Link Generation
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

  if (msg.text && msg.text.startsWith('/start')) {
    return;
  }

  const file = msg.video || msg.document || msg.audio || msg.photo;

  if (file) {
    try {
      const fileName = file.file_name || msg.caption || 'MayaJaal_Media_File';

      // Send a processing notice
      const processingMsg = await bot.sendMessage(chatId, "🔄 *Processing your media through MayaJaal core...*", { parse_mode: 'Markdown' });

      // Forward file to private storage channel
      const forwardedMsg = await bot.forwardMessage(STORAGE_CHANNEL, chatId, msg.message_id);
      const fileMessageId = forwardedMsg.message_id;

      // Generate App Deep Link / Stream Link
      const accessLink = `${BACKEND_URL}/stream?msgId=${fileMessageId}`;

      // Delete processing notice and send final clickable link success box
      await bot.deleteMessage(chatId, processingMsg.message_id);

      const successText = `✨ **MayaJaal Media Link Generated!** ✨\n\n` +
        `📌 **File:** ${fileName}\n\n` +
        `🔗 **Stream Link:**\n${accessLink}\n\n` +
        `💡 *Click the link above to stream directly inside your MayaJaal app!*`;

      bot.sendMessage(chatId, successText, { parse_mode: 'Markdown' });

    } catch (error) {
      console.error("File forwarding error:", error);
      bot.sendMessage(chatId, "❌ Failed to process media. Please ensure the bot is an Admin in your storage channel.");
    }
  }
});

console.log("MayaJaal Telegram Bot chal pada hai...");
