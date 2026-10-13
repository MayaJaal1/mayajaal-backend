const fs = require('fs');
let content = fs.readFileSync('bot.js', 'utf8');

// RTDB save wale block ko skip karo
const regex = /try \{\s*await getRTDB\(\)\.ref\(`links\/\$\{shortId\}`\)\.set\(\{[\s\S]*?\n\s*\}\s*\} catch \(e\) \{[\s\S]*?\n\s*\}/;

const replacement = `// RTDB skip - Firestore already saved
        console.log('[RTDB] Skipped - Firestore saved link');`;

if (regex.test(content)) {
    content = content.replace(regex, replacement);
    fs.writeFileSync('bot.js', content);
    console.log('✅ RTDB step skip ho gaya.');
} else {
    console.log('⚠️ RTDB block nahi mila, manually dekhenge.');
}
