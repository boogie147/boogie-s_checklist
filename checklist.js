// checklist.js
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is missing. Add it to GitHub Secrets.');
  process.exit(1);
}

// Start bot in polling mode (listens to messages)
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// === Persistence helpers ===
const DATA_PATH = path.resolve(__dirname, 'checklists.json');

function loadData() {
  try {
    const txt = fs.readFileSync(DATA_PATH, 'utf8');
    return JSON.parse(txt);
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

const getList = (chatId) => (DB[chatId] ||= []);
const renderList = (items) =>
  items.length
    ? items.map((it, i) => `${i + 1}. ${it.done ? '✅' : '⬜️'} ${it.text}`).join('\n')
    : 'No items yet. Use /add <task>.';

function reply(chatId, text) {
  return bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

// === Commands ===
bot.onText(/^\/add (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const text = match[1].trim();
  const items = getList(chatId);
  items.push({ text, done: false });
  saveData(DB);
  reply(chatId, `Added: <b>${escapeHtml(text)}</b>`);
});

bot.onText(/^\/list$/, (msg) => {
  const chatId = msg.chat.id;
  const items = getList(chatId);
  reply(chatId, `<b>Your checklist</b>\n${renderList(items)}`);
});

bot.onText(/^\/done (\d+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const idx = parseInt(match[1], 10) - 1;
  const items = getList(chatId);
  if (idx >= 0 && idx < items.length) {
    items[idx].done = true;
    saveData(DB);
    reply(chatId, `Marked done: <b>${escapeHtml(items[idx].text)}</b> ✅`);
  } else {
    reply(chatId, 'Invalid item number.');
  }
});

bot.onText(/^\/remove (\d+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const idx = parseInt(match[1], 10) - 1;
  const items = getList(chatId);
  if (idx >= 0 && idx < items.length) {
    const removed = items.splice(idx, 1)[0];
    saveData(DB);
    reply(chatId, `Removed: <b>${escapeHtml(removed.text)}</b> 🗑️`);
  } else {
    reply(chatId, 'Invalid item number.');
  }
});

bot.onText(/^\/clear$/, (msg) => {
  const chatId = msg.chat.id;
  DB[chatId] = [];
  saveData(DB);
  reply(chatId, 'Cleared your checklist.');
});

// === Auto-shutdown after 30 minutes ===
setTimeout(() => {
  console.log('⏱️ 30 minutes elapsed. Stopping bot.');
  bot.stopPolling();
  process.exit(0);
}, 0.5 * 60 * 1000);
