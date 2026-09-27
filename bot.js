const { Telegraf } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.start((ctx) => {
  ctx.reply('Welcome to Mayajaal Bot! Send or forward any video file here, and I will generate your secure streaming link instantly.');
});

bot.on(['video', 'document'], async (ctx) => {
  try {
    const fileId = ctx.message.video?.file_id || ctx.message.document?.fileId || ctx.message.document?.file_id;
    
    if (!fileId) {
      return ctx.reply('Kripya koi valid video file bhejein.');
    }

    // Aapki website ya vercel domain
    const domain = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://live-score-website-alpha.vercel.app';
    const streamUrl = `${domain}/?fileId=${fileId}`;

    await ctx.reply(`✅ *Stream Link Generated Successfully!*\n\n${streamUrl}\n\nIs link ko copy karke Mayajaall app me paste karein.`, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error(error);
    ctx.reply('Link banane me kuch error aa gaya hai.');
  }
});

module.exports = bot;
