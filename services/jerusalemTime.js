// Тихие часы 20:00–09:00 по Asia/Jerusalem: Натали не беспокоим.

function jerusalemPartsNow(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0; // некоторые ICU-реализации отдают "24" вместо "00"
  return { year: parts.year, month: parts.month, day: parts.day, hour };
}

function jerusalemOffsetMinutes(date = new Date()) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem',
    timeZoneName: 'shortOffset',
  });
  const tzPart = dtf.formatToParts(date).find((p) => p.type === 'timeZoneName')?.value || 'GMT+0';
  const m = tzPart.match(/GMT([+-]\d+)(?::(\d+))?/);
  if (!m) return 0;
  const hours = parseInt(m[1], 10);
  const mins = m[2] ? parseInt(m[2], 10) : 0;
  return hours * 60 + (hours < 0 ? -mins : mins);
}

function isQuietHours(date = new Date()) {
  const { hour } = jerusalemPartsNow(date);
  return hour >= 20 || hour < 9;
}

function isBusinessHours(date = new Date()) {
  return !isQuietHours(date);
}

// Ближайшие 09:00 по Иерусалиму (сегодня, если ещё не наступили, иначе завтра).
function nextNineAmJerusalem(date = new Date()) {
  const offsetMin = jerusalemOffsetMinutes(date);
  const { year, month, day } = jerusalemPartsNow(date);
  let candidate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 9, 0, 0) - offsetMin * 60000);
  if (candidate <= date) {
    candidate = new Date(candidate.getTime() + 24 * 60 * 60 * 1000);
  }
  return candidate;
}

// Дата по Иерусалиму в формате YYYY-MM-DD — ключ для дедупликации/меток отчётов.
function jerusalemDateString(date = new Date()) {
  const { year, month, day } = jerusalemPartsNow(date);
  return `${year}-${month}-${day}`;
}

// Границы ВЧЕРАШНИХ суток по Иерусалиму как UTC Date: [startUtc, endUtc) —
// начало включительно, конец (= начало сегодняшних суток) исключительно.
// Плюс dateLabel — календарная дата вчера для текста отчёта.
function getYesterdayRangeJerusalem(date = new Date()) {
  const offsetMin = jerusalemOffsetMinutes(date);
  const { year, month, day } = jerusalemPartsNow(date);
  const todayStartUtc = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 0, 0, 0) - offsetMin * 60000);
  const yesterdayStartUtc = new Date(todayStartUtc.getTime() - 24 * 60 * 60 * 1000);
  // метка даты вчера: берём точку посреди вчерашних суток, чтобы не попасть
  // на соседний день из-за смещения при переходе летнего/зимнего времени
  const dateLabel = jerusalemDateString(new Date(yesterdayStartUtc.getTime() + 12 * 60 * 60 * 1000));
  return { startUtc: yesterdayStartUtc, endUtc: todayStartUtc, dateLabel };
}

module.exports = {
  isQuietHours,
  isBusinessHours,
  nextNineAmJerusalem,
  jerusalemDateString,
  getYesterdayRangeJerusalem,
};
