// === index.js ===
const { startSock } = require('./services/whatsapp');

startSock();

// === config/firebase.js ===
const { initializeApp, cert } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const serviceAccount = require('../firebase-key.json');

initializeApp({
  credential: cert(serviceAccount),
  databaseURL: "https://reseller-form-a616f-default-rtdb.asia-southeast1.firebasedatabase.app/"
});

module.exports = getDatabase();

// === helpers/normalizer.js ===
function normalizePhoneNumber(rawNumber) {
  return rawNumber.trim().replace(/^0/, '62');
}

module.exports = { normalizePhoneNumber };

// === helpers/delay.js ===
module.exports = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// === helpers/storage.js ===
const fs = require('fs');
const path = require('path');

const sentMessagesPath = path.join(__dirname, '..', 'sentMessages.json');
const backupDir = path.join(__dirname, '..', 'backups');
if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);

let sentMessages = new Set();
if (fs.existsSync(sentMessagesPath)) {
  try {
    const saved = JSON.parse(fs.readFileSync(sentMessagesPath, 'utf-8'));
    sentMessages = new Set(saved);
  } catch (err) {
    console.error('Gagal load sentMessages cache:', err.message);
  }
}

function saveSentMessages() {
  try {
    const data = JSON.stringify([...sentMessages], null, 2);
    fs.writeFileSync(sentMessagesPath, data, 'utf-8');

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `sentMessages_backup_${timestamp}.json`);
    fs.writeFileSync(backupPath, data, 'utf-8');

    console.log(`Pesan disimpan & backup dibuat: ${backupPath}`);
  } catch (err) {
    console.error('Gagal simpan cache atau backup:', err.message);
  }
}

module.exports = { sentMessages, saveSentMessages };

// === services/messageSender.js ===
const { normalizePhoneNumber } = require('../helpers/normalizer');
const { sentMessages, saveSentMessages } = require('../helpers/storage');
const delay = require('../helpers/delay');

let sock;
let isReady = false;
const messageQueue = [];

function setSocket(s) {
  sock = s;
}

function setReady(value) {
  isReady = value;
}

async function kirimPesan(rawNumber, message, tag = '') {
  if (!rawNumber || !message) return;
  const phoneNumber = normalizePhoneNumber(rawNumber);
  const messageKey = `${tag}_${phoneNumber}_${message}`;

  if (sentMessages.has(messageKey)) {
    console.log(`Lewati (sudah terkirim): ${messageKey}`);
    return;
  }

  const payload = { phoneNumber, message, tag };
  if (!isReady) {
    messageQueue.push(payload);
    console.log(`Ditunda: ${tag} - ${phoneNumber}`);
    return;
  }

  for (let i = 0; i < 3; i++) {
    try {
      await sock.sendMessage(`${phoneNumber}@s.whatsapp.net`, { text: message });
      console.log(`Pesan dikirim ${tag}: ${phoneNumber}`);
      sentMessages.add(messageKey);
      saveSentMessages();
      return;
    } catch (err) {
      console.error(`Gagal kirim (${i + 1}/3): ${tag} - ${phoneNumber}`, err.message || err);
      await delay(1500);
    }
  }

  console.error(`Gagal total kirim: ${tag} - ${phoneNumber}`);
}

async function processMessageQueue() {
  for (const msg of messageQueue) {
    await kirimPesan(msg.phoneNumber, msg.message, msg.tag);
  }
  messageQueue.length = 0;
}

module.exports = { kirimPesan, setSocket, setReady, processMessageQueue };

// === services/whatsapp.js ===
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const { kirimPesan, setSocket, setReady, processMessageQueue } = require('./messageSender');
const setupFirebaseListeners = require('./firebaseListeners');
const setupChatbotHandler = require('./chatbotHandler');

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const sock = makeWASocket({ auth: state, printQRInTerminal: false });

  setSocket(sock);
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) qrcode.generate(qr, { small: true });

    if (connection === 'close') {
      setReady(false);
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
        : true;
      console.log('Connection closed. Reconnecting...', shouldReconnect);
      if (shouldReconnect) startSock();
    } else if (connection === 'open') {
      setReady(true);
      console.log('Terhubung ke WhatsApp!');
      await processMessageQueue();
    }
  });

  setupFirebaseListeners(sock);
  setupChatbotHandler(sock);
}

module.exports = { startSock };
