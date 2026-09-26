const express = require('express');
const axios = require('axios');
const app = express();

const TOKEN = '8697090840:AAHuAlkm2mmbHx_pCtu9ZDy5kfpVtvVQ8ZA';
const STORAGE_CHANNEL = '@maya_jaal1'; // Aapka private storage channel
const LOG_CHAT_ID = process.env.LOG_CHAT_ID || '@maya_jaal1'; // Jahan file forward karke file_id nikali jayegi

app.get('/', (req, res) => {
  const telegramId = req.query.id;
  const name = req.query.name;
  
  if (telegramId) {
    return res.status(200).json({ success: true, message: `User ${name} connected!` });
  }
  res.send('MayaJaal Backend is live and running!');
});

// Stream route jo Android app call karega
app.get('/stream', async (req, res) => {
  try {
    const msgId = req.query.msgId;
    if (!msgId) {
      return res.status(400).send('Missing msgId parameter.');
    }

    // 1. Telegram channel ke message_id se file ka file_id nikalne ke liye message ko forward/copy karte hain
    // (Kyunki Telegram Bot API direct message_id se file nahi deti, pehle file_id chahiye hoti hai)
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

    // 2. file_id se Telegram server se file ka direct path lo
    const fileResponse = await axios.get(`https://api.telegram.org/bot${TOKEN}/getFile?file_id=${fileId}`);
    const filePath = fileResponse.data.result.file_path;

    // 3. Direct Telegram file download/stream URL banao
    const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${filePath}`;

    // 4. Video ko Android app ke player par redirect/stream kar do
    res.redirect(fileUrl);

  } catch (error) {
    console.error('Streaming error:', error.response?.data || error.message);
    res.status(500).send('Internal Server Error while streaming video.');
  }
});

module.exports = app;
