// checklist.js
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

/* ===================== ENV ===================== */
const BOT_TOKEN = process.env.BOT_TOKEN;
const GROUP_CHAT_ID = (process.env.CHAT_ID || '').trim(); // main group chat id (required)

const VERBOSE = String(process.env.VERBOSE || 'false') === 'true';
const RUN_KIND = String(process.env.RUN_KIND || '').trim().toLowerCase(); // e.g. "morning" from CI
const SILENT_AWAKE = String(process.env.SILENT_AWAKE || 'false') === 'true';

// Behavior toggles (you can override in CI env)
const DEFAULT_SEND_POLL_ON_START = (RUN_KIND === 'morning');
const DEFAULT_SEND_START_DUTY_ON_START = (RUN_KIND === 'morning');

const SEND_POLL_ON_START =
  process.env.SEND_POLL_ON_START != null
    ? String(process.env.SEND_POLL_ON_START) === 'true'
    : DEFAULT_SEND_POLL_ON_START;

const SEND_START_DUTY_ON_START =
  process.env.SEND_START_DUTY_ON_START != null
    ? String(process.env.SEND_START_DUTY_ON_START) === 'true'
    : DEFAULT_SEND_START_DUTY_ON_START;

if (!BOT_TOKEN || !GROUP_CHAT_ID) {
  console.error('❌ BOT_TOKEN or CHAT_ID missing.');
  process.exit(1);
}

/* ===================== BOT ===================== */
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const log = (...a) => { if (VERBOSE) console.log(...a); };

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

// DB layout:
// DB.group = { chatId: "<GROUP_CHAT_ID>", items:[{text,done}], dutyUserId?:string, dutyUserName?:string }
// DB.dmLink = { "<dmChatId>": true }
// DB.meta = { lastStartDutyMessageId?: number|null }

DB.group ??= { chatId: String(GROUP_CHAT_ID), items: [] };
DB.group.chatId = String(GROUP_CHAT_ID);
DB.group.items ??= [];
DB.dmLink ??= {};
DB.meta ??= { lastStartDutyMessageId: null };

save(DB);

const isPrivate = (msg) => msg.chat && msg.chat.type === 'private';

function checklist() {
  return DB.group.items;
}

function renderChecklist(items) {
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
    log('sendMessage failed:', e?.response?.body || e);
    return null;
  }
}

async function safePoll(chatId, question, options, extra = {}) {
  try { return await bot.sendPoll(chatId, question, options, extra); }
  catch (e) {
    console.error('poll send error:', e?.response?.body || e);
    return null;
  }
}

/* ===================== GROUP: START DUTY PROMPT ===================== */
async function sendStartDutyPrompt(reason = '') {
  const text =
    '🟢 Duty Start\n\n' +
    'Tap the button below to open your checklist in DM.' +
    (reason ? `\n\n(${reason})` : '');

  const msg = await safeSend(GROUP_CHAT_ID, text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🧑‍💻 Start Duty', callback_data: 'START_DUTY' }]
      ]
    }
  });

  if (msg?.message_id) {
    DB.meta.lastStartDutyMessageId = msg.message_id;
    save(DB);
  }
}

async function sendDutySummaryToGroup(prefix = '📊 Duty Summary') {
  const items = checklist();
  const total = items.length;
  const done = items.filter(x => x.done).length;

  const userLine = DB.group.dutyUserName
    ? `Duty user: ${DB.group.dutyUserName}`
    : 'Duty user: (not started)';

  const statusLine =
    total === 0 ? 'Checklist: (no items)' :
    done === total ? `Checklist: ✅ COMPLETE (${done}/${total})` :
    `Checklist: ⚠️ INCOMPLETE (${done}/${total})`;

  await safeSend(GROUP_CHAT_ID, `${prefix}\n${userLine}\n${statusLine}`);
}

/* ===================== CALLBACK: START DUTY ===================== */
bot.on('callback_query', async (q) => {
  if (q.data !== 'START_DUTY') return;

  const dmChatId = String(q.from.id);

  // mark as linked
  DB.dmLink[dmChatId] = true;
  DB.group.dutyUserId = dmChatId;

  const displayName =
    [q.from.first_name, q.from.last_name].filter(Boolean).join(' ') ||
    q.from.username ||
    `id:${q.from.id}`;

  DB.group.dutyUserName = displayName;
  save(DB);

  // ack
  try { await bot.answerCallbackQuery(q.id, { text: 'Opening DM checklist…' }); } catch {}

  // DM intro
  const dmIntro =
    '✅ You are now on duty.\n' +
    'Checklist is managed in DM.\n\n' +
    'If the menu disappears, type /menu to restore it.';

  const ok = await safeSend(dmChatId, dmIntro, { reply_markup: buildDMKeyboard() });
  if (!ok) {
    await safeSend(
      GROUP_CHAT_ID,
      '⚠️ I could not DM you.\nPlease open the bot in private once and press /start, then tap Start Duty again.'
    );
    return;
  }

  await safeSend(dmChatId, renderChecklist(checklist()), { reply_markup: buildDMKeyboard() });
});

/* ===================== GROUP COMMAND: /duty ===================== */
/**
 * Lets you repost the Start Duty button manually.
 * (Useful when Telegram clients glitch or someone missed it.)
 */
bot.onText(/^\/duty(?:@[\w_]+)?/i, async (msg) => {
  if (String(msg.chat.id) !== String(GROUP_CHAT_ID)) return;
  await sendStartDutyPrompt('manual repost');
});

/* ===================== DM CONTROLS (DM-only checklist) ===================== */
bot.on('message', async (msg) => {
  if (!msg?.text) return;

  // DM only
  if (!isPrivate(msg)) return;

  const dmChatId = String(msg.chat.id);
  const text = msg.text.trim();

  // /start in DM
  if (/^\/start/i.test(text)) {
    await safeSend(
      dmChatId,
      '👋 Hello.\nTo take duty, return to the group and tap “Start Duty”.\n\nIf you already tapped it, your menu will appear here.',
      { reply_markup: buildDMKeyboard() }
    );
    return;
  }

  // must have started duty
  if (!DB.dmLink[dmChatId]) {
    await safeSend(
      dmChatId,
      'This checklist is activated from the group.\nGo to the group and tap “Start Duty”.'
    );
    return;
  }

  // menu restore
  if (text === '/menu') {
    await safeSend(dmChatId, '📋 Menu restored.', { reply_markup: buildDMKeyboard() });
    return;
  }

  // refresh
  if (text === '🔄 Refresh') {
    await safeSend(dmChatId, renderChecklist(checklist()), { reply_markup: buildDMKeyboard() });
    return;
  }

  // clear checks
  if (text === '🧹 Clear checks') {
    checklist().forEach(x => { x.done = false; });
    save(DB);
    await safeSend(dmChatId, 'Cleared all checkmarks.', { reply_markup: buildDMKeyboard() });
    await safeSend(dmChatId, renderChecklist(checklist()), { reply_markup: buildDMKeyboard() });
    return;
  }

  // summary
  if (text === '🧾 Summary') {
    const items = checklist();
    const total = items.length;
    const done = items.filter(x => x.done).length;
    const line =
      total === 0 ? 'Checklist: (no items)' :
      done === total ? `Checklist: ✅ COMPLETE (${done}/${total})` :
      `Checklist: ⚠️ INCOMPLETE (${done}/${total})`;
    await safeSend(dmChatId, `📊 Status\n${line}`, { reply_markup: buildDMKeyboard() });
    return;
  }

  // add prompt
  if (text === '➕ Add') {
    await safeSend(dmChatId, 'Send task text:', { reply_markup: { force_reply: true } });
    return;
  }

  // add via force-reply
  if (msg.reply_to_message && (msg.reply_to_message.text || '') === 'Send task text:') {
    const t = text;
    if (!t) return;
    checklist().push({ text: t, done: false });
    save(DB);
    await safeSend(dmChatId, 'Added.', { reply_markup: buildDMKeyboard() });
    await safeSend(dmChatId, renderChecklist(checklist()), { reply_markup: buildDMKeyboard() });
    return;
  }

  // toggle via "#N"
  const m = text.match(/#(\d+)/);
  if (m) {
    const idx = parseInt(m[1], 10) - 1;
    if (idx >= 0 && idx < checklist().length) {
      checklist()[idx].done = !checklist()[idx].done;
      save(DB);
      await safeSend(dmChatId, renderChecklist(checklist()), { reply_markup: buildDMKeyboard() });
      return;
    }
  }

  // free-text add (optional convenience)
  if (text.length > 0 && !text.startsWith('/')) {
    checklist().push({ text, done: false });
    save(DB);
    await safeSend(dmChatId, 'Added.', { reply_markup: buildDMKeyboard() });
    await safeSend(dmChatId, renderChecklist(checklist()), { reply_markup: buildDMKeyboard() });
  }
});

/* ===================== STARTUP BEHAVIOR ===================== */
async function morningPoll() {
  await safePoll(
    GROUP_CHAT_ID,
    'Good morning commanders, please indicate whether you will be in camp for today',
    ['Yes', 'No', 'MA/MC', 'OL', 'LL', 'OFF'],
    { is_anonymous: false, allows_multiple_answers: false }
  );
}

(async function main() {
  console.log('🤖 Bot online');
  log('RUN_KIND=', RUN_KIND, 'SEND_POLL_ON_START=', SEND_POLL_ON_START, 'SEND_START_DUTY_ON_START=', SEND_START_DUTY_ON_START);

  if (!SILENT_AWAKE) {
    await safeSend(GROUP_CHAT_ID, '👋 Bot awake');
  }

  // CRITICAL FIX:
  // For CI jobs: do the morning actions immediately at start (instead of relying on in-process schedule)
  if (SEND_POLL_ON_START) {
    await morningPoll();
  }
  if (SEND_START_DUTY_ON_START) {
    await sendStartDutyPrompt(RUN_KIND ? `run_kind=${RUN_KIND}` : 'startup');
  }

  // If you also want the bot to announce summary before exit when CI stops it:
  const DURATION_MINUTES = Number(process.env.DURATION_MINUTES || 0);
  const SLEEP_WARNING_SECONDS = Number(process.env.SLEEP_WARNING_SECONDS || 60);

  if (DURATION_MINUTES > 0) {
    const durMs = DURATION_MINUTES * 60 * 1000;
    const warnMs = Math.max(0, durMs - (SLEEP_WARNING_SECONDS * 1000));

    if (warnMs > 0) {
      setTimeout(async () => {
        await safeSend(GROUP_CHAT_ID, '😴 Bot is going to sleep soon.');
        await sendDutySummaryToGroup('📊 Status before sleep');
      }, warnMs);
    }

    setTimeout(async () => {
      await safeSend(GROUP_CHAT_ID, '😴 Bot is going to sleep.');
      await sendDutySummaryToGroup('📊 Final status');
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
