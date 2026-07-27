const fs = require('fs');
const path = require('path');

const FILE_PATH = path.join(__dirname, '../data/learned-answers.md');

const HEADER =
  '# Накопленные уточнения от Натали\n\n' +
  'Вопросы, на которые Натали ответила через бота, но которых нет в основном knowledge.md.\n' +
  'Периодически стоит просматривать этот файл и переносить устоявшиеся уточнения в knowledge.md вручную,\n' +
  'чтобы основная база не захламлялась разовыми нюансами.\n\n';

// Добавляет пару "вопрос → ответ" в конец файла, не трогая основной knowledge.md.
function appendLearnedAnswer(question, answer) {
  if (!fs.existsSync(FILE_PATH)) {
    fs.writeFileSync(FILE_PATH, HEADER);
  }
  const entry = `## ${new Date().toISOString()}\n**Вопрос:** ${question}\n**Ответ Натали:** ${answer}\n\n`;
  fs.appendFileSync(FILE_PATH, entry);
}

// Возвращает содержимое файла (пусто, если его ещё нет) — для подмешивания в промпт.
function readLearnedAnswers() {
  if (!fs.existsSync(FILE_PATH)) return '';
  return fs.readFileSync(FILE_PATH, 'utf-8');
}

module.exports = { appendLearnedAnswer, readLearnedAnswers };
