const express = require('express');
const mongoose = require('mongoose');

const app = express();
app.use(express.json());

// MongoDB Connection (Yahan apni MONGO_URI daal dena, password ke sath)
const MONGO_URI = process.env.MONGO_URI || "YAHAN_APNI_MONGO_URI_DALNA";

mongoose.connect(MONGO_URI)
  .then(() => console.log("MongoDB Connected Successfully"))
  .catch(err => console.log("DB Error: ", err));

// Database Schema
const userSchema = new mongoose.Schema({
  telegramId: String,
  apiKey: String,
  views: { type: Number, default: 0 },
  earnings: { type: Number, default: 0 }
});
const User = mongoose.model('User', userSchema);

// 1. Home Page / API Key Generator Route
app.get('/', async (req, res) => {
  const telegramId = req.query.id;
  if (!telegramId) {
    return res.send("<h1>MayaJaal Platform</h1><p>Apna Telegram ID bhejiye API key lene ke liye. Jaise: ?id=YOUR_TELEGRAM_ID</p>");
  }

  let user = await User.findOne({ telegramId });
  if (!user) {
    const apiKey = 'mj_' + Math.random().toString(36.substring(2)) + Date.now().toString(36);
    user = new User({ telegramId, apiKey });
    await user.save();
  }

  res.send(`<h1>Aapki API Key</h1><p><b>${user.apiKey}</b></p><p>Ise apne Telegram bot me use karein.</p>`);
});

// Server Listen
app.listen(3000, () => console.log("Server running on port 3000"));
