/*

📝 | Edited By: Sins.Outlaw
🖥️ | Base Ori By: Trashcore 
📌 | Credits: Putrazy Xd
📱 | WhatsApp: +2347086412154
👑 | Github: Blackbrood
✉️ | Email: victorolutayo3@gmail.com
*/

const fs = require('fs');
const pino = require('pino');
const readline = require('readline');
const path = require('path');
const chalk = require('chalk');
const { exec } = require('child_process');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
  downloadContentFromMessage,
  jidDecode
} = require('@whiskeysockets/baileys');
const handleCommand = require('./case');
const config = require('./config');

// 🌈 Console helpers
const log = {
  info: (msg) => console.log(chalk.cyanBright(`[INFO] ${msg}`)),
  success: (msg) => console.log(chalk.greenBright(`[SUCCESS] ${msg}`)),
  error: (msg) => console.log(chalk.redBright(`[ERROR] ${msg}`)),
  warn: (msg) => console.log(chalk.yellowBright(`[WARN] ${msg}`))
};

// 🧠 Readline setup
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function question(query) {
  return new Promise(resolve => rl.question(query, ans => resolve(ans.trim())));
}

// 🚀 Start socket
async function starttrashcore() {
  const store = makeInMemoryStore({
    logger: pino().child({ level: 'silent', stream: 'store' })
  });

  const { state, saveCreds } = await useMultiFileAuthState('./session');
  const { version } = await fetchLatestBaileysVersion();

  const trashcore = makeWASocket({
    version,
    keepAliveIntervalMs: 10000,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }).child({ level: 'silent' }))
    },
    browser: ["Ubuntu", "Chrome", "20.0.00"]
  });

  trashcore.ev.on('creds.update', saveCreds);

  // Pairing code
  if (!trashcore.authState.creds.registered) {
    const phoneNumber = await question(chalk.yellowBright("[ = ] Enter your WhatsApp number (with country code):\n"));
    const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
    console.clear();

    const pairCode = await trashcore.requestPairingCode(cleanNumber);
    log.info(`Enter this code on your phone to pair: ${chalk.green(pairCode)}`);
    log.info("⏳ Wait a few seconds and approve the pairing on your phone...");
  }

  // Connection handling
  trashcore.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
      log.error('Connection closed.');
      if (shouldReconnect) starttrashcore();
    } else if (connection === 'open') {
      const botNumber = trashcore.user.id.split("@")[0];
      log.success(`Escanor connected as ${chalk.green(botNumber)}`);
      rl.close();

      // ✅ Send DM to owner
      setTimeout(async () => {
        const ownerJid = `${botNumber}@s.whatsapp.net`;
        const message = `
🔥 *Escanor Bot Connected Successfully!*

👑 *Owner:* Sins.Outlaw
⚙️ *Version:* 1.0.0
📱 *Number:* ${botNumber}

✨ Type *menu* to see commands!
`;
        try {
          await trashcore.sendMessage(ownerJid, { text: message });
          log.success(`Sent DM to paired number (${botNumber})`);
        } catch (err) {
          log.error(`Failed to send DM: ${err}`);
        }
      }, 2000);

      trashcore.isPublic = true;
    }
  });

  // (Everything else remains unchanged — handlers, anti features, etc.)

}

starttrashcore();
