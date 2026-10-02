app.post('/api/convert', async (req, res) => {
  const { url, telegram_id } = req.body;

  if (!url) {
    return res.status(400).json({ success: false, message: 'URL required' });
  }

  try {
    console.log(`[API Convert] Processing URL: ${url}`);

    // 1. Link Extract karein
    let extracted = null;
    if (/diskwala/i.test(url)) {
      extracted = await extractDiskwalaLink(url);
    } else {
      extracted = await extractTeraboxLink(url);
    }

    if (!extracted || !extracted.url) {
      return res.status(422).json({
        success: false,
        message: 'Extraction failed: Link invalid ya cookies expired.'
      });
    }

    // 2. Telegram Channel Upload (Background Task)
    let uploadSuccess = false;
    let messageId = null;

    if (STORAGE_CHANNEL_ID) {
      const uploadResult = await uploadToStorageChannel2GB(
        extracted.url,
        extracted.name,
        `📁 <b>${escapeHtml(extracted.name)}</b>\n🔗 Original: ${url}`
      );

      if (uploadResult && uploadResult.id) {
        uploadSuccess = true;
        messageId = uploadResult.id;
      }
    }

    // 3. Redis mein stream ID save karein
    const shortId = crypto.randomBytes(4).toString('hex');
    const payload = {
      url: extracted.url,
      name: extracted.name,
      uploader: telegram_id ? `TG_${telegram_id}` : 'API_User',
      channel_msg_id: messageId
    };

    linkStore.set(shortId, payload);
    await redis.set(`terabox:${shortId}`, JSON.stringify(payload), { ex: 30 * 86400 });

    const streamUrl = `${BASE_URL}/tb/${shortId}`;

    return res.json({
      success: true,
      file_name: extracted.name,
      stream_url: streamUrl,
      channel_uploaded: uploadSuccess,
      short_id: shortId
    });

  } catch (err) {
    console.error('[API Convert Error]:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || msg.caption || '').trim();

  if (!text || text.startsWith('/')) return;

  const match = text.match(/(https?:\/\/[^\s<>"']+)/i);
  if (!match) return;

  const targetUrl = match[1];

  // User auth check
  const user = await getUser(chatId);
  if (!user || !user.apiToken) {
    return bot.sendMessage(chatId, `❌ Pehle /api se Matrix key link karein.`);
  }

  const statusMsg = await bot.sendMessage(chatId, `🔄 <i>Backend processing & Vault upload started...</i>`, { parse_mode: 'HTML' });

  try {
    // Extraction logic
    const extracted = /diskwala/i.test(targetUrl)
      ? await extractDiskwalaLink(targetUrl)
      : await extractTeraboxLink(targetUrl);

    if (!extracted || !extracted.url) {
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      return bot.sendMessage(chatId, `❌ Link extract nahi ho paya.`);
    }

    // Channel upload
    let isBackedUp = false;
    if (STORAGE_CHANNEL_ID) {
      const uploadRes = await uploadToStorageChannel2GB(
        extracted.url,
        extracted.name,
        `📁 <b>${escapeHtml(extracted.name)}</b>\n👤 User: ${msg.from?.first_name || chatId}\n🔗 Link: ${targetUrl}`
      );
      if (uploadRes) isBackedUp = true;
    }

    // Save & Return Stream Link
    const shortId = crypto.randomBytes(4).toString('hex');
    const payload = {
      url: extracted.url,
      name: extracted.name,
      uploader: msg.from?.username ? `@${msg.from.username}` : String(chatId)
    };

    await redis.set(`terabox:${shortId}`, JSON.stringify(payload), { ex: 30 * 86400 });
    const playUrl = `${BASE_URL}/tb/${shortId}`;

    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    await bot.sendMessage(chatId, buildSuccessMessage(user, extracted.name, playUrl, isBackedUp), {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });

  } catch (err) {
    console.error('[Bot Error]:', err.message);
    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
});
      
