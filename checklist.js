// checklist.js
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN is missing (set it in GitHub Secrets).');
  process.exit(1);
}

// Start bot in polling mode (interactive for 30 mins)
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ===== Persistence =====
const DATA_PATH = path.resolve(__dirname, 'checklists.json');

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  } catch {
    fs.writeFileSync(DATA_PATH, JSON.stringify({}, null, 2));
    return {};
  }
}
function saveData(obj) {
  const tmp = DATA_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, DATA_PATH);
}

let DB = loadData();

// Track chats we should notify during this run
const ActiveChats = new Set(Object.keys(DB)); // start with known chats
const ANNOUNCE_CHAT = process.env.CHAT_ID || null; // optional broadcast chat (e.g., a group)

// ===== Helpers =====
const getList = (chatId) => (DB[chatId] ||= []);
const isAllDone = (items) => items.length > 0 && items.every((x) => x.done);
const emptyOrAllDone = (items) => items.length === 0 || isAllDone(items);

const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

function renderLines(items) {
  return items.length
    ? items.map((it, i) => `${i + 1}. ${it.done ? '✅' : '⬜️'} ${it.text}`).join('\n')
    : 'No items yet. Use /add <task> or the + button to add one.';
}

function buildKeyboard(items) {
  // One button per item -> toggles done/undone
  const rows = items.map((it, i) => ([
    { text: `${it.done ? '✅' : '⬜️'} ${truncate(it.text, 40)}`, callback_data: `t:${i}` },
    { text: '🗑', callback_data: `rm:${i}` },
  ]));

  // Controls row
  rows.push([
    { text: '➕ Add', callback_data: 'add_prompt' },
    { text: '🧹 Clear', callback_data: 'clear_all' },
    { text: '🔄 Refresh', callback_data: 'refresh' },
  ]);

  return { reply_markup: { inline_keyboard: rows } };
}

function truncate(s, n) {
  if (!s) return s;
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

async function reply(chatId, html, extra = {}) {
  return bot.sendMessage(chatId, html, { parse_mode: 'HTML', ...extra });
}

async function edit(chatId, message_id, html, extra = {}) {
  return bot.editMessageText(html, {
    chat_id: chatId,
    message_id,
    parse_mode: 'HTML',
    ...extra,
  });
}

function ensureChatTracked(chatId) {
  ActiveChats.add(String(chatId));
  if (!DB[chatId]) DB[chatId] = [];
}

// ===== Command wiring =====
bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;
  ensureChatTracked(chatId);

  await reply(
    chatId,
    [
      '<b>Checklist Bot</b> is awake 👋',
      'Use the buttons or commands:',
      '• /add &lt;text&gt;',
      '• /list',
      '• /done &lt;number&gt;',
      '• /remove &lt;number&gt;',
      '• /clear',
    ].join('\n'),
    buildKeyboard(getList(chatId))
  );
});

bot.onText(/^\/add (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  ensureChatTracked(chatId);
  const text = match[1].trim();
  if (!text) return reply(chatId, 'Usage: /add <task>');
  getList(chatId).push({ text, done: false });
  saveData(DB);
  await reply(chatId, `Added: <b>${escapeHtml(text)}</b>`);
  await sendListInteractive(chatId);
});

bot.onText(/^\/list$/, async (msg) => {
  const chatId = msg.chat.id;
  ensureChatTracked(chatId);
  await sendListInteractive(chatId);
});

bot.onText(/^\/done (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  ensureChatTracked(chatId);
  const idx = parseInt(match[1], 10) - 1;
  const items = getList(chatId);
  if (idx >= 0 && idx < items.length) {
    items[idx].done = true;
    saveData(DB);
    await reply(chatId, `Marked done: <b>${escapeHtml(items[idx].text)}</b> ✅`);
    await sendListInteractive(chatId);
  } else {
    await reply(chatId, 'Invalid item number.');
  }
});

bot.onText(/^\/remove (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  ensureChatTracked(chatId);
  const idx = parseInt(match[1], 10) - 1;
  const items = getList(chatId);
  if (idx >= 0 && idx < items.length) {
    const removed = items.splice(idx, 1)[0];
    saveData(DB);
    await reply(chatId, `Removed: <b>${escapeHtml(removed.text)}</b> 🗑️`);
    await sendListInteractive(chatId);
  } else {
    await reply(chatId, 'Invalid item number.');
  }
});

bot.onText(/^\/clear$/, async (msg) => {
  const chatId = msg.chat.id;
  ensureChatTracked(chatId);
  DB[chatId] = [];
  saveData(DB);
  await reply(chatId, 'Cleared your checklist.');
  await sendListInteractive(chatId);
});

// Optional: any non-command text becomes a new item
bot.on('message', async (msg) => {
  if (!msg.text) return;
  if (/^\/(start|add|list|done|remove|clear)/.test(msg.text)) return;

  const chatId = msg.chat.id;
  ensureChatTracked(chatId);
  const t = msg.text.trim();
  if (!t) return;
  getList(chatId).push({ text: t, done: false });
  saveData(DB);
  await reply(chatId, `Added: <b>${escapeHtml(t)}</b>`);
  await sendListInteractive(chatId);
});

// ===== Inline button handlers =====
bot.on('callback_query', async (q) => {
  try {
    const chatId = q.message.chat.id;
    const msgId = q.message.message_id;
    ensureChatTracked(chatId);
    const items = getList(chatId);

    const [action, arg] = (q.data || '').split(':');

    if (action === 't') {
      // toggle index
      const i = parseInt(arg, 10);
      if (!isNaN(i) && items[i]) {
        items[i].done = !items[i].done;
        saveData(DB);
      }
      await refreshMessage(chatId, msgId);
    } else if (action === 'rm') {
      const i = parseInt(arg, 10);
      if (!isNaN(i) && items[i]) {
        const removed = items.splice(i, 1)[0];
        saveData(DB);
        await reply(chatId, `Removed: <b>${escapeHtml(removed.text)}</b> 🗑️`);
      }
      await refreshMessage(chatId, msgId);
    } else if (action === 'clear_all') {
      DB[chatId] = [];
      saveData(DB);
      await refreshMessage(chatId, msgId);
    } else if (action === 'refresh') {
      await refreshMessage(chatId, msgId);
    } else if (action === 'add_prompt') {
      await reply(chatId, 'Send me the task text, and I will add it.');
    }

    // Always answer callback to remove spinner
    await bot.answerCallbackQuery(q.id);
  } catch (e) {
    console.error('callback error:', e?.response?.body || e);
    try { await bot.answerCallbackQuery(q.id); } catch {}
  }
});

async function sendListInteractive(chatId) {
  const items = getList(chatId);
  return reply(
    chatId,
    `<b>Your checklist</b>\n${renderLines(items)}`,
    buildKeyboard(items)
  );
}

async function refreshMessage(chatId, message_id) {
  const items = getList(chatId);
  return edit(
    chatId,
    message_id,
    `<b>Your checklist</b>\n${renderLines(items)}`,
    buildKeyboard(items)
  );
}

// ===== Wake message + timed reminders =====
async function broadcastAwake() {
  const chats = new Set(ActiveChats);
  if (ANNOUNCE_CHAT) chats.add(String(ANNOUNCE_CHAT));

  for (const cid of chats) {
    try {
      await reply(cid, '👋 Hello! The bot is awake and ready for the next 30 minutes. Use /list or the buttons below.');
      await sendListInteractive(cid);
    } catch (e) {
      // Ignore send errors (bot kicked, etc.)
      console.warn('awake send failed for', cid, e?.response?.body || e);
    }
  }
}

// 20-minute reminder
setTimeout(async () => {
  await sendReminder('⏱️ 20 minutes gone. ');
}, 20 * 60 * 1000);

// 25-minute reminder
setTimeout(async () => {
  await sendReminder('⏱️ 25 minutes gone. ');
}, 25 * 60 * 1000);

async function sendReminder(prefix) {
  const chats = new Set(ActiveChats);
  if (ANNOUNCE_CHAT) chats.add(String(ANNOUNCE_CHAT));

  for (const cid of chats) {
    const items = getList(cid);
    try {
      if (isAllDone(items)) {
        await reply(cid, `${prefix}🎉 Awesome work — your list is complete!`);
      } else if (items.length === 0) {
        await reply(cid, `${prefix}Your list is empty. Tap ➕ Add to create your first task.`);
      } else {
        await reply(cid, `${prefix}Friendly reminder to keep going!\n\n${renderLines(items)}`, buildKeyboard(items));
      }
    } catch (e) {
      console.warn('reminder send failed for', cid, e?.response?.body || e);
    }
  }
}

// ===== Startup & graceful shutdown =====
(async function main() {
  // Clear webhook if any, so polling works
  try {
    await bot.deleteWebHook({ drop_pending_updates: false });
  } catch (e) {
    console.warn('webhook delete failed:', e?.response?.body || e);
  }

  const me = await bot.getMe();
  console.log(`🤖 Bot @${me.username} is starting with ${ActiveChats.size} known chats.`);

  // Send wake announcement
  await broadcastAwake();

  // Auto-stop after 30 minutes (so the workflow can commit changes)
  setTimeout(async () => {
    console.log('⏱️ 30 minutes elapsed — stopping bot and exiting.');
    try { await bot.stopPolling(); } catch {}
    saveData(DB);
    process.exit(0);
  }, 30 * 60 * 1000);
})();

// Safety: persist on SIGTERM in case runner ends early
process.on('SIGTERM', () => {
  try { saveData(DB); } catch {}
  process.exit(0);
});

