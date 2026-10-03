require('dotenv').config();

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const path = require('path');
const fs = require('fs');

process.on('uncaughtException', (err) => console.error('[UncaughtException]:', err.message));
process.on('unhandledRejection', (reason) => console.error('[UnhandledRejection]:', reason));

const redis = Redis.fromEnv();
const linkStore = new Map();

const TOKEN = process.env.BOT_TOKEN;

const BASE_URL = process.env.CUSTOM_DOMAIN
  ? (process.env.CUSTOM_DOMAIN.startsWith('http')
      ? process.env.CUSTOM_DOMAIN
      : `https://${process.env.CUSTOM_DOMAIN}`)
  : 'https://mayajaal.online';

if (!TOKEN) {
  console.error('BOT_TOKEN missing!');
  process.exit(1);
}

// Telegram Channel Storage
// Video Telegram Channel me rahegi.
// Cloudflare R2 me video upload nahi hogi.
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

if (!TELEGRAM_CHANNEL_ID) {
  console.warn('⚠️ TELEGRAM_CHANNEL_ID missing');
}

// Express
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static(__dirname));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }

  next();
});

app.get('/', (req, res) => {
  res.send('Stream Engine Online');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime()
  });
});

// Player
app.get('/v/:id', async (req, res) => {
  try {
    const id = req.params.id;

    let data = linkStore.get(id);

    if (!data) {
      const raw =
        (await redis.get(`video:${id}`)) ||
        (await redis.get(`terabox:${id}`));

      if (raw) {
        data = typeof raw === 'string'
          ? JSON.parse(raw)
          : raw;
      }
    }

    if (!data) {
      return res.status(404).send(
        'Video not found or link expired'
      );
    }

    const streamUrl =
      `${BASE_URL}/stream/${id}`;

    const videoTitle =
      data.name || 'Video Player';

    res.send(`
<!DOCTYPE html>
<html lang="hi">

<head>
<meta charset="UTF-8">

<meta name="viewport"
content="width=device-width, initial-scale=1.0">

<title>${videoTitle}</title>

<style>

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  background: #000;
  color: #fff;
  font-family: sans-serif;

  display: flex;
  flex-direction: column;

  align-items: center;
  justify-content: center;

  min-height: 100vh;
}

.player-box {
  width: 100%;
  max-width: 900px;
  padding: 16px;
}

video {
  width: 100%;
  max-height: 80vh;

  border-radius: 12px;

  background: #111;

  outline: none;

  box-shadow:
    0 10px 30px
    rgba(0,0,0,0.8);
}

.title {
  margin-top: 15px;

  font-size: 1.1rem;

  color: #00ff88;

  word-break: break-all;
}

</style>
</head>

<body>

<div class="player-box">

<video
  controls
  autoplay
  playsinline
  preload="metadata"
>

<source
  src="${streamUrl}"
  type="${data.mimeType || 'video/mp4'}"
>

Aapka browser HTML5 video support nahi karta.

</video>

<div class="title">
${videoTitle}
</div>

</div>

</body>
</html>
`);

  } catch (err) {

    res.status(500).send(
      'Player error: ' + err.message
    );

  }
});


// Telegram → Cloudflare Domain → Player
app.get('/stream/:id', async (req, res) => {

  let sourceStream = null;

  try {

    const id = req.params.id;

    let data = linkStore.get(id);

    if (!data) {

      const raw =
        (await redis.get(`video:${id}`)) ||
        (await redis.get(`terabox:${id}`));

      if (raw) {
        data =
          typeof raw === 'string'
            ? JSON.parse(raw)
            : raw;
      }
    }

    if (!data) {
      return res.status(404).send(
        'Stream not found'
      );
    }


    // ==========================================
    // TELEGRAM VIDEO STREAM
    // ==========================================

    if (data.telegramFileId) {

      const fileInfo =
        await bot.getFile(
          data.telegramFileId
        );

      const filePath =
        fileInfo?.file_path;

      if (!filePath) {

        return res.status(404).send(
          'Telegram file path not available'
        );

      }


      // Local Bot API me file_path
      // absolute path hona chahiye.

      if (!path.isAbsolute(filePath)) {

        return res.status(500).send(
          'Local Telegram Bot API is not configured'
        );

      }


      if (!fs.existsSync(filePath)) {

        return res.status(404).send(
          'Telegram local file is not accessible'
        );

      }


      const stat =
        fs.statSync(filePath);

      const totalSize =
        stat.size;

      const range =
        req.headers.range;


      res.setHeader(
        'Accept-Ranges',
        'bytes'
      );

      res.setHeader(
        'Content-Type',
        data.mimeType ||
        'video/mp4'
      );


      // ==========================================
      // RANGE REQUEST
      // ==========================================

      if (range) {

        const match =
          range.match(
            /bytes=(\d*)-(\d*)/
          );

        if (!match) {

          return res.status(416).send(
            'Invalid Range'
          );

        }


        const startByte =
          match[1]
            ? Number(match[1])
            : 0;

        const endByte =
          match[2]
            ? Number(match[2])
            : totalSize - 1;


        if (
          !Number.isSafeInteger(startByte) ||
          !Number.isSafeInteger(endByte) ||
          startByte < 0 ||
          endByte < startByte ||
          startByte >= totalSize
        ) {

          res.setHeader(
            'Content-Range',
            `bytes */${totalSize}`
          );

          return res.status(416).end();

        }


        const safeEnd =
          Math.min(
            endByte,
            totalSize - 1
          );


        const chunkSize =
          safeEnd - startByte + 1;


        res.status(206);

        res.setHeader(
          'Content-Range',
          `bytes ${startByte}-${safeEnd}/${totalSize}`
        );

        res.setHeader(
          'Content-Length',
          chunkSize
        );


        sourceStream =
          fs.createReadStream(
            filePath,
            {
              start: startByte,
              end: safeEnd
            }
          );

      } else {

        res.status(200);

        res.setHeader(
          'Content-Length',
          totalSize
        );

        sourceStream =
          fs.createReadStream(
            filePath
          );

      }


      sourceStream.on(
        'error',
        (err) => {

          console.error(
            '[Telegram Stream Error]',
            err.message
          );

          if (!res.headersSent) {
            res.status(500).end(
              'Telegram stream error'
            );
          } else {
            res.destroy(err);
          }

        }
      );


      req.on(
        'close',
        () => {

          if (
            sourceStream &&
            !sourceStream.destroyed
          ) {
            sourceStream.destroy();
          }

        }
      );


      return sourceStream.pipe(res);

    }


    // ==========================================
    // EXISTING TERABOX STREAM
    // ==========================================

    if (!data.url) {

      return res.status(404).send(
        'Stream expired'
      );

    }


    let rawCookie =
      process.env.TERABOX_COOKIE || '';

    if (
      rawCookie &&
      !rawCookie.includes('ndus=')
    ) {

      rawCookie =
        `ndus=${rawCookie.trim()};`;

    }


    const headers = {

      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',

      'Cookie':
        rawCookie,

      'Accept':
        '*/*'

    };


    if (req.headers.range) {

      headers['Range'] =
        req.headers.range;

    }


    const videoStream =
      await axios.get(
        data.url,
        {
          responseType: 'stream',

          headers,

          maxRedirects: 10,

          timeout: 60000,

          maxContentLength: Infinity,

          maxBodyLength: Infinity
        }
      );


    res.status(
      videoStream.status
    );


    res.setHeader(
      'Content-Type',
      videoStream.headers[
        'content-type'
      ] || 'video/mp4'
    );


    res.setHeader(
      'Accept-Ranges',
      'bytes'
    );


    if (
      videoStream.headers[
        'content-range'
      ]
    ) {

      res.setHeader(
        'Content-Range',
        videoStream.headers[
          'content-range'
        ]
      );

    }


    if (
      videoStream.headers[
        'content-length'
      ]
    ) {

      res.setHeader(
        'Content-Length',
        videoStream.headers[
          'content-length'
        ]
      );

    }


    return videoStream.data.pipe(
      res
    );


  } catch (err) {

    console.error(
      '[Streaming Error]',
      err.message
    );

    if (!res.headersSent) {

      res.status(500).send(
        'Streaming error'
      );

    } else {

      res.destroy(err);

    }

  }

});


app.listen(
  PORT,
  () => console.log(
    `Server running on port ${PORT}`
  )
);


// ==========================================
// TERABOX LINK RESOLVER
// ==========================================

async function extractTeraboxLink(rawUrl) {

  try {

    let resolvedUrl =
      rawUrl;


    try {

      const resp =
        await axios.get(
          rawUrl,
          {
            maxRedirects: 5,

            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            },

            timeout: 8000
          }
        );


      if (
        resp.request?.res?.responseUrl
      ) {

        resolvedUrl =
          resp.request.res.responseUrl;

      }

    } catch (e) {}


    const match =
      resolvedUrl.match(
        /\/(s|sharing\/link\?surl=)([a-zA-Z0-9_-]+)/i
      ) ||

      resolvedUrl.match(
        /surl=([a-zA-Z0-9_-]+)/i
      ) ||

      rawUrl.match(
        /\/s\/([a-zA-Z0-9_-]+)/i
      );


    let shorturl =
      match
        ? (match[2] || match[1])
        : '';


    if (
      !shorturl &&
      resolvedUrl.includes('/s/')
    ) {

      shorturl =
        resolvedUrl
          .split('/s/')[1]
          .split(/[?&#]/)[0];

    }


    if (!shorturl) {
      return null;
    }


    const formattedKey =
      shorturl.startsWith('1')
        ? shorturl.substring(1)
        : shorturl;


    let rawCookie =
      process.env.TERABOX_COOKIE || '';


    if (
      rawCookie &&
      !rawCookie.includes('ndus=')
    ) {

      rawCookie =
        `ndus=${rawCookie.trim()};`;

    }


    for (
      const k of
      [formattedKey, shorturl]
    ) {

      try {

        const result =
          await axios.get(
            `https://www.1024tera.com/share/list?app_id=250528&shorturl=${k}&root=1`,
            {
              headers: {

                'User-Agent':
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',

                'Referer':
                  'https://www.1024tera.com/',

                'Cookie':
                  rawCookie

              },

              timeout: 8000
            }
          );


        if (
          result.data?.errno === 0 &&
          result.data?.list?.length > 0
        ) {

          const file =
            result.data.list[0];


          const streamUrl =
            file.dlink ||
            file.direct_link ||
            file.url;


          if (streamUrl) {

            return {

              url: streamUrl,

              name:
                file.server_filename ||
                'Video'

            };

          }

        }

      } catch (err) {}

    }

  } catch (e) {}


  return null;

}


// ==========================================
// TELEGRAM BOT
// ==========================================

const TELEGRAM_API_BASE_URL =
  String(
    process.env.TELEGRAM_BOT_API_BASE_URL ||
    'http://127.0.0.1:8081'
  ).replace(/\/$/, '');


const bot =
  new TelegramBot(
    TOKEN,
    {
      baseApiUrl:
        TELEGRAM_API_BASE_URL,

      polling: {
        autoStart: true,

        params: {
          timeout: 10
        }
      }
    }
  );


bot.on(
  'polling_error',
  async (error) => {

    if (
      error.message &&
      error.message.includes(
        '409 Conflict'
      )
    ) {

      await new Promise(
        r => setTimeout(r, 4000)
      );

    }

  }
);


function escapeHtml(str = '') {

  return String(str).replace(
    /[&<>"']/g,
    (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[c])
  );

}


bot.onText(
  /\/start/,
  (msg) => {

    bot.sendMessage(
      msg.chat.id,

      `🎬 <b>Stream Converter Bot</b>\n\n` +

      `• <b>Video Upload:</b> ` +
      `Video Telegram Channel me save hogi ` +
      `aur aapke Cloudflare domain player par chalegi.\n` +

      `• <b>Link Convert:</b> ` +
      `Terabox link bhej kar stream link banayein.`,

      {
        parse_mode: 'HTML'
      }
    );

  }
);// ==========================================
// VIDEO UPLOAD
// User → Bot → Telegram Channel
// Video R2/Cloudflare Storage me nahi jayegi.
// ==========================================

bot.on(
  'message',
  async (msg) => {

    const chatId =
      msg.chat.id;


    const uploaderName =
      msg.from?.username
        ? `@${msg.from.username}`
        : (
            msg.from?.first_name ||
            'User'
          );


    const videoObj =
      msg.video ||
      msg.document ||
      (
        msg.animation
          ? msg.animation
          : null
      );


    // ==========================================
    // VIDEO MESSAGE
    // ==========================================

    if (videoObj) {


      if (!TELEGRAM_CHANNEL_ID) {

        return bot.sendMessage(
          chatId,

          '❌ <b>TELEGRAM_CHANNEL_ID configured nahi hai.</b>',

          {
            parse_mode: 'HTML'
          }
        );

      }


      const fileId =
        videoObj.file_id;


      const fileName =
        videoObj.file_name ||
        `video_${Date.now()}.mp4`;


      const statusMsg =
        await bot.sendMessage(
          chatId,

          `⚡ <i>Video Telegram Channel me save ho rahi hai...</i>`,

          {
            parse_mode: 'HTML'
          }
        );


      try {


        // ======================================
        // COPY VIDEO DIRECTLY TO CHANNEL
        // ======================================

        const copied =
          await bot.copyMessage(
            TELEGRAM_CHANNEL_ID,
            chatId,
            msg.message_id
          );


        const channelMessageId =
          copied?.message_id;


        if (!channelMessageId) {

          throw new Error(
            'Telegram Channel message ID nahi mila'
          );

        }


        // ======================================
        // FILE INFORMATION
        // ======================================

        const fileInfo =
          await bot.getFile(
            fileId
          );


        const shortId =
          crypto.randomBytes(4)
          .toString('hex');


        const payload = {

          name:
            fileName,

          telegramFileId:
            fileId,

          channelId:
            String(
              TELEGRAM_CHANNEL_ID
            ),

          channelMessageId:
            channelMessageId,

          filePath:
            fileInfo?.file_path ||
            null,

          fileSize:
            Number(
              videoObj.file_size ||
              0
            ),

          mimeType:
            videoObj.mime_type ||
            'video/mp4',

          uploader:
            uploaderName

        };


        // ======================================
        // SAVE LINK DATA
        // ======================================

        linkStore.set(
          shortId,
          payload
        );


        await redis.set(
          `video:${shortId}`,

          JSON.stringify(
            payload
          ),

          {
            ex:
              30 * 86400
          }
        );


        const playUrl =
          `${BASE_URL}/v/${shortId}`;


        await bot.deleteMessage(
          chatId,
          statusMsg.message_id
        ).catch(() => {});


        // ======================================
        // SEND PLAYER LINK
        // ======================================

        const reply =
          `✨ <b>Video Ready!</b>\n\n` +

          `📌 <b>File:</b> ` +
          `${escapeHtml(fileName)}\n\n` +

          `📦 <b>Storage:</b> Telegram Channel\n` +

          `☁️ <b>Player:</b> ` +
          `Cloudflare Domain\n\n` +

          `🔗 <b>Your Player Link:</b>\n` +
          `${playUrl}`;


        return bot.sendMessage(
          chatId,

          reply,

          {
            parse_mode: 'HTML',

            disable_web_page_preview:
              false
          }
        );


      } catch (err) {


        console.error(
          '[Telegram Channel Upload Error]',
          err
        );


        await bot.deleteMessage(
          chatId,
          statusMsg.message_id
        ).catch(() => {});


        return bot.sendMessage(
          chatId,

          `❌ <b>Upload Error:</b>\n` +
          `<code>${escapeHtml(err.message)}</code>`,

          {
            parse_mode: 'HTML'
          }
        );

      }

    }


    // ==========================================
    // LINK RECEIVE
    // ==========================================

    const incomingText =
      (msg.text || '').trim();


    if (
      !incomingText ||
      incomingText.startsWith('/')
    ) {

      return;

    }


    const urlRegex =
      /(https?:\/\/[^\s<>"']+)/gi;


    const urls =
      incomingText.match(
        urlRegex
      ) || [];


    if (
      urls.length === 0
    ) {

      return;

    }


    const statusMsg =
      await bot.sendMessage(
        chatId,

        `🔄 <i>Link process ho raha hai...</i>`,

        {
          parse_mode: 'HTML'
        }
      );


    try {


      const targetUrl =
        urls[0];


      let extracted =
        await extractTeraboxLink(
          targetUrl
        );


      if (!extracted) {

        extracted = {

          url:
            targetUrl,

          name:
            'Web Video'

        };

      }


      const shortId =
        crypto.randomBytes(4)
        .toString('hex');


      const payload = {

        name:
          extracted.name,

        url:
          extracted.url,

        uploader:
          uploaderName

      };


      linkStore.set(
        shortId,
        payload
      );


      await redis.set(
        `video:${shortId}`,

        JSON.stringify(
          payload
        ),

        {
          ex:
            30 * 86400
        }
      );


      const playUrl =
        `${BASE_URL}/v/${shortId}`;


      await bot.deleteMessage(
        chatId,
        statusMsg.message_id
      ).catch(() => {});


      bot.sendMessage(
        chatId,

        `✨ <b>Aapka Stream Link:</b>\n` +
        `${playUrl}`,

        {
          parse_mode: 'HTML'
        }
      );


    } catch (err) {


      await bot.deleteMessage(
        chatId,
        statusMsg.message_id
      ).catch(() => {});


      bot.sendMessage(
        chatId,

        `❌ <b>Error:</b>\n` +
        `<code>${escapeHtml(err.message)}</code>`,

        {
          parse_mode: 'HTML'
        }
      );

    }

  }
);
