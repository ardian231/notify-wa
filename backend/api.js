const express = require('express');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const dotenv = require('dotenv');
const Groq = require('groq-sdk');
const serviceAccount = require('./firebase-key.json');

// === Load .env ===
dotenv.config();

// === Init Express ===
const app = express();
app.use(express.json());

// === Firebase Init ===
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore(); // Firestore

// === GROQ Init ===
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// === Endpoint chatbot ===
app.post('/api/chatbot', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'No message provided' });

  try {
    // === Kirim prompt ke GROQ untuk identifikasi intent ===
    const response = await groq.chat.completions.create({
      model: 'mixtral-8x7b-32768',
      messages: [
        {
          role: 'system',
          content: 'Kamu hanya mengembalikan nama intent seperti: greeting, harga, produk, bantuan, status, dst. Tanpa penjelasan.'
        },
        {
          role: 'user',
          content: message
        }
      ]
    });

    // Ambil hasil intent dan bersihkan
    let intent = response.choices[0].message.content.toLowerCase().replace(/^intent:\s*/i, '').trim();

    // Cari intent di Firestore
    const doc = await db.collection('chatbot_responses').doc(intent).get();

    if (doc.exists) {
      return res.json({ reply: doc.data().response });
    } else {
      // Coba fallback ke 'default'
      const fallbackDoc = await db.collection('chatbot_responses').doc('default').get();
      return res.json({
        reply: fallbackDoc.exists ? fallbackDoc.data().response : 'Maaf, saya belum punya jawaban untuk itu.'
      });
    }

  } catch (err) {
    console.error('❌ Error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// === Start server ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Chatbot API running on http://localhost:${PORT}`);
});
