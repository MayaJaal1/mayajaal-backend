const fs = require('fs');
let content = fs.readFileSync('bot.js', 'utf8');

// findUserByTelegram wali line ko null se replace karo
const old = 'const fbUser = await findUserByTelegram(uid);';
const neu = 'const fbUser = null; // RTDB skip - link aage bhejo';

if (content.includes(old)) {
    content = content.replace(old, neu);
    fs.writeFileSync('bot.js', content);
    console.log('✅ RTDB block skip ho gaya. Ab link Telegram par aayega.');
} else {
    console.log('⚠️ Line nahi mili, kuch aur check karenge.');
}
