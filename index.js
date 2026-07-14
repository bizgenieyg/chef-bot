require('dotenv').config();
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const buildPrompt = require('./prompt');
const { sendOrderToNatalia } = require('./services/notify');
const { transcribeVoice } = require('./services/transcribe');

const app = express();
app.use(express.json());

const PORT         = 3006;
const WAHA_URL     = 'http://localhost:3003';
const WAHA_API_KEY = process.env.WAHA_API_KEY || 'blaster123';
const WAHA_SESSION = process.env.WAHA_SESSION || 'default';

// Номер самой Натали — её сообщения не обрабатываем как заказ клиента
const NATALIA_NUMBERS = ['972587958060@c.us', '972559598952@c.us'];

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// История диалогов в памяти: chatId → [{role, parts}]
const sessions = new Map();

function getHistory(chatId) {
  if (!sessions.has(chatId)) sessions.set(chatId, []);
  return sessions.get(chatId);
}

function todayString() {
  return new Date().toLocaleDateString('ru-RU', {
    timeZone: 'Asia/Jerusalem',
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

async function askGemini(chatId, userText) {
  const history = getHistory(chatId);

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: buildPrompt(todayString()),
  });

  const chat = model.startChat({ history });
  const result = await chat.sendMessage(userText);
  const reply = result.response.text();

  history.push({ role: 'user',  parts: [{ text: userText }] });
  history.push({ role: 'model', parts: [{ text: reply }] });

  return reply;
}

async function downloadMedia(payload) {
  // WAHA (NOWEB) отдаёт прямую ссылку на вложение в payload.media.url
  const mediaUrl = payload?.media?.url;
  if (!mediaUrl) throw new Error('no media.url in payload');

  const resp = await fetch(mediaUrl, {
    headers: { 'X-Api-Key': WAHA_API_KEY },
  });
  if (!resp.ok) throw new Error(`media download failed: ${resp.status}`);

  const arrayBuffer = await resp.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function sendText(chatId, text) {
  try {
    const resp = await fetch(`${WAHA_URL}/api/sendText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': WAHA_API_KEY },
      body: JSON.stringify({ session: WAHA_SESSION, chatId, text }),
    });
    if (!resp.ok) console.error(`[sendText] ${resp.status}`, await resp.text());
  } catch (e) {
    console.error('[sendText] error:', e.message);
  }
}

// POST /webhook — входящие сообщения от WAHA
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  const event   = req.body?.event;
  const payload = req.body?.payload;

  if (event !== 'message') return;

  const chatId = payload?.from;
  let text      = payload?.body || '';
  let isVoice   = false;

  if (!chatId || chatId.endsWith('@g.us') || payload?.fromMe) return;
  if (NATALIA_NUMBERS.includes(chatId)) {
    console.log(`[skip] message from Natalia's own number ${chatId}`);
    return;
  }

  if (payload?.hasMedia && String(payload?.mimetype || '').startsWith('audio')) {
    try {
      const audioBuffer = await downloadMedia(payload);
      text = await transcribeVoice(audioBuffer);
      isVoice = true;
      console.log(`[voice] transcribed from=${chatId} text="${text}"`);
    } catch (e) {
      console.error('[voice] transcription failed:', e.message);
      await sendText(chatId, 'Извините, не удалось распознать голосовое сообщение. Пожалуйста, напишите текстом.');
      return;
    }
  }

  console.log(`[incoming] from=${chatId} text="${text}"`);

  try {
    const reply = await askGemini(chatId, text);

    if (reply.includes('[[ORDER_COMPLETE]]')) {
      const [clientMsg, orderBlock] = reply.split('[[ORDER_COMPLETE]]');
      // клиенту — только его часть
      await sendText(chatId, clientMsg.trim());
      // Натали — структурированный заказ
      console.log(`[order] Complete order from ${chatId} — notifying Natalia`);
      const noteBlock = isVoice ? `${orderBlock.trim()}\n\n🎤 (голосовое)` : orderBlock.trim();
      await sendOrderToNatalia(noteBlock, chatId);
      sessions.delete(chatId); // сбрасываем диалог после оформления
    } else {
      await sendText(chatId, reply.trim());
    }
  } catch (e) {
    console.error('[gemini] error:', e.message);
    await sendText(chatId, 'Извините, произошла техническая заминка. Пожалуйста, напишите ещё раз.');
  }
});

app.listen(PORT, () => console.log(`chef-bot listening on port ${PORT}`));
