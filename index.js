require('dotenv').config();
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const buildSalesPrompt = require('./prompts/sales');
const buildSupportPrompt = require('./prompts/support');
const { sendOrderToNatalia } = require('./services/notify');
const { transcribeVoice } = require('./services/transcribe');
const { withGeminiRetry } = require('./services/geminiRetry');
const { classifyIntent, matchesSupportKeywords } = require('./services/intentRouter');

const app = express();
app.use(express.json());

const PORT         = 3006;
const WAHA_URL     = 'http://localhost:3003';
const WAHA_API_KEY = process.env.WAHA_API_KEY || 'blaster123';
const WAHA_SESSION = process.env.WAHA_SESSION || 'default';

// Номер самой Натали — её сообщения не обрабатываем как заказ клиента
const NATALIA_NUMBERS = ['972587958060@c.us', '972559598952@c.us'];

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Состояние диалога в памяти: chatId → { history: [{role, parts}], mode: 'SALES'|'SUPPORT'|null }
const sessions = new Map();

function getSession(chatId) {
  if (!sessions.has(chatId)) sessions.set(chatId, { history: [], mode: null });
  return sessions.get(chatId);
}

function todayString() {
  return new Date().toLocaleDateString('ru-RU', {
    timeZone: 'Asia/Jerusalem',
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

const PROMPT_BUILDERS = { SALES: buildSalesPrompt, SUPPORT: buildSupportPrompt };
const COMPLETION_TOKENS = { SALES: '[[ORDER_COMPLETE]]', SUPPORT: '[[SUPPORT_ESCALATE]]' };

// Явные триггеры смены темы посреди диалога (уже в заданном режиме)
const NEW_ORDER_TRIGGERS = [
  /нов(ый|ое)\s+заказ/i,
  /хочу\s+(сделать\s+)?заказать?/i,
  /оформить\s+заказ/i,
  /что\s+нового/i,
  /есть\s+что(-|\s)нибудь\s+нов/i,
];

function hasExplicitTopicSwitchTrigger(text, currentMode) {
  if (currentMode === 'SALES') return matchesSupportKeywords(text);
  if (currentMode === 'SUPPORT') return NEW_ORDER_TRIGGERS.some((re) => re.test(text));
  return false;
}

async function askGemini(chatId, userText, knownName, knownPhone, mode) {
  const session = getSession(chatId);
  const buildPromptFn = PROMPT_BUILDERS[mode] || PROMPT_BUILDERS.SALES;

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: buildPromptFn(todayString(), knownName, knownPhone),
  });

  const chat = model.startChat({ history: session.history });

  const result = await withGeminiRetry(() => chat.sendMessage(userText), 'gemini-chat');
  const reply = result.response.text();

  session.history.push({ role: 'user',  parts: [{ text: userText }] });
  session.history.push({ role: 'model', parts: [{ text: reply }] });

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

function isAudioMessage(payload) {
  return !!(
    payload?.hasMedia &&
    (payload?._data?.type === 'ptt' || String(payload?.media?.mimetype || '').startsWith('audio'))
  );
}

async function downloadMedia(payload) {
  const rawUrl = payload?.media?.url;
  if (!rawUrl) throw new Error('no media.url in payload');

  // WAHA отдаёт media.url с внутренним портом контейнера (localhost:3000),
  // но chef-bot обращается к WAHA снаружи, на внешнем порту 3003
  const mediaUrl = rawUrl.replace(/^https?:\/\/[^/]+/, WAHA_URL);

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

  if (isAudioMessage(payload)) {
    try {
      const audioBuffer = await downloadMedia(payload);
      text = await transcribeVoice(audioBuffer);
      isVoice = true;
      console.log(`[voice] transcribed from=${displayId} text="${text}"`);
    } catch (e) {
      console.error('[voice] transcription failed after retries:', e.message);
      await sendText(sendTo, 'Прошу прощения, сейчас небольшая техническая заминка. Пожалуйста, напишите ещё раз через минуту 🙏');
      return;
    }
  }

  console.log(`[incoming] from=${displayId} text="${text}"`);

  const session = getSession(displayId);

  if (!session.mode || hasExplicitTopicSwitchTrigger(text, session.mode)) {
    session.mode = await classifyIntent(text, session.history);
    console.log(`[mode] chat=${displayId} mode=${session.mode}`);
  }

  try {
    const reply = await askGemini(displayId, text, knownName, knownPhone, session.mode);
    const completionToken = COMPLETION_TOKENS[session.mode] || COMPLETION_TOKENS.SALES;

    if (reply.includes(completionToken)) {
      const [clientMsg, orderBlock] = reply.split(completionToken);
      // клиенту — только его часть
      await sendText(sendTo, clientMsg.trim());
      // Натали — структурированное сообщение (заказ или эскалация поддержки)
      console.log(`[${session.mode}] complete from ${displayId} — notifying Natalia`);
      const noteBlock = isVoice ? `${orderBlock.trim()}\n\n🎤 (голосовое)` : orderBlock.trim();
      await sendOrderToNatalia(noteBlock, displayId);
      sessions.delete(displayId); // сбрасываем диалог и режим после завершения
    } else {
      await sendText(sendTo, reply.trim());
    }
  } catch (e) {
    console.error('[gemini] error after retries:', e.message);
    await sendText(sendTo, 'Прошу прощения, сейчас небольшая техническая заминка. Пожалуйста, напишите ещё раз через минуту 🙏');
  }
});

app.listen(PORT, () => console.log(`chef-bot listening on port ${PORT}`));
