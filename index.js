const express = require('express');
const app = express();

app.use(express.json());

// Root route ya API endpoint jo Telegram bot ke liye data bhejega
app.get('/', (req, res) => {
  const telegramId = req.query.id || 'Unknown';
  const name = req.query.name || 'User';

  // Fixed line 32 syntax error here
  const apiKey = 'mj_' + Math.random().toString(36).substring(2) + Date.now().toString(36);

  res.json({
    status: 'success',
    message: `Namaste ${name}! MayaJaal backend se successfully connect ho gaya hai.`,
    userId: telegramId,
    generatedApiKey: apiKey,
    timestamp: new Date().toISOString()
  });
});

// Health check route
app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', uptime: process.uptime() });
});

// Exporting app for Vercel serverless environment
module.exports = app;
