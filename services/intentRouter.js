const { GoogleGenerativeAI } = require('@google/generative-ai');
const { withGeminiRetry } = require('./geminiRetry');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const SUPPORT_KEYWORDS = [
  /мо[йе]\s+заказ/i,
  /где\s+(мой\s+)?заказ/i,
  /не\s+привезли/i,
  /не\s+приехал/i,
  /не\s+приехал[а-я]*/i,
  /опаздыва/i,
  /проблем/i,
  /жалоб/i,
  /отменить/i,
  /отмена/i,
  /перенести/i,
  /перенос/i,
  /изменить\s+заказ/i,
  /испортил/i,
  /не\s+то,?\s+что\s+заказыва/i,
  /вернуть\s+деньги/i,
  /возврат/i,
];

// 1. Быстрый keyword-фильтр
function matchesSupportKeywords(text) {
  return SUPPORT_KEYWORDS.some((re) => re.test(text));
}

// 2. Если по ключевым словам не ясно — короткий классификатор через Gemini
async function classifyWithGemini(text, chatHistory) {
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const historySnippet = (chatHistory || [])
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'Клиент' : 'Бот'}: ${m.parts?.[0]?.text || ''}`)
    .join('\n');

  const prompt = `Ты классификатор намерений для WhatsApp-бота домашней кухни на заказ.
Определи, к какой категории относится последнее сообщение клиента:

SALES — клиент хочет сделать новый заказ, спрашивает про меню, цены, доставку, условия, или это обычное первое обращение.
SUPPORT — клиент пишет про УЖЕ существующий заказ: статус, жалобу, просьбу изменить/отменить/перенести, проблему с доставкой.

Контекст последних сообщений:
${historySnippet || '(истории нет, это начало диалога)'}

Последнее сообщение клиента: "${text}"

Ответь ОДНИМ словом: SALES или SUPPORT.`;

  const result = await withGeminiRetry(
    () => model.generateContent(prompt),
    'gemini-intent-classify'
  );
  const answer = result.response.text().trim().toUpperCase();

  return answer.includes('SUPPORT') ? 'SUPPORT' : 'SALES';
}

// 3. classifyIntent: keyword-фильтр → (если неясно) Gemini → по умолчанию SALES
async function classifyIntent(text, chatHistory) {
  if (matchesSupportKeywords(text)) {
    console.log(`[intent] keyword match → SUPPORT: "${text}"`);
    return 'SUPPORT';
  }

  try {
    const classified = await classifyWithGemini(text, chatHistory);
    console.log(`[intent] Gemini classified → ${classified}: "${text}"`);
    return classified;
  } catch (e) {
    console.error('[intent] classification failed, defaulting to SALES:', e.message);
    return 'SALES';
  }
}

module.exports = { classifyIntent, matchesSupportKeywords };
