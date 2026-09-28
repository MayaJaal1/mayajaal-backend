const { Telegraf } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.start((ctx) => {
  return ctx.reply('Welcome to Mayajaal Bot! Send or forward any video file here, and I will generate your secure streaming link instantly.');
});

bot.on(['video', 'document', 'audio'], async (ctx) => {
  try {
    const message = ctx.message;
    const fileId = message.video?.file_id || message.document?.file_id || message.audio?.file_id;
    const fileName = message.video?.file_name || message.document?.file_name || message.audio?.file_name || 'MayaJaalMediaFile';
    const msgId = message.message_id;

    if (!fileId) {
      return ctx.reply('Kripya koi valid video file ya document bhejein.');
    }

    // Aapka active Vercel domain
    const domain = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://mayajaal-backend.vercel.app';
    const streamUrl = `${domain}/stream?msgId=${msgId}`;

    const responseText = `📌 *File: ${fileName}*\n\n🔗 *Stream Link:*\n${streamUrl}\n\n💡 Click the link above to stream directly inside your MayaJaal app!`;

    await ctx.reply(responseText, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error("Link generation error:", error);
    await ctx.reply('Kuch technical error aa gaya hai, kripya dobara try karein.');
  }
});

module.exports = bot;
