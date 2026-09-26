const express = require('express');
const axios = require('axios');

const app = express();
const TOKEN = process.env.BOT_TOKEN || '8697090840:AAHuAlkm2mmbHx_pCtu9ZDy5kfpVtvVQ8ZA';
const LOG_CHAT_ID = process.env.LOG_CHAT_ID || '7728273125';

app.get('/', (req, res) => {
  const { id, name } = req.query;
  if (id) {
    console.log(`User Linked - ID: ${id}, Name: ${name}`);
  }
  res.send('MayaJaal Backend Streaming Server is Active!');
});

app.get('/stream', async (req, res) => {
  const msgId = req.query.msgId;

  if (!msgId) {
    return res.status(400).send('<h3>Error: Missing msgId parameter.</h3>');
  }

  try {
    // 1. Telegram channel se message forward karke file_id nikalna
    const forwardResponse = await axios.post(`https://api.telegram.org/bot${TOKEN}/forwardMessage`, {
      chat_id: LOG_CHAT_ID,
      from_chat_id: LOG_CHAT_ID,
      message_id: Number(msgId)
    });

    const messageData = forwardResponse.data.result;
    const media = messageData.video || messageData.document || messageData.audio;

    if (!media) {
      return res.status(404).send('<h3>Error: Media file not found in this message.</h3>');
    }

    const fileId = media.file_id;

    // 2. Telegram se file ka direct download/stream path lena
    const fileResponse = await axios.get(`https://api.telegram.org/bot${TOKEN}/getFile?file_id=${fileId}`);
    const filePath = fileResponse.data.result.file_path;
    const directVideoUrl = `https://api.telegram.org/file/bot${TOKEN}/${filePath}`;

    // 3. HTML5 Video Player Page return karna jo app ke WebView me chalega
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
    res.status(500).send('<h3>Error loading media stream from Telegram. Please check msgId.</h3>');
  }
});

module.exports = app;
