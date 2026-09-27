const express = require('express');
const bot = require('./bot');

const app = express();
app.use(express.json());

// Telegram webhook route
app.post('/api/webhook', async (req, res) => {
  try {
    await bot.handleUpdate(req.body);
    res.status(200).send('OK');
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).send('Error');
  }
});

// Fallback route for root
app.get('/', (req, res) => {
  res.send('Mayajaal Backend is running smoothly!');
});

// Export app for Vercel Serverless Functions
module.exports = app;
