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
// Anti-spam: ignore rapid button taps per user/chat (ms)
const SPAM_GAP_MS = Number(process.env.SPAM_GAP_MS || 800);
// Drop any pending updates that arrived while the bot was asleep
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
 * DB[chatId] structure (backward compatible):
 * - OLD: Array of items
 * - NEW: { items: [...], allow: [userId, ...], view: "full" | "compact" }
 */
function getState(cid) {
  let v = DB[cid];
  if (!v) { v = { items: [], allow: [], view: 'full' }; DB[cid] = v; return v; }
  if (Array.isArray(v)) { v = { items: v, allow: [], view: 'full' }; DB[cid] = v; return v; }
  if (!Array.isArray(v.items)) v.items = [];
  if (!Array.isArray(v.allow)) v.allow = [];
  if (!v.view) v.view = 'full';
  return v;
}
const getList  = (cid) => getState(cid).items;
const getAllow = (cid) => getState(cid).allow;
const getView  = (cid) => getState(cid).view;
const setView  = (cid, view) => { getState(cid).view = view; };

const ActiveChats = new Set(Object.keys(DB));
const isAllDone = (items) => items.length > 0 && items.every((x) => x.done);
const escapeHtml = (s) => s.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const truncate = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s);

// ===== Rendering =====
function renderLinesFull(items) {
  return items.length
    ? items.map((it, i) => `${i + 1}. ${it.done ? '✅' : '⬜️'} ${escapeHtml(it.text)}`).join('\n')
    : 'No items yet. Use /add &lt;task&gt; or the + button.';
}
function renderLinesCompact(items) {
  if (!items.length) return 'No items yet. Tap ➕ Add.';
  const remaining = items.filter(i => !i.done);
  const done = items.length - remaining.length;
  const top = remaining.slice(0, 5) // cap to keep short
    .map((it, i) => `${i + 1}. ⬜️ ${escapeHtml(truncate(it.text, 24))}`)
    .join('\n');
  const more = remaining.length > 5 ? `\n…+${remaining.length - 5} more` : '';
  const line2 = done ? `\n${done} done ✅` : '';
  return top + more + line2;
}
function renderForView(cid, items) {
  const view = getView(cid);
  return view === 'compact' ? renderLinesCompact(items) : renderLinesFull(items);
}

// Inline keyboard under the checklist message (unchanged)
function buildInlineKeyboard(items) {
  const rows = items.map((it, i) => ([
    { text: `${it.done ? '✅' : '⬜️'} ${truncate(it.text, 40)}`, callback_data: `t:${i}` },
    { text: '🗑', callback_data: `rm:${i}` },
  ]));
  rows.push([
    { text: '➕ Add', callback_data: 'add_prompt' },
    { text: '🧹 Clear checks', callback_data: 'clear_checks' },
    { text: '🔄 Refresh', callback_data: 'refresh' },
  ]);
  return { reply_markup: { inline_keyboard: rows } };
}

// Reply keyboard at the bottom bar (now includes Compact/Full toggle)
function replyKbFor(cid) {
  const view = getView(cid);
  const toggle = view === 'compact' ? '📋 Full' : '🔎 Compact';
  return {
    keyboard: [
      [{ text: '➕ Add' }, { text: '🧹 Clear checks' }],
      [{ text: toggle }, { text: '🔄 Refresh' }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

async function reply(cid, html, extra = {}) {
  return bot.sendMessage(cid, html, { parse_mode: 'HTML', ...extra });
}
async function edit(cid, mid, html, extra = {}) {
  return bot.editMessageText(html, { chat_id: cid, message_id: mid, parse_mode: 'HTML', ...extra });
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
  return reply(cid, `<b>Your checklist</b>\n${renderForView(cid, items)}`, buildInlineKeyboard(items));
}
async function refreshMessage(cid, mid) {
  const items = getList(cid);
  return edit(cid, mid, `<b>Your checklist</b>\n${renderForView(cid, items)}`, buildInlineKeyboard(items));
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

  await reply(
    cid,
    '👋 Hello! The bot is awake. Use /list or the buttons below.',
    { reply_markup: replyKbFor(cid) }
  );
  await sendListInteractive(cid);
}

async function sendReminderToChat(cid, prefix) {
  const items = getList(cid);
  if (isAllDone(items)) {
    await reply(cid, `${prefix}🎉 Awesome — your list is complete!`);
  } else if (items.length === 0) {
    await reply(cid, `${prefix}Your list is empty. Tap ➕ Add to start.`, buildInlineKeyboard(items));
  } else {
    await reply(cid, `${prefix}Keep going!\n\n${renderForView(cid, items)}`, buildInlineKeyboard(items));
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
     'Use buttons or commands:',
     '• /add &lt;text&gt;',
     '• /list',
     '• /done &lt;number&gt;',
     '• /remove &lt;number&gt;',
     '• /clear  (uncheck all)',
     '• /allow (admin, reply to a user)',
     '• /deny  (admin, reply to a user)',
     '• /whoallowed'].join('\n'),
    { reply_markup: replyKbFor(cid) }
  );
});

// /add <text>
bot.onText(cmdRe('add', true), async (msg, m) => {
  const cid = msg.chat.id;
  const newlyTracked = ensureChatTracked(cid);
  await maybeWelcome(cid, newlyTracked);

  if (!(await canUserAdd(msg))) {
    return reply(cid, `🚫 You are not allowed to add tasks in this chat.`);
  }

  const text = (m[1] || '').trim();
  if (!text) return reply(cid, 'Usage: /add &lt;task&gt;');
  getList(cid).push({ text, done: false }); saveData(DB);
  await reply(cid, `Added: <b>${escapeHtml(text)}</b>`);
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
    await reply(cid, `Marked done: <b>${escapeHtml(items[i].text)}</b> ✅`);
    await sendListInteractive(cid);
  } else {
    await reply(cid, 'Usage: /done &lt;number&gt;');
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
    await reply(cid, `Removed: <b>${escapeHtml(r.text)}</b> 🗑️`);
    await sendListInteractive(cid);
  } else {
    await reply(cid, 'Usage: /remove &lt;number&gt;');
  }
});

// /clear  -> Uncheck all items (keep text)
bot.onText(cmdRe('clear'), async (msg) => {
  const cid = msg.chat.id;
  const newlyTracked = ensureChatTracked(cid);
  await maybeWelcome(cid, newlyTracked);

  const { changed, count } = uncheckAll(cid);
  if (count === 0) {
    await reply(cid, 'Nothing to clear — your list is empty.');
  } else {
    if (changed) { saveData(DB); }
    await reply(cid, 'All checkmarks cleared. ⬜️');
  }
  await sendListInteractive(cid);
});

// Allowlist admin commands (reply-based)
bot.onText(cmdRe('allow'), async (msg) => {
  const cid = msg.chat.id;
  if (!(await isAdmin(cid, msg.from.id))) return reply(cid, 'Only admins can use /allow.');
  if (!msg.reply_to_message || !msg.reply_to_message.from) return reply(cid, 'Reply to the user’s message with /allow.');

  const target = msg.reply_to_message.from;
  const allow = getAllow(cid);
  if (!allow.includes(target.id)) {
    allow.push(target.id);
    saveData(DB);
  }
  await reply(cid, `✅ Allowed: ${formatUser(target)}`);
});
bot.onText(cmdRe('deny'), async (msg) => {
  const cid = msg.chat.id;
  if (!(await isAdmin(cid, msg.from.id))) return reply(cid, 'Only admins can use /deny.');
  if (!msg.reply_to_message || !msg.reply_to_message.from) return reply(cid, 'Reply to the user’s message with /deny.');

  const target = msg.reply_to_message.from;
  const allow = getAllow(cid);
  const idx = allow.indexOf(target.id);
  if (idx >= 0) {
    allow.splice(idx, 1);
    saveData(DB);
    await reply(cid, `🚫 Removed from allowlist: ${formatUser(target)}`);
  } else {
    await reply(cid, `${formatUser(target)} was not on the allowlist.`);
  }
});
bot.onText(cmdRe('whoallowed'), async (msg) => {
  const cid = msg.chat.id;
  const allow = getAllow(cid);
  if (allow.length === 0) return reply(cid, 'No one is on the allowlist yet.');
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
  await reply(cid, `<b>Allowlist</b>\n${lines.join('\n')}`);
});

// ===== Message handler (reply keyboard texts + free-text add) =====
bot.on('message', async (msg) => {
  if (!msg.text) return;

  const cid = msg.chat.id;
  const newlyTracked = ensureChatTracked(cid);
  await maybeWelcome(cid, newlyTracked);

  // Reply-keyboard menu texts
  if (msg.text === '🔄 Refresh') {
    await sendListInteractive(cid);
    return;
  }

  if (msg.text === '🧹 Clear checks') {
    const { changed } = uncheckAll(cid);
    if (changed) saveData(DB);
    await reply(cid, 'All checkmarks cleared. ⬜️', { reply_markup: replyKbFor(cid) });
    await sendListInteractive(cid);
    return;
  }

  if (msg.text === '🔎 Compact' || msg.text === '📋 Full') {
    const next = msg.text === '🔎 Compact' ? 'compact' : 'full';
    setView(cid, next); saveData(DB);
    await reply(cid, `View changed to <b>${next}</b>.`, { reply_markup: replyKbFor(cid) });
    await sendListInteractive(cid);
    return;
  }

  if (msg.text === '➕ Add') {
    if (!(await canUserAdd(msg))) {
      await reply(cid, '🚫 You are not allowed to add tasks in this chat.');
      return;
    }
    await bot.sendMessage(cid, 'Send the task text as a reply to this message.', {
      reply_markup: { force_reply: true },
    });
    return;
  }

  // Commands are handled by onText above; ignore them here
  if (/^\/(start|add|list|done|remove|clear|allow|deny|whoallowed)/i.test(msg.text)) return;

  // In groups, only accept free text if replying to the bot
  if (msg.chat.type !== 'private') {
    if (!(msg.reply_to_message && msg.reply_to_message.from && msg.reply_to_message.from.id === SELF_ID)) return;
  }

  if (!(await canUserAdd(msg))) {
    return reply(cid, `🚫 You are not allowed to add tasks in this chat.`);
  }

  const t = msg.text.trim(); if (!t) return;
  getList(cid).push({ text: t, done: false }); saveData(DB);
  await reply(cid, `Added: <b>${escapeHtml(t)}</b>`, { reply_markup: replyKbFor(cid) });
  await sendListInteractive(cid);
});

// ===== Anti-spam for inline buttons =====
const tapLimiter = new Map(); // key `${cid}:${uid}` -> lastTs

// Inline buttons
bot.on('callback_query', async (q) => {
  try {
    const cid = q.message.chat.id; const mid = q.message.message_id;
    const newlyTracked = ensureChatTracked(cid);
    await maybeWelcome(cid, newlyTracked);

    // Throttle per user per chat
    const key = `${cid}:${q.from.id}`;
    const now = Date.now();
    const last = tapLimiter.get(key) || 0;
    if (now - last < SPAM_GAP_MS) {
      await bot.answerCallbackQuery(q.id, { text: 'Please wait…', show_alert: false });
      return;
    }
    tapLimiter.set(key, now);

    const items = getList(cid);
    const [action, arg] = (q.data || '').split(':');

    if (action === 't') {
      const i = parseInt(arg, 10);
      if (!isNaN(i) && items[i]) { items[i].done = !items[i].done; saveData(DB); }
      await refreshMessage(cid, mid);
    } else if (action === 'rm') {
      const i = parseInt(arg, 10);
      if (!isNaN(i) && items[i]) {
        const r = items.splice(i, 1)[0]; saveData(DB);
        await reply(cid, `Removed: <b>${escapeHtml(r.text)}</b> 🗑️`);
      }
      await refreshMessage(cid, mid);
    } else if (action === 'clear_checks') {
      const { changed } = uncheckAll(cid); if (changed) saveData(DB);
      await refreshMessage(cid, mid);
    } else if (action === 'refresh') {
      await refreshMessage(cid, mid);
    } else if (action === 'add_prompt') {
      const fakeMsg = { chat: { id: cid, type: q.message.chat.type }, from: q.from };
      if (!(await canUserAdd(fakeMsg))) {
        await reply(cid, `🚫 You are not allowed to add tasks in this chat.`);
      } else {
        await bot.sendMessage(cid, 'Send the task text as a reply to this message.', {
          reply_markup: { force_reply: true },
        });
      }
    }

    await bot.answerCallbackQuery(q.id);
  } catch (e) {
    console.error('callback error:', e?.response?.body || e);
    try { await bot.answerCallbackQuery(q.id); } catch {}
  }
});

// Polling error visibility (do NOT exit)
bot.on('polling_error', (err) => {
  console.error('polling_error:', err?.response?.body || err);
});

if (VERBOSE) {
  bot.on('message', (m) => console.log('msg from', m.chat?.id, m.text));
  bot.on('callback_query', (q) => console.log('callback from', q.message?.chat?.id, q.data));
}

// ======= Reminders / Awake / Sleep =======
async function broadcastAwake() {
  const targets = new Set(ActiveChats);
  if (ANNOUNCE_CHAT) targets.add(String(ANNOUNCE_CHAT));

  if (VERBOSE) console.log('broadcast targets:', [...targets]);
  if (targets.size === 0) console.log('No targets to notify (ActiveChats empty and CHAT_ID not set).');

  for (const cid of targets) {
    try {
      await reply(
        cid,
        '👋 Hello! The bot is awake. Use /list or the buttons below.',
        { reply_markup: replyKbFor(cid) }
      );
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

// Warning before sleep (generic message, no “SM” text)
async function sendSleepWarning() {
  const targets = new Set(ActiveChats);
  if (ANNOUNCE_CHAT) targets.add(String(ANNOUNCE_CHAT));
  for (const cid of targets) {
    await reply(cid, '😴 The bot is going to sleep soon.');
  }
}

// ======= Startup =======
(async function main() {
  try {
    const me = await bot.getMe(); // token check early
    SELF_ID = me.id;
    console.log(`🤖 Bot @${me.username} (ID ${me.id}) starting…`);

    if (ANNOUNCE_CHAT) ensureChatTracked(ANNOUNCE_CHAT);

    // Clear webhook so polling can work; DROP old updates
    try {
      await bot.deleteWebHook({ drop_pending_updates: DROP_PENDING });
      console.log(`✅ Webhook cleared. (drop_pending_updates=${DROP_PENDING})`);
    } catch (e) {
      console.warn('⚠️ deleteWebHook failed (continuing):', e?.response?.body || e);
    }

    // Start polling
    await bot.startPolling({
      interval: 300,
      params: { timeout: 50, allowed_updates: ['message', 'callback_query'] },
    });
    console.log('📡 Polling started.');

    if (VERBOSE) console.log('ActiveChats:', [...ActiveChats]);

    // Startup hello
    await broadcastAwake();

    // Timed reminders (example: 20 & 25 minutes)
    const durMs = DURATION_MINUTES * 60 * 1000;
    if (DURATION_MINUTES <= 0 || durMs > 20 * 60 * 1000)
      setTimeout(() => sendReminder('⏱️ 20 minutes gone. '), 20 * 60 * 1000);
    if (DURATION_MINUTES <= 0 || durMs > 25 * 60 * 1000)
      setTimeout(() => sendReminder('⏱️ 25 minutes gone. '), 25 * 60 * 1000);

    // Auto-stop + warning + reset checks
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
