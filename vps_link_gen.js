const fs = require('fs');
let content = fs.readFileSync('bot.js', 'utf8');

// Render wale function ko bypass karo
const regex = /async function getCentralConfig\(\) \{[\s\S]*?\n\}/;
const newFunc = `async function getCentralConfig() {
    console.log('[BOT] ⚡ VPS link generation active.');
    return { api_connected: true, api_base: 'http://127.0.0.1:8080' };
}`;

if (regex.test(content)) {
    content = content.replace(regex, newFunc);
    console.log('✅ Render hataya, VPS link generator laga.');
} else {
    content = content.replace(/getCentralConfig\(\)/g, "Promise.resolve({api_connected: true, api_base: 'http://127.0.0.1:8080'})");
    console.log('✅ Fallback lagaya.');
}

fs.writeFileSync('bot.js', content);
