require('dotenv').config();
const db = require('./db');

const WAHA_URL     = 'http://localhost:3003';
const WAHA_API_KEY = process.env.WAHA_API_KEY || 'blaster123';
const WAHA_SESSION = process.env.WAHA_SESSION || 'default';
const NATALIA_ASK_NUMBER = '972559598952@c.us';

const CHECK_INTERVAL_MS = 10 * 60 * 1000; // каждые 10 минут
const REMINDER_AFTER_MS = 30 * 60 * 1000; // напоминать через 30 минут ожидания
const MAX_REMINDERS = 2; // после 2 напоминаний без ответа — больше не напоминаем автоматически

function extractWahaMessageId(sendResult) {
  return (
    sendResult?.id?._serialized ||
    sendResult?._data?.id?._serialized ||
    (typeof sendResult?.id === 'string' ? sendResult.id : null) ||
    sendResult?.messageId ||
    null
  );
}

// Возвращает id только что отправленного напоминания (или null при ошибке) —
// он становится новой "точкой привязки" для следующего реплея Натали.
async function sendReminderReply(wahaMessageId, text) {
  try {
    const resp = await fetch(`${WAHA_URL}/api/sendText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': WAHA_API_KEY },
      body: JSON.stringify({
        session: WAHA_SESSION,
        chatId: NATALIA_ASK_NUMBER,
        text,
        reply_to: wahaMessageId,
      }),
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

async function checkAndSendReminders() {
  const pending = db.getPendingEscalations();
  const now = Date.now();

  for (const escalation of pending) {
    if (escalation.reminder_count >= MAX_REMINDERS) continue;

    const lastActivity = escalation.last_reminder_at || escalation.created_at;
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

    const newMessageId = await sendReminderReply(escalation.waha_message_id, reminderText);

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
    checkAndSendReminders().catch((e) => console.error('[reminders] loop error:', e));
  }, CHECK_INTERVAL_MS);
  console.log(`[reminders] loop started, checking every ${CHECK_INTERVAL_MS / 1000}s`);
}

module.exports = { startReminderLoop };
