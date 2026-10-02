// Master Handler for Text + Photo Captions
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const incomingContent = (msg.text || msg.caption || '').trim();

  // Ignore commands like /start, /api
  if (!incomingContent || incomingContent.startsWith('/')) return;

  // 1. Extract any URL containing common Terabox keywords
  const urlRegex = /(https?:\/\/[^\s<>"']+)/gi;
  const matches = incomingContent.match(urlRegex) || [];
  
  const teraboxUrl = matches.find(url => 
    /(terabox|terasharefile|1024tera|teraboxapp|teraboxshare|teraboxlink|tibibox|momerybox|mirrorbox|4funbox|dubox|freeterabox)/i.test(url)
  );

  if (!teraboxUrl) {
    // Agar link TeraBox ka nahi mila toh user ko inform karein
    return;
  }

  // 2. User Key Verification
  const user = await getUser(chatId);
  if (!user || !user.apiToken) {
    return bot.sendMessage(
      chatId,
      `❌ <b>Pehle Matrix Key link karein!</b>\n\nKey lein: ${WEB_PAGE_URL}?tg=${chatId}\nPhir <code>/api YOUR_KEY</code> bhejein.`,
      { parse_mode: 'HTML' }
    );
  }

  const uploaderName = msg.from?.username ? `@${msg.from.username}` : (msg.from?.first_name || 'Matrix User');

  // 3. Immediate Feedback
  let statusMsg;
  try {
    statusMsg = await bot.sendMessage(chatId, `🔄 <i>Converting Terabox to MayaJaal Stream...</i>`, { parse_mode: 'HTML' });
  } catch (e) {
    console.error('Status message send error:', e.message);
  }

  try {
    console.log(`[Bot] Processing link: ${teraboxUrl} for chat ${chatId}`);
    const extracted = await extractTeraboxLink(teraboxUrl);

    if (!extracted || !extracted.url) {
      if (statusMsg) await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      return bot.sendMessage(chatId, `❌ <b>Link convert nahi ho saka (Terabox API down ya link expired).</b>`, { parse_mode: 'HTML' });
    }

    const shortId = crypto.randomBytes(4).toString('hex');
    const payload = {
      url: extracted.url,
      name: extracted.name,
      uploader: uploaderName,
    };

    linkStore.set(shortId, payload);
    await redis.set(`terabox:${shortId}`, JSON.stringify(payload), { ex: 30 * 86400 });

    const playUrl = `${BASE_URL}/tb/${shortId}`;

    if (statusMsg) await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    await bot.sendMessage(chatId, buildSuccessMessage(user, extracted.name, playUrl), {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error('[Bot Error]:', err.message);
    if (statusMsg) await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    bot.sendMessage(chatId, `❌ <b>Error:</b> <code>${escapeHtml(err.message)}</code>`, { parse_mode: 'HTML' });
  }
});
