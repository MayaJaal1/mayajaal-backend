const express = require('express');
const bot = require('./bot');

const app = express();
app.use(express.json());

// Webhook route for Telegram
app.post('/api/webhook', async (req, res) => {
  try {
    await bot.handleUpdate(req.body);
    return res.status(200).send('OK');
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).send('Error');
  }
});

app.get('/', (req, res) => {
  res.send('Mayajaal Backend is running smoothly!');
});

// Vercel ke liye export karna zaroori hai
module.exports = app;
