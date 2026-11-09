'use strict';
// Telegram alerts. .env me: TELEGRAM_BOT_TOKEN=... aur TELEGRAM_CHAT_ID=...
// Setup: @BotFather se bot banao -> bot ko /start bhejo -> `node telegram_setup.js` chat id batayega.
const sent = new Map();      // key -> ts (dedupe/cooldown)
let minuteCount = 0, minuteStart = Date.now();
const enabled = () => !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);

async function notify(text, key, cooldownMs = 10 * 60 * 1000) {
  if (!enabled()) return false;
  const now = Date.now();
  if (now - minuteStart > 60000) { minuteStart = now; minuteCount = 0; }
  if (minuteCount >= 15) return false;                                   // spam se bachav: max 15 msg/min
  const k = key || text;
  if (sent.has(k) && now - sent.get(k) < cooldownMs) return false;
  sent.set(k, now); minuteCount++;
  if (sent.size > 500) for (const [a, t] of sent) if (now - t > 86400000) sent.delete(a);
  try {
    const r = await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: String(text).slice(0, 3800), disable_web_page_preview: true })
    });
    if (!r.ok) { console.warn('[Telegram] HTTP', r.status); return false; }
    return true;
  } catch (e) { console.warn('[Telegram]', e.message); return false; }
}
module.exports = { notify, enabled };
