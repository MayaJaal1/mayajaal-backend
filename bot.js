require("dotenv").config():
const TelegramBot
require("node-telegram-bot-api );
const express require("express");
const axios
require("axios");
require("path");
const fs require("fs");
const path
const
BOT TOKEN,
TELEGRAM CHANNEL_ID,
TELEGRAM BOT_API_BASE_URL = "http://127.0.0.1:8081",
CUSTOM DOMAIN "https://mayajaal.online",
UPSTASH_REDIS_REST_URL,
UPSTASH_REDIS_REST_TOKEN.
TERABOX COOKIE
)
process.envi
if (!BOT TOKEN) [
throw new Error("BOT TOKEN is missing");
]
if (ITELEGRAM_CHANNEL_ID) {
throw new Error("TELEGRAM_CHANNEL ID is missing");
}
const bot
new TelegramBot(BOT_TOKEN, {
baseApiUrl: TELEGRAM_BOT_API_BASE_URL
});
const app express();
const PORT
process.env. PORT 8080/
const BASE_URL
CUSTOM_DOMAIN.replace(/\/+\$/,"")
console.log(
console.log(" MayaJaal Bot Starting...");
console.log("=
console.log(" Telegram Channel:", TELEGRAM_CHANNEL_ID);
console.log(" Local Bot API, TELEGRAM_BOT_API_BASE_URL);
console.log(" Player Domain:", BASE_URL);
console.log("
Video storage: Telegram Channel");
console.log("
console.log('
Cloudflare R2 video upload: DISABLED");
// Redis helpers
17
async function redisCommand(command) {
if (!UPSTASH_REDIS_REST_URL || UPSTASH_REDIS_REST_TOKEN) ( 
return null;
1
const response await axios.post(
UPSTASH_REDIS_REST_URL.
command.
{
headers: (
Authorization: Bearer \$(UPSTASH_REDIS_REST_TOKEN)
"Content-Type": "application/json"
],
timeout: 15000
return response.datai
}
async function redisSet (key, value) {
try {
return await redisCommand ( 
"SET
key.
JSON.stringify(value)
1) 
 catch (error) [
console.error("Redis SET error:", error.message)1
return null;
async function redisGet(key) {
try {
const result await redisCommand([
"GET",
  key
1);
if (tresult || result.result == null) {
return null;
}
return JSON.parse(result.result);
 catch (error) {
console.error("Redis GET error, error.message) 
return null
}
// In-memory cache
H
const videoCache new Map():
async function saveVideo(id, data) {
videoCache.set(id, data);
await redisSet( video:\${id} , data);
}
async function getVideo(id) {
if (videoCache.has(id)) {
return videoCache.get(id):
1
const data await redisGet("video:\$(id))
if (data) {
videoCache.set(id, data) 
}
return datar
}
// ID generator
function generateld(length  10) {
const chars =
"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" 
let result
for (let $i=0i$ i  length i++) {
result + chars.charAt(
Math.floor(Math.random() chars.length)
);
}
return result;
}
11
// HTML escape
11
function escapeHtml (value) {
return String(value**)
.replace(/&/g, "&amp ")
.replace(/</g
,
.replace(/>/g,
.replace(/*/g,
.replace(//g.
"&lt ")
"&gt ")
"&quot")
"&#039;");
// Player page.
app.get("/v/:id", async (req, res) =>  
try
const id
req.params.id/
const data await getVideo(id);
if (!data) {
return res.status(404).send("Video not found");
}
const title
escapeHtml(
"MayaJaal Video"
data.name
const streamUrl =
   \${BASE_URL)/stream/\${encodeURIComponent(id)  
res.setHeader("Content-Type", "text/html; charset utf-8");
res.send("
<!DOCTYPE html>
<html lang $=^{*}en^{\prime\prime}>$
<head>
<meta charset="UTF-8">
<meta name="viewport"
content="width=device-width, initial-scale=1.0">
<title>\$(title)</title>
<style>
html, body (
margin:0;
padding:0;
width:100%;
height:100%;
background: #000;
overflow:hidden;
body{
display: flex;
align-items:centeri
justify-content:centeri
1
video
width:100%;
height:100% 
object-fit:contain 
background: #000;
}
</style>
</head>
<body>
<video
controls
autoplay
playsinline
preload="metadata"
<
<source
src="\$(streamUrl}
type="\${escapeHtml(
data.mimeType "video/mp4"
>
}"
Your browser does not support HTML5 video.
</video>
</body>
</html>
)catch (error) {
console.error("Player error:", error);
res.status(500).send(
"Player error"
}
});
17
// Health check
app.get("/ , (req, res) => {
res.json((
status: online",
bot: "MayaJaal".
storage: "Telegram Channel",
r2: false,
localBot Api: TELEGRAM_BOT_API_BASE_URL,
player: BASE_URL
});
 );
// Video streaming route
11
app.get("/stream/:id", async (req, res) => {
try {
const id
req.params.id 
const data await getVideo(id):
if (!data) {
return res.status(404).send("Video not found");
}
// Telegram video
if (data.telegramFileId) {
const fileInfo await bot.getFile(
data.telegramFileld
if (!fileInfo
IfileInfo.file_path) {
return res.status(404).send(
"Telegram file path unavailable"
}
const filePath
fileInfo.file path:
if (!path, isAbsolute(filePath)) {
return res.status(500).send(
"Local Bot API did not return an absolute file path
};
}
if (!fs.existsSync(filePath)) {
return res.status(404).send(
"Telegram local file is not available"
const stat
fs.statSync(filePath);
const fileSize
const range
res.setHeader(
stat.size)
req.headers.range:
"Accept-Ranges",
"bytes'
res.setHeader(
"Content-Type"
data.mimeType "video/mp4"
};
// Cloudflare proxy can serve the stream,
// but it will not be used as permanent storage.
res.setHeader(
"Cache-Control",
"no-store, no-cache, must-revalidate"
if (range) (
const match range.match(
/bytes=(\d+)-(\d+)/
if ( match) [
return res.status(416).send(
"Invalid Range"
let start
match[1]
? parseInt(match[1], 10)
01
let end match[2]
? parseInt(match[2], 10)
: fileSize
17
if (start >= fileSize) {
res.setHeader(
 Content-Range",
bytes /\${fileSize) 
return res.status(416).end();
}
if (end > fileSize) {
end fileSize 17
const chunkSize
end start + 1 
res.status(206);
res.setHeader(
"Content-Range",
  bytes \$ start)-\$ end}/\${fileSize}
res.setHeader(
"Content-Length"
chunkSize
const stream =
fs.createReadStream(
filePath,
{
start,
end
}
 
stream.on("error", (error) => {
console.error(
"Telegram stream error:",
error.message
if (tres.headersSent) (
res.status(500).end();
} else {
res.destroy();
}
});
return stream.pipe(res);
1
res.status(200) 
res.setHeader(
"Content-Length",
fileSize
const stream
fs.createReadStream(filePath):
stream.on("error", (error) => {
console.error(
"Telegram stream error:",
error message
if (!res.headersSent) {
res.status(500).end();
 else  
res.destroy();
1
return stream.pipe(res);
}
// Terabox streaming
if (data.url) {
const headers
[};
if (req.headers.range) {
headers. Range
req.headers.range:
if (TERABOX_COOKIE) {
headers. Cookie
TERABOX_COOKIE 
}
const response
await axios({
method:  GET",
url: data.url,
headers,
responseType: "stream",
validateStatus: () => true
res.status(
response.status
if (response.headers["content-type"]) [
res.setHeader(
"Content-Type",
response.headers  content-type  
}
if (response.headers["content-length"]) {
res.setHeader(
"Content-Length",
response.headers[ content-length"]
}
if (response.headers["content-range ]) {
res.setHeader(
"Content-Range",
response.headers content-range*]
);
res.setHeader(
 Accept-Ranges",
"bytes"
return response.data.pipe(res);
}
return res.status(404).send(
"No playable source found"
 catch (error) {
console.error(
"Stream error:",
error message
);
if (!res.headersSent) {
return res.status(500).send(
"Unable to stream video
1
res.destroy())
 );
  
