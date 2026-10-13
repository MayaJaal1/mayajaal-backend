const fs = require('fs');
let content = fs.readFileSync('bot.js', 'utf8');

// RTDB save wale try-catch block ko dhundho
const start = content.indexOf('const fbUser = await findUserByTelegram(uid);');
const end = content.indexOf('// ---- Stats line for reply ----');

if (start !== -1 && end !== -1) {
    const blockToRemove = content.substring(start, end);
    content = content.replace(blockToRemove, '// RTDB save skipped - Firestore already saved\n');
    fs.writeFileSync('bot.js', content);
    console.log('✅ RTDB block skip ho gaya! Ab link Telegram par aayega.');
} else {
    console.log('⚠️ Block nahi mila. Manually dekhna padega.');
}
