const express = require('express');
const { WAHA_URL } = require('../services/config');
const router = express.Router();

const WAHA_API_KEY = process.env.WAHA_API_KEY || 'blaster123';
const WAHA_SESSION = process.env.WAHA_SESSION || 'default';
const RECONNECT_PASSWORD = process.env.RECONNECT_PASSWORD;

// Простая Basic Auth — браузер сам покажет системный диалог логина/пароля.
// Логин может быть любым, проверяется только пароль.
function basicAuth(req, res, next) {
  if (!RECONNECT_PASSWORD) {
    return res.status(500).send('RECONNECT_PASSWORD не задан в .env на сервере');
  }

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');

  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
    const pass = decoded.slice(decoded.indexOf(':') + 1);
    if (pass === RECONNECT_PASSWORD) return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="chef-bot reconnect"');
  return res.status(401).send('Требуется авторизация');
}

router.use(basicAuth);

// GET /reconnect/status — статус сессии WAHA
router.get('/status', async (req, res) => {
  try {
    const resp = await fetch(`${WAHA_URL}/api/sessions/${WAHA_SESSION}`, {
      headers: { 'X-Api-Key': WAHA_API_KEY },
    });
    if (!resp.ok) return res.status(502).json({ status: 'ERROR', error: `WAHA ${resp.status}` });
    const data = await resp.json();
    res.json({ status: data.status || 'UNKNOWN' });
  } catch (e) {
    res.status(502).json({ status: 'ERROR', error: e.message });
  }
});

// POST /reconnect/reconnect — stop (unpair) → start заново
router.post('/reconnect', async (req, res) => {
  try {
    await fetch(`${WAHA_URL}/api/sessions/${WAHA_SESSION}`, {
      method: 'DELETE',
      headers: { 'X-Api-Key': WAHA_API_KEY },
    });

    // небольшая пауза, чтобы WAHA успела освободить сессию перед стартом
    await new Promise((r) => setTimeout(r, 1500));

    const startResp = await fetch(`${WAHA_URL}/api/sessions/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': WAHA_API_KEY },
      body: JSON.stringify({ name: WAHA_SESSION }),
    });

    if (!startResp.ok) {
      const errText = await startResp.text();
      return res.status(502).json({ ok: false, error: errText });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// GET /reconnect/qr — QR-код текущей сессии в виде картинки
router.get('/qr', async (req, res) => {
  try {
    const resp = await fetch(`${WAHA_URL}/api/${WAHA_SESSION}/auth/qr?format=image`, {
      headers: { 'X-Api-Key': WAHA_API_KEY },
    });
    if (!resp.ok) return res.status(resp.status).send('QR недоступен');

    res.set('Content-Type', resp.headers.get('content-type') || 'image/png');
    res.set('Cache-Control', 'no-store');
    const buffer = Buffer.from(await resp.arrayBuffer());
    res.send(buffer);
  } catch (e) {
    res.status(502).send('Ошибка получения QR');
  }
});

const HTML_PAGE = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Переподключение WhatsApp — chef-bot</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 420px; margin: 40px auto; padding: 0 16px; text-align: center; color: #222; }
  h1 { font-size: 20px; }
  #status { font-size: 18px; margin: 20px 0; padding: 12px; border-radius: 8px; }
  .working { background: #e6f7e9; color: #1a7f37; }
  .waiting { background: #fff8e1; color: #8a6d00; }
  .error { background: #fdecea; color: #b3261e; }
  button { font-size: 16px; padding: 10px 20px; border-radius: 8px; border: none; background: #1a73e8; color: white; cursor: pointer; }
  button:disabled { opacity: 0.6; cursor: default; }
  #qr { margin-top: 16px; max-width: 280px; width: 100%; border: 1px solid #ddd; border-radius: 8px; }
  #hint { color: #666; font-size: 14px; margin-top: 12px; }
</style>
</head>
<body>
  <h1>WhatsApp-сессия chef-bot</h1>
  <div id="status">Проверяю статус…</div>
  <button id="reconnectBtn" style="display:none">Переподключить</button>
  <img id="qr" style="display:none" alt="QR-код">
  <div id="hint" style="display:none">Отсканируйте QR в WhatsApp: Настройки → Связанные устройства → Привязать устройство</div>

<script>
const statusEl = document.getElementById('status');
const btn = document.getElementById('reconnectBtn');
const qrEl = document.getElementById('qr');
const hintEl = document.getElementById('hint');

let qrPollTimer = null;

function renderStatus(status) {
  if (status === 'WORKING') {
    statusEl.textContent = '✅ Подключено';
    statusEl.className = 'working';
    btn.style.display = 'none';
    qrEl.style.display = 'none';
    hintEl.style.display = 'none';
    stopQrPolling();
  } else if (status === 'ERROR') {
    statusEl.textContent = '⚠️ Ошибка связи с сервером';
    statusEl.className = 'error';
    btn.style.display = 'inline-block';
    qrEl.style.display = 'none';
    hintEl.style.display = 'none';
    stopQrPolling();
  } else {
    statusEl.textContent = 'Статус: ' + status;
    statusEl.className = 'waiting';
    btn.style.display = 'inline-block';
    if (status === 'SCAN_QR_CODE') {
      qrEl.style.display = 'inline-block';
      hintEl.style.display = 'block';
      refreshQr();
      startQrPolling();
    } else {
      qrEl.style.display = 'none';
      hintEl.style.display = 'none';
      stopQrPolling();
    }
  }
}

function refreshQr() {
  qrEl.src = '/reconnect/qr?t=' + Date.now();
}

function startQrPolling() {
  if (qrPollTimer) return;
  qrPollTimer = setInterval(refreshQr, 5000);
}
function stopQrPolling() {
  if (qrPollTimer) { clearInterval(qrPollTimer); qrPollTimer = null; }
}

async function checkStatus() {
  try {
    const resp = await fetch('/reconnect/status');
    if (resp.status === 401) {
      statusEl.textContent = 'Требуется авторизация — обновите страницу';
      return;
    }
    const data = await resp.json();
    renderStatus(data.status);
  } catch (e) {
    renderStatus('ERROR');
  }
}

btn.addEventListener('click', async () => {
  btn.disabled = true;
  statusEl.textContent = 'Переподключаю…';
  statusEl.className = 'waiting';
  try {
    await fetch('/reconnect/reconnect', { method: 'POST' });
  } catch (e) {}
  setTimeout(() => { btn.disabled = false; checkStatus(); }, 3000);
});

checkStatus();
setInterval(checkStatus, 3000);
</script>
</body>
</html>`;

router.get('/', (req, res) => {
  res.type('html').send(HTML_PAGE);
});

module.exports = router;
