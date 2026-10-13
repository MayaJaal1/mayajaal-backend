const fs = require('fs');
let content = fs.readFileSync('bot.js', 'utf8');

// Wait wale function ko dhundho aur usko bypass kar do
const regex = /async function waitForApiConnection\(\) \{[\s\S]*?\n\}/;
const newFunc = `async function waitForApiConnection() {
    console.log('[BOT] ⚡ Bypassing central API wait... Connected to local VPS API.');
    return { api_connected: true, api_base: 'http://127.0.0.1:8081' };
}`;

if (regex.test(content)) {
    content = content.replace(regex, newFunc);
    fs.writeFileSync('bot.js', content);
    console.log('✅ Waiting loop bypass ho gaya!');
} else {
    console.log('⚠️ Exact function nahi mila, fallback lagaya ja raha hai...');
    content = content.replace("await waitForApiConnection();", "console.log('[BOT] ⚡ Bypassing API wait...');");
    fs.writeFileSync('bot.js', content);
    console.log('✅ Fallback bypass lag gaya!');
}
