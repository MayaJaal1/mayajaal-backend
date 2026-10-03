require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const {
  BOT_TOKEN,
  TELEGRAM_CHANNEL_ID,
  TELEGRAM_BOT_API_BASE_URL = "http://127.0.0.1:8081",
  CUSTOM_DOMAIN = "https://mayajaal.online",
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  TERABOX_COOKIE
} = process.env;

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is missing");
}
if (!TELEGRAM_CHANNEL_ID) {
  throw new Error("TELEGRAM_CHANNEL_ID is missing");
}

// Đã bật polling để bot nhận tin nhắn
const bot = new TelegramBot(BOT_TOKEN, {
  polling: true,
  baseApiUrl: TELEGRAM_BOT_API_BASE_URL
});

const app = express();
const PORT = process.env.PORT || 8080;
const BASE_URL = CUSTOM_DOMAIN.replace(/\/+$/, "");

console.log("========================================");
console.log(" MayaJaal Bot Starting...");
console.log("========================================");
console.log(" Telegram Channel:", TELEGRAM_CHANNEL_ID);
console.log(" Local Bot API:", TELEGRAM_BOT_API_BASE_URL);
console.log(" Player Domain:", BASE_URL);
console.log(" Video storage: Telegram Channel");
console.log(" Cloudflare R2 video upload: DISABLED");
console.log("========================================");

// Redis helpers
async function redisCommand(command) {
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    return null;
  }
  const response = await axios.post(
    UPSTASH_REDIS_REST_URL,
    command,
    {
      headers: {
        Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
        "Content-Type": "application/json"
      },
      timeout: 15000
    }
  );
  return response.data;
}

async function redisSet(key, value) {
  try {
    return await redisCommand([
      "SET",
      key,
      JSON.stringify(value)
    ]);
  } catch (error) {
    console.error("Redis SET error:", error.message);
    return null;
  }
}

async function redisGet(key) {
  try {
    const result = await redisCommand([
      "GET",
      key
    ]);
    if (!result || result.result == null) {
      return null;
    }
    return JSON.parse(result.result);
  } catch (error) {
    console.error("Redis GET error:", error.message);
    return null;
  }
}

// In-memory cache
const videoCache = new Map();

async function saveVideo(id, data) {
  videoCache.set(id, data);
  await redisSet(`video:${id}`, data);
}

async function getVideo(id) {
  if (videoCache.has(id)) {
    return videoCache.get(id);
  }
  const data = await redisGet(`video:${id}`);
  if (data) {
    videoCache.set(id, data);
  }
  return data;
}

// ID generator
function generateId(length = 10) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// HTML escape
function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Player page
app.get("/v/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const data = await getVideo(id);
    if (!data) {
      return res.status(404).send("Video not found");
    }

    const title = escapeHtml(data.name || "MayaJaal Video");
    const streamUrl = `${BASE_URL}/stream/${encodeURIComponent(id)}`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background: #000;
      overflow: hidden;
    }
    body {
      display: flex;
      align-items: center;
      justify-content: center;
    }
    video {
      width: 100%;
      height: 100%;
      object-fit: contain;
      background: #000;
    }
  </style>
</head>
<body>
  <video controls autoplay playsinline preload="metadata">
    <source src="${streamUrl}" type="${escapeHtml(data.mimeType || "video/mp4")}">
    Your browser does not support HTML5 video.
  </video>
</body>
</html>`);
  } catch (error) {
    console.error("Player error:", error);
    res.status(500).send("Player error");
  }
});

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "online",
    bot: "MayaJaal",
    storage: "Telegram Channel",
    r2: false,
    localBotApi: TELEGRAM_BOT_API_BASE_URL,
    player: BASE_URL
  });
});
// Video streaming route
app.get("/stream/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const data = await getVideo(id);

    if (!data) {
      return res.status(404).send("Video not found");
    }

    // Telegram video streaming via Local Bot API
    if (data.telegramFileId) {
      const fileInfo = await bot.getFile(data.telegramFileId);

      if (!fileInfo || !fileInfo.file_path) {
        return res.status(404).send("Telegram file path unavailable");
      }

      const filePath = fileInfo.file_path;

      if (!path.isAbsolute(filePath)) {
        return res.status(500).send("Local Bot API did not return an absolute file path");
      }

      if (!fs.existsSync(filePath)) {
        return res.status(404).send("Telegram local file is not available");
      }

      const stat = fs.statSync(filePath);
      const fileSize = stat.size;
      const range = req.headers.range;

      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Type", data.mimeType || "video/mp4");
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

      if (range) {
        const match = range.match(/bytes=(\d+)-(\d*)/);
        if (!match) {
          return res.status(416).send("Invalid Range");
        }

        let start = parseInt(match[1], 10);
        let end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

        if (start >= fileSize) {
          res.setHeader("Content-Range", `bytes */${fileSize}`);
          return res.status(416).end();
        }

        if (end >= fileSize) {
          end = fileSize - 1;
        }

        const chunkSize = end - start + 1;

        res.status(206);
        res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
        res.setHeader("Content-Length", chunkSize);

        const stream = fs.createReadStream(filePath, { start, end });
        stream.on("error", (error) => {
          console.error("Telegram stream error:", error.message);
          if (!res.headersSent) {
            res.status(500).end();
          } else {
            res.destroy();
          }
        });
        return stream.pipe(res);
      }

      res.status(200);
      res.setHeader("Content-Length", fileSize);

      const stream = fs.createReadStream(filePath);
      stream.on("error", (error) => {
        console.error("Telegram stream error:", error.message);
        if (!res.headersSent) {
          res.status(500).end();
        } else {
          res.destroy();
        }
      });
      return stream.pipe(res);
    }

    // TeraBox streaming fallback
    if (data.url) {
      const headers = {};
      if (req.headers.range) {
        headers["Range"] = req.headers.range;
      }
      if (TERABOX_COOKIE) {
        headers["Cookie"] = TERABOX_COOKIE;
      }

      const response = await axios({
        method: "GET",
        url: data.url,
        headers,
        responseType: "stream",
        validateStatus: () => true
      });

      res.status(response.status);

      if (response.headers["content-type"]) {
        res.setHeader("Content-Type", response.headers["content-type"]);
      }
      if (response.headers["content-length"]) {
        res.setHeader("Content-Length", response.headers["content-length"]);
      }
      if (response.headers["content-range"]) {
        res.setHeader("Content-Range", response.headers["content-range"]);
      }

      res.setHeader("Accept-Ranges", "bytes");
      return response.data.pipe(res);
    }

    return res.status(404).send("No playable source found");
  } catch (error) {
    console.error("Stream error:", error.message);
    if (!res.headersSent) {
      return res.status(500).send("Unable to stream video");
    }
    res.destroy();
  }
});

// Telegram bot message handler
bot.on("message", async (msg) => {
  try {
    const chatId = msg.chat.id;

    // Handle incoming video or document
    const file = msg.video || (msg.document && msg.document.mime_type && msg.document.mime_type.startsWith("video/") ? msg.document : null);

    if (file) {
      const statusMsg = await bot.sendMessage(chatId, "⏳ Processing your video...");

      // Forward or copy video to Telegram channel for permanent storage
      const forwarded = await bot.forwardMessage(TELEGRAM_CHANNEL_ID, chatId, msg.message_id);
      const storedFileId = (forwarded.video && forwarded.video.file_id) || (forwarded.document && forwarded.document.file_id) || file.file_id;

      const videoId = generateId(8);
      const videoData = {
        id: videoId,
        telegramFileId: storedFileId,
        name: msg.caption || file.file_name || "video.mp4",
        mimeType: file.mime_type || "video/mp4",
        size: file.file_size || 0,
        createdAt: new Date().toISOString()
      };

      await saveVideo(videoId, videoData);

      const playerUrl = `${BASE_URL}/v/${videoId}`;
      const streamUrl = `${BASE_URL}/stream/${videoId}`;

      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});

      return bot.sendMessage(
        chatId,
        `✅ *Video Ready!*\n\n🌐 *Player Link:*\n${playerUrl}\n\n⚡ *Stream Link:*\n${streamUrl}`,
        { parse_mode: "Markdown" }
      );
    }

    // Default response for text
    if (msg.text && !msg.text.startsWith("/")) {
      bot.sendMessage(chatId, "Send me any video to generate a high-speed web player link!");
    }
  } catch (error) {
    console.error("Bot message error:", error);
    bot.sendMessage(msg.chat.id, "❌ Error processing request: " + error.message).catch(() => {});
  }
});

// Start Express server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
