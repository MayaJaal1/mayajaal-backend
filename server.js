const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { Redis } = require('@upstash/redis');

// ========== EXPRESS SERVER ==========
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.BOT_TOKEN;

if (!TOKEN) {
  console.error('BOT_TOKEN environment variable is missing!');
  process.exit(1);
}

// Auto-detect Railway public URL
const BACKEND_URL =
  process.env.BACKEND_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `http://localhost:${PORT}`);

console.log(`Backend URL: ${BACKEND_URL}`);

// Redis (agar aapke paas Upstash Redis hai)
let redis = null;
try {
  redis = Redis.fromEnv();
  console.log('Redis connected');
} catch (e) {
  console.warn('Redis not configured, using in-memory fallback');
}

// In-memory fallback (agar Redis nahi hai)
const memoryStore = new Map();

// Health check
app.get('/', (req, res) => {
  res.send('MayaJaal Backend is running!');
});

// Save mapping: message ID -> file ID
app.post('/save', async (req, res) => {
  try {
    const { msgId, fileId } = req.body;
    if (!msgId || !fileId) {
      return res.status(400).json({ error: 'msgId and fileId required' });
    }

    if (redis) {
      await redis.set(`file:${msgId}`, fileId);
    } else {
      memoryStore.set(`file:${msgId}`, fileId);
    }

    res.json({ success: true, msgId });
  } catch (error) {
    console.error('Save error:', error.message);
    res.status(500).json({ error: 'Failed to save' });
  }
});

// Stream route (video player page)
app.get('/maya/:msgId', async (req, res) => {
  try {
    const msgId = req.params.msgId;
    let fileId = req.query.fileId;

    if (!fileId) {
      if (redis) {
        fileId = await redis.get(`file:${msgId}`);
      } else {
        fileId = memoryStore.get(`file:${msgId}`);
      }
    }

    if (!fileId) {
      return res.status(404).send('<h2>File not found</h2>');
    }

    const fileResponse = await axios.get(
      `https://api.telegram.org/bot${TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`
    );

    const filePath = fileResponse.data.result.file_path;
    const directVideoUrl = `https://api.telegram.org/file/bot${TOKEN}/${filePath}`;

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>MayaJaal Stream</title>
        <style>
          html, body { margin:0; padding:0; width:100%; height:100%; background:#000; overflow:hidden; }
          video { width:100%; height:100%; object-fit:contain; }
        </style>
      </head>
      <body>
        <video controls autoplay playsinline>
          <source src="${directVideoUrl}" type="video/mp4">
        </video>
      </body>
      </html>
    `);
  } catch (error) {
    console.error('Stream error:', error.message);
    res.status(500).send('<h2>Error loading media</h2>');
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});

// ========== TELEGRAM BOT ==========
const bot = new TelegramBot(TOKEN, { polling: true });
const STORAGE_CHANNEL = '@maya_jaal1';

// /start command
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from.first_name || 'User';

  try {
    // Simple health check (optional)
    await axios.get(`${BACKEND_URL}/`);

    const welcomeText =
      `🎬 **Welcome to MayaJaal, ${firstName}!**\n\n` +
      `⚡ Your personal high-speed streaming portal is now successfully linked.\n\n` +
      `📂 **How to use:**\n` +
      `Simply send any Video, Movie, or Document here, and MayaJaal will instantly generate a clickable streaming link!`;

    await bot.sendMessage(chatId, welcomeText, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Start error:', error.message);
    await bot.sendMessage(chatId, '⚠️ MayaJaal server connection error. Please try again later.');
  }
});

// File handling
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  if (msg.text && msg.text.startsWith('/start')) return;

  const file = msg.video || msg.document || msg.audio || (msg.photo && msg.photo[msg.photo.length - 1]);
  if (!file) return;

  try {
    const fileName = file.file_name || msg.caption || 'MayaJaal_Media_File';

    const processingMsg = await bot.sendMessage(chatId, '🔄 *Processing your media through MayaJaal core...*', { parse_mode: 'Markdown' });

    const originalFileId = file.file_id;

    const forwardedMsg = await bot.forwardMessage(STORAGE_CHANNEL, chatId, msg.message_id);
    const fileMessageId = forwardedMsg.message_id;

    await axios.post(`${BACKEND_URL}/save`, {
      msgId: fileMessageId,
      fileId: originalFileId
    });

    const accessLink = `${BACKEND_URL}/maya/${fileMessageId}?fileId=${originalFileId}`;

    await bot.deleteMessage(chatId, processingMsg.message_id);

    const successText =
      `✨ **MayaJaal Media Link Generated!** ✨\n\n` +
      `📌 **File:** ${fileName}\n\n` +
      `🔗 **Stream Link:**\n${accessLink}\n\n` +
      `💡 *Click the link above to stream directly!*`;

    await bot.sendMessage(chatId, successText, { parse_mode: 'Markdown', disable_web_page_preview: true });

  } catch (error) {
    console.error('File processing error:', error.response?.data || error.message);
    await bot.sendMessage(chatId, '❌ Failed to process media. Please ensure the bot is Admin in the storage channel and the backend is running.');
  }
});

bot.on('polling_error', (error) => console.log('Polling error:', error.code));
bot.on('error', (error) => console.log('General bot error:', error.message));

console.log('MayaJaal Telegram Bot chal pada hai...');
