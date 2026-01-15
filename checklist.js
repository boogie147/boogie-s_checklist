// checklist.js
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

/* ===================== ENV ===================== */
const BOT_TOKEN = process.env.BOT_TOKEN;
const GROUP_CHAT_ID_RAW = (process.env.CHAT_ID || '').trim(); // MAIN GROUP (required)
const VERBOSE = String(process.env.VERBOSE || 'false') === 'true';

if (!BOT_TOKEN || !GROUP_CHAT_ID_RAW) {
  console.error('❌ BOT_TOKEN or CHAT_ID missing');
  process.exit(1);
}

const GROUP_CHAT_ID = String(GROUP_CHAT_ID_RAW);

/* ===================== BOT ===================== */
// Polling mode
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

/* ===================== STORAGE ===================== */
const DATA_PATH = path.join(__dirname, 'checklists.json');

function load() {
  try { return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')); }
  catch { return {}; }
}
function save(db) {
  const tmp = DATA_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_PATH);
}

const DB = load();

/*
DB = {
  group: {
    chatId: "<GROUP_CHAT_ID>",
    items: [{text, done}]
  },
  dmLink: {
    "<dmChatId>": true
  },
  meta: {
    lastStartDutyMessageId: number|null
  }
}
*/

DB.group ??= { chatId: GROUP_CHAT_ID, items: [] };
DB.group.chatId = GROUP_CHAT_ID; // enforce
DB.group.items ??= [];
DB.dmLink ??= {};
DB.meta ??= { lastStartDutyMessageId: null };

save(DB);

/* ===================== HELPERS ===================== */
const isPrivate = (msg) => msg.chat && msg.chat.type === 'private';
const checklist = () => DB.group.items;

function render(items) {
  if (!items.length) return 'No checklist items yet.\n\nUse ➕ Add to create tasks.';
  return items.map((x, i) => `${i + 1}. ${x.done ? '✅' : '⬜️'} ${x.text}`).join('\n');
}

function buildDMKeyboard() {
  return {
    keyboard: [
      [{ text: '➕ Add' }, { text: '🔄 Refresh' }],
      [{ text: '🧹 Clear checks' }, { text: '🧾 Summary' }],
      ...checklist().map((x, i) => [{ text: `${x.done ? '✅' : '⬜️'} #${i + 1}` }]),
      [{ text: '/menu' }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

async function safeSend(chatId, text, opts = {}) {
  try { return await bot.sendMessage(chatId, text, opts); }
  catch (e) {
    if (VERBOSE) console.error('sendMessage failed:', e?.response?.body || e);
    return null;
  }
}

function log(...a) { if (VERBOSE) console.log(...a); }

/* ===================== GROUP FLOW ===================== */
async function sendStartDutyPrompt() {
  // Message with inline button (in GROUP only)
  const msg = await safeSend(
    GROUP_CHAT_ID,
    '🟢 Duty Start\n\nTap the button below to open your checklist in DM.',
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🧑‍💻 Start Duty', callback_data: 'START_DUTY' }]
        ]
      }
    }
  );

  if (msg && msg.message_id) {
    DB.meta.lastStartDutyMessageId = msg.message_id;
    save(DB);
  }
}

async function sendDutySummaryToGroup(prefix = '📊 Duty Summary') {
  const items = checklist();
  const total = items.length;
  const done = items.filter(x => x.done).length;

  const statusLine =
    total === 0 ? 'No checklist items exist.' :
    done === total ? `All done ✅ (${done}/${total})` :
    `Incomplete ⚠️ (${done}/${total})`;

  await safeSend(GROUP_CHAT_ID, `${prefix}\n${statusLine}`);
}

/* ===================== CALLBACKS ===================== */
bot.on('callback_query', async (q) => {
  if (q.data !== 'START_DUTY') return;

  const dmChatId = String(q.from.id);
  DB.dmLink[dmChatId] = true;
  save(DB);

  // Acknowledge button tap quickly
  try { await bot.answerCallbackQuery(q.id, { text: 'Opening DM checklist…' }); }
  catch {}

  // Try DM the user
  const dmIntro =
    '✅ You are now on duty.\n' +
    'This checklist is controlled in DM only.\n\n' +
    'If the menu disappears, type /menu to restore it.';

  const ok1 = await safeSend(dmChatId, dmIntro, { reply_markup: buildDMKeyboard() });
  if (!ok1) {
    await safeSend(
      GROUP_CHAT_ID,
      '⚠️ I could not DM you.\nPlease open the bot in private once and press /start, then tap Start Duty again.'
    );
    return;
  }

  await safeSend(dmChatId, render(checklist()), { reply_markup: buildDMKeyboard() });
});

/* ===================== DM CHECKLIST CONTROLS ===================== */
bot.on('message', async (msg) => {
  if (!msg || !msg.text) return;

  // Ignore group messages (DM-only checklist)
  if (!isPrivate(msg)) return;

  const dmChatId = String(msg.chat.id);
  const text = msg.text.trim();

  // Allow /start to register user then tell them to return to group
  if (/^\/start/i.test(text)) {
    await safeSend(
      dmChatId,
      '👋 Hello.\nTo take duty, return to the group and tap “Start Duty”.\n\nIf you already tapped it, your menu will appear here.',
      { reply_markup: buildDMKeyboard() }
    );
    return;
  }

  // Only linked DMs can control checklist
  if (!DB.dmLink[dmChatId]) {
    await safeSend(
      dmChatId,
      'This bot’s checklist is DM-only and activated from the group.\nGo to the group and tap “Start Duty”.'
    );
    return;
  }

  // Menu recovery
  if (text === '/menu') {
    await safeSend(dmChatId, '📋 Menu restored.', { reply_markup: buildDMKeyboard() });
    return;
  }

  // Buttons
  if (text === '🔄 Refresh') {
    await safeSend(dmChatId, render(checklist()), { reply_markup: buildDMKeyboard() });
    return;
  }

  if (text === '🧹 Clear checks') {
    checklist().forEach(x => { x.done = false; });
    save(DB);
    await safeSend(dmChatId, 'Cleared all checkmarks.', { reply_markup: buildDMKeyboard() });
    await safeSend(dmChatId, render(checklist()), { reply_markup: buildDMKeyboard() });
    return;
  }

  if (text === '🧾 Summary') {
    const items = checklist();
    const total = items.length;
    const done = items.filter(x => x.done).length;
    const line =
      total === 0 ? 'No checklist items exist.' :
      done === total ? `All done ✅ (${done}/${total})` :
      `Incomplete ⚠️ (${done}/${total})`;
    await safeSend(dmChatId, `📊 Your status\n${line}`, { reply_markup: buildDMKeyboard() });
    return;
  }

  if (text === '➕ Add') {
    await safeSend(dmChatId, 'Send task text:', { reply_markup: { force_reply: true } });
    return;
  }

  // Add via force-reply
  if (msg.reply_to_message && (msg.reply_to_message.text || '') === 'Send task text:') {
    const t = text;
    if (!t) return;
    checklist().push({ text: t, done: false });
    save(DB);
    await safeSend(dmChatId, 'Added.', { reply_markup: buildDMKeyboard() });
    await safeSend(dmChatId, render(checklist()), { reply_markup: buildDMKeyboard() });
    return;
  }

  // Toggle item via "#N"
  const m = text.match(/#(\d+)/);
  if (m) {
    const idx = parseInt(m[1], 10) - 1;
    if (idx >= 0 && idx < checklist().length) {
      checklist()[idx].done = !checklist()[idx].done;
      save(DB);
      await safeSend(dmChatId, render(checklist()), { reply_markup: buildDMKeyboard() });
      return;
    }
  }

  // If user typed plain text in DM, treat it as add (phone-friendly)
  // (You can remove this if you want stricter behavior.)
  if (text.length > 0 && !text.startsWith('/')) {
    checklist().push({ text, done: false });
    save(DB);
    await safeSend(dmChatId, 'Added.', { reply_markup: buildDMKeyboard() });
    await safeSend(dmChatId, render(checklist()), { reply_markup: buildDMKeyboard() });
  }
});

/* ===================== SGT SCHEDULING ===================== */
const MS_IN_DAY = 24 * 60 * 60 * 1000;

function msUntilNextSgt(hour, minute) {
  const now = new Date();
  const targetUtc = new Date(now);
  targetUtc.setUTCHours(hour - 8, minute, 0, 0);
  let delta = targetUtc.getTime() - now.getTime();
  if (delta < 0) delta += MS_IN_DAY;
  return delta;
}

function scheduleDailyAtSgt(hour, minute, fn) {
  const d = msUntilNextSgt(hour, minute);
  log(`Scheduling ${hour}:${minute} SGT in ${Math.round(d/1000)}s`);
  setTimeout(async () => {
    try { await fn(); } catch (e) { console.error('daily task error:', e?.response?.body || e); }
    setInterval(async () => {
      try { await fn(); } catch (e) { console.error('daily task error:', e?.response?.body || e); }
    }, MS_IN_DAY);
  }, d);
}

/* ===================== DAILY ACTIONS ===================== */
async function sendDailyMorningPollAndStartDuty() {
  // Poll in group
  try {
    await bot.sendPoll(
      GROUP_CHAT_ID,
      'Good morning commanders, please indicate whether you will be in camp for today',
      ['Yes', 'No', 'MA/MC', 'OL', 'LL', 'OFF'],
      { is_anonymous: false, allows_multiple_answers: false }
    );
  } catch (e) {
    console.error('poll send error:', e?.response?.body || e);
  }

  // Start Duty prompt in group (inline button)
  await sendStartDutyPrompt();
}

/* ===================== STARTUP ===================== */
(async function main() {
  console.log('🤖 Bot online');
  await safeSend(GROUP_CHAT_ID, '👋 Bot awake');

  // If you run via CI at 06:00/12:00/16:00, this in-process scheduling is optional.
  // Keeping it here makes it work on 24/7 hosting too.
  scheduleDailyAtSgt(6,  0, sendDailyMorningPollAndStartDuty); // 06:00 SGT
  scheduleDailyAtSgt(17, 0, () => sendDutySummaryToGroup('📊 End-of-day summary')); // 17:00 SGT

  // Optional: when the bot is about to exit (CI duration), announce summary
  const DURATION_MINUTES = Number(process.env.DURATION_MINUTES || 0);
  const SLEEP_WARNING_SECONDS = Number(process.env.SLEEP_WARNING_SECONDS || 60);

  if (DURATION_MINUTES > 0) {
    const durMs = DURATION_MINUTES * 60 * 1000;
    const warnMs = Math.max(0, durMs - (SLEEP_WARNING_SECONDS * 1000));

    if (warnMs > 0) {
      setTimeout(async () => {
        await sendDutySummaryToGroup('😴 Bot sleeping soon — current status');
      }, warnMs);
    }

    setTimeout(async () => {
      await sendDutySummaryToGroup('🛑 Bot going offline — final status');
      process.exit(0);
    }, durMs);
  }
})();

/* ===================== CLEAN SHUTDOWN ===================== */
process.on('SIGTERM', async () => {
  try { await sendDutySummaryToGroup('🛑 Bot stopping — final status'); } catch {}
  process.exit(0);
});
process.on('SIGINT', async () => {
  try { await sendDutySummaryToGroup('🛑 Bot stopping — final status'); } catch {}
  process.exit(0);
});
