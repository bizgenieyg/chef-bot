require('dotenv').config();
const { NATALIA_PERSONAL_NUMBER } = require('./natalia');

const WAHA_URL     = 'http://localhost:3003';
const WAHA_API_KEY = process.env.WAHA_API_KEY || 'blaster123';
const WAHA_SESSION = process.env.WAHA_SESSION || 'default';

async function sendOrderToNatalia(orderBlock, clientChatId) {
  // clientChatId для связи (WhatsApp), телефон клиента уже внутри orderBlock
  const text = `${orderBlock}\n\n💬 WhatsApp клиента: ${clientChatId}`;

  try {
    const resp = await fetch(`${WAHA_URL}/api/sendText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': WAHA_API_KEY },
      body: JSON.stringify({ session: WAHA_SESSION, chatId: NATALIA_PERSONAL_NUMBER, text }),
    });
    if (!resp.ok) {
      console.error('[notify] failed:', resp.status, await resp.text());
    } else {
      console.log(`[notify] Order sent to Natalia (client ${clientChatId})`);
    }
  } catch (e) {
    console.error('[notify] error:', e.message);
  }
}

module.exports = { sendOrderToNatalia };
