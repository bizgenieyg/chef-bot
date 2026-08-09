const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { withGeminiRetry } = require('./geminiRetry');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

const knowledge = fs.readFileSync(path.join(__dirname, '../data/knowledge.md'), 'utf-8');

function truncateFallback(text, maxLen = 60) {
  const clean = String(text || '').trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen).trim() + '…';
}

// Сокращает вопрос клиента до короткой темы (5-8 слов, винительный падеж, без кавычек)
// для фразы "Уточнила у Натали насчёт {суть}". Фолбэк — обрезка вопроса до ~60 символов.
async function summarizeQuestion(question) {
  try {
    const result = await withGeminiRetry(
      () => model.generateContent(
        `Сократи вопрос клиента до короткой темы в 5-8 слов, в винительном падеже, без кавычек. Вопрос: ${question}`
      ),
      'gemini-summarize-question'
    );
    const summary = result.response.text().trim();
    return summary || truncateFallback(question);
  } catch (e) {
    console.error('[nataliaReply] summarizeQuestion failed, using fallback truncation:', e.message);
    return truncateFallback(question);
  }
}

// Генерирует короткую реплику бота, которая идёт СРАЗУ ПОСЛЕ дословного ответа Натали:
// отказ → сочувствие + похожая позиция из меню; согласие → подтверждение + переход к заказу;
// неоднозначно → мягкое уточнение.
async function craftFollowUp(question, nataliaAnswer) {
  const prompt = `Ты — помощник Натали Жук, шеф-повара домашней кухни на заказ.
Клиент спросил: "${question}"
Натали ответила: "${nataliaAnswer}"

База знаний (меню и цены):
${knowledge}

Составь короткую (1-3 предложения) реплику клиенту от своего лица (помощника), которая идёт СРАЗУ ПОСЛЕ дословного ответа Натали (сам ответ уже показан клиенту отдельно, повторять его не нужно):
- Если ответ Натали — отказ или "нет" — прояви сочувствие и предложи 1 похожую позицию из меню с ценой.
- Если ответ Натали — согласие или "да" — подтверди и предложи перейти к оформлению заказа (спроси количество и дату).
- Если ответ неоднозначный или непонятный — мягко предложи уточнить, что именно интересует клиента.

Пиши на «Вы», без длинного тире (—), без слов «меня зовут». Верни только текст реплики, без кавычек и пояснений.`;

  try {
    const result = await withGeminiRetry(
      () => model.generateContent(prompt),
      'gemini-followup-after-natalia'
    );
    return result.response.text().trim();
  } catch (e) {
    console.error('[nataliaReply] craftFollowUp failed, using generic fallback:', e.message);
    return 'Если появятся ещё вопросы — пишите, с радостью помогу!';
  }
}

// Определяет, ответила ли Натали по существу или отсрочила ответ (позже, завтра,
// спокойной ночи, занята и т.п.). Фолбэк при сбое Gemini — ANSWER: безопаснее переслать
// сомнительный ответ клиенту, чем зациклить тикет на requeue из-за временной ошибки API.
async function classifyNataliaReply(question, nataliaAnswer) {
  const prompt = `Это ответ по существу на вопрос «${question}» или отсрочка/отговорка (например "позже", "завтра отвечу", "спокойной ночи", "занята сейчас")? Текст Натали: "${nataliaAnswer}"

Ответь одним словом: ANSWER или DEFER.`;

  try {
    const result = await withGeminiRetry(
      () => model.generateContent(prompt),
      'gemini-classify-natalia-reply'
    );
    const answer = result.response.text().trim().toUpperCase();
    return answer.includes('DEFER') ? 'DEFER' : 'ANSWER';
  } catch (e) {
    console.error('[nataliaReply] classifyNataliaReply failed, defaulting to ANSWER:', e.message);
    return 'ANSWER';
  }
}

module.exports = { summarizeQuestion, craftFollowUp, classifyNataliaReply };
