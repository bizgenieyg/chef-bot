const RETRY_DELAYS_MS = [1000, 2000, 3000]; // макс. 3 повторные попытки

function is5xxError(e) {
  const status = e?.status ?? (String(e?.message || '').match(/\[(\d{3})\s/) || [])[1];
  if (status && Number(status) >= 500 && Number(status) < 600) return true;
  return /\b5\d\d\b/.test(String(e?.message || ''));
}

// Оборачивает вызов Gemini retry-логикой: при 5xx ждёт 1с → 2с → 3с и повторяет,
// после исчерпания попыток пробрасывает последнюю ошибку.
async function withGeminiRetry(fn, label = 'gemini') {
  let lastError;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (!is5xxError(e) || attempt === RETRY_DELAYS_MS.length) throw e;
      const delay = RETRY_DELAYS_MS[attempt];
      console.warn(`[${label}] 5xx error, retrying in ${delay}ms (attempt ${attempt + 1}/${RETRY_DELAYS_MS.length}):`, e.message);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

module.exports = { withGeminiRetry };
