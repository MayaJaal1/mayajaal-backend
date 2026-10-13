const fs = require('fs');
let lines = fs.readFileSync('bot.js', 'utf8').split('\n');

// Saari lines dhundho jahan 'const s3Client' likha hai
let s3ClientIndexes = [];
lines.forEach((line, i) => {
    if (line.includes("const s3Client")) {
        s3ClientIndexes.push(i);
    }
});

console.log("s3Client mile:", s3ClientIndexes.length, "jagah");

// Agar ek se zyada hai, toh sab hatao aur ek sahi wala daalo
if (s3ClientIndexes.length > 1) {
    // Pehle saari s3Client wali lines hatao (multi-line declaration ko bhi handle karo)
    let newLines = [];
    let skip = false;
    let braceCount = 0;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        if (line.includes("const s3Client = new S3Client")) {
            // Agar ek line mein hi pura declaration hai
            if (line.includes("});") || line.includes("});")) {
                continue;
            }
            skip = true;
            braceCount = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
            continue;
        }
        
        if (skip) {
            braceCount += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
            if (braceCount <= 0 && line.includes("}")) {
                skip = false;
            }
            continue;
        }
        
        newLines.push(line);
    }
    
    // Ab ek sahi s3Client declaration daalo (dotenv ke baad)
    const s3Def = `const s3Client = new S3Client({
    region: 'auto',
    endpoint: \`https://\${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com\`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});`;
    
    // Dotenv wali line ke baad daalo
    const dotenvIndex = newLines.findIndex(l => l.includes("dotenv") && l.includes("config"));
    if (dotenvIndex !== -1) {
        newLines.splice(dotenvIndex + 1, 0, s3Def);
    } else {
        newLines.unshift(s3Def);
    }
    
    fs.writeFileSync('bot.js', newLines.join('\n'));
    console.log("✅ Saari duplicate hata di, ek sahi wala daal diya.");
} else {
    console.log("✅ Sirf ek s3Client hai, kuch nahi kiya.");
}
