const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// Aapka Telegram Bot Token
const TOKEN = '8697090840:AAHuAlkm2mmbHx_pCtu9ZDy5kfpVtvVQ8ZA';

// Aapka Vercel backend URL
const BACKEND_URL = 'https://mayajaal-backend-git-main-ajayr0201-9102.vercel.app';

// Aapka Private Telegram Channel jahan files store hongi
const STORAGE_CHANNEL = '@maya_jaal1';

const bot = new TelegramBot(TOKEN, { polling: true });

// 1. Jab koi user /start likhega
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id.toString();
  const firstName = msg.from.first_name || 'User';

  try {
    const response = await axios.get(`${BACKEND_URL}/?id=${telegramId}&name=${encodeURIComponent(firstName)}`);
    
    bot.sendMessage(chatId, `Namaste ${firstName}! MayaJaal me aapka swagat hai.\n\nAapka account successfully connect ho gaya hai!\n\nDetails: ${JSON.stringify(response.data)}`);
  } catch (error) {
    console.error(error);
    bot.sendMessage(chatId, "Backend se connect karne me kuch samasya aayi hai. Kripya thodi der baad koshish karein.");
  }
});

// 2. Jab koi user koi bhi File, Video, Photo ya Audio bhejega
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

  // Agar user ne /start bheja hai toh use yahan dobara process mat karo (wo upar handle ho raha hai)
  if (msg.text && msg.text.startsWith('/start')) {
    return;
  }

  // Check karo ki message mein koi media file hai ya nahi
  const file = msg.video || msg.document || msg.audio || msg.photo;

  if (file) {
    try {
      // Photo ke case mein arrays hote hain, sabse badi quality wali photo uthate hain
      const fileId = Array.isArray(file) ? file[file.length - 1].file_id : file.file_id;
      const fileName = file.file_name || msg.caption || 'MayaJaal_Media_File';

      // File ko aapke private storage channel par forward karo
      const forwardedMsg = await bot.forwardMessage(STORAGE_CHANNEL, chatId, msg.message_id);

      // Backend ko bhej do taki database ya streaming link generate ho sake
      // (Aap chahe toh yahan backend par POST request bhi laga sakte hain)
      
      // User ko clean link/success message bhejo
      bot.sendMessage(chatId, `✅ File successfully upload ho gayi hai!\n\n📁 **File Name:** ${fileName}\n🔗 **Storage Channel:** ${STORAGE_CHANNEL}\n\nYeh lijiye aapka access/streaming link taiyar hai!`);
    } catch (error) {
      console.error("File forwarding error:", error);
      bot.sendMessage(chatId, "File upload karne mein kuch samasya aayi. Kripya dobara koshish karein.");
    }
  }
});

console.log("MayaJaal Telegram Bot chal pada hai aur messages & files sun raha hai...");
