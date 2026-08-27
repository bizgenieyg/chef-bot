// Единый источник правды для базового URL WAHA. НЕ дублировать строку по файлам —
// импортировать отсюда, иначе следующий переезд/смена порта снова разойдётся по местам.
const WAHA_URL = (process.env.WAHA_URL || 'http://127.0.0.1:3003').replace(/\/$/, '');

// Человекочитаемый номер для показа Натали: 972504632607@c.us → +972504632607.
// Если chatId не похож на телефон (например @lid, который не удалось резолвить) —
// возвращает исходную строку как есть, ничего не выдумывая.
function formatPhone(chatId) {
  if (!chatId) return chatId;
  const match = String(chatId).match(/^(\d+)(@c\.us|@s\.whatsapp\.net)?$/);
  return match ? `+${match[1]}` : chatId;
}

module.exports = { WAHA_URL, formatPhone };
