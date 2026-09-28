const express = require('express');
const axios = require('axios');
const { Redis } = require('@upstash/redis');

const app = express();
app.use(express.json());

// ✅ CORS enable (page different domain se request karega)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const TOKEN = process.env.BOT_TOKEN;

if (!TOKEN) {
  console.error('BOT_TOKEN environment variable is missing');
}

const redis = Redis.fromEnv();

app.get('/', (req, res) => {
  res.send('MayaJaal Backend Streaming Server is Active!');
});

// ═══════════════════════════════════════════
// SAVE KEY (called from Vercel page)
// ═══════════════════════════════════════════
app.post('/save-key', async (req, res) => {
  try {
    const { telegram_id, key } = req.body;

    if (!telegram_id || !key) {
      return res.status(400).json({ error: 'telegram_id and key required' });
    }

    // key → telegram_id (for verification)
    await redis.set(`key:${key}`, String(telegram_id), { ex: 60 * 60 * 24 * 30 });
    // telegram_id → key (for showing existing key)
    await redis.set(`user:${telegram_id}`, key, { ex: 60 * 60 * 24 * 30 });

    res.json({ success: true, key, telegram_id });
  } catch (err) {
    console.error('save-key error:', err.message);
    res.status(500).json({ error: 'Failed to save key' });
  }
});

// ═══════════════════════════════════════════
// GET EXISTING KEY (called from Vercel page)
// ═══════════════════════════════════════════
app.get('/get-key/:telegram_id', async (req, res) => {
  try {
    const key = await redis.get(`user:${req.params.telegram_id}`);
    res.json({ key: key || null });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch key' });
  }
});

// ═══════════════════════════════════════════
// VERIFY KEY (called from bot)
// ═══════════════════════════════════════════
app.get('/verify-key/:key', async (req, res) => {
  try {
    const telegram_id = await redis.get(`key:${req.params.key}`);
    res.json({ valid: !!telegram_id, telegram_id: telegram_id || null });
  } catch (err) {
    res.status(500).json({ error: 'Verify failed' });
  }
});

// ═══════════════════════════════════════════
// STREAM ROUTES (existing)
// ═══════════════════════════════════════════
app.post('/save', async (req, res) => {
  try {
    const { msgId, fileId } = req.body;
    if (!msgId || !fileId) {
      return res.status(400).json({ error: 'msgId and fileId are required' });
    }
    await redis.set(`file:${msgId}`, fileId);
    res.json({ success: true, msgId, message: 'File mapping saved' });
  } catch (error) {
    console.error('Redis save error:', error.message);
    res.status(500).json({ error: 'Failed to save mapping' });
  }
});

app.get('/maya/:msgId', async (req, res) => {
  try {
    const msgId = req.params.msgId;
    let fileId = req.query.fileId;

    if (!fileId) {
      fileId = await redis.get(`file:${msgId}`);
    }

    if (!fileId) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>MayaJaal</title>
        <style>body{background:#000;color:#fff;font-family:sans-serif;text-align:center;padding:50px}h2{color:#9c27b0}</style></head>
        <body><h2>MayaJaal</h2><p>File not found.</p></body></html>
      `);
    }

    const fileResponse = await axios.get(
      `https://api.telegram.org/bot${TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`
    );
    const filePath = fileResponse.data.result.file_path;
    const directVideoUrl = `https://api.telegram.org/file/bot${TOKEN}/${filePath}`;

    res.send(`
      <!DOCTYPE html>
      <html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>MayaJaal Stream</title>
      <style>html,body{margin:0;padding:0;width:100%;height:100%;background:#000;overflow:hidden}video{width:100%;height:100%;object-fit:contain}</style></head>
      <body><video controls autoplay playsinline><source src="${directVideoUrl}">Your browser does not support video playback.</video></body></html>
    `);
  } catch (error) {
    console.error('Stream error:', error.message);
    res.status(500).send(`
      <!DOCTYPE html>
      <html><head><meta charset="UTF-8"><title>MayaJaal</title>
      <style>body{background:#000;color:#fff;font-family:sans-serif;text-align:center;padding:50px}h2{color:#9c27b0}</style></head>
      <body><h2>MayaJaal</h2><p>Error loading the media.</p></body></html>
    `);
  }
});

module.exports = app;
