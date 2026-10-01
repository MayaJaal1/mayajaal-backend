require('dotenv').config();

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const path = require('path');
const fs = require('fs');

// ═══════════════════════════════════════════
// 0. REDIS + CONFIG
// ═══════════════════════════════════════════
const redis = Redis.fromEnv();

const WEB_PAGE_URL = process.env.WEB_PAGE_URL || 'https://mayajaal.online/key';
const BACKEND_URL = process.env.BACKEND_URL || 'https://mayajaal.online';
const TERABOX_API = process.env.TERABOX_API || 'https://terabox.hnn.workers.dev/api';
const LOCAL_BOT_API = process.env.LOCAL_BOT_API_URL || 'http://127.0.0.1:8081';

// ═══════════════════════════════════════════
// 1. EXPRESS SERVER
// ═══════════════════════════════════════════
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(__dirname));

const linkStore = new Map();
const LINK_TTL_MS = 24 * 60 * 60 * 1000;

const BASE_URL = process.env.CUSTOM_DOMAIN 
  ? (process.env.CUSTOM_DOMAIN.startsWith('http') ? process.env.CUSTOM_DOMAIN : `https://${process.env.CUSTOM_DOMAIN}`)
  : 'https://mayajaal.online';

app.get('/', (req, res) => res.send('MayaJaal Bot is running!'));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.get(['/version.json', '/check-update', '/api/check-update'], (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.json({
    latestVersionCode: 2,
    latestVersionName: "v1.1.0",
    updateUrl: "https://mayajaal.online/download.html",
    forceUpdate: false,
    changelog: "⚡ Fast player and auto-update test success!"
  });
});

app.get('/logo.jpg', (req, res) => {
  res.sendFile(path.join(__dirname, 'logo.jpg'));
});

app.get('/key', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get(['/download', '/download.html'], (req, res) => {
  const dlPath = path.join(__dirname, 'download.html');
  if (fs.existsSync(dlPath)) {
    return res.sendFile(dlPath);
  }
  res.status(404).send('download.html not found');
});

app.post('/save-key', async (req, res) => {
  try {
    const { telegram_id, key } = req.body;
    if (!telegram_id || !key) {
      return res.status(400).json({ success: false, message: 'Missing parameters' });
    }
    await redis.set(`matrix_key:${key}`, String(telegram_id), { ex: 30 * 86400 });
    res.json({ success: true });
  } catch (err) {
    console.error('Save key error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/verify-key/:key', async (req, res) => {
  try {
    const key = req.params.key;
    const tgId = await redis.get(`matrix_key:${key}`);
    if (tgId) {
      return res.json({ valid: true, telegram_id: tgId });
    }
    res.json({ valid: false });
  } catch (err) {
    console.error('Verify key error:', err.message);
    res.status(500).json({ valid: false, error: err.message });
  }
});

app.get('/api/stream-info/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let data = linkStore.get(id);
    if (!data) data = await redis.get(`video:${id}`);
    if (!data) data = await redis.get(`terabox:${id}`);
    
    if (!data) return res.status(404).json({ success: false, message: 'Stream not found' });
    
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    res.json({
      success: true,
      url: parsed.url,
      title: parsed.name || 'MayaJaal Stream Video',
      uploader: parsed.uploader || 'Matrix Ghost Node',
      id: id
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/history/save', async (req, res) => {
  try {
    const { telegram_id, video } = req.body;
    if (!telegram_id || !video) return res.status(400).json({ success: false });
    
    const key = `user_history:${telegram_id}`;
    let history = await redis.get(key);
    history = history ? (typeof history === 'string' ? JSON.parse(history) : history) : [];
    
    history = history.filter(item => item.url !== video.url);
    history.unshift({ ...video, watchedAt: Date.now() });
    
    if (history.length > 50) history.pop();
    
    await redis.set(key, JSON.stringify(history));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/history/:telegram_id', async (req, res) => {
  try {
    const key = `user_history:${req.params.telegram_id}`;
    let history = await redis.get(key);
    res.json({
      success: true,
      history: history ? (typeof history === 'string' ? JSON.parse(history) : history) : []
    });
  } catch (err) {
    res.status(500).json({ success: false, history: [] });
  }
});

function servePlayerPage(req, res) {
  const playerFile = path.join(__dirname, 'player.html');
  if (fs.existsSync(playerFile)) {
    return res.sendFile(playerFile);
  }
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>MayaJaal Stream</title>
    <style>body{background:#000;color:#00ff88;font-family:monospace;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;}</style>
    </head><body><h2>MAYAJAAL STREAM NODE</h2><p>Please open link in MayaJaal App</p></body></html>
  `);
}

app.get('/v/:id', (req, res) => servePlayerPage(req, res));
app.get('/tb/:id', (req, res) => servePlayerPage(req, res));

app.get('/.well-known/assetlinks.json', (req, res) => {
  res.set('Content-Type', 'application/json');
  res.json([{
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: "com.example.mayajaall",
      sha256_cert_fingerprints: [
        "11:EE:5A:9A:37:60:BB:80:3F:5E:4F:9B:3B:88:C4:C2:14:6A:C4:2E:D0:60:B1:98:20:9E:58:F8:2D:7F:ED:74"
      ]
    }
  }]);
});

app.get('/api/v/:id', async (req, res) => {
  const id = req.params.id;
  const memoryData = linkStore.get(id);
  if (memoryData && memoryData.url) {
    return res.json({ success: true, url: memoryData.url });
  }

  const redisData = await redis.get(`video:${id}`);
  if (redisData) {
    const parsed = typeof redisData === 'string' ? JSON.parse(redisData) : redisData;
    return res.json({ success: true, url: parsed.url || parsed });
  }

  const tbData = await redis.get(`terabox:${id}`);
  if (tbData) {
    const parsed = typeof tbData === 'string' ? JSON.parse(tbData) : tbData;
    return res.json({ success: true, url: parsed.url || parsed });
  }

  res.status(404).json({ error: 'Stream not found' });
});

app.get('/api/tb/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const data = await redis.get(`terabox:${id}`);
    if (!data) return res.status(404).json({ error: 'Not found or expired' });
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    res.json({
      video_url: parsed.url,
      file_name: parsed.name || 'MayaJaal Video'
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
  console.log(`🌐 Base URL: ${BASE_URL}`);
});
