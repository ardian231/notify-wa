const express = require('express');
require('dotenv').config();
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const dotenv = require('dotenv');
const Groq = require('groq-sdk');
const serviceAccount = require('./firebase-key.json');

console.log('GROQ_API_KEY:', process.env.GROQ_API_KEY ? '[FOUND]' : '[NOT FOUND]');


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

  const systemPrompt = `
Kamu adalah chatbot untuk Adira Finance yang bertugas mengidentifikasi intent dari pesan pengguna.
Kamu hanya mengembalikan satu kata intent saja, dalam huruf kecil, dan hanya salah satu dari daftar ini:

bantuan, cara_bayar, customer_support, default, greeting, harga, produk, simulasi, status, syarat_reseller

Berikut contoh pemetaan pesan ke intent:

- "Halo" → greeting  
- "Apa saja produk Adira?" → produk  
- "Bagaimana cara bayar cicilan?" → cara_bayar  
- "Saya ingin tahu syarat menjadi reseller" → syarat_reseller  
- "Bisa bantu saya?" → bantuan  
- "Status pengajuan saya bagaimana?" → status  
- "Saya ingin simulasi kredit" → simulasi  
- "Saya mau kontak customer service" → customer_support

Jika pesan tidak sesuai atau tidak jelas, balas 'default'.
`;

  try {
    const response = await groq.chat.completions.create({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
      ],
      temperature: 0.2,
    });

    let intent = response.choices[0].message.content.toLowerCase().trim();

    const validIntents = ['bantuan', 'cara_bayar', 'customer_support', 'default', 'greeting', 'harga', 'produk', 'simulasi', 'status', 'syarat_reseller'];
    if (!validIntents.includes(intent)) {
      intent = 'default';
    }

    console.log(`[Chatbot] User message: "${message}"`);
    console.log(`[Chatbot] Detected intent: "${intent}"`);

    const doc = await db.collection('chatbot_responses').doc(intent).get();

    if (doc.exists) {
      return res.json({ reply: doc.data().response });
    } else {
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
