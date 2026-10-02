const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

const apiId = 35399167;
const apiHash = "88a34526a5e73078110072770dd85e5b";
const stringSession = new StringSession("");

(async () => {
  console.log("Loading Telegram Session Generator...");
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await ask("Apna Phone Number Dalein (+91...): "),
    password: async () => await ask("2FA Password (agar ho to, nahi to Enter): "),
    phoneCode: async () => await ask("Telegram OTP Code: "),
    onError: (err) => console.log(err),
  });

  console.log("\n================ AAPKA SESSION STRING ================\n");
  console.log(client.session.save());
  console.log("\n======================================================\n");
  rl.close();
  process.exit(0);
})();
