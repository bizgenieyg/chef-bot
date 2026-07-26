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
    client_chat_id TEXT,
    question TEXT,
    status TEXT,
    created_at TEXT
  );
`);

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
  'INSERT INTO escalations (client_chat_id, question, status, created_at) VALUES (?, ?, ?, ?)'
);
const getPendingEscalationsStmt = escalationsDb.prepare(
  "SELECT * FROM escalations WHERE status = 'pending' ORDER BY created_at ASC"
);
const markEscalationAnsweredStmt = escalationsDb.prepare(
  "UPDATE escalations SET status = 'answered' WHERE id = ?"
);

function createEscalation(clientChatId, question) {
  insertEscalationStmt.run(clientChatId, question, 'pending', new Date().toISOString());
}

function getPendingEscalations() {
  return getPendingEscalationsStmt.all();
}

function markEscalationAnswered(id) {
  markEscalationAnsweredStmt.run(id);
}

module.exports = {
  saveMessage,
  getRecentHistory,
  createEscalation,
  getPendingEscalations,
  markEscalationAnswered,
};
