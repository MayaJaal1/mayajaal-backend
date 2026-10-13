const fs = require('fs');
let content = fs.readFileSync('bot.js', 'utf8');

// Wait function ko dhundho aur bypass karo
const regex = /async function waitForApiConnection\(\) \{[\s\S]*?\n\}/;
const newFunc = `async function waitForApiConnection() {
    console.log('[BOT] ⚡ Local VPS mode active. No Render needed.');
    return { api_connected: true, api_base: 'http://127.0.0.1:8080' };
}`;

if (regex.test(content)) {
    content = content.replace(regex, newFunc);
    fs.writeFileSync('bot.js', content);
    console.log('✅ Wait bypass ho gaya.');
} else {
    console.log('⚠️ Exact function nahi mila, lekin aage badh rahe hain.');
}
