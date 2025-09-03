// checklist.js
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN is missing (set it in GitHub Secrets).');
  process.exit(1);
}

// === Persistence ===
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
const getList = (chatId) => (DB[chatId] ||= []);
const renderList = (items) =>
  items.length
    ? items.map((it, i) => `${i + 1}. ${it.done ? '✅' : '⬜️'} ${it.text}`).join('\n')
    : 'No items yet. Use /add <task>.';
const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

// Create bot without polling first; we’ll clear webhook and then start polling explicitly
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// Basic logging & error visibility
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

async function reply(chatId, text) {
  return bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
}

// === Command handlers ===
function wireHandlers() {
  // /start
  bot.onText(/^\/start$/, async (msg) => {
    const chatId = msg.chat.id;
    await reply(
      chatId,
      [
        '<b>Checklist Bot</b>',
        'Commands:',
        '• /add &lt;text&gt;',
        '• /list',
        '• /done &lt;number&gt;',
        '• /remove &lt;number&gt;',
        '• /clear',
      ].join('\n')
    );
  });

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
    reply(chatId, `<b>Your checklist</b>\n${renderList(getList(chatId))}`);
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

  // Optional fallback: if user just types text, treat as /add
  bot.on('message', (msg) => {
    if (msg.text && !/^\/(start|add|list|done|remove|clear)/.test(msg.text)) {
      const chatId = msg.chat.id;
      const items = getList(chatId);
      items.push({ text: msg.text.trim(), done: false });
      saveData(DB);
      reply(chatId, `Added: <b>${escapeHtml(msg.text.trim())}</b>`);
    }
  });

  // Log polling errors
  bot.on('polling_error', (err) => {
    console.error('polling_error:', err?.response?.body || err);
  });
}

async function main() {
  try {
    const me = await bot.getMe();
    console.log(`🤖 Starting bot @${me.username} (ID ${me.id})`);

    // Ensure webhook is cleared so polling can work
    try {
      await bot.deleteWebHook({ drop_pending_updates: false });
      console.log('✅ Webhook cleared (polling mode enabled).');
    } catch (e) {
      console.warn('⚠️ Failed to delete webhook (continuing):', e?.response?.body || e);
    }

    wireHandlers();

    // Start polling explicitly
    await bot.startPolling();
    console.log('📡 Polling started.');

    // Optional: send a “bot is online” ping to a known chat for visibility
    if (process.env.CHAT_ID) {
      await reply(process.env.CHAT_ID, '✅ Bot is online for the next 30 minutes.');
    }

    // Auto-shutdown after 30 minutes so the workflow can commit state
    setTimeout(async () => {
      console.log('⏱️ 30 minutes elapsed — stopping bot and exiting.');
      try {
        await bot.stopPolling();
      } catch (e) {
        console.warn('stopPolling error:', e);
      }
      process.exit(0);
    }, 0.5 * 60 * 1000);
  } catch (e) {
    console.error('Fatal startup error:', e?.response?.body || e);
    process.exit(1);
  }
}

main();

