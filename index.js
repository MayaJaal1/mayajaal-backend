const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const TOKEN = process.env.BOT_TOKEN || '8697090840:AAHuAlkm2mmbHx_pCtu9ZDy5kfpVtvVQ8ZA';
const RENDER_URL = process.env.RENDER_URL || 'https://live-score-website-alpha.vercel.app';
const STORAGE_CHANNEL = process.env.STORAGE_CHANNEL || '@maya_jaal1'; // Aapka storage channel jahan files aayengi
const LOG_CHAT_ID = process.env.LOG_CHAT_ID || '7728273125';

app.get('/', (req, res) => {
  res.send('MayaJaal Backend Streaming Server is Active!');
});

// Telegram Webhook
app.post('/webhook', async (req, res) => {
  try {
    const update = req.body;

    if (update && update.message) {
      const chatId = update.message.chat.id;
      const text = update.message.text;
      const messageId = update.message.message_id;

      if (text && text.startsWith('/start')) {
        await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
          chat_id: chatId,
          text: 'Welcome to MayaJaal! 🎬\n\nSend any video or file here, and I will instantly give you a streaming link for your app!'
        });
      } 
      else if (update.message.video || update.message.document || update.message.audio) {
        const streamLink = `${RENDER_URL}/stream?msgId=${messageId}`;
        
        await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
          chat_id: chatId,
          text: `✅ File processed successfully!\n\n🔗 Watch Link:\n${streamLink}`,
          disable_web_page_preview: true
        });
      }
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook error:', error.message);
    res.status(500).send('Error processing update');
  }
});

// Real Streaming Route with Telegram file lookup
app.get('/stream', async (req, res) => {
  const msgId = req.query.msgId;

  if (!msgId) {
    return res.status(400).send('<h3>Error: Missing msgId parameter.</h3>');
  }

  try {
    // 1. Message forward karke media details nikalna
    const forwardResponse = await axios.post(`https://api.telegram.org/bot${TOKEN}/forwardMessage`, {
      chat_id: LOG_CHAT_ID,
      from_chat_id: STORAGE_CHANNEL,
      message_id: Number(msgId)
    });

    const messageData = forwardResponse.data.result;
    const media = messageData.video || messageData.document || messageData.audio;

    if (!media) {
      return res.status(404).send('<h3>Error: Media file not found.</h3>');
    }

    const fileId = media.file_id;

    // 2. Telegram se asli file_path lena
    const fileResponse = await axios.get(`https://api.telegram.org/bot${TOKEN}/getFile?file_id=${fileId}`);
    const filePath = fileResponse.data.result.file_path;
    const directVideoUrl = `https://api.telegram.org/file/bot${TOKEN}/${filePath}`;

    // 3. HTML5 Video Player render karna jo app ke WebView me chalega
    const htmlResponse = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>MayaJaal Secure Stream</title>
          <style>
              body {
                  margin: 0;
                  background-color: #000;
                  display: flex;
                  justify-content: center;
                  align-items: center;
                  height: 100vh;
              }
              video {
                  width: 100%;
                  height: 100%;
                  max-height: 100vh;
                  outline: none;
              }
          </style>
      </head>
      <body>
          <video controls autoplay playsinline>
              <source src="${directVideoUrl}" type="video/mp4">
              Your browser does not support the video tag.
          </video>
      </body>
      </html>
    `;

    res.send(htmlResponse);

  } catch (error) {
    console.error('Streaming error:', error.response?.data || error.message);
    res.status(500).send('<h3>Error loading media stream from Telegram. Please check permissions.</h3>');
  }
});

module.exports = app;
