const fs = require('fs');
let content = fs.readFileSync('bot.js', 'utf8');

// Step 1: S3Client import karo (agar nahi hai)
if (!content.includes("@aws-sdk/client-s3")) {
    content = "const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');\n" + content;
    console.log('✅ S3Client import add ho gaya.');
} else {
    console.log('✅ S3Client import pehle se hai.');
}

// Step 2: s3Client variable define karo (agar nahi hai)
if (!content.includes("const s3Client = new S3Client")) {
    const r2Def = `
const s3Client = new S3Client({
    region: 'auto',
    endpoint: \`https://\${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com\`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});
`;
    // Pehle 'require' wale line ke baad daalo
    const firstRequire = content.indexOf("require(");
    const lineEnd = content.indexOf("\n", firstRequire);
    if (lineEnd !== -1) {
        content = content.substring(0, lineEnd + 1) + r2Def + content.substring(lineEnd + 1);
    } else {
        content = r2Def + content;
    }
    console.log('✅ s3Client define ho gaya.');
} else {
    console.log('✅ s3Client pehle se defined hai.');
}

fs.writeFileSync('bot.js', content);
