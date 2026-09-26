const express = require('express');
const app = express();

app.use(express.json());

app.get('/', (req, res) => {
  const telegramId = req.query.id || 'Unknown';
  const name = req.query.name || 'User';

  const apiKey = 'mj_' + Math.random().toString(36).substring(2) + Date.now().toString(36);

  res.json({
    status: 'success',
    message: `Namaste ${name}! MayaJaal backend se successfully connect ho gaya hai.`,
    userId: telegramId,
    generatedApiKey: apiKey,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', uptime: process.uptime() });
});

module.exports = app;
