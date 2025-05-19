// === Import Library yang Dibutuhkan ===
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const { initializeApp, cert } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
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

// === Setup Cache & Backup Pesan yang Sudah Terkirim ===
const sentMessagesPath = path.join(__dirname, 'sentMessages.json');
const backupDir = path.join(__dirname, 'backups');
if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);

// Load pesan yang sudah pernah dikirim dari file JSON
let sentMessages = new Set();
if (fs.existsSync(sentMessagesPath)) {
  try {
    const saved = JSON.parse(fs.readFileSync(sentMessagesPath, 'utf-8'));
    sentMessages = new Set(saved);
  } catch (err) {
    console.error('Gagal load sentMessages cache:', err.message);
  }
}

// Simpan cache pesan terkirim + buat backup cadangan
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

let sock;               // Instance socket WhatsApp
let isReady = false;    // Status apakah socket siap digunakan
let messageQueue = [];  // Antrian pesan jika socket belum siap

const delay = ms => new Promise(resolve => setTimeout(resolve, ms)); // Fungsi delay (untuk retry)

// Fungsi utama untuk kirim pesan WhatsApp
const kirimPesan = async (rawNumber, message, tag = '') => {
  if (!rawNumber || !message) return;

  // Normalisasi nomor (ganti awalan 0 ke 62)
  const phoneNumber = rawNumber.trim().replace(/^0/, '62');
  const messageKey = `${tag}_${phoneNumber}_${message}`;

  // Skip jika pesan ini sudah pernah dikirim
  if (sentMessages.has(messageKey)) {
    console.log(`Lewati (sudah terkirim): ${messageKey}`);
    return;
  }

  const payload = { phoneNumber, message, tag };

  // Masukkan ke antrian jika koneksi belum siap
  if (!isReady) {
    messageQueue.push(payload);
    console.log(`Ditunda: ${tag} - ${phoneNumber}`);
    return;
  }

  // Coba kirim pesan maksimal 3 kali
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

// Fungsi utama untuk menjalankan socket WhatsApp
async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  // Listener untuk koneksi WhatsApp
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) qrcode.generate(qr, { small: true }); // Tampilkan QR code di terminal

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

      // Kirim semua pesan yang tertunda
      if (messageQueue.length > 0) {
        console.log(`Mengirim ${messageQueue.length} pesan tertunda...`);
        for (const msg of messageQueue) {
          await kirimPesan(msg.phoneNumber, msg.message, msg.tag);
        }
        messageQueue = [];
      }
    }
  });

  // === Listener untuk node 'orders' di Firebase ===
  const ordersRef = db.ref('orders');

  // Saat ada pengajuan baru ditambahkan
  ordersRef.on('child_added', async (snapshot) => {
    const data = snapshot.val();
    if (!data?.phone || !data?.name) return;

    const msg = `Pengajuan dari *${data.name}* berhasil dikirim!`;
    await kirimPesan(data.phone, msg, `order_added_${snapshot.key}`);
  });

  // Saat status pengajuan berubah
  ordersRef.on('child_changed', async (snapshot) => {
    const data = snapshot.val();
    if (!data?.phone || !data?.status || !data?.name) return;

    const customerMsg = {
      diterima: `Pengajuan *${data.name}* telah *diterima*!`,
      diproses: `Pengajuan *${data.name}* sedang *diproses*!`,
      ditolak: `Pengajuan *${data.name}* *ditolak*. Silakan hubungi admin.`,
      dibatalkan: `Pengajuan *${data.name}* telah *dibatalkan*.`,
    };

    const agentMsg = {
      diterima: `Pengajuan dari *${data.name}* telah *disetujui*!`,
      ditolak: `Pengajuan dari *${data.name}* telah *ditolak*.`,
      dibatalkan: `Pengajuan dari *${data.name}* telah *dibatalkan*.`,
    };

    const status = data.status.toLowerCase();
    const tagPrefix = `order_changed_${snapshot.key}_${status}`;

    // Kirim ke customer
    if (customerMsg[status]) {
      await kirimPesan(data.phone, customerMsg[status], `${tagPrefix}_cust`);
    }

    // Kirim ke agen jika ada nomor agen
    if (agentMsg[status] && data.agentPhone) {
      await kirimPesan(data.agentPhone, agentMsg[status], `${tagPrefix}_agent`);
    }
  });

  // === Listener untuk node 'agent-form' di Firebase ===
  const agentFormRef = db.ref('agent-form');

  // Saat ada agen baru mendaftar
  agentFormRef.on('child_added', async (snapshot) => {
    const data = snapshot.val();
    if (!data?.phone || !data?.fullName) return;

    const msg = `Pendaftaran agen *${data.fullName}* berhasil dikirim!`;
    await kirimPesan(data.phone, msg, `agen_added_${snapshot.key}`);
  });

  // Saat status pendaftaran agen berubah
  agentFormRef.on('child_changed', async (snapshot) => {
    const data = snapshot.val();
    if (!data?.phone || !data?.status || !data?.fullName) return;

    const status = data.status.toLowerCase();
    const name = data.fullName;

    let message = '';
    if (status === 'diproses') {
      message = `Pendaftaran *${name}* sedang *diproses*. Mohon tunggu ya.`;
    } else if (status === 'diterima') {
      message = `Selamat *${name}*, kamu telah diterima sebagai agen!`;
    } else if (status === 'ditolak') {
      message = `Maaf *${name}*, pendaftaran kamu sebagai agen ditolak.`;
    } else {
      message = `Data agen *${name}* telah diperbarui.`;
    }

    await kirimPesan(data.phone, message, `agen_changed_${snapshot.key}_${status}`);
  });

  // === Handler Pesan Masuk (Chatbot) ===
  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

    try {
      // Kirim ke API chatbot lokal dan kirim balik hasilnya
      const res = await axios.post('http://localhost:3000/api/chatbot', {
        message: text,
        sender: sender
      });

      await sock.sendMessage(sender, { text: res.data.reply });
    } catch (err) {
      console.error("Error chatbot:", err.message);
      await sock.sendMessage(sender, { text: "Maaf, terjadi kesalahan saat memproses pesan kamu." });
    }
  });
}

// === Jalankan Socket WhatsApp ===
startSock();
