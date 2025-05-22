// === Import Library yang Dibutuhkan ===
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const { initializeApp, cert } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { getFirestore } = require('firebase-admin/firestore');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// === Inisialisasi Firebase Admin SDK ===
const serviceAccount = require('./firebase-key.json');
initializeApp({
  credential: cert(serviceAccount),
  databaseURL: "https://reseller-form-a616f-default-rtdb.asia-southeast1.firebasedatabase.app/"
});
const db = getDatabase();
const firestore = getFirestore();

// === Setup Cache & Backup Pesan yang Sudah Terkirim ===
const sentMessagesPath = path.join(__dirname, 'sentMessages.json');
const backupDir = path.join(__dirname, 'backups');
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

const saveSentMessages = () => {
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
};

let sock;
let isReady = false;
let messageQueue = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// === Fungsi ambil dan isi template pesan dari Firestore ===
const getMessageTemplate = async (key, data = {}) => {
  try {
    const doc = await firestore.collection('templates').doc(key).get();
    if (!doc.exists) return null;

    let template = doc.data().text || '';
    for (const [k, v] of Object.entries(data)) {
      template = template.replace(new RegExp(`{${k}}`, 'g'), v);
    }
    return template;
  } catch (err) {
    console.error('Gagal ambil template:', key, err.message);
    return null;
  }
};

// === Fungsi utama untuk kirim pesan WhatsApp ===
const kirimPesan = async (rawNumber, message, tag = '') => {
  if (!rawNumber || !message) return;

  const phoneNumber = rawNumber.trim().replace(/^0/, '62');
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
};

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  sock = makeWASocket({ auth: state, printQRInTerminal: false });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) qrcode.generate(qr, { small: true });

    if (connection === 'close') {
      isReady = false;
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
        : true;
      console.log('Connection closed. Reconnecting...', shouldReconnect);
      if (shouldReconnect) startSock();
    } else if (connection === 'open') {
      isReady = true;
      console.log('Terhubung ke WhatsApp!');
      if (messageQueue.length > 0) {
        console.log(`Mengirim ${messageQueue.length} pesan tertunda...`);
        for (const msg of messageQueue) {
          await kirimPesan(msg.phoneNumber, msg.message, msg.tag);
        }
        messageQueue = [];
      }
    }
  });

  db.ref('orders').on('child_added', async (snapshot) => {
    const data = snapshot.val();
    if (!data?.phone || !data?.name) return;
    const msg = await getMessageTemplate('pengajuan_added', { name: data.name });
    if (msg) await kirimPesan(data.phone, msg, `order_added_${snapshot.key}`);
  });

  db.ref('orders').on('child_changed', async (snapshot) => {
    const data = snapshot.val();
    if (!data?.phone || !data?.status || !data?.name) return;
    const status = data.status.toLowerCase();
    const tagPrefix = `order_changed_${snapshot.key}_${status}`;

    const customerMsg = await getMessageTemplate(`pengajuan_${status}_customer`, { name: data.name });
    const agentMsg = await getMessageTemplate(`pengajuan_${status}_agent`, { name: data.name });

    if (customerMsg) await kirimPesan(data.phone, customerMsg, `${tagPrefix}_cust`);
    if (agentMsg && data.agentPhone) await kirimPesan(data.agentPhone, agentMsg, `${tagPrefix}_agent`);
  });

  db.ref('agent-form').on('child_added', async (snapshot) => {
    const data = snapshot.val();
    if (!data?.phone || !data?.fullName) return;
    const msg = await getMessageTemplate('agen_added', { name: data.fullName });
    if (msg) await kirimPesan(data.phone, msg, `agen_added_${snapshot.key}`);
  });

  db.ref('agent-form').on('child_changed', async (snapshot) => {
    const data = snapshot.val();
    if (!data?.phone || !data?.status || !data?.fullName) return;
    const status = data.status.toLowerCase();
    const msg = await getMessageTemplate(`agen_${status}`, { name: data.fullName });
    if (msg) await kirimPesan(data.phone, msg, `agen_changed_${snapshot.key}_${status}`);
  });

  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

    try {
      const res = await axios.post('http://localhost:3000/api/chatbot', { message: text, sender });
      await sock.sendMessage(sender, { text: res.data.reply });
    } catch (err) {
      console.error("Error chatbot:", err.message);
      await sock.sendMessage(sender, { text: "Maaf, terjadi kesalahan saat memproses pesan kamu." });
    }
  });
}

startSock();