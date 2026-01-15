// checklist.js
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

/* ===================== ENV ===================== */
const BOT_TOKEN = process.env.BOT_TOKEN;
const GROUP_CHAT_ID = process.env.CHAT_ID; // MAIN GROUP (required)

if (!BOT_TOKEN || !GROUP_CHAT_ID) {
  console.error('❌ BOT_TOKEN or CHAT_ID missing');
  process.exit(1);
}

/* ===================== BOT ===================== */
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

/* ===================== STORAGE ===================== */
const DATA_PATH = path.join(__dirname, 'checklists.json');

function load() {
  try { return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')); }
  catch { return {}; }
}
function save(db) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(db, null, 2));
}

const DB = load();

/*
DB = {
  group: { items:[{text,done}] },
  dmLink: { "<dmChatId>": true }
}
*/

DB.group ??= { items: [] };
DB.dmLink ??= {};
save(DB);

/* ===================== HELPERS ===================== */
const isPrivate = (msg) => msg.chat.type === 'private';

function checklist() {
  return DB.group.items;
}

function render(items) {
  if (!items.length) return 'No checklist items yet.';
  return items.map((x,i)=>`${i+1}. ${x.done?'✅':'⬜️'} ${x.text}`).join('\n');
}

function keyboard() {
  return {
    keyboard: [
      [{ text: '➕ Add' }, { text: '🔄 Refresh' }],
      [{ text: '🧹 Clear checks' }],
      ...checklist().map((x,i)=>[{ text:`${x.done?'✅':'⬜️'} #${i+1}` }])
    ],
    resize_keyboard: true
  };
}

/* ===================== GROUP FLOW ===================== */
async function sendStartDuty() {
  await bot.sendMessage(
    GROUP_CHAT_ID,
    '🟢 Duty start\n\nClick below to begin your checklist in DM.',
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🧑‍💻 Start Duty', callback_data: 'START_DUTY' }]
        ]
      }
    }
  );
}

async function sendSummary() {
  const items = checklist();
  const done = items.filter(x=>x.done).length;
  await bot.sendMessage(
    GROUP_CHAT_ID,
    `📊 Duty Summary\n${done}/${items.length} completed`
  );
}

/* ===================== CALLBACK ===================== */
bot.on('callback_query', async (q) => {
  if (q.data !== 'START_DUTY') return;

  const dmId = q.from.id;
  DB.dmLink[dmId] = true;
  save(DB);

  try {
    await bot.sendMessage(
      dmId,
      '✅ You are now on duty.\n\nHere is today’s checklist:',
      { reply_markup: keyboard() }
    );
    await bot.sendMessage(dmId, render(checklist()));
  } catch {
    await bot.sendMessage(
      GROUP_CHAT_ID,
      '⚠️ User must start the bot first (@yourbot /start)'
    );
  }

  await bot.answerCallbackQuery(q.id);
});

/* ===================== DM CHECKLIST ===================== */
bot.on('message', async (msg) => {
  if (!isPrivate(msg)) return;
  if (!DB.dmLink[msg.chat.id]) return;

  const text = msg.text || '';

  if (text === '/menu') {
    return bot.sendMessage(msg.chat.id, '📋 Menu restored', { reply_markup: keyboard() });
  }

  if (text === '🔄 Refresh') {
    return bot.sendMessage(msg.chat.id, render(checklist()), { reply_markup: keyboard() });
  }

  if (text === '🧹 Clear checks') {
    checklist().forEach(x=>x.done=false);
    save(DB);
    return bot.sendMessage(msg.chat.id, 'Cleared.', { reply_markup: keyboard() });
  }

  if (text === '➕ Add') {
    return bot.sendMessage(msg.chat.id, 'Send task text:', { force_reply:true });
  }

  if (msg.reply_to_message && msg.reply_to_message.text === 'Send task text:') {
    checklist().push({ text, done:false });
    save(DB);
    return bot.sendMessage(msg.chat.id, render(checklist()), { reply_markup: keyboard() });
  }

  const m = text.match(/#(\d+)/);
  if (m) {
    const i = parseInt(m[1])-1;
    if (checklist()[i]) {
      checklist()[i].done = !checklist()[i].done;
      save(DB);
      return bot.sendMessage(msg.chat.id, render(checklist()), { reply_markup: keyboard() });
    }
  }
});

/* ===================== SCHEDULE ===================== */
function schedule(hour, minute, fn) {
  const now = new Date();
  const target = new Date();
  target.setUTCHours(hour-8, minute, 0, 0);
  if (target < now) target.setDate(target.getDate()+1);
  setTimeout(()=>{
    fn();
    setInterval(fn, 86400000);
  }, target-now);
}

async function sendPoll() {
  await bot.sendPoll(
    GROUP_CHAT_ID,
    'Will you be in camp today?',
    ['Yes','No','MA/MC','OL','OFF'],
    { is_anonymous:false }
  );
  await sendStartDuty();
}

/* ===================== STARTUP ===================== */
(async ()=>{
  console.log('🤖 Bot online');
  await bot.sendMessage(GROUP_CHAT_ID, '👋 Bot awake');
  schedule(6,0, sendPoll);
  schedule(17,0, sendSummary);
})();
