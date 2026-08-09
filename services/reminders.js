require('dotenv').config();
const db = require('./db');
const { NATALIA_PERSONAL_NUMBER } = require('./natalia');
const { isQuietHours } = require('./jerusalemTime');

const WAHA_URL     = 'http://localhost:3003';
const WAHA_API_KEY = process.env.WAHA_API_KEY || 'blaster123';
const WAHA_SESSION = process.env.WAHA_SESSION || 'default';

const CHECK_INTERVAL_MS = 10 * 60 * 1000;      // каждые 10 минут
const REMINDER_AFTER_MS = 4 * 60 * 60 * 1000;  // напоминать через 4 часа ожидания
const MAX_REMINDERS = 2;                        // после 2 напоминаний без ответа — больше не напоминаем автоматически

// Короткий _data.Info.ID (GOWS) в приоритете — см. комментарий в index.js
function extractWahaMessageId(sendResult) {
  return (
    sendResult?._data?.Info?.ID ||
    sendResult?.id?._serialized ||
    sendResult?._data?.id?._serialized ||
    (typeof sendResult?.id === 'string' ? sendResult.id : null) ||
    sendResult?.messageId ||
    null
  );
}

// Универсальная отправка Натали: reply_to опционален (реплей на конкретное сообщение
// для напоминаний, без него — для утренней рассылки отложенных вопросов).
// Возвращает id отправленного сообщения (или null при ошибке).
async function sendToNatalia(text, replyToId) {
  try {
    const body = { session: WAHA_SESSION, chatId: NATALIA_PERSONAL_NUMBER, text };
    if (replyToId) body.reply_to = replyToId;

    const resp = await fetch(`${WAHA_URL}/api/sendText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': WAHA_API_KEY },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      console.error('[reminders] sendText failed:', resp.status, await resp.text());
      return null;
    }
    const result = await resp.json();
    return extractWahaMessageId(result);
  } catch (e) {
    console.error('[reminders] sendText error:', e.message);
    return null;
  }
}

// Отложенные вопросы (тихие часы или после отсрочки Натали), чьё время настало —
// отправляем ОТДЕЛЬНЫМИ сообщениями (не дайджестом), чтобы реплей однозначно матчился.
async function sendMorningBatch() {
  const due = db.getDueQueuedEscalations();

  for (const escalation of due) {
    const messageId = await sendToNatalia(
      `❓ Вопрос от клиента (${escalation.client_chat_id}): ${escalation.question}\n\nОтветьте мне, и я перешлю клиенту.`
    );

    if (messageId) {
      db.markEscalationSent(escalation.id, messageId);
      console.log(`[reminders] morning batch: sent queued escalation id=${escalation.id}, waha_message_id=${messageId}`);
    } else {
      console.error(`[reminders] morning batch: failed to send escalation id=${escalation.id}, staying queued for next check`);
    }
  }
}

// Напоминания только в рабочее время (09:00–20:00 Jerusalem), только для уже
// отправленных (status='pending') тикетов старше 4 часов, максимум 2 раза за тикет.
async function checkAndSendReminders() {
  if (isQuietHours()) return;

  const pending = db.getPendingEscalations();
  const now = Date.now();

  for (const escalation of pending) {
    if (escalation.reminder_count >= MAX_REMINDERS) continue;

    const lastActivity = escalation.last_reminder_at || escalation.sent_at || escalation.created_at;
    const elapsed = now - new Date(lastActivity).getTime();

    if (elapsed < REMINDER_AFTER_MS) continue;

    if (!escalation.waha_message_id) {
      console.warn(`[reminders] escalation id=${escalation.id} has no waha_message_id, skipping reminder`);
      continue;
    }

    // Текст напоминания включает сам вопрос — Натали не нужно листать историю,
    // чтобы понять, о чём речь. reply_to даёт ещё и нативный "прыжок" к
    // оригинальному сообщению по тапу на цитату в WhatsApp.
    const reminderText =
      `🔔 Напоминание — жду ответа на предыдущий вопрос от клиента (${escalation.client_chat_id}):\n` +
      `«${escalation.question}»\n\n` +
      `Ответьте реплеем на это сообщение 🙏`;

    const newMessageId = await sendToNatalia(reminderText, escalation.waha_message_id);

    if (newMessageId) {
      // waha_message_id обновляется на id напоминания: если Натали ответит
      // реплеем именно на него, а не на исходный вопрос, матчинг всё равно сработает
      db.bumpReminder(escalation.id, newMessageId);
      console.log(`[reminders] sent reminder #${escalation.reminder_count + 1} for escalation id=${escalation.id}`);
    } else {
      console.error(`[reminders] escalation id=${escalation.id}: reminder sent but no message id returned, waha_message_id NOT updated (next reminder will still reply to the old message)`);
    }
  }
}

function startReminderLoop() {
  setInterval(() => {
    sendMorningBatch().catch((e) => console.error('[reminders] morning batch error:', e));
    checkAndSendReminders().catch((e) => console.error('[reminders] loop error:', e));
  }, CHECK_INTERVAL_MS);
  console.log(`[reminders] loop started, checking every ${CHECK_INTERVAL_MS / 1000}s`);
}

module.exports = { startReminderLoop };
