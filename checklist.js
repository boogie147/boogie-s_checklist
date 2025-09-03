// checklist.js
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is missing. Add it to your GitHub Secrets.');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

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

// === Checklist helpers ===
const getList = (chatId) => (DB[chatId] ||= []);
const renderList = (items) =>
  items.length
    ? items.map((it, i) => `${i + 1}. ${it.done ? '✅' : '⬜️'} ${it.text}`).join('\n')
    : 'No items yet. Use /add <task> to add one.';

async function reply(chatId, text) {
  return bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

// === Commands ===
async function cmdAdd(chatId, args) {
  const text = args.trim();
  if (!text) return reply(chatId, 'Usage: /add <task>');
  const items = getList(chatId);
  items.push({ text, done: false });
  saveData(DB);
  await reply(chatId, `Added: <b>${escapeHtml(text)}</b>`);
}

async function cmdList(chatId) {
  const items = getList(chatId);
  return reply(chatId, `<b>Your checklist</b>\n${renderList(items)}`);
}

async function cmdDone(chatId, args) {
  const idx = parseInt(args, 10) - 1;
  const items = getList(chatId);
  if (isNaN(idx) || idx < 0 || idx >= items.length) {
    return reply(chatId, 'Usage: /done <number>');
  }
  items[idx].done = true;
  saveData(DB);
  await reply(chatId, `Marked done: <b>${escapeHtml(items[idx].text)}</b> ✅`);
}

async function cmdRemove(chatId, args) {
  const idx = parseInt(args, 10) - 1;
  const items = getList(chatId);
  if (isNaN(idx) || idx < 0 || idx >= items.length) {
    return reply(chatId, 'Usage: /remove <number>');
  }
  const removed = items.splice(idx, 1)[0];
  saveData(DB);
  await reply(chatId, `Removed: <b>${escapeHtml(removed.text)}</b> 🗑️`);
}

async function cmdClear(chatId) {
  DB[chatId] = [];
  saveData(DB);
  await reply(chatId, 'Cleared your checklist.');
}

// === Scheduled entrypoint ===
(async function main() {
  saveData(DB); // normalize format

  const CHAT_ID = process.env.CHAT_ID;
  if (CHAT_ID) {
    const items = getList(CHAT_ID);
    await reply(CHAT_ID, `<b>Checklist digest</b>\n${renderList(items)}`);
  }

  console.log('checklist.js run complete.');
})();
