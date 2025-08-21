require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');

const TOKEN = process.env.BOT_TOKEN;
const DATA_FILE = './checklists.json';
const bot = new TelegramBot(TOKEN, { polling: true });

// === Load/save functions ===
function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(DATA_FILE));
    } catch (e) {
      console.warn("⚠️ Invalid JSON, resetting.");
      return {};
    }
  }
  return {};
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let data = loadData();

// === Bot Commands ===

bot.onText(/\/start/, (msg) => {
  const id = msg.from.id;
  data[id] = data[id] || { checklist: [] };
  saveData(data);
  bot.sendMessage(id, `👋 Welcome to Checklist Bot!\n\nCommands:\n/add <task>\n/list\n/done <number>\n/remove <number>\n/clear\n/reset`);
});

bot.onText(/\/add (.+)/, (msg, match) => {
  const id = msg.from.id;
  const item = match[1];
  data[id] = data[id] || { checklist: [] };
  data[id].checklist.push({ item, done: false });
  saveData(data);
  bot.sendMessage(id, `✅ Added: ${item}`);
});

bot.onText(/\/list/, (msg) => {
  const id = msg.from.id;
  const list = data[id]?.checklist || [];
  if (!list.length) return bot.sendMessage(id, "📜 Your checklist is empty.");
  const text = list.map((e, i) => `${i + 1}. ${e.done ? "✅" : "⬜"} ${e.item}`).join('\n');
  bot.sendMessage(id, `📋 Your checklist:\n${text}`);
});

bot.onText(/\/done (\d+)/, (msg, match) => {
  const id = msg.from.id;
  const i = parseInt(match[1]) - 1;
  if (data[id]?.checklist?.[i]) {
    data[id].checklist[i].done = true;
    saveData(data);
    bot.sendMessage(id, `✅ Marked item ${i + 1} as done.`);
  } else {
    bot.sendMessage(id, "❌ Invalid task number.");
  }
});

bot.onText(/\/remove (\d+)/, (msg, match) => {
  const id = msg.from.id;
  const i = parseInt(match[1]) - 1;
  if (data[id]?.checklist?.[i]) {
    const removed = data[id].checklist.splice(i, 1)[0];
    saveData(data);
    bot.sendMessage(id, `🗑️ Removed: ${removed.item}`);
  } else {
    bot.sendMessage(id, "❌ Invalid task number.");
  }
});

bot.onText(/\/clear/, (msg) => {
  const id = msg.from.id;
  if (data[id]?.checklist?.length) {
    data[id].checklist = [];
    saveData(data);
    bot.sendMessage(id, "🧹 Checklist cleared.");
  } else {
    bot.sendMessage(id, "Checklist is already empty.");
  }
});

bot.onText(/\/reset/, (msg) => {
  const id = msg.from.id;
  if (data[id]?.checklist?.length) {
    data[id].checklist.forEach(e => e.done = false);
    saveData(data);
    bot.sendMessage(id, "♻️ All tasks marked as not done.");
  } else {
    bot.sendMessage(id, "Checklist is empty.");
  }
});

// === Startup message to all users
for (const id of Object.keys(data)) {
  bot.sendMessage(id, "✅ Bot is now online!");
}

// === Reminder after 10 seconds
setTimeout(() => {
  for (const id of Object.keys(data)) {
    const list = data[id]?.checklist || [];
    let message = "⏰ Reminder!\n";
    if (!list.length) message += "Your checklist is empty.";
    else message += list.map((e, i) => `${i + 1}. ${e.done ? "✅" : "⬜"} ${e.item}`).join('\n');
    bot.sendMessage(id, message);
  }
}, 10000);

// === Auto shutdown after 30 minutes
setTimeout(() => {
  console.log("🔴 Shutting down after 30 mins.");
  process.exit(0);
}, 30 * 60 * 1000);
