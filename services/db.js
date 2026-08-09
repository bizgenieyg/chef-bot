const path = require('path');
const Database = require('better-sqlite3');

const conversationsDb = new Database(path.join(__dirname, '../data/conversations.db'));
const escalationsDb   = new Database(path.join(__dirname, '../data/escalations.db'));

conversationsDb.pragma('journal_mode = WAL');
escalationsDb.pragma('journal_mode = WAL');

conversationsDb.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
`);

// status: 'queued' (создан, Натали ещё не отправлен — тихие часы или ждёт повторной отправки
//         после отсрочки) | 'pending' (отправлен, ждём ответа) | 'answered'
escalationsDb.exec(`
  CREATE TABLE IF NOT EXISTS escalations (
    id INTEGER PRIMARY KEY,
    waha_message_id TEXT UNIQUE,
    client_chat_id TEXT,
    question TEXT,
    status TEXT,
    created_at TEXT,
    reminder_count INTEGER DEFAULT 0,
    last_reminder_at TEXT,
    scheduled_for TEXT,
    sent_at TEXT,
    deferred_count INTEGER DEFAULT 0
  );
`);

// Миграция: у таблицы, созданной до введения этих колонок, их не будет —
// CREATE TABLE IF NOT EXISTS их не добавит на существующую таблицу.
const escalationColumns = escalationsDb.prepare('PRAGMA table_info(escalations)').all();
const escalationColumnNames = escalationColumns.map((c) => c.name);
if (!escalationColumnNames.includes('waha_message_id')) {
  escalationsDb.exec('ALTER TABLE escalations ADD COLUMN waha_message_id TEXT');
}
if (!escalationColumnNames.includes('reminder_count')) {
  escalationsDb.exec('ALTER TABLE escalations ADD COLUMN reminder_count INTEGER DEFAULT 0');
}
if (!escalationColumnNames.includes('last_reminder_at')) {
  escalationsDb.exec('ALTER TABLE escalations ADD COLUMN last_reminder_at TEXT');
}
if (!escalationColumnNames.includes('scheduled_for')) {
  escalationsDb.exec('ALTER TABLE escalations ADD COLUMN scheduled_for TEXT');
}
if (!escalationColumnNames.includes('sent_at')) {
  escalationsDb.exec('ALTER TABLE escalations ADD COLUMN sent_at TEXT');
}
if (!escalationColumnNames.includes('deferred_count')) {
  escalationsDb.exec('ALTER TABLE escalations ADD COLUMN deferred_count INTEGER DEFAULT 0');
}

const insertMessageStmt = conversationsDb.prepare(
  'INSERT INTO messages (chat_id, role, content, timestamp) VALUES (?, ?, ?, ?)'
);
const getRecentMessagesStmt = conversationsDb.prepare(
  'SELECT role, content FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?'
);

function saveMessage(chatId, role, content) {
  insertMessageStmt.run(chatId, role, content, new Date().toISOString());
}

// возвращает последние N сообщений в хронологическом порядке (старые → новые),
// в формате, готовом для Gemini history: [{role, parts:[{text}]}]
function getRecentHistory(chatId, limit = 20) {
  const rows = getRecentMessagesStmt.all(chatId, limit);
  return rows.reverse().map((r) => ({
    role: r.role,
    parts: [{ text: r.content }],
  }));
}

const insertQueuedEscalationStmt = escalationsDb.prepare(
  "INSERT INTO escalations (client_chat_id, question, status, created_at, scheduled_for, deferred_count) VALUES (?, ?, 'queued', ?, ?, 0)"
);
const insertPendingEscalationStmt = escalationsDb.prepare(
  "INSERT INTO escalations (waha_message_id, client_chat_id, question, status, created_at, sent_at, deferred_count) VALUES (?, ?, ?, 'pending', ?, ?, 0)"
);
const getEscalationByMessageIdStmt = escalationsDb.prepare(
  'SELECT * FROM escalations WHERE waha_message_id = ? AND status = ?'
);
const markEscalationAnsweredStmt = escalationsDb.prepare(
  "UPDATE escalations SET status = 'answered' WHERE id = ?"
);

// Тихие часы / первичная отправка ещё не удалась — вопрос создан, но Натали пока не отправлен
function createQueuedEscalation(clientChatId, question, scheduledFor) {
  const now = new Date().toISOString();
  insertQueuedEscalationStmt.run(clientChatId, question, now, scheduledFor);
}

// Рабочее время — вопрос отправлен Натали сразу
function createPendingEscalation(wahaMessageId, clientChatId, question) {
  const now = new Date().toISOString();
  insertPendingEscalationStmt.run(wahaMessageId, clientChatId, question, now, now);
}

function getPendingEscalationByMessageId(wahaMessageId) {
  return getEscalationByMessageIdStmt.get(wahaMessageId, 'pending') || null;
}

function markEscalationAnswered(id) {
  markEscalationAnsweredStmt.run(id);
}

const getPendingEscalationsStmt = escalationsDb.prepare(
  "SELECT * FROM escalations WHERE status = 'pending'"
);
const bumpReminderStmt = escalationsDb.prepare(
  'UPDATE escalations SET reminder_count = reminder_count + 1, last_reminder_at = ?, waha_message_id = ? WHERE id = ?'
);

function getPendingEscalations() {
  return getPendingEscalationsStmt.all();
}

const getOpenEscalationsByClientStmt = escalationsDb.prepare(
  "SELECT question FROM escalations WHERE client_chat_id = ? AND status IN ('queued', 'pending')"
);

// Открытые вопросы конкретного клиента к Натали (и ещё не отправленные, и отправленные,
// но без ответа) — источник истины для промпта: модель не должна помнить "жду ответа"
// сама по себе, только по этому списку.
function getPendingEscalationsByClient(clientChatId) {
  return getOpenEscalationsByClientStmt.all(clientChatId).map((r) => r.question);
}

// Обновляет waha_message_id на id только что отправленного напоминания —
// если Натали ответит реплеем на напоминание (а не на исходный вопрос),
// матчинг всё равно сработает, т.к. ищем по последнему сообщению бота.
function bumpReminder(id, newWahaMessageId) {
  bumpReminderStmt.run(new Date().toISOString(), newWahaMessageId, id);
}

const getDueQueuedEscalationsStmt = escalationsDb.prepare(
  "SELECT * FROM escalations WHERE status = 'queued' AND scheduled_for IS NOT NULL AND scheduled_for <= ?"
);

// Отложенные вопросы, чьё время (scheduled_for) уже наступило — их пора отправить Натали
function getDueQueuedEscalations() {
  return getDueQueuedEscalationsStmt.all(new Date().toISOString());
}

const markEscalationSentStmt = escalationsDb.prepare(
  "UPDATE escalations SET status = 'pending', waha_message_id = ?, sent_at = ? WHERE id = ?"
);

// Переводит queued → pending после фактической отправки (утренняя рассылка)
function markEscalationSent(id, wahaMessageId) {
  markEscalationSentStmt.run(wahaMessageId, new Date().toISOString(), id);
}

const requeueEscalationStmt = escalationsDb.prepare(
  "UPDATE escalations SET status = 'queued', scheduled_for = ?, deferred_count = deferred_count + 1 WHERE id = ?"
);

// Натали отсрочила ответ ("отвечу позже") — возвращаем в очередь.
// scheduledFor = null означает "висит без даты, до ручного разбора" (deferred_count >= 3).
function requeueEscalation(id, scheduledFor) {
  requeueEscalationStmt.run(scheduledFor, id);
}

module.exports = {
  saveMessage,
  getRecentHistory,
  createQueuedEscalation,
  createPendingEscalation,
  getPendingEscalationByMessageId,
  markEscalationAnswered,
  getPendingEscalations,
  getPendingEscalationsByClient,
  bumpReminder,
  getDueQueuedEscalations,
  markEscalationSent,
  requeueEscalation,
};
