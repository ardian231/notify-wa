// === Import Dependencies ===
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const { initializeApp, cert } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { getFirestore } = require('firebase-admin/firestore');
const axios = require('axios');

// === Inisialisasi Firebase ===
const serviceAccount = require('./firebase-key.json');
initializeApp({
  credential: cert(serviceAccount),
  databaseURL: "https://reseller-form-a616f-default-rtdb.asia-southeast1.firebasedatabase.app"
});
const db = getDatabase();
const firestore = getFirestore();

// === Utilitas ===
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const logError = async (context, error) => {
  await firestore.collection('logs').add({
    context,
    error: error?.message || String(error),
    timestamp: new Date().toISOString()
  });
};
const simpanPesanGagal = async (payload, reason = '') => {
  await firestore.collection('failed_messages').add({
    ...payload,
    reason,
    timestamp: new Date().toISOString()
  });
};
const simpanPesanTerkirim = async ({ messageKey, phoneNumber, message, tag }) => {
  await firestore.collection('sent_messages').doc(messageKey).set({
    phoneNumber,
    message,
    tag,
    timestamp: new Date().toISOString()
  });
};

const cekPesanTerkirim = async (messageKey) => {
  const doc = await firestore.collection('sent_messages').doc(messageKey).get();
  return doc.exists;
};
const getMessageTemplate = async (key, data = {}) => {
  try {
    const doc = await firestore.collection('templates').doc(key).get();
    if (!doc.exists) {
      console.log(`Template tidak ditemukan: ${key}`);
      return null;
    }
    const templateData = doc.data();
    let template = templateData.text || templateData.message || '';
    console.log('Template asli:', template);

    for (const [k, v] of Object.entries(data)) {
      template = template.replace(new RegExp(`{{\\s*${k}\\s*}}`, 'g'), v);
    }
    console.log('Template setelah replace:', template);

    return template;
  } catch (err) {
    await logError('getMessageTemplate', err);
    return null;
  }
};



// === WhatsApp Sender Logic ===
let sock, isReady = false, messageQueue = [];

const kirimPesan = async (rawNumber, message, tag = '') => {
  if (!rawNumber || !message) return;
  const phoneNumber = rawNumber.trim().replace(/^0/, '62');
  const messageKey = `${tag}_${phoneNumber}_${message}`;
  if (await cekPesanTerkirim(messageKey)) return console.log(`⏩ Lewati: ${messageKey}`);

  const payload = { phoneNumber, message, tag };
  if (!isReady) return messageQueue.push(payload);

  for (let i = 0; i < 3; i++) {
    try {
      await sock.sendMessage(`${phoneNumber}@s.whatsapp.net`, { text: message });
      console.log(`Pesan terkirim: ${tag} ke ${phoneNumber}`);
      // Simpan log lengkap pesan yang dikirim:
      await simpanPesanTerkirim({ messageKey, phoneNumber, message, tag });
      return;
    } catch (err) {
      console.error(`Gagal kirim (${i + 1}/3): ${tag} - ${phoneNumber}`, err.message);
      await delay(1500);
    }
  }

  console.error(`Gagal total kirim: ${tag} - ${phoneNumber}`);
  await simpanPesanGagal(payload, 'Gagal kirim pesan');
};


// === Event Handler DB ===
const handleRealtimeEvents = () => {
  // Pesan saat order baru masuk
  db.ref('orders').on('child_added', async (snap) => {
  console.log('child_added orders event triggered', snap.key);
  const data = snap.val();
  if (!data?.phone || !data?.name) {
    console.log('Data tidak lengkap:', data);
    return;
  }
  const msg = await getMessageTemplate('order_added', { name: data.name });
  console.log('Template pesan:', msg);
  if (msg) {
    console.log(`Mengirim pesan ke ${data.phone}`);
    await kirimPesan(data.phone, msg, `order_added_${snap.key}`);
  } else {
    console.log('Pesan template kosong, skip kirim pesan');
  }
});


  // Pesan saat status order berubah
  db.ref('orders').on('child_changed', async (snap) => {
    const data = snap.val();
    if (!data?.phone || !data?.status || !data?.name) return;

    const status = data.status.toLowerCase();
    const tag = `order_changed_${snap.key}_${status}`;

    // Pakai template order_status_{status}
    const customerMsg = await getMessageTemplate(`order_status_${status}`, { name: data.name });
    const agentMsg = await getMessageTemplate(`order_status_${status}`, { name: data.name });

    if (customerMsg) await kirimPesan(data.phone, customerMsg, `${tag}_cust`);
    if (agentMsg && data.agentPhone) await kirimPesan(data.agentPhone, agentMsg, `${tag}_agent`);
  });

  // Pesan saat agen baru daftar
  db.ref('agent-form').on('child_added', async (snap) => {
    const data = snap.val();
    if (!data?.phone || !data?.fullName) return;
    const msg = await getMessageTemplate('agent_added', { name: data.fullName });
    if (msg) await kirimPesan(data.phone, msg, `agent_added_${snap.key}`);
  });

  // Pesan saat status agen berubah
  db.ref('agent-form').on('child_changed', async (snap) => {
    const data = snap.val();
    if (!data?.phone || !data?.status || !data?.fullName) return;

    const status = data.status.toLowerCase();
    const msg = await getMessageTemplate(`agent_status_${status}`, { name: data.fullName });
    if (msg) await kirimPesan(data.phone, msg, `agent_changed_${snap.key}_${status}`);
  });
};

const printTemplates = async () => {
  const snapshot = await firestore.collection('templates').get();
  const keys = snapshot.docs.map(doc => doc.id);
  console.log('Templates in Firestore:', keys);
};
printTemplates();

// === WhatsApp Socket Connection ===
const startSock = async () => {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  sock = makeWASocket({ auth: state, printQRInTerminal: false });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) qrcode.generate(qr, { small: true });
    if (connection === 'close') {
      isReady = false;
      const shouldReconnect = !(lastDisconnect?.error instanceof Boom) ||
        lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Disconnected. Reconnecting...', shouldReconnect);
      if (shouldReconnect) await startSock();
    } else if (connection === 'open') {
      isReady = true;
      console.log('Terhubung ke WhatsApp');
      if (messageQueue.length) {
        console.log(`Mengirim ${messageQueue.length} pesan tertunda...`);
        for (const msg of messageQueue) {
          await kirimPesan(msg.phoneNumber, msg.message, msg.tag);
        }
        messageQueue = [];
      }
    }
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
      await sock.sendMessage(sender, { text: 'Maaf, terjadi kesalahan saat memproses pesan kamu.' });
    }
  });

  handleRealtimeEvents();
};

startSock();
