const fs = require('fs');
let content = fs.readFileSync('bot.js', 'utf8');

// S3Client import add karo (agar nahi hai)
if (!content.includes('@aws-sdk/client-s3')) {
    content = "const { S3Client } = require('@aws-sdk/client-s3');\n" + content;
    console.log('✅ S3Client import add ho gaya.');
}

// s3Client variable add karo (agar nahi hai)
if (!content.includes('const s3Client = new S3Client')) {
    const s3Def = 'const s3Client = new S3Client({\n' +
        '    region: "auto",\n' +
        '    endpoint: "https://" + process.env.R2_ACCOUNT_ID + ".r2.cloudflarestorage.com",\n' +
        '    credentials: {\n' +
        '        accessKeyId: process.env.R2_ACCESS_KEY_ID,\n' +
        '        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,\n' +
        '    },\n' +
        '});\n';
    
    // Dotenv wali line ke baad daalo
    const dotenvLine = "require('dotenv').config();";
    if (content.includes(dotenvLine)) {
        content = content.replace(dotenvLine, dotenvLine + '\n' + s3Def);
    } else {
        content = s3Def + content;
    }
    console.log('✅ s3Client variable add ho gaya.');
} else {
    console.log('✅ s3Client pehle se hai.');
}

fs.writeFileSync('bot.js', content);
console.log('✅ Ho gaya! Ab bot restart karo.');
