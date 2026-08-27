require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('./db');
const { WAHA_URL, formatPhone } = require('./config');
const { NATALIA_PERSONAL_NUMBER } = require('./natalia');
const { isQuietHours, getYesterdayRangeJerusalem } = require('./jerusalemTime');
const { withGeminiRetry } = require('./geminiRetry');

const WAHA_API_KEY = process.env.WAHA_API_KEY || 'blaster123';
const WAHA_SESSION = process.env.WAHA_SESSION || 'default';

const STATE_PATH = path.join(__dirname, '../data/daily-report-state.json');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

const OUTCOME_ICONS = { order: '✅', lost: '❌', in_progress: '💬', info_only: 'ℹ️' };
const VALID_OUTCOMES = ['order', 'lost', 'in_progress', 'info_only'];

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
  } catch (e) {
    return {};
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// Защита от дублей при рестарте pm2 в 9:0x — отчёт за одну и ту же дату шлём максимум раз.
function alreadySentFor(dateLabel) {
  return readState().lastSentDate === dateLabel;
}

function markSentFor(dateLabel) {
  writeState({ lastSentDate: dateLabel });
}

async function analyzeConversation(messages) {
  const transcript = messages
    .map((m) => `${m.role === 'user' ? 'Клиент' : 'Бот'}: ${m.content}`)
    .join('\n');

  const prompt = `Проанализируй диалог клиента с ботом домашней кухни. Верни JSON:
{
  "client_name": имя клиента или null,
  "summary": суть обращения в 5-10 словах,
  "outcome": "order" | "lost" | "in_progress" | "info_only",
  "reason": если outcome="lost" — причина отказа коротко (не подошла дата, дорого, нет нужного блюда, ушёл молча, другое); иначе null
}
Только JSON, без пояснений.

Диалог:
${transcript}`;

  try {
    const result = await withGeminiRetry(() => model.generateContent(prompt), 'gemini-daily-report-analyze');
    const raw = result.response.text().trim().replace(/^```json\s*|```\s*$/g, '').trim();
    const parsed = JSON.parse(raw);
    return {
      clientName: parsed.client_name || null,
      summary: parsed.summary || '(не удалось определить суть)',
      outcome: VALID_OUTCOMES.includes(parsed.outcome) ? parsed.outcome : 'info_only',
      reason: parsed.reason || null,
    };
  } catch (e) {
    console.error('[daily-report] analyze failed:', e.message);
    return { clientName: null, summary: '(ошибка анализа диалога)', outcome: 'info_only', reason: null };
  }
}

async function sendToNatalia(text) {
  try {
    const resp = await fetch(`${WAHA_URL}/api/sendText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': WAHA_API_KEY },
      body: JSON.stringify({ session: WAHA_SESSION, chatId: NATALIA_PERSONAL_NUMBER, text }),
    });
    if (!resp.ok) {
      console.error('[daily-report] sendText failed:', resp.status, await resp.text());
    }
  } catch (e) {
    console.error('[daily-report] sendText error:', e.message);
  }
}

async function buildAndSendDailyReport() {
  // Отчёт только в рабочее время (с 09:00) — не раньше
  if (isQuietHours()) return;

  const { startUtc, endUtc, dateLabel } = getYesterdayRangeJerusalem();

  if (alreadySentFor(dateLabel)) {
    return; // уже отправлен, в т.ч. если это повторный тик после рестарта pm2
  }

  const startIso = startUtc.toISOString();
  const endIso = endUtc.toISOString();

  const chatIds = db.getChatIdsWithMessagesInRange(startIso, endIso);

  if (chatIds.length === 0) {
    await sendToNatalia(`📊 За ${dateLabel} обращений не было`);
    markSentFor(dateLabel);
    console.log(`[daily-report] no activity for ${dateLabel}, sent short notice`);
    return;
  }

  const results = [];
  for (const chatId of chatIds) {
    const messages = db.getMessagesForChatInRange(chatId, startIso, endIso);
    if (messages.length === 0) continue;
    const analysis = await analyzeConversation(messages);
    results.push({ chatId, ...analysis });
  }

  const counts = { order: 0, lost: 0, in_progress: 0, info_only: 0 };
  for (const r of results) counts[r.outcome]++;

  const detailLines = results.map((r) => {
    const label = r.clientName || formatPhone(r.chatId);
    const icon = OUTCOME_ICONS[r.outcome] || 'ℹ️';
    const reasonPart = r.outcome === 'lost' && r.reason ? ` (${r.reason})` : '';
    return `${label} — ${r.summary}\n${icon}${reasonPart}`;
  });

  const openEscalations = db.getAllOpenEscalations();
  const openBlock = openEscalations.length > 0
    ? `\n\n── Открытые вопросы ──\n${openEscalations.map((e) => `${formatPhone(e.client_chat_id)}: ${e.question}`).join('\n')}`
    : '';

  const text =
    `📊 Отчёт за ${dateLabel}\n\n` +
    `Всего обращений: ${results.length}\n` +
    `✅ Оформлено заказов: ${counts.order}\n` +
    `💬 В процессе: ${counts.in_progress}\n` +
    `❌ Не сложилось: ${counts.lost}\n\n` +
    `── Детали ──\n${detailLines.join('\n\n')}` +
    openBlock;

  await sendToNatalia(text);
  markSentFor(dateLabel);
  console.log(`[daily-report] sent report for ${dateLabel}, ${results.length} conversations`);
}

module.exports = { buildAndSendDailyReport };
