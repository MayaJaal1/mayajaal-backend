const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const TOKEN = process.env.BOT_TOKEN || '8697090840:AAHuAlkm2mmbHx_pCtu9ZDy5kfpVtvVQ8ZA';
const RENDER_URL = process.env.RENDER_URL || 'https://live-score-website-alpha.vercel.app';

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

      if (text && text.startsWith('/start')) {
        await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
          chat_id: chatId,
          text: 'Welcome to MayaJaal! 🎬\n\nSend any video or file here, and I will instantly give you a streaming link for your app!'
        });
      } 
      else {
        const media = update.message.video || update.message.document || update.message.audio;
        if (media) {
          const fileId = media.file_id;
          const streamLink = `${RENDER_URL}/stream?fileId=${encodeURIComponent(fileId)}`;
          
          await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
            chat_id: chatId,
            text: `✅ File processed successfully!\n\n🔗 Watch Link:\n${streamLink}`,
            disable_web_page_preview: true
          });
        }
      }
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook error:', error.message);
    res.status(500).send('Error processing update');
  }
});

// Real Streaming Route using direct fileId
app.get('/stream', async (req, res) => {
  const fileId = req.query.fileId;

  if (!fileId) {
    return res.status(400).send('<h3>Error: Missing fileId parameter.</h3>');
  }

  try {
    // Telegram se seedha file_path nikalna
    const fileResponse = await axios.get(`https://api.telegram.org/bot${TOKEN}/getFile?file_id=${fileId}`);
    const filePath = fileResponse.data.result.file_path;
    const directVideoUrl = `https://api.telegram.org/file/bot${TOKEN}/${filePath}`;

    // HTML5 Video Player render karna jo app ke WebView me chalega
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
    res.status(500).send('<h3>Error loading media stream from Telegram.</h3>');
  }
});

module.exports = app;
