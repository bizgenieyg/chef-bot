require('dotenv').config();
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const buildSalesPrompt = require('./prompts/sales');
const buildSupportPrompt = require('./prompts/support');
const { sendOrderToNatalia } = require('./services/notify');
const { transcribeVoice } = require('./services/transcribe');
const { withGeminiRetry } = require('./services/geminiRetry');
const { classifyIntent, matchesSupportKeywords } = require('./services/intentRouter');
const db = require('./services/db');
const { startReminderLoop } = require('./services/reminders');
const { NATALIA_PERSONAL_NUMBER, NATALIA_NUMBERS } = require('./services/natalia');
const { appendLearnedAnswer } = require('./services/learnedAnswers');

const app = express();
app.use(express.json());

const PORT         = 3006;
const WAHA_URL     = 'http://localhost:3003';
const WAHA_API_KEY = process.env.WAHA_API_KEY || 'blaster123';
const WAHA_SESSION = process.env.WAHA_SESSION || 'default';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Режим диалога в памяти: chatId → 'SALES'|'SUPPORT'|null.
// История сообщений персистентна (SQLite, services/db.js) — переживает рестарт pm2.
const modes = new Map();

function getMode(chatId) {
  return modes.has(chatId) ? modes.get(chatId) : null;
}

function setMode(chatId, mode) {
  modes.set(chatId, mode);
}

function resetConversation(chatId) {
  modes.delete(chatId);
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

async function askGemini(chatId, userText, knownName, knownPhone, mode, isVoice) {
  const history = db.getRecentHistory(chatId, 20);
  const buildPromptFn = PROMPT_BUILDERS[mode] || PROMPT_BUILDERS.SALES;

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: buildPromptFn(todayString(), knownName, knownPhone, isVoice),
  });

  const chat = model.startChat({ history });

  const result = await withGeminiRetry(() => chat.sendMessage(userText), 'gemini-chat');
  const reply = result.response.text();

  db.saveMessage(chatId, 'user', userText);
  db.saveMessage(chatId, 'model', reply);

  return reply;
}

// Резолвинг @lid → реальный номер через WAHA. Сразу после рестарта сессии
// store иногда ещё не успевает синхронизироваться, и pn может прийти null —
// в этом случае просто падаем на ручной сбор имени/телефона у клиента.
// /api/contacts/about не поддерживается движком NOWEB (всегда 501) — не используем.
const lidCache = new Map(); // lid → { pn } | null

async function resolveLid(lid) {
  if (lidCache.has(lid)) return lidCache.get(lid);

  let resolved = null;

  try {
    const resp = await fetch(`${WAHA_URL}/api/${WAHA_SESSION}/lids/${encodeURIComponent(lid)}`, {
      headers: { 'X-Api-Key': WAHA_API_KEY },
    });
    if (resp.ok) {
      const data = await resp.json();
      const pn = data?.pn || data?.phoneNumber || null;
      if (pn) resolved = { pn };
    } else {
      console.warn(`[resolveLid] /lids returned ${resp.status} for ${lid}`);
    }
  } catch (e) {
    console.error('[resolveLid] /lids failed:', e.message);
  }

  lidCache.set(lid, resolved);
  return resolved;
}

// Имя клиента приходит прямо в payload входящего сообщения — отдельный запрос не нужен.
// Поле отличается в зависимости от движка WAHA:
// - GOWS: payload._data.Info.PushName (проверено на живом payload от 30 июля)
// - NOWEB (Baileys): payload._data.pushName
// Остальные варианты — фолбэк на случай будущей смены движка.
function extractNotifyName(payload) {
  return (
    payload?._data?.Info?.PushName ||
    payload?._data?.pushName ||
    payload?.notifyName ||
    payload?.pushName ||
    payload?._data?.notifyName ||
    null
  );
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

// Возвращает распарсенный JSON-ответ WAHA (содержит id отправленного сообщения)
// или null при ошибке.
async function sendText(chatId, text) {
  try {
    const resp = await fetch(`${WAHA_URL}/api/sendText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': WAHA_API_KEY },
      body: JSON.stringify({ session: WAHA_SESSION, chatId, text }),
    });
    if (!resp.ok) {
      console.error(`[sendText] ${resp.status}`, await resp.text());
      return null;
    }
    return await resp.json();
  } catch (e) {
    console.error('[sendText] error:', e.message);
    return null;
  }
}

// Достаёт id сообщения из разных возможных форм ответа WAHA
function extractWahaMessageId(sendResult) {
  return (
    sendResult?.id?._serialized ||
    sendResult?._data?.id?._serialized ||
    (typeof sendResult?.id === 'string' ? sendResult.id : null) ||
    sendResult?.messageId ||
    null
  );
}

// Обрабатывает сообщение от самой Натали: пересылает клиенту, только если это
// РЕПЛЕЙ на конкретный вопрос, отправленный через ASK_NATALIA.
// Во всех остальных случаях (не реплей, реплей не найден в escalations) —
// полностью игнорирует, не пытается собирать с неё заказ.
async function handleNataliaMessage(text, payload) {
  const replyToId = payload?.replyTo?.id;

  if (!replyToId) {
    console.log('[natalia] message is not a reply, ignoring');
    // TODO: со временем можно добавить мягкое напоминание
    // "пожалуйста, отвечайте реплеем на вопрос"
    return;
  }

  const escalation = db.getPendingEscalationByMessageId(replyToId);

  if (!escalation) {
    console.log(`[natalia] reply to ${replyToId} does not match any pending escalation, ignoring`);
    return;
  }

  await sendText(escalation.client_chat_id, `Уточнила у Натали: ${text}`);
  db.markEscalationAnswered(escalation.id);
  appendLearnedAnswer(escalation.question, text);
  console.log(`[natalia] escalation id=${escalation.id} answered, forwarded to ${escalation.client_chat_id}`);
}

// POST /webhook — входящие сообщения от WAHA
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  // WhatsApp Статусы (Stories) — игнорируем сразу, до любой другой обработки
  if (req.body?.payload?.from === 'status@broadcast' || String(req.body?.payload?.from || '').endsWith('@broadcast')) {
    return;
  }

  try {
    const event   = req.body?.event;
    const payload = req.body?.payload;

    if (event !== 'message') return;

    const rawChatId = payload?.from;
    let text         = payload?.body || '';
    let isVoice      = false;

    if (!rawChatId || rawChatId.endsWith('@g.us') || payload?.fromMe) return;

    // sendTo — всегда исходный chatId из webhook (гарантированно валиден для WAHA sendText).
    // displayId — резолвим номер из @lid, если возможно, для истории и уведомления Натали.
    // knownName — берётся прямо из payload входящего сообщения, отдельный запрос не нужен.
    // Резолвим ДО проверки NATALIA_NUMBERS: если Натали пишет с номера, который
    // WhatsApp показал как @lid, сырой rawChatId не совпадёт со списком, а резолвнутый — совпадёт.
    const sendTo = rawChatId;
    let displayId = rawChatId;
    let knownName = extractNotifyName(payload);
    let knownPhone = null;

    if (rawChatId.endsWith('@lid')) {
      const resolved = await resolveLid(rawChatId);
      if (resolved?.pn) {
        knownPhone = resolved.pn;
        displayId = resolved.pn.endsWith('@c.us') ? resolved.pn : `${resolved.pn}@c.us`;
        console.log(`[lid] resolved ${rawChatId} → ${displayId}`);
      } else {
        console.log(`[lid] could not resolve pn for ${rawChatId} (known WAHA bug, will work once store is enabled on session start), falling back to manual name/phone`);
      }
    }

    // Сравниваем и с резолвнутым номером, и с исходным rawChatId — на случай,
    // если резолвинг не удался, а номер и так пришёл в формате @c.us.
    if (NATALIA_NUMBERS.includes(displayId) || NATALIA_NUMBERS.includes(rawChatId)) {
      await handleNataliaMessage(text, payload);
      return;
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

    let mode = getMode(displayId);

    if (!mode || hasExplicitTopicSwitchTrigger(text, mode)) {
      mode = await classifyIntent(text, db.getRecentHistory(displayId, 20));
      setMode(displayId, mode);
      console.log(`[mode] chat=${displayId} mode=${mode}`);
    }

    try {
      const reply = await askGemini(displayId, text, knownName, knownPhone, mode, isVoice);
      const completionToken = COMPLETION_TOKENS[mode] || COMPLETION_TOKENS.SALES;
      const askMatch = reply.match(/\[\[ASK_NATALIA:\s*([\s\S]*?)\]\]/);

      if (reply.includes(completionToken)) {
        const [clientMsg, orderBlock] = reply.split(completionToken);
        // клиенту — только его часть
        await sendText(sendTo, clientMsg.trim());
        // Натали — структурированное сообщение (заказ или эскалация поддержки)
        console.log(`[${mode}] complete from ${displayId} — notifying Natalia`);
        const noteBlock = isVoice ? `${orderBlock.trim()}\n\n🎤 (голосовое)` : orderBlock.trim();
        await sendOrderToNatalia(noteBlock, displayId);
        resetConversation(displayId); // сбрасываем режим после завершения
      } else if (askMatch) {
        const question  = askMatch[1].trim();
        const clientMsg = reply.replace(askMatch[0], '').trim();
        await sendText(sendTo, clientMsg);

        const sendResult = await sendText(
          NATALIA_PERSONAL_NUMBER,
          `❓ Вопрос от клиента (${displayId}): ${question}\n\nОтветьте мне, и я перешлю клиенту.`
        );
        const wahaMessageId = extractWahaMessageId(sendResult);

        if (wahaMessageId) {
          db.createEscalation(wahaMessageId, displayId, question);
          console.log(`[ask_natalia] chat=${displayId} question="${question}" waha_message_id=${wahaMessageId}`);
        } else {
          console.error(`[ask_natalia] could not extract WAHA message id, escalation NOT saved (Natalia's reply won't be matched):`, JSON.stringify(sendResult));
        }
      } else {
        await sendText(sendTo, reply.trim());
      }
    } catch (e) {
      console.error('[gemini] error after retries:', e.message);
      await sendText(sendTo, 'Прошу прощения, сейчас небольшая техническая заминка. Пожалуйста, напишите ещё раз через минуту 🙏');
    }
  } catch (e) {
    // Верхнеуровневая страховка: любое необработанное исключение в обработчике
    // не должно ронять процесс (иначе PM2 уходит в цикл перезапусков).
    console.error('[webhook] unhandled error:', e);
  }
});

app.listen(PORT, () => console.log(`chef-bot listening on port ${PORT}`));

startReminderLoop();
