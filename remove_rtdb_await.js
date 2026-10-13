const fs = require('fs');
let content = fs.readFileSync('bot.js', 'utf8');

// `await getRTDB().ref(...)` ko dhundho aur await hatao
const pattern = /await\s+getRTDB\(\)\.ref\(`links\/\$\{shortId\}`\)\.set\(/g;

if (pattern.test(content)) {
    content = content.replace(pattern, 'getRTDB().ref(`links/${shortId}`).set(');
    fs.writeFileSync('bot.js', content);
    console.log('✅ RTDB ka await hata diya. Ab code hang nahi hoga.');
} else {
    console.log('⚠️ Pattern nahi mila, lekin koi aur change nahi karenge.');
}

// Verify
const check = fs.readFileSync('bot.js', 'utf8');
const still = check.match(/await\s+getRTDB\(\)\.ref\(`links\/\$\{shortId\}`\)\.set/g);
console.log('Abhi bhi await baaki hai:', still ? still.length : 0);
