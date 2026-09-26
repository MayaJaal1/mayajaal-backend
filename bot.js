// Files, Videos, ya Photos receive karne ke liye updated logic
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

  if (msg.text && msg.text.startsWith('/start')) {
    return;
  }

  const file = msg.video || msg.document || msg.audio || msg.photo;

  if (file) {
    try {
      const fileName = file.file_name || msg.caption || 'MayaJaal_Media_File';

      // 1. File ko private storage channel par forward karo
      const forwardedMsg = await bot.forwardMessage(STORAGE_CHANNEL, chatId, msg.message_id);

      // 2. Storage channel ki message ID nikal lo (yeh Android app ke streaming ke liye kaam aayegi)
      const fileMessageId = forwardedMsg.message_id;

      // 3. User ke liye ek direct streaming/access link generate karo
      // (Yeh link aapke Vercel backend par jayega, jo aage chal kar Android app handle karegi)
      const accessLink = `${BACKEND_URL}/stream?msgId=${fileMessageId}`;

      // 4. User ko link wapas bhejo
      bot.sendMessage(chatId, `✅ File successfully upload ho gayi hai!\n\n📁 **File Name:** ${fileName}\n\n🔗 **Aapka Streaming Link:**\n\`${accessLink}\`\n\n*(Is link ko aap apne Android app mein player ke sath use kar sakte hain)*`, { parse_mode: 'Markdown' });

    } catch (error) {
      console.error("File forwarding error:", error);
      bot.sendMessage(chatId, "File upload karne mein kuch samasya aayi. Kripya dobara koshish karein.");
    }
  }
});
