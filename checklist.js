// checklist.js
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

/* ===================== ENV ===================== */
const BOT_TOKEN = process.env.BOT_TOKEN;
const GROUP_CHAT_ID = (process.env.CHAT_ID || '').trim(); // main group chat id (required)

const VERBOSE = String(process.env.VERBOSE || 'false') === 'true';
const DROP_PENDING = String(process.env.DROP_PENDING || 'true') === 'true';

const DURATION_MINUTES = Number(process.env.DURATION_MINUTES || 0); // 0 = no auto-stop
const SLEEP_WARNING_SECONDS = Number(process.env.SLEEP_WARNING_SECONDS || 60);

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN missing.');
  process.exit(1);
}
if (!GROUP_CHAT_ID) {
  console.error('❌ CHAT_ID (group chat id) missing.');
  process.exit(1);
}

/* ===================== BOT ===================== */
// Start with polling; we still delete webhook (best-effort) right after start
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const log = (...a) => { if (VERBOSE) console.log(...a); };

const isPrivate = (msg) => msg?.chat?.type === 'private';
const isGroupMsg = (msg) => String(msg?.chat?.id || '') === String(GROUP_CHAT_ID);

/* ===================== STORAGE ===================== */
const DATA_PATH = path.join(__dirname, 'checklists.json');

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}
function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

let DB = readJsonSafe(DATA_PATH);
if (!DB || typeof DB !== 'object') DB = {};

/**
 * DB schema:
 * DB.groups = {
 *   "<GROUP_CHAT_ID>": {
 *      items: [{text, done}],
 *      removeMode: boolean,
 *      dutyUserId: string|null,
 *      dutyUserName: string|null,
 *      dmLinked: { "<dmChatId>": true }
 *   }
 * }
 * DB.meta = { lastDutyPromptMessageId?: number|null }
 */
DB.groups ??= {};
DB.meta ??= { lastDutyPromptMessageId: null };

function getGroupState(gid) {
  const k = String(gid);
  DB.groups[k] ??= {
    items: [],
    removeMode: false,
    dutyUserId: null,
    dutyUserName: null,
    dmLinked: {}
  };
  if (!Array.isArray(DB.groups[k].items)) DB.groups[k].items = [];
  if (typeof DB.groups[k].removeMode !== 'boolean') DB.groups[k].removeMode = false;
  DB.groups[k].dmLinked ??= {};
  return DB.groups[k];
}

function saveDB() {
  writeJsonAtomic(DATA_PATH, DB);
}

const G = getGroupState(GROUP_CHAT_ID);
saveDB();

/* ===================== CHECKLIST HELPERS ===================== */
function listItems() {
  return getGroupState(GROUP_CHAT_ID).items;
}
function renderChecklist(items) {
  if (!items.length) return 'No checklist items yet.\n\nUse ➕ Add to create tasks.';
  return items.map((x, i) => `${i + 1}. ${x.done ? '✅' : '⬜️'} ${x.text}`).join('\n');
}
function stats(items) {
  const total = items.length;
  const done = items.filter(x => x.done).length;
  return { total, done, left: total - done };
}

/* ===================== DM REPLY KEYBOARD ===================== */
function itemButtonLabel(it, idx) {
  // small label for phone users
  const n = idx + 1;
  return `${it.done ? '✅' : '⬜️'} #${n}`;
}

function buildDMKeyboard() {
  const st = getGroupState(GROUP_CHAT_ID);
  const items = st.items;

  const rows = [
    [{ text: '➕ Add' }, { text: '🔄 Refresh' }],
    [
      { text: st.removeMode ? '✅ Done removing' : '🗑 Remove mode' },
      { text: '🧹 Clear checks' }
    ],
    [{ text: '🧾 Summary' }],
  ];

  // one row per item
  for (let i = 0; i < items.length; i++) {
    rows.push([{ text: itemButtonLabel(items[i], i) }]);
  }

  return {
    reply_markup: {
      keyboard: rows,
      resize_keyboard: true,
      one_time_keyboard: false,
      input_field_placeholder: 'Tap a button or type a task…'
    }
  };
}

async function dmSendMenu(dmChatId, header = null) {
  if (header) await safeSend(dmChatId, header);
  await safeSend(dmChatId, renderChecklist(listItems()), buildDMKeyboard());
}

/* ===================== SAFE SEND ===================== */
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

/* ===================== GROUP: DUTY START PROMPT ===================== */
async function sendDutyStartPrompt(reason = 'bot online') {
  const text =
    '🟢 Duty Start\n\n' +
    'Tap below to start duty and receive your checklist in DM.';

  const msg = await safeSend(GROUP_CHAT_ID, text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🧑‍💻 Start Duty', callback_data: 'START_DUTY' }]
      ]
    }
  });

  if (msg?.message_id) {
    DB.meta.lastDutyPromptMessageId = msg.message_id;
    saveDB();
  }
}

/* ===================== GROUP: SUMMARY BEFORE SLEEP ===================== */
async function sendDutySummaryToGroup(prefix = '📊 Duty Summary') {
  const st = getGroupState(GROUP_CHAT_ID);
  const { total, done } = stats(st.items);

  const userLine = st.dutyUserName
    ? `Duty user: ${st.dutyUserName}`
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
  const st = getGroupState(GROUP_CHAT_ID);

  st.dmLinked[dmChatId] = true;
  st.dutyUserId = dmChatId;

  const displayName =
    [q.from.first_name, q.from.last_name].filter(Boolean).join(' ') ||
    q.from.username ||
    `id:${q.from.id}`;

  st.dutyUserName = displayName;
  saveDB();

  try { await bot.answerCallbackQuery(q.id, { text: 'Opening DM checklist…' }); } catch {}

  const dmIntro =
    '✅ You are now on duty.\n' +
    'Use the menu buttons below to manage the checklist.\n\n' +
    'If your menu disappears, type /menu to restore it.';

  const ok = await safeSend(dmChatId, dmIntro, buildDMKeyboard());
  if (!ok) {
    await safeSend(
      GROUP_CHAT_ID,
      '⚠️ I could not DM you.\nPlease open the bot in private once and press /start, then tap Start Duty again.'
    );
    return;
  }

  await dmSendMenu(dmChatId);
});

/* ===================== DM COMMANDS ===================== */
bot.onText(/^\/start(?:@[\w_]+)?/i, async (msg) => {
  if (!isPrivate(msg)) return;

  await safeSend(
    msg.chat.id,
    '👋 Hello.\nTo take duty, return to the group and tap “Start Duty”.\n\nIf your menu disappears, type /menu.',
    buildDMKeyboard()
  );
});

bot.onText(/^\/menu(?:@[\w_]+)?/i, async (msg) => {
  if (!isPrivate(msg)) return;

  // must be linked
  const st = getGroupState(GROUP_CHAT_ID);
  if (!st.dmLinked[String(msg.chat.id)]) {
    await safeSend(msg.chat.id, 'Go to the group and tap “Start Duty” first.');
    return;
  }

  await safeSend(msg.chat.id, 'Restoring menu…');
  await safeSend(msg.chat.id, 'Menu restored.', buildDMKeyboard());
  await dmSendMenu(msg.chat.id);
});

/* ===================== DM MESSAGE HANDLER (MENU + TEXT) ===================== */
bot.on('message', async (msg) => {
  if (!msg?.text) return;
  if (!isPrivate(msg)) return;

  const dmChatId = String(msg.chat.id);
  const st = getGroupState(GROUP_CHAT_ID);

  // ignore command messages (handled by onText)
  if (msg.text.trim().startsWith('/')) return;

  // must be linked via Start Duty
  if (!st.dmLinked[dmChatId]) {
    await safeSend(dmChatId, 'This checklist is activated from the group.\nGo to the group and tap “Start Duty”.');
    return;
  }

  const text = msg.text.trim();
  const items = st.items;

  // MENU: Refresh
  if (text === '🔄 Refresh') {
    await dmSendMenu(dmChatId);
    return;
  }

  // MENU: Clear checks
  if (text === '🧹 Clear checks') {
    let changed = false;
    for (const it of items) {
      if (it.done) { it.done = false; changed = true; }
    }
    if (changed) saveDB();
    await safeSend(dmChatId, '✅ All checks cleared.');
    await dmSendMenu(dmChatId);
    return;
  }

  // MENU: Remove mode toggle
  if (text === '🗑 Remove mode') {
    st.removeMode = true;
    saveDB();
    await safeSend(dmChatId, '🗑 Remove mode ON.\nTap an item to delete it.\nPress “✅ Done removing” to exit.');
    await safeSend(dmChatId, 'Menu updated.', buildDMKeyboard());
    return;
  }
  if (text === '✅ Done removing') {
    st.removeMode = false;
    saveDB();
    await safeSend(dmChatId, '✅ Remove mode OFF.');
    await safeSend(dmChatId, 'Menu updated.', buildDMKeyboard());
    return;
  }

  // MENU: Summary
  if (text === '🧾 Summary') {
    const { total, done, left } = stats(items);
    const line =
      total === 0 ? 'Checklist: (no items)' :
      done === total ? `Checklist: ✅ COMPLETE (${done}/${total})` :
      `Checklist: ⚠️ INCOMPLETE (${done}/${total}), ${left} left`;
    await safeSend(dmChatId, `📊 Status\n${line}`, buildDMKeyboard());
    return;
  }

  // MENU: Add (force reply)
  if (text === '➕ Add') {
    await safeSend(dmChatId, 'Send task text:', { reply_markup: { force_reply: true } });
    return;
  }

  // Add via force reply
  if (msg.reply_to_message && (msg.reply_to_message.text || '') === 'Send task text:') {
    const t = text;
    if (!t) return;
    items.push({ text: t, done: false });
    saveDB();
    await safeSend(dmChatId, '✅ Added.');
    await dmSendMenu(dmChatId);
    return;
  }

  // Item button: "✅ #N" or "⬜️ #N"
  const m = text.match(/#(\d+)/);
  if (m) {
    const idx = parseInt(m[1], 10) - 1;
    if (idx >= 0 && idx < items.length) {
      if (st.removeMode) {
        const removed = items.splice(idx, 1);
        saveDB();
        await safeSend(dmChatId, `🗑 Removed: ${removed[0]?.text || '(item)'}`);
        await safeSend(dmChatId, 'Menu updated.', buildDMKeyboard());
        await dmSendMenu(dmChatId);
      } else {
        items[idx].done = !items[idx].done;
        saveDB();
        await dmSendMenu(dmChatId);
      }
      return;
    }
  }

  // Free text = add task (fallback)
  if (text.length > 0) {
    items.push({ text, done: false });
    saveDB();
    await safeSend(dmChatId, '✅ Added.');
    await dmSendMenu(dmChatId);
  }
});

/* ===================== OPTIONAL: GROUP COMMANDS (ADMIN-LITE) ===================== */
/**
 * If you want group admins to manage items without DM, uncomment these.
 * For now, DM is the main interface as you requested.
 */
// bot.onText(/^\/gadd(?:@[\w_]+)?\s+(.+)/i, async (msg, m) => {
//   if (!isGroupMsg(msg)) return;
//   const t = (m[1] || '').trim();
//   if (!t) return;
//   const st = getGroupState(GROUP_CHAT_ID);
//   st.items.push({ text: t, done: false });
//   saveDB();
//   await safeSend(GROUP_CHAT_ID, '✅ Added to checklist (group).');
// });

/* ===================== STARTUP ===================== */
(async function main() {
  try {
    // Best-effort: clear webhook (helps avoid "stuck" states when switching hosting)
    try {
      await bot.deleteWebHook({ drop_pending_updates: DROP_PENDING });
      log(`✅ Webhook cleared. (drop_pending_updates=${DROP_PENDING})`);
    } catch (e) {
      log('⚠️ deleteWebHook failed (continuing):', e?.response?.body || e);
    }

    await safeSend(GROUP_CHAT_ID, '👋 Bot awake');

    // ALWAYS send Duty Start prompt whenever bot comes online
    await sendDutyStartPrompt('online');

    // If you still want the morning poll, enable this env: SEND_POLL_ON_START=true
    const SEND_POLL_ON_START = String(process.env.SEND_POLL_ON_START || 'false') === 'true';
    if (SEND_POLL_ON_START) {
      await safePoll(
        GROUP_CHAT_ID,
        'Good morning commanders, please indicate whether you will be in camp for today',
        ['Yes', 'No', 'MA/MC', 'OL', 'LL', 'OFF'],
        { is_anonymous: false, allows_multiple_answers: false }
      );
    }

    // Auto-stop flow for CI runners
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
  } catch (e) {
    console.error('❌ Fatal startup error:', e?.response?.body || e);
    process.exit(1);
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
