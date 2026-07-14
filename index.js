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

async function askGemini(chatId, userText, knownName, knownPhone) {
  const history = getHistory(chatId);

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: buildPrompt(todayString(), knownName, knownPhone),
  });

  const chat = model.startChat({ history });
  const result = await chat.sendMessage(userText);
  const reply = result.response.text();

  history.push({ role: 'user',  parts: [{ text: userText }] });
  history.push({ role: 'model', parts: [{ text: reply }] });

  return reply;
}

// Резолвинг @lid → реальный номер и имя (WAHA известный баг: pn иногда null)
const lidCache = new Map(); // lid → { pn, name } | null

async function resolveLid(lid) {
  if (lidCache.has(lid)) return lidCache.get(lid);

  let resolved = null;

  try {
    const resp = await fetch(`${WAHA_URL}/api/${WAHA_SESSION}/lids/${encodeURIComponent(lid)}`, {
      headers: { 'X-Api-Key': WAHA_API_KEY },
    });
    if (resp.ok) {
      const data = await resp.json();
      console.log('[lid] full response (/lids):', JSON.stringify(data));
      const pn   = data?.pn || data?.phoneNumber || null;
      const name = data?.pushname || data?.pushName || data?.name || data?.shortName || null;
      if (pn || name) resolved = { pn, name };
    }
  } catch (e) {
    console.error('[resolveLid] /lids failed:', e.message);
  }

  if (!resolved) {
    try {
      const contactId = lid.replace('@lid', '') + '@lid';
      const resp = await fetch(
        `${WAHA_URL}/api/contacts/about?contactId=${encodeURIComponent(contactId)}&session=${WAHA_SESSION}`,
        { headers: { 'X-Api-Key': WAHA_API_KEY } }
      );
      if (resp.ok) {
        const data = await resp.json();
        console.log('[lid] full response (/contacts/about):', JSON.stringify(data));
        const pn   = data?.pn || data?.phoneNumber || null;
        const name = data?.pushname || data?.pushName || data?.name || data?.shortName || null;
        if (pn || name) resolved = { pn, name };
      }
    } catch (e) {
      console.error('[resolveLid] /contacts/about failed:', e.message);
    }
  }

  lidCache.set(lid, resolved);
  return resolved;
}

// Доп. запрос по уже резолвнутому chatId (например, 972...@c.us) —
// пробуем добрать имя, если /lids или /contacts/about по lid его не дали
async function fetchContactAbout(chatId) {
  try {
    const resp = await fetch(
      `${WAHA_URL}/api/contacts?contactId=${encodeURIComponent(chatId)}&session=${WAHA_SESSION}`,
      { headers: { 'X-Api-Key': WAHA_API_KEY } }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    console.log('[contact] full response:', JSON.stringify(data));
    const name = data?.shortName || data?.name || null;
    return name;
  } catch (e) {
    console.error('[fetchContactAbout] failed:', e.message);
    return null;
  }
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

  const rawChatId = payload?.from;
  let text         = payload?.body || '';
  let isVoice      = false;

  if (!rawChatId || rawChatId.endsWith('@g.us') || payload?.fromMe) return;
  if (NATALIA_NUMBERS.includes(rawChatId)) {
    console.log(`[skip] message from Natalia's own number ${rawChatId}`);
    return;
  }

  // sendTo — всегда исходный chatId из webhook (гарантированно валиден для WAHA sendText).
  // displayId/knownName — резолвим из @lid, если возможно, для истории и уведомления Натали.
  const sendTo = rawChatId;
  let displayId = rawChatId;
  let knownName = null;
  let knownPhone = null;

  if (rawChatId.endsWith('@lid')) {
    const resolved = await resolveLid(rawChatId);
    if (resolved?.pn) {
      knownPhone = resolved.pn;
      displayId = resolved.pn.endsWith('@c.us') ? resolved.pn : `${resolved.pn}@c.us`;
      console.log(`[lid] resolved ${rawChatId} → ${displayId}`);
    } else {
      console.log(`[lid] could not resolve pn for ${rawChatId} (known WAHA bug), falling back to manual name/phone`);
    }
    if (resolved?.name) {
      knownName = resolved.name;
    }

    // если имени всё ещё нет, но номер добыли — пробуем /contacts/about по реальному chatId
    if (!knownName && displayId !== rawChatId) {
      const aboutName = await fetchContactAbout(displayId);
      if (aboutName) {
        knownName = aboutName;
        console.log(`[contact] got name from /contacts/about: ${aboutName}`);
      }
    }
  }

  if (payload?.hasMedia && String(payload?.mimetype || '').startsWith('audio')) {
    try {
      const audioBuffer = await downloadMedia(payload);
      text = await transcribeVoice(audioBuffer);
      isVoice = true;
      console.log(`[voice] transcribed from=${displayId} text="${text}"`);
    } catch (e) {
      console.error('[voice] transcription failed:', e.message);
      await sendText(sendTo, 'Извините, не удалось распознать голосовое сообщение. Пожалуйста, напишите текстом.');
      return;
    }
  }

  console.log(`[incoming] from=${displayId} text="${text}"`);

  try {
    const reply = await askGemini(displayId, text, knownName, knownPhone);

    if (reply.includes('[[ORDER_COMPLETE]]')) {
      const [clientMsg, orderBlock] = reply.split('[[ORDER_COMPLETE]]');
      // клиенту — только его часть
      await sendText(sendTo, clientMsg.trim());
      // Натали — структурированный заказ
      console.log(`[order] Complete order from ${displayId} — notifying Natalia`);
      const noteBlock = isVoice ? `${orderBlock.trim()}\n\n🎤 (голосовое)` : orderBlock.trim();
      await sendOrderToNatalia(noteBlock, displayId);
      sessions.delete(displayId); // сбрасываем диалог после оформления
    } else {
      await sendText(sendTo, reply.trim());
    }
  } catch (e) {
    console.error('[gemini] error:', e.message);
    await sendText(sendTo, 'Извините, произошла техническая заминка. Пожалуйста, напишите ещё раз.');
  }
});

app.listen(PORT, () => console.log(`chef-bot listening on port ${PORT}`));
