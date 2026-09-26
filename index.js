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
    // Telegram API se message ki details nikalna
    const telegramUrl = `https://api.telegram.org/bot${TOKEN}/forwardMessage`;
    
    // Ham storage channel ya log chat se file fetch karne ke liye direct stream URL banate hain
    // Telegram file link direct fetch karne ke liye getFile API use hoti hai
    // Par sabse asaan tarika yeh hai ki hum HTML5 video player me direct stream URL pass karein
    
    // Yahan hum ek responsive HTML5 video player page return kar rahe hain
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
                  color: #fff;
                  font-family: sans-serif;
              }
              video {
                  width: 100%;
                  height: 100%;
                  max-height: 100vh;
              }
          </style>
      </head>
      <body>
          <div style="text-align: center;">
              <p>Loading MayaJaal Secure Stream for ID: ${msgId}...</p>
          </div>
      </body>
      </html>
    `;

    res.send(htmlResponse);

  } catch (error) {
    console.error('Streaming error:', error);
    res.status(500).send('<h3>Error loading media stream from Telegram.</h3>');
  }
});

module.exports = app;
