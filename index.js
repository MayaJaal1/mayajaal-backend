const express = require('express');
const axios = require('axios');
const app = express();

const TOKEN = '8697090840:AAHuAlkm2mmbHx_pCtu9ZDy5kfpVtvVQ8ZA';
const STORAGE_CHANNEL = '@maya_jaal1'; 
const LOG_CHAT_ID = '7728273125'; // Aapki apni Telegram Chat ID

app.get('/', (req, res) => {
  res.send('MayaJaal Backend is live and running!');
});

app.get('/stream', async (req, res) => {
  try {
    const msgId = req.query.msgId;
    if (!msgId) {
      return res.status(400).send('Missing msgId parameter.');
    }

    // Storage channel se message ko log chat mein forward karke file_id nikalna
    const forwardResponse = await axios.post(`https://api.telegram.org/bot${TOKEN}/forwardMessage`, {
      chat_id: LOG_CHAT_ID,
      from_chat_id: STORAGE_CHANNEL,
      message_id: parseInt(msgId)
    });

    const messageData = forwardResponse.data.result;
    const mediaObj = messageData.video || messageData.document || messageData.audio;

    if (!mediaObj) {
      return res.status(404).send('Media not found in this message.');
    }

    const fileId = mediaObj.file_id;

    // Telegram server se file ka direct path lena
    const fileResponse = await axios.get(`https://api.telegram.org/bot${TOKEN}/getFile?file_id=${fileId}`);
    const filePath = fileResponse.data.result.file_path;

    const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${filePath}`;

    // Video ko stream/redirect karna
    res.redirect(fileUrl);

  } catch (error) {
    console.error('Streaming error:', error.response?.data || error.message);
    res.status(500).send('Internal Server Error while streaming video.');
  }
});

module.5 = app; // ( ya module.exports = app; )
