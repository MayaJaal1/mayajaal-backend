const express = require('express');
const axios = require('axios');

const app = express();
const TOKEN = process.env.BOT_TOKEN || '8697090840:AAHuAlkm2mmbHx_pCtu9ZDy5kfpVtvVQ8ZA';

app.get('/', (req, res) => {
  res.send('MayaJaal Backend Streaming Server is Active!');
});

app.get('/stream', async (req, res) => {
  const msgId = req.query.msgId;

  if (!msgId) {
    return res.status(400).send('<h3>Error: Missing msgId parameter.</h3>');
  }

  try {
    // Direct Telegram GetMessage API ya Storage Channel se link fetch karna
    // Agar forward fail ho raha hai, toh hum direct file_id get karne ke liye alternative method use karte hain
    // Filhaal hum direct HTML video player render kar rahe hain jo file_id ko handle karega
    
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
                  color: white;
                  font-family: sans-serif;
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
              <source src="https://api.telegram.org/file/bot${TOKEN}/documents/file_${msgId}.mp4" type="video/mp4">
              Your browser does not support the video tag.
          </video>
      </body>
      </html>
    `;

    res.send(htmlResponse);

  } catch (error) {
    console.error('Streaming error:', error.message);
    res.status(500).send('<h3>Error loading media stream from Telegram.</h3>');
  }
});

module.exports = app;
