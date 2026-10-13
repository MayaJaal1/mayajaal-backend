const fs = require('fs');
let content = fs.readFileSync('bot.js', 'utf8');

// 1. Check karo ki S3Client import hai ya nahi
if (!content.includes('@aws-sdk/client-s3')) {
    content = "const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');\n" + content;
    console.log('✅ S3Client import add ho gaya.');
}

// 2. Check karo ki s3Client define hai ya nahi
if (!content.includes('const s3Client = new S3Client')) {
    const insertAfter = "require('@aws-sdk/client-s3');";
    const s3ClientDef = `
const s3Client = new S3Client({
    region: 'auto',
    endpoint: \`https://\${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com\`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});
`;
    content = content.replace(insertAfter, insertAfter + s3ClientDef);
    console.log('✅ s3Client define ho gaya.');
} else {
    console.log('✅ s3Client pehle se defined hai.');
}

fs.writeFileSync('bot.js', content);
