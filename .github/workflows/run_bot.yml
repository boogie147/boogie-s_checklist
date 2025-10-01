// checklist.js
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN is missing (set it in GitHub Secrets).');
  process.exit(1);
}

// ===== Config from env / dispatch =====
const VERBOSE = String(process.env.VERBOSE || 'false') === 'true';
const ANNOUNCE_CHAT = ((process.env.CHAT_ID || '').trim()) || null; // optional
const DURATION_MINUTES = Number(process.env.DURATION_MINUTES || 30); // 0 = no auto-stop
const SLEEP_WARNING_SECONDS = Number(process.env.SLEEP_WARNING_SECONDS || 60); // warn before sleep
const ADD_REQUIRE_ALLOWLIST = String(process.env.ADD_REQUIRE_ALLOWLIST || 'true') === 'true';

// Phone-first compact UI
const COMPACT = String(process.env.COMPACT || 'true') === 'true';
const BUTTONS_PER_ROW = Number(process.env.BUTTONS_PER_ROW || 2); // 2 or 3 are nice on phones
const TITLE_MAX = Number(process.env.TITLE_MAX || 22);            // truncate harder on mobile

// Anti-spam for button taps (messages) in ms
const SPAM_GAP_MS = Number(process.env.SPAM_GAP_MS || 800);

// Drop pending updates that arrived while the bot was asleep
const DROP_PENDING = String(process.env.DROP_PENDING || 'true') === 'true';

// Create bot WITHOUT polling first; we will delete webhook, then start polling explicitly.
const bot = new TelegramBot(BOT_TOKEN, { polling: false });
// Helper to accept /cmd and /cmd@BotName (with optional argument)
const cmdRe = (name, hasArg = false) =>
  new RegExp(`^\\/${name}(?:@\\w+)?${hasArg ? "\\s+(.+)" : "\\s*$"}`, "i");

// ======= Persistence =======
const DATA_PATH = path.resolve(__dirname, 'checklists.json');
function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')); }
  catch { fs.writeFileSync(DATA_PATH, JSON.stringify({}, null, 2)); return {}; }
}
function saveData(obj) {
  const tmp = DATA_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, DATA_PATH);
}
let DB = loadData();

/**
 * DB[chatId] structure:
 * { items: [{text, done}], allow: [userId], removeMode: boolean }
 * (Backward compatible with the old array-only structure.)
 */
function getState(cid) {
  let v = DB[cid];
  if (!v) { v = { items: [], allow: [], removeMode: false }; DB[cid] = v; return v; }
  if (Array.isArray(v)) { v = { items: v, allow: [], removeMode: false }; DB[cid] = v; return v; }
  if (!Array.isArray(v.items)) v.items = [];
  if (!Array.isArray(v.allow)) v.allow = [];
  if (typeof v.removeMode !== 'boolean') v.removeMode = false;
  return v;
}
const getList   = (cid) => getState(cid).items;
const getAllow  = (cid) => getState(cid).allow;
const getMode   = (cid) => getState(cid).removeMode;
const setMode   = (cid, on) => { getState(cid).removeMode = !!on; };

const ActiveChats = new Set(Object.keys(DB));
const isAllDone = (items) => items.length > 0 && items.every((x) => x.done);
const escapeHtml = (s) => s.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const truncate = (s, n = TITLE_MAX) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s);

// Nice little progress bar for header
function progressBar(done, total, width = 10) {
  if (total <= 0) return '[──────────]';
  const filled = Math.round((done / total) * width);
  return '[' + '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled)) + ']';
}
function renderHeader(items) {
  const total = items.length;
  const done = items.filter(i => i.done).length;
  return `<b>Your checklist</b> — ${done}/${total} done ${progressBar(done, total, 10)}`;
}

function renderLines(items) {
  return items.length
    ? items.map((it, i) => `${i + 1}. ${it.done ? '✅' : '⬜️'} ${escapeHtml(it.text)}`).join('\n')
    : 'No items yet. Use /add &lt;task&gt; or the + button.';
}

// Build REPLY keyboard (bottom area) — compact grid of item buttons + control row
function buildKeyboard(cid) {
  const items = getList(cid);
  const rows = [];

  // Items as buttons like "#3 ⬜️ Title…"
  const flat = items.map((it, i) => ({
    text: `#${i + 1} ${it.done ? '✅' : '⬜️'} ${truncate(it.text)}`
  }));
  for (let i = 0; i < flat.length; i += BUTTONS_PER_ROW) {
    rows.push(flat.slice(i, i + BUTTONS_PER_ROW));
  }

  // Control row
  const inRemove = getMode(cid);
  rows.push([
    { text: '➕ Add' },
    { text: inRemove ? '✅ Done removing' : '🗑 Remove mode' },
  ]);
  rows.push([
    { text: '🧹 Clear checks' },
    { text: '🔄 Refresh' },
  ]);

  return {
    reply_markup: {
      keyboard: rows,
      resize_keyboard: true,
      one_time_keyboard: false,
      input_field_placeholder: 'Type a task or use buttons…'
    }
  };
}

async function reply(cid, html, extra = {}) {
  return bot.sendMessage(cid, html, { parse_mode: 'HTML', ...extra });
}

function ensureChatTracked(cid) {
  const key = String(cid);
  let added = false;
  if (!ActiveChats.has(key)) { ActiveChats.add(key); added = true; }
  getState(cid); // ensures structure exists
  return added;
}

async function sendListInteractive(cid) {
  const items = getList(cid);
  const title = COMPACT ? renderHeader(items) : `<b>Your checklist</b>\n${renderLines(items)}`;
  return reply(cid, title, buildKeyboard(cid));
}

// === helpers for “clear checks” ===
function uncheckAll(cid) {
  const items = getList(cid);
  let changed = false;
  for (const it of items) {
    if (it.done) { it.done = false; changed = true; }
  }
  return { changed, count: items.length };
}
function resetAllChatsChecks() {
  let changed = false;
  for (const cid of Object.keys(DB)) {
    const st = getState(cid);
    for (const it of st.items) {
      if (it.done) { it.done = false; changed = true; }
    }
  }
  return changed;
}

// ===== Allowlist & permissions =====
let SELF_ID = 0; // set after getMe()

async function isAdmin(cid, uid) {
  try {
    const m = await bot.getChatMember(cid, uid);
    return m && (m.status === 'creator' || m.status === 'administrator');
  } catch { return false; }
}

async function canUserAdd(msg) {
  const cid = msg.chat.id;
  const uid = msg.from?.id;
  if (!uid) return false;

  // Always allow in private chats
  if (msg.chat.type === 'private') return true;

  // Admins always allowed
  if (await isAdmin(cid, uid)) return true;

  // If enforcement disabled, allow everyone
  if (!ADD_REQUIRE_ALLOWLIST) return true;

  // Otherwise only allow if on allowlist
  return getAllow(cid).includes(uid);
}

function formatUser(u) {
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || `id:${u.id}`;
  return `${escapeHtml(name)} (${u.id})`;
}

// ===== Welcome-on-first-contact helpers =====
const WelcomedThisRun = new Set();

async function maybeWelcome(cid, newlyTracked) {
  if (WelcomedThisRun.has(cid)) return;
  WelcomedThisRun.add(cid);
  if (newlyTracked) saveData(DB); // persist new chat

  await reply(cid, '👋 Hello! The bot is awake. Use the keyboard buttons below.');
  await sendListInteractive(cid);
}

async function sendReminderToChat(cid, prefix) {
  const items = getList(cid);
  if (isAllDone(items)) {
    await reply(cid, `${prefix}🎉 Awesome — your list is complete!`, buildKeyboard(cid));
  } else if (items.length === 0) {
    await reply(cid, `${prefix}Your list is empty. Tap ➕ Add to start.`, buildKeyboard(cid));
  } else {
    const title = COMPACT ? renderHeader(items) : `<b>Your checklist</b>\n${renderLines(items)}`;
    await reply(cid, `${prefix}${title}`, buildKeyboard(cid));
  }
}

// ======= Logging & hardening =======
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e?.response?.body || e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e?.response?.body || e));
const HEARTBEAT = setInterval(() => { if (VERBOSE) console.log('…heartbeat'); }, 10_000);

// ======= Commands =======
// /start
bot.onText(cmdRe('start'), async (msg) => {
  const cid = msg.chat.id;
  const newlyTracked = ensureChatTracked(cid);
  await maybeWelcome(cid, newlyTracked);

  await reply(
    cid,
    ['<b>Checklist Bot</b> is awake 👋',
     'Use keyboard buttons or commands:',
     '• /add &lt;text&gt;',
     '• /list',
     '• /done &lt;number&gt;',
     '• /remove &lt;number&gt;',
     '• /clear  (uncheck all)',
     '• /allow (admin, reply to a user)',
     '• /deny  (admin, reply to a user)',
     '• /whoallowed'].join('\n'),
    buildKeyboard(cid)
  );
});

// /add <text>
bot.onText(cmdRe('add', true), async (msg, m) => {
  const cid = msg.chat.id;
  const newlyTracked = ensureChatTracked(cid);
  await maybeWelcome(cid, newlyTracked);

  if (!(await canUserAdd(msg))) {
    return reply(cid, `🚫 You are not allowed to add tasks in this chat.`, buildKeyboard(cid));
  }

  const text = (m[1] || '').trim();
  if (!text) return reply(cid, 'Usage: /add &lt;task&gt;', buildKeyboard(cid));
  getList(cid).push({ text, done: false }); saveData(DB);
  await reply(cid, `Added: <b>${escapeHtml(text)}</b>`, buildKeyboard(cid));
  await sendListInteractive(cid);
});

// /list
bot.onText(cmdRe('list'), async (msg) => {
  const cid = msg.chat.id;
  const newlyTracked = ensureChatTracked(cid);
  await maybeWelcome(cid, newlyTracked);
  await sendListInteractive(cid);
});

// /done <n>
bot.onText(cmdRe('done', true), async (msg, m) => {
  const cid = msg.chat.id;
  const newlyTracked = ensureChatTracked(cid);
  await maybeWelcome(cid, newlyTracked);

  const i = parseInt(m[1], 10) - 1;
  const items = getList(cid);
  if (i >= 0 && i < items.length) {
    items[i].done = true; saveData(DB);
    await reply(cid, `Marked done: <b>${escapeHtml(items[i].text)}</b> ✅`, buildKeyboard(cid));
    await sendListInteractive(cid);
  } else {
    await reply(cid, 'Usage: /done &lt;number&gt;', buildKeyboard(cid));
  }
});

// /remove <n>
bot.onText(cmdRe('remove', true), async (msg, m) => {
  const cid = msg.chat.id;
  const newlyTracked = ensureChatTracked(cid);
  await maybeWelcome(cid, newlyTracked);

  const i = parseInt(m[1], 10) - 1;
  const items = getList(cid);
  if (i >= 0 && i < items.length) {
    const r = items.splice(i, 1)[0]; saveData(DB);
    await reply(cid, `Removed: <b>${escapeHtml(r.text)}</b> 🗑️`, buildKeyboard(cid));
    await sendListInteractive(cid);
  } else {
    await reply(cid, 'Usage: /remove &lt;number&gt;', buildKeyboard(cid));
  }
});

// /clear  -> Uncheck all items (keep text)
bot.onText(cmdRe('clear'), async (msg) => {
  const cid = msg.chat.id;
  const newlyTracked = ensureChatTracked(cid);
  await maybeWelcome(cid, newlyTracked);

  const { changed, count } = uncheckAll(cid);
  if (count === 0) {
    await reply(cid, 'Nothing to clear — your list is empty.', buildKeyboard(cid));
  } else {
    if (changed) { saveData(DB); }
    await reply(cid, 'All checkmarks cleared. ⬜️', buildKeyboard(cid));
  }
  await sendListInteractive(cid);
});

// Allowlist admin commands (reply-based)
bot.onText(cmdRe('allow'), async (msg) => {
  const cid = msg.chat.id;
  if (!(await isAdmin(cid, msg.from.id))) return reply(cid, 'Only admins can use /allow.', buildKeyboard(cid));
  if (!msg.reply_to_message || !msg.reply_to_message.from) return reply(cid, 'Reply to the user’s message with /allow.', buildKeyboard(cid));

  const target = msg.reply_to_message.from;
  const allow = getAllow(cid);
  if (!allow.includes(target.id)) {
    allow.push(target.id);
    saveData(DB);
  }
  await reply(cid, `✅ Allowed: ${formatUser(target)}`, buildKeyboard(cid));
});
bot.onText(cmdRe('deny'), async (msg) => {
  const cid = msg.chat.id;
  if (!(await isAdmin(cid, msg.from.id))) return reply(cid, 'Only admins can use /deny.', buildKeyboard(cid));
  if (!msg.reply_to_message || !msg.reply_to_message.from) return reply(cid, 'Reply to the user’s message with /deny.', buildKeyboard(cid));

  const target = msg.reply_to_message.from;
  const allow = getAllow(cid);
  const idx = allow.indexOf(target.id);
  if (idx >= 0) {
    allow.splice(idx, 1);
    saveData(DB);
    await reply(cid, `🚫 Removed from allowlist: ${formatUser(target)}`, buildKeyboard(cid));
  } else {
    await reply(cid, `${formatUser(target)} was not on the allowlist.`, buildKeyboard(cid));
  }
});
bot.onText(cmdRe('whoallowed'), async (msg) => {
  const cid = msg.chat.id;
  const allow = getAllow(cid);
  if (allow.length === 0) return reply(cid, 'No one is on the allowlist yet.', buildKeyboard(cid));
  const lines = [];
  for (const uid of allow) {
    try {
      const m = await bot.getChatMember(cid, uid);
      const u = m.user || { id: uid };
      lines.push(`• ${formatUser(u)}`);
    } catch {
      lines.push(`• id:${uid}`);
    }
  }
  await reply(cid, `<b>Allowlist</b>\n${lines.join('\n')}`, buildKeyboard(cid));
});

// ====== Keyboard message handling (taps) & add prompt replies ======
const tapLimiter = new Map(); // key `${cid}:${uid}` -> lastTs
const ADD_PROMPT_TAG = '[ADD]';

// Everything that isn’t a slash command comes here
bot.on('message', async (msg) => {
  if (!msg.text) return;

  // Ignore command messages (handled above)
  if (/^\/(start|add|list|done|remove|clear|allow|deny|whoallowed)/i.test(msg.text)) return;

  const cid = msg.chat.id;
  const uid = msg.from?.id;
  const newlyTracked = ensureChatTracked(cid);
  await maybeWelcome(cid, newlyTracked);

  // 1) Handle item button taps: "#<n> …"
  const m = msg.text.match(/^#(\d+)\b/);
  if (m) {
    // Throttle per user per chat
    const key = `${cid}:${uid}`;
    const now = Date.now();
    const last = tapLimiter.get(key) || 0;
    if (now - last < SPAM_GAP_MS) return;
    tapLimiter.set(key, now);

    const idx = parseInt(m[1], 10) - 1;
    const items = getList(cid);
    if (idx >= 0 && idx < items.length) {
      if (getMode(cid)) {
        // Remove mode -> delete
        const r = items.splice(idx, 1)[0];
        saveData(DB);
        await reply(cid, `Removed: <b>${escapeHtml(r.text)}</b> 🗑️`, buildKeyboard(cid));
      } else {
        // Toggle
        items[idx].done = !items[idx].done;
        saveData(DB);
      }
    }
    await sendListInteractive(cid);
    return;
  }

  // 2) Handle control buttons
  if (msg.text === '➕ Add') {
    // Ask for a reply with the task text
    return bot.sendMessage(cid, `✍️ Send the task text. (Reply to this message) ${ADD_PROMPT_TAG}`, {
      reply_markup: { force_reply: true, selective: true }
    });
  }
  if (msg.text === '🧹 Clear checks') {
    const { changed, count } = uncheckAll(cid);
    if (count === 0) await reply(cid, 'Nothing to clear — your list is empty.', buildKeyboard(cid));
    else {
      if (changed) saveData(DB);
      await reply(cid, 'All checkmarks cleared. ⬜️', buildKeyboard(cid));
    }
    await sendListInteractive(cid);
    return;
  }
  if (msg.text === '🔄 Refresh') {
    await sendListInteractive(cid);
    return;
  }
  if (msg.text === '🗑 Remove mode') {
    setMode(cid, true); saveData(DB);
    await reply(cid, '🗑 Remove mode ON. Tap an item to delete it. Tap “✅ Done removing” to exit.', buildKeyboard(cid));
    await sendListInteractive(cid);
    return;
  }
  if (msg.text === '✅ Done removing') {
    setMode(cid, false); saveData(DB);
    await reply(cid, '✅ Remove mode OFF. Taps will toggle items.', buildKeyboard(cid));
    await sendListInteractive(cid);
    return;
  }

  // 3) Handle replies to the add prompt (in groups, require reply-to-bot)
  const isReplyToBot = !!(msg.reply_to_message && msg.reply_to_message.from && msg.reply_to_message.from.id === SELF_ID);
  const isAddReply = isReplyToBot && (msg.reply_to_message.text || '').includes(ADD_PROMPT_TAG);

  // Enforce allowlist
  if (isAddReply || msg.chat.type === 'private') {
    if (!(await canUserAdd(msg))) {
      return reply(cid, `🚫 You are not allowed to add tasks in this chat.`, buildKeyboard(cid));
    }
  }

  if (isAddReply || (msg.chat.type === 'private' && !/^#\d+/.test(msg.text))) {
    const t = msg.text.trim(); if (!t) return;
    getList(cid).push({ text: t, done: false }); saveData(DB);
    await reply(cid, `Added: <b>${escapeHtml(t)}</b>`, buildKeyboard(cid));
    await sendListInteractive(cid);
    return;
  }

  // Otherwise ignore stray non-commands in groups
  if (msg.chat.type !== 'private') return;
});

// Polling error visibility (do NOT exit)
bot.on('polling_error', (err) => {
  console.error('polling_error:', err?.response?.body || err);
});

if (VERBOSE) {
  bot.on('message', (m) => console.log('msg from', m.chat?.id, m.text));
}

// ======= Reminders / Awake / Sleep =======
async function broadcastAwake() {
  const targets = new Set(ActiveChats);
  if (ANNOUNCE_CHAT) targets.add(String(ANNOUNCE_CHAT));

  if (VERBOSE) console.log('broadcast targets:', [...targets]);
  if (targets.size === 0) console.log('No targets to notify (ActiveChats empty and CHAT_ID not set).');

  for (const cid of targets) {
    try {
      await reply(cid, '👋 Hello! The bot is awake. Use the keyboard below.');
      await sendListInteractive(cid);
    } catch (e) { console.warn('awake send failed for', cid, e?.response?.body || e); }
  }
}

async function sendReminder(prefix) {
  const targets = new Set(ActiveChats);
  if (ANNOUNCE_CHAT) targets.add(String(ANNOUNCE_CHAT));
  if (VERBOSE) console.log('sendReminder targets:', [...targets]);
  for (const cid of targets) {
    try {
      await sendReminderToChat(cid, prefix);
    } catch (e) {
      console.error('sendReminder error for', cid, e?.response?.body || e);
    }
  }
}

// Warning before sleep — now just “going to sleep…”
async function sendSleepWarning() {
  const targets = new Set(ActiveChats);
  if (ANNOUNCE_CHAT) targets.add(String(ANNOUNCE_CHAT));

  for (const cid of targets) {
    await reply(cid, '😴 The bot is going to sleep now. See you next time!', buildKeyboard(cid));
  }
}

// ======= Startup =======
(async function main() {
  try {
    const me = await bot.getMe(); // token check early
    SELF_ID = me.id;
    console.log(`🤖 Bot @${me.username} (ID ${me.id}) starting…`);

    // Ensure we always have at least one target this run
    if (ANNOUNCE_CHAT) { ensureChatTracked(ANNOUNCE_CHAT); }

    // Clear webhook so polling can work; DROP old updates so offline taps/msgs are discarded
    try {
      await bot.deleteWebHook({ drop_pending_updates: DROP_PENDING });
      console.log(`✅ Webhook cleared. (drop_pending_updates=${DROP_PENDING})`);
    } catch (e) {
      console.warn('⚠️ deleteWebHook failed (continuing):', e?.response?.body || e);
    }

    // Start polling explicitly with sane params
    await bot.startPolling({
      interval: 300, // ms between polls
      params: { timeout: 50, allowed_updates: ['message'] },
    });
    console.log('📡 Polling started.');

    if (VERBOSE) console.log('ActiveChats:', [...ActiveChats]);

    // 🔔 Startup hello
    await broadcastAwake();

    // Timed reminders (still at 25 & 30 mins here; change if you want 20/25)
    const durMs = DURATION_MINUTES * 60 * 1000;

    setTimeout(() => {
      console.log('⏰ 25-min reminder firing…');
      sendReminder('⏱️ 25 minutes gone. ').catch(e => console.error('25-min reminder error:', e?.response?.body || e));
    }, 25 * 60 * 1000);

    if (DURATION_MINUTES <= 0 || durMs >= 30 * 60 * 1000) {
      setTimeout(() => {
        console.log('⏰ 30-min reminder firing…');
        sendReminder('⏱️ 30 minutes gone. ').catch(e => console.error('30-min reminder error:', e?.response?.body || e));
      }, 30 * 60 * 1000);
    }

    // Optional auto-stop + warning + reset checks
    if (DURATION_MINUTES > 0) {
      const warnMs = Math.max(0, durMs - (SLEEP_WARNING_SECONDS * 1000));
      setTimeout(() => {
        console.log('⏰ Sleep warning firing…');
        sendSleepWarning().catch(e => console.error('sleep warning error:', e?.response?.body || e));
      }, warnMs);

      setTimeout(async () => {
        console.log(`⏱️ ${DURATION_MINUTES} minutes elapsed — stopping bot.`);
        if (resetAllChatsChecks()) saveData(DB);
        try { await bot.stopPolling(); } catch {}
        clearInterval(HEARTBEAT);
        process.exit(0);
      }, durMs);
    } else {
      console.log('🟢 Auto-stop disabled (DURATION_MINUTES=0).');
    }

  } catch (e) {
    console.error('❌ Fatal startup error:', e?.response?.body || e);
    process.exit(1);
  }
})();

// Persist on shutdown
process.on('SIGTERM', () => { try { if (resetAllChatsChecks()) saveData(DB); } catch {} clearInterval(HEARTBEAT); process.exit(0); });
process.on('SIGINT',  () => { try { if (resetAllChatsChecks()) saveData(DB); } catch {} clearInterval(HEARTBEAT); process.exit(0); });
