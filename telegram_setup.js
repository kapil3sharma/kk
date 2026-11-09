'use strict';
// Chalao: node telegram_setup.js   (pehle .env me TELEGRAM_BOT_TOKEN daalo aur bot ko Telegram me /start bhejo)
require('dotenv').config();
(async () => {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) return console.log('Pehle .env me TELEGRAM_BOT_TOKEN daalo (BotFather se milta hai).');
  const r = await fetch('https://api.telegram.org/bot' + t + '/getUpdates'); const j = await r.json();
  if (!j.ok) return console.log('Telegram error:', j.description);
  const ids = new Map();
  for (const u of j.result) { const c = (u.message || u.channel_post || {}).chat; if (c) ids.set(c.id, c.title || c.username || c.first_name); }
  if (!ids.size) return console.log('Koi chat nahi mili. Telegram me apne bot ko /start ya koi message bhejo, phir dobara chalao.');
  for (const [id, n] of ids) console.log('CHAT ID:', id, '(' + n + ')  ->  .env me TELEGRAM_CHAT_ID=' + id);
})();
