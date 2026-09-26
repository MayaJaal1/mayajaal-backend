const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// Aapka Telegram Bot Token
const TOKEN = '8697090840:AAHuAlkm2mmbHx_pCtu9ZDy5kfpVtvVQ8ZA';

// Yahan apna Vercel wala live URL daal dein (jaise https://mayajaal-backend.vercel.app)
const BACKEND_URL = 'APNA_VERCEL_BACKEND_URL_YAHAN_DAALEIN';

const bot = new TelegramBot(TOKEN, { polling: true });

// Jab koi user /start likhega
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id.toString();
  const firstName = msg.from.first_name || 'User';

  try {
    // Vercel backend ko request bhejna user ki details ke liye
    const response = await axios.get(`${BACKEND_URL}/?id=${telegramId}&name=${encodeURIComponent(firstName)}`);
    
    bot.sendMessage(chatId, `Namaste ${firstName}! MayaJaal me aapka swagat hai.\n\nAapka account successfully connect ho gaya hai!\n\nDetails: ${JSON.stringify(response.data)}`);
  } catch (error) {
    console.error(error);
    bot.sendMessage(chatId, "Backend se connect karne me kuch samasya aayi hai. Kripya thodi der baad koshish karein.");
  }
});

console.log("MayaJaal Telegram Bot chal pada hai aur messages sun raha hai...");
