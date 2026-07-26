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

escalationsDb.exec(`
  CREATE TABLE IF NOT EXISTS escalations (
    id INTEGER PRIMARY KEY,
    waha_message_id TEXT UNIQUE,
    client_chat_id TEXT,
    question TEXT,
    status TEXT,
    created_at TEXT,
    reminder_count INTEGER DEFAULT 0,
    last_reminder_at TEXT
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

const insertEscalationStmt = escalationsDb.prepare(
  'INSERT INTO escalations (waha_message_id, client_chat_id, question, status, created_at) VALUES (?, ?, ?, ?, ?)'
);
const getEscalationByMessageIdStmt = escalationsDb.prepare(
  'SELECT * FROM escalations WHERE waha_message_id = ? AND status = ?'
);
const markEscalationAnsweredStmt = escalationsDb.prepare(
  "UPDATE escalations SET status = 'answered' WHERE id = ?"
);

function createEscalation(wahaMessageId, clientChatId, question) {
  insertEscalationStmt.run(wahaMessageId, clientChatId, question, 'pending', new Date().toISOString());
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

// Обновляет waha_message_id на id только что отправленного напоминания —
// если Натали ответит реплеем на напоминание (а не на исходный вопрос),
// матчинг всё равно сработает, т.к. ищем по последнему сообщению бота.
function bumpReminder(id, newWahaMessageId) {
  bumpReminderStmt.run(new Date().toISOString(), newWahaMessageId, id);
}

module.exports = {
  saveMessage,
  getRecentHistory,
  createEscalation,
  getPendingEscalationByMessageId,
  markEscalationAnswered,
  getPendingEscalations,
  bumpReminder,
};
