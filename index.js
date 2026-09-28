const express = require('express');
const axios = require('axios');
const { Redis } = require('@upstash/redis');

const app = express();
app.use(express.json());

const TOKEN = process.env.BOT_TOKEN;

if (!TOKEN) {
  console.error('BOT_TOKEN environment variable is missing');
}

const redis = Redis.fromEnv();

app.get('/', (req, res) => {
  res.send('MayaJaal Backend Streaming Server is Active!');
});

// Save mapping: message ID -> Telegram file ID
app.post('/save', async (req, res) => {
  try {
    const { msgId, fileId } = req.body;

    if (!msgId || !fileId) {
      return res.status(400).json({
        error: 'msgId and fileId are required'
      });
    }

    await redis.set(`file:${msgId}`, fileId);

    res.json({
      success: true,
      msgId,
      message: 'File mapping saved'
    });
  } catch (error) {
    console.error('Redis save error:', error.message);
    res.status(500).json({ error: 'Failed to save mapping' });
  }
});

// MayaJaal short stream route
app.get('/maya/:msgId', async (req, res) => {
  try {
    const msgId = req.params.msgId;

    const fileId = await redis.get(`file:${msgId}`);

    if (!fileId) {
      return res.status(404).send(`
        <h2>MayaJaal</h2>
        <p>File not found.</p>
      `);
    }

    const fileResponse = await axios.get(
      `https://api.telegram.org/bot${TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`
    );

    const filePath = fileResponse.data.result.file_path;

    const directVideoUrl =
      `https://api.telegram.org/file/bot${TOKEN}/${filePath}`;

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>MayaJaal Stream</title>
        <style>
          html, body {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            background: #000;
          }

          video {
            width: 100%;
            height: 100%;
            object-fit: contain;
          }
        </style>
      </head>

      <body>
        <video controls autoplay playsinline>
          <source src="${directVideoUrl}">
          Your browser does not support video playback.
        </video>
      </body>
      </html>
    `);

  } catch (error) {
    console.error('Stream error:', error.message);

    res.status(500).send(`
      <h2>MayaJaal</h2>
      <p>Error loading the media.</p>
    `);
  }
});

module.exports = app;
