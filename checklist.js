// checklist.js
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN is missing (set it in your CI/CD secrets).');
  process.exit(1);
}

// ===== Config =====
const VERBOSE = String(process.env.VERBOSE || 'false') === 'true';
const ANNOUNCE_CHAT = ((process.env.CHAT_ID || '').trim()) || null; // optional
const DURATION_MINUTES = Number(process.env.DURATION_MINUTES || 30); // 0 = no auto-stop
const SLEEP_WARNING_SECONDS = Number(process.env.SLEEP_WARNING_SECONDS || 60); // warn before sleep
const ADD_REQUIRE_ALLOWLIST = String(process.env.ADD_REQUIRE_ALLOWLIST || 'true') === 'true';
const DROP_PENDING = String(process.env.DROP_PENDING || 'true') === 'true';
const DEFAULT_COMPACT = String(process.env.COMPACT || 'false') === 'true'; // default per-chat view

// Menu recovery knobs
const MENU_RECOVERY_PHRASES = [
  'menu', 'buttons', 'keyboard', 'controls', 'show menu', 'show keyboard'
];

// No polling yet; we’ll clear webhook then start
const bot = new TelegramBot(BOT_TOKEN, { polling: false });
const cmdRe = (name, hasArg = false) =>
  new RegExp(`^\\/${name}(?:@\\w+)?${hasArg ? "\\s+(.+)" : "\\s*$"}`, "i");

// ===== Persistence =====
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
 * DB[chatId] = { items:[{text,done}], allow:[id...], removeMode:boolean, compact:boolean }
 * (backward-compatible with legacy array -> {items:...})
 */
function getState(cid) {
  let v = DB[cid];
  if (!v) { v = { items: [], allow: [], removeMode: false, compact: DEFAULT_COMPACT }; DB[cid] = v; return v; }
  if (Array.isArray(v)) { v = { items: v, allow: [], removeMode: false, compact: DEFAULT_COMPACT }; DB[cid] = v; return v; }
  if (!Array.isArray(v.items)) v.items = [];
  if (!Array.isArray(v.allow)) v.allow = [];
  if (typeof v.removeMode !== 'boolean') v.removeMode = false;
  if (typeof v.compact !== 'boolean') v.compact = DEFAULT_COMPACT;
  return v;
}

const getList       = (cid) => getState(cid).items;
const getAllow      = (cid) => getState(cid).allow;
const isRemoveMode  = (cid) => getState(cid).removeMode;
const setRemoveMode = (cid, on) => { getState(cid).removeMode = !!on; };
const isCompact     = (cid) => getState(cid).compact;
const setCompact    = (cid, on) => { getState(cid).compact = !!on; };

const ActiveChats = new Set(Object.keys(DB));

// ===== Utils =====
const escapeHtml = (s) => s.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const truncate = (s,n)=> s && s.length>n ? s.slice(0,n-1)+'…' : s;

function renderLines(items) {
  return items.length
    ? items.map((it,i)=> `${i+1}. ${it.done?'✅':'⬜️'} ${escapeHtml(it.text)}`).join('\n')
    : 'No items yet. Use the keyboard below or /add &lt;task&gt;.';
}
function renderHeader(items) {
  const total = items.length;
  const done = items.filter(x => x.done).length;
  const left = total - done;
  return `<b>Checklist</b> — ${total ? `${left}/${total} left${left===0?' ✅':''}` : 'empty'}`;
}

// Each item’s keyboard button label (easy to parse, phone-friendly)
function itemButtonLabel(it, i) {
  return `${it.done ? '✅' : '⬜️'} #${i+1}: ${truncate(it.text, 28)}`;
}

// Build reply keyboard with global controls + one row per item
function buildReplyKeyboard(cid) {
  const items = getList(cid);
  const rows = [
    [ { text:'➕ Add' }, { text:'🔄 Refresh' } ],
    [ { text: isRemoveMode(cid) ? '✅ Done removing' : '🗑 Remove mode' }, { text:'🧹 Clear checks' } ],
    [ { text: isCompact(cid) ? '📝 Full view' : '📋 Compact view' }, { text:'📌 Show menu' } ],
  ];
  for (let i=0;i<items.length;i++){
    rows.push([ { text: itemButtonLabel(items[i], i) } ]);
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

// Track & ensure state shell exists
function ensureChatTracked(cid){
  const k = String(cid);
  let added = false;
  if (!ActiveChats.has(k)) { ActiveChats.add(k); added = true; }
  getState(cid);
  return added;
}

// Core send
async function sendListInteractive(cid) {
  const items = getList(cid);
  const body = isCompact(cid) ? renderHeader(items) : `<b>Your checklist</b>\n${renderLines(items)}`;
  return bot.sendMessage(cid, body, { parse_mode:'HTML', ...buildReplyKeyboard(cid) });
}

// Send a plain message but always re-attach keyboard immediately after (mobile-friendly)
async function sendWithMenu(cid, text, extra = {}) {
  await bot.sendMessage(cid, text, extra);
  await sendListInteractive(cid);
}

// Clear checkmarks (keep text)
function uncheckAll(cid) {
  const items = getList(cid);
  let changed = false;
  for (const it of items) { if (it.done) { it.done = false; changed = true; } }
  return { changed, count: items.length };
}
function resetAllChatsChecks() {
  let changed = false;
  for (const cid of Object.keys(DB)) {
    const st = getState(cid);
    for (const it of st.items) { if (it.done) { it.done = false; changed = true; } }
  }
  return changed;
}

// ===== Allowlist / permissions =====
let SELF_ID = 0;

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
  if (msg.chat.type === 'private') return true;
  if (await isAdmin(cid, uid)) return true;
  if (!ADD_REQUIRE_ALLOWLIST) return true;
  return getAllow(cid).includes(uid);
}
function formatUser(u) {
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || `id:${u.id}`;
  return `${escapeHtml(name)} (${u.id})`;
}

// ===== Welcome (once per run per chat) =====
const WelcomedThisRun = new Set();
async function maybeWelcome(cid, newlyTracked) {
  if (WelcomedThisRun.has(cid)) return;
  WelcomedThisRun.add(cid);
  if (newlyTracked) saveData(DB);
  // IMPORTANT: attach keyboard in the next message (mobile)
  await sendWithMenu(cid, '👋 Hello! The bot is awake. Use the keyboard below or type a task.');
}

// ===== Logging & safety =====
process.on('unhandledRejection', e => console.error('unhandledRejection:', e?.response?.body || e));
process.on('uncaughtException',  e => console.error('uncaughtException:', e?.response?.body || e));
const HEARTBEAT = setInterval(() => { if (VERBOSE) console.log('…heartbeat'); }, 10_000);

// ===== Commands =====
bot.onText(cmdRe('start'), async (msg) => {
  const cid = msg.chat.id; const added = ensureChatTracked(cid);
  await maybeWelcome(cid, added);
  // re-attach menu after help text too (mobile)
  await bot.sendMessage(cid,
    ['<b>Checklist Bot</b> is awake 👋',
     'Use buttons or commands:',
     '• /add &lt;text&gt;',
     '• /list',
     '• /done &lt;number&gt;',
     '• /remove &lt;number&gt;',
     '• /clear (uncheck all)',
     '• /allow (admin, reply to a user)',
     '• /deny  (admin, reply to a user)',
     '• /whoallowed',
     '• /menu (show keyboard if hidden)'].join('\n'),
    { parse_mode:'HTML' }
  );
  await sendListInteractive(cid);
});

bot.onText(cmdRe('menu'), async (msg) => {
  const cid = msg.chat.id; const added = ensureChatTracked(cid);
  await maybeWelcome(cid, added);
  await sendListInteractive(cid);
});

bot.onText(cmdRe('add', true), async (msg, m) => {
  const cid = msg.chat.id; const added = ensureChatTracked(cid);
  await maybeWelcome(cid, added);
  if (!(await canUserAdd(msg))) return bot.sendMessage(cid, '🚫 You are not allowed to add tasks in this chat.');
  const text = (m[1] || '').trim(); if (!text) return bot.sendMessage(cid, 'Usage: /add <task>');
  getList(cid).push({ text, done:false }); saveData(DB);
  await sendListInteractive(cid);
});

bot.onText(cmdRe('list'), async (msg) => {
  const cid = msg.chat.id; const added = ensureChatTracked(cid);
  await maybeWelcome(cid, added);
  await sendListInteractive(cid);
});

bot.onText(cmdRe('done', true), async (msg, m) => {
  const cid = msg.chat.id; const added = ensureChatTracked(cid);
  await maybeWelcome(cid, added);
  const i = parseInt(m[1],10)-1; const items = getList(cid);
  if (i>=0 && i<items.length) { items[i].done = true; saveData(DB); await sendListInteractive(cid); }
  else await bot.sendMessage(cid, 'Usage: /done <number>');
});

bot.onText(cmdRe('remove', true), async (msg, m) => {
  const cid = msg.chat.id; const added = ensureChatTracked(cid);
  await maybeWelcome(cid, added);
  const i = parseInt(m[1],10)-1; const items = getList(cid);
  if (i>=0 && i<items.length) { items.splice(i,1); saveData(DB); await sendListInteractive(cid); }
  else await bot.sendMessage(cid, 'Usage: /remove <number>');
});

bot.onText(cmdRe('clear'), async (msg) => {
  const cid = msg.chat.id; const added = ensureChatTracked(cid);
  await maybeWelcome(cid, added);
  const { changed } = uncheckAll(cid); if (changed) saveData(DB);
  await sendListInteractive(cid);
});

// Allowlist admin
bot.onText(cmdRe('allow'), async (msg) => {
  const cid = msg.chat.id;
  if (!(await isAdmin(cid, msg.from.id))) return bot.sendMessage(cid, 'Only admins can use /allow.');
  if (!msg.reply_to_message || !msg.reply_to_message.from) return bot.sendMessage(cid, 'Reply to the user’s message with /allow.');
  const target = msg.reply_to_message.from;
  const allow = getAllow(cid);
  if (!allow.includes(target.id)) { allow.push(target.id); saveData(DB); }
  await bot.sendMessage(cid, `✅ Allowed: ${formatUser(target)}`, { parse_mode:'HTML' });
  await sendListInteractive(cid);
});

bot.onText(cmdRe('deny'), async (msg) => {
  const cid = msg.chat.id;
  if (!(await isAdmin(cid, msg.from.id))) return bot.sendMessage(cid, 'Only admins can use /deny.');
  if (!msg.reply_to_message || !msg.reply_to_message.from) return bot.sendMessage(cid, 'Reply to the user’s message with /deny.');
  const target = msg.reply_to_message.from;
  const allow = getAllow(cid);
  const idx = allow.indexOf(target.id);
  if (idx >= 0) { allow.splice(idx, 1); saveData(DB); await bot.sendMessage(cid, `🚫 Removed from allowlist: ${formatUser(target)}`, { parse_mode:'HTML' }); }
  else { await bot.sendMessage(cid, `${formatUser(target)} was not on the allowlist.`, { parse_mode:'HTML' }); }
  await sendListInteractive(cid);
});

bot.onText(cmdRe('whoallowed'), async (msg) => {
  const cid = msg.chat.id; const allow = getAllow(cid);
  if (allow.length === 0) { await bot.sendMessage(cid, 'No one is on the allowlist yet.'); await sendListInteractive(cid); return; }
  const lines = [];
  for (const uid of allow) {
    try { const m = await bot.getChatMember(cid, uid); const u = m.user || { id: uid }; lines.push(`• ${formatUser(u)}`); }
    catch { lines.push(`• id:${uid}`); }
  }
  await bot.sendMessage(cid, `<b>Allowlist</b>\n${lines.join('\n')}`, { parse_mode:'HTML' });
  await sendListInteractive(cid);
});

// ===== Reply keyboard actions & free text =====
bot.on('message', async (msg) => {
  if (!msg.text) return;

  // Ignore known slash commands handled by onText
  if (/^\/(start|menu|add|list|done|remove|clear|allow|deny|whoallowed)/i.test(msg.text)) return;

  const cid = msg.chat.id;
  const added = ensureChatTracked(cid);
  await maybeWelcome(cid, added);

  const text = msg.text.trim();

  // ===== Menu recovery fallback (works even when keyboard is hidden) =====
  const tLower = text.toLowerCase();
  if (text === '📌 Show menu' || MENU_RECOVERY_PHRASES.some(p => tLower === p)) {
    await sendListInteractive(cid);
    return;
  }

  // Global buttons
  if (text === '🔄 Refresh') { await sendListInteractive(cid); return; }

  if (text === '🧹 Clear checks') {
    const { changed } = uncheckAll(cid); if (changed) saveData(DB);
    await sendListInteractive(cid); return;
  }

  if (text === '📋 Compact view') {
    setCompact(cid, true); saveData(DB);
    await sendListInteractive(cid); return;
  }
  if (text === '📝 Full view') {
    setCompact(cid, false); saveData(DB);
    await sendListInteractive(cid); return;
  }

  if (text === '🗑 Remove mode') {
    if (!(await canUserAdd(msg))) { await bot.sendMessage(cid, '🚫 You are not allowed to remove in this chat.'); await sendListInteractive(cid); return; }
    setRemoveMode(cid, true); saveData(DB);
    await sendWithMenu(cid, 'Remove mode ON. Tap any item button to delete it, or press “✅ Done removing”.');
    return;
  }
  if (text === '✅ Done removing') {
    setRemoveMode(cid, false); saveData(DB);
    await sendWithMenu(cid, 'Remove mode OFF.');
    return;
  }

  if (text === '➕ Add') {
    await bot.sendMessage(cid, 'Send the task text:', { reply_markup: { force_reply: true } });
    return;
  }

  // Add via force-reply
  if (msg.reply_to_message && /Send the task text:/.test(msg.reply_to_message.text || '')) {
    if (!(await canUserAdd(msg))) { await bot.sendMessage(cid, `🚫 You are not allowed to add tasks in this chat.`); await sendListInteractive(cid); return; }
    const t = text; if (!t) return;
    getList(cid).push({ text:t, done:false }); saveData(DB);
    await sendListInteractive(cid); return;
  }

  // Item buttons: match "#N"
  const m = text.match(/#(\d+)/);
  if (m) {
    const n = parseInt(m[1], 10) - 1;
    const items = getList(cid);
    if (n >= 0 && n < items.length) {
      if (isRemoveMode(cid)) {
        if (!(await canUserAdd(msg))) { await bot.sendMessage(cid, `🚫 You are not allowed to remove tasks in this chat.`); await sendListInteractive(cid); return; }
        items.splice(n, 1); saveData(DB);
      } else {
        items[n].done = !items[n].done; saveData(DB);
      }
      await sendListInteractive(cid);
      return;
    }
  }

  // In groups: only add free text when replying to the bot
  if (msg.chat.type !== 'private') {
    if (!(msg.reply_to_message && msg.reply_to_message.from && msg.reply_to_message.from.id === SELF_ID)) return;
  }

  // Free text add (fallback)
  if (!(await canUserAdd(msg))) { await bot.sendMessage(cid, `🚫 You are not allowed to add tasks in this chat.`); await sendListInteractive(cid); return; }
  const t = text; if (!t) return;
  getList(cid).push({ text:t, done:false }); saveData(DB);
  await sendListInteractive(cid);
});

// ===== Timed helpers (SGT scheduling) =====
const MS_IN_DAY = 24 * 60 * 60 * 1000;

// Returns ms until the next SGT clock time (hour:0-23, minute:0-59)
function msUntilNextSgt(hour, minute) {
  const now = new Date();
  // SGT = UTC+8 -> target UTC time is SGT-8h
  const targetUtc = new Date(now);
  targetUtc.setUTCHours(hour - 8, minute, 0, 0);
  let delta = targetUtc.getTime() - now.getTime();
  if (delta < 0) delta += MS_IN_DAY; // next day
  return delta;
}

// Schedule a daily task at SGT time
function scheduleDailyAtSgt(hour, minute, fn) {
  const d = msUntilNextSgt(hour, minute);
  if (VERBOSE) console.log(`Scheduling daily task at ${hour.toString().padStart(2,'0')}:${minute.toString().padStart(2,'0')} SGT in ${Math.round(d/1000)}s`);
  setTimeout(async () => {
    try { await fn(); } catch (e) { console.error('daily task error:', e?.response?.body || e); }
    setInterval(async () => {
      try { await fn(); } catch (e) { console.error('daily task error:', e?.response?.body || e); }
    }, MS_IN_DAY);
  }, d);
}

// Targets helper
function getTargets() {
  const targets = new Set(ActiveChats);
  if (ANNOUNCE_CHAT) targets.add(String(ANNOUNCE_CHAT));
  return targets;
}

// Daily messages (IMPORTANT: always re-attach the keyboard after non-interactive messages)
async function sendDailyHandover() {
  for (const cid of getTargets()) {
    try {
      await sendWithMenu(cid, '🔔 10:00 SGT — Handover time.');
    } catch (e) { console.error('handover send error for', cid, e?.response?.body || e); }
  }
}

async function sendDailyEOD() {
  for (const cid of getTargets()) {
    try {
      await sendWithMenu(cid, '🔔 17:00 SGT — End of day.');
    } catch (e) { console.error('EOD send error for', cid, e?.response?.body || e); }
  }
}

async function sendDailyMorningPoll() {
  for (const cid of getTargets()) {
    try {
      // Poll messages commonly cause Telegram mobile to hide reply keyboards.
      // Fix: always re-send the interactive list (keyboard) right after the poll.
      await bot.sendPoll(
        cid,
        'Good morning commanders, please indicate whether you will be in camp for today',
        ['Yes', 'No', 'MA/MC', 'OL', 'LL', 'OFF'],
        { is_anonymous: false, allows_multiple_answers: false }
      );
      await sendListInteractive(cid);
    } catch (e) { console.error('poll send error for', cid, e?.response?.body || e); }
  }
}

// ===== Reminders / Awake / Sleep =====
async function broadcastAwake() {
  for (const cid of getTargets()) {
    try { await sendWithMenu(cid, '👋 The bot is awake.'); }
    catch (e) { console.warn('awake send failed for', cid, e?.response?.body || e); }
  }
}

async function sendReminder(prefix) {
  for (const cid of getTargets()) {
    try { await sendWithMenu(cid, prefix); }
    catch (e) { console.error('reminder error for', cid, e?.response?.body || e); }
  }
}

async function sendSleepWarning() {
  for (const cid of getTargets()) {
    try {
      // warning can be plain, but re-attach menu anyway for mobile users
      await sendWithMenu(cid, '😴 The bot is going to sleep soon.');
    } catch {}
  }
}

// ===== Startup =====
(async function main(){
  try {
    const me = await bot.getMe();
    SELF_ID = me.id;
    console.log(`🤖 Bot @${me.username} (ID ${me.id}) starting…`);

    if (ANNOUNCE_CHAT) ensureChatTracked(ANNOUNCE_CHAT);

    try {
      await bot.deleteWebHook({ drop_pending_updates: DROP_PENDING });
      console.log(`✅ Webhook cleared. (drop_pending_updates=${DROP_PENDING})`);
    } catch (e) {
      console.warn('⚠️ deleteWebHook failed (continuing):', e?.response?.body || e);
    }

    await bot.startPolling({
      interval: 300,
      // Keep it message-only (your design uses reply keyboard, not callback_query)
      params: { timeout: 50, allowed_updates: ['message'] },
    });
    console.log('📡 Polling started.');

    if (VERBOSE) console.log('ActiveChats:', [...ActiveChats]);

    // Hello
    await broadcastAwake();

    // Timed reminders (relative to start)
    setTimeout(() => sendReminder('⏱️ 20 minutes gone.'), 20 * 60 * 1000);
    setTimeout(() => sendReminder('⏱️ 25 minutes gone.'), 25 * 60 * 1000);

    // Daily SGT schedules (fire once per day while bot is running)
    scheduleDailyAtSgt(6,  0, sendDailyMorningPoll); // 06:00 SGT poll
    scheduleDailyAtSgt(10, 0, sendDailyHandover);     // 10:00 SGT
    scheduleDailyAtSgt(17, 0, sendDailyEOD);          // 17:00 SGT

    // Auto-stop + warning + reset checks
    if (DURATION_MINUTES > 0) {
      const durMs = DURATION_MINUTES * 60 * 1000;
      const warnMs = Math.max(0, durMs - (SLEEP_WARNING_SECONDS * 1000));
      if (warnMs > 0) setTimeout(() => { if (VERBOSE) console.log('⏰ Sleep warning firing…'); sendSleepWarning(); }, warnMs);

      setTimeout(async () => {
        if (VERBOSE) console.log(`⏱️ ${DURATION_MINUTES} minutes elapsed — stopping bot.`);
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
process.on('SIGTERM', ()=> { try { if (resetAllChatsChecks()) saveData(DB); } catch {} clearInterval(HEARTBEAT); process.exit(0); });
process.on('SIGINT',  ()=> { try { if (resetAllChatsChecks()) saveData(DB); } catch {} clearInterval(HEARTBEAT); process.exit(0); });
