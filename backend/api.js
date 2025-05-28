const express = require('express');
require('dotenv').config();
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const axios = require('axios');
const serviceAccount = require('./firebase-key.json');

console.log('GROQ_API_KEY:', process.env.GROQ_API_KEY ? '[FOUND]' : '[NOT FOUND]');

// === Init Express ===
const app = express();
app.use(express.json());

// === Firebase Init ===
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore(); // Firestore

// === Model fallback dan kuota tracking ===
const models = [
  "llama3-70b-8192",
  "gemma2-9b-it",
  "llama-guard-3-8b",
  "llama3-8b-8192",
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "compound-beta"
];

const modelQuotaStatus = models.reduce((acc, model) => {
  acc[model] = { remainingRequests: Infinity, remainingTokens: Infinity, retryAfter: 0 };
  return acc;
}, {});

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function updateQuotaStatus(model, headers) {
  if (!headers) return;
  const quota = modelQuotaStatus[model];
  if (!quota) return;
  if (headers['x-ratelimit-remaining-requests']) {
    quota.remainingRequests = parseInt(headers['x-ratelimit-remaining-requests'], 10);
  }
  if (headers['x-ratelimit-remaining-tokens']) {
    quota.remainingTokens = parseInt(headers['x-ratelimit-remaining-tokens'], 10);
  }
  if (headers['retry-after']) {
    const retryAfterSec = parseInt(headers['retry-after'], 10);
    quota.retryAfter = Date.now() + retryAfterSec * 1000;
  }
}

async function requestWithFallback(requestData) {
  const now = Date.now();
  for (const model of models) {
    const quota = modelQuotaStatus[model];
    if (quota.retryAfter > now) {
      console.log(`[RateLimit] Model ${model} sedang cooldown sampai ${new Date(quota.retryAfter).toLocaleTimeString()}`);
      continue;
    }
    try {
      const response = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model: model,
          messages: requestData.messages,
          temperature: requestData.temperature ?? 0.2
        },
        {
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.GROQ_API_KEY}`
          }
        }
      );

      updateQuotaStatus(model, response.headers);
      console.log(`[Success] Response dari model: ${model}`);
      return response.data;

    } catch (error) {
      if (error.response && error.response.status === 429) {
        const retryAfterSec = parseInt(error.response.headers['retry-after'] || '60', 10);
        quota.retryAfter = Date.now() + retryAfterSec * 1000;
        quota.remainingRequests = 0;
        quota.remainingTokens = 0;
        console.warn(`[RateLimit] Model ${model} kena limit. Retry setelah ${retryAfterSec} detik.`);
        continue;
      } else {
        console.error(`[Error] Model ${model} gagal dengan error:`, error.message);
        throw error;
      }
    }
  }
  throw new Error("Semua model kena rate limit, coba lagi nanti.");
}

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
    const response = await requestWithFallback({
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
    console.error('❌ Error:', err.message);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// === Start server ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Chatbot API running on http://localhost:${PORT}`);
});
