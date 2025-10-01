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
const SPAM_GAP_MS = Number(process.env.SPAM_GAP_MS || 800); // anti-spam taps
const DROP_PENDING = String(process.env.DROP_PENDING || 'true') === 'true';
const DEFAULT_COMPACT = String(process.env.COMPACT || 'true') === 'true'; // default per-chat view

// === Bot bootstrap (no polling yet; we’ll clear webhook then start) ===
const bot = new TelegramBot(BOT_TOKEN, { polling: false });
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
 * { items: [{text, done}], allow: [userId,...], removeMode: bool, compact: bool }
 * (Backward compatible with legacy array form.)
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
const getList      = (cid) => getState(cid).items;
const getAllow     = (cid) => getState(cid).allow;
const isRemoveMode = (cid) => getState(cid).removeMode;
const setRemoveMode= (cid, on) => { getState(cid).removeMode = !!on; };
const isCompact    = (cid) => getState(cid).compact;
const setCompact   = (cid, on) => { getState(cid).compact = !!on; };

const ActiveChats = new Set(Object.keys(DB));

// ===== Utils & rendering =====
const isAllDone = (items) => items.length > 0 && items.every(x => x.done);
const escapeHtml = (s) => s.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const truncate = (s,n)=> s && s.length>n ? s.slice(0,n-1)+'…' : s;

function renderLines(items) {
  return items.length
    ? items.map((it,i)=> `${i+1}. ${it.done?'✅':'⬜️'} ${escapeHtml(it.text)}`).join('\n')
    : 'No items yet. Use the keyboard below or /add <task>.';
}
function renderHeader(items) {
  const total = items.length;
  const done = items.filter(x => x.done).length;
  const left = total - done;
  const parts = [];
  parts.push('<b>Checklist</b>');
  parts.push(total ? `— ${left}/${total} left${left === 0 ? ' ✅' : ''}` : '— empty');
  return parts.join(' ');
}

// Inline (per-item) keyboard: keep only item actions here
function buildInlineKeyboard(items) {
  const rows = items.map((it,i)=> ([
    { text: `${it.done?'✅':'⬜️'} ${truncate(it.text, 32)}`, callback_data: `t:${i}` },
    { text: '🗑', callback_data: `rm:${i}` },
  ]));
  return { reply_markup: { inline_keyboard: rows } };
}

// Reply (global) keyboard: Add / RemoveMode / Clear / Refresh / View toggle
function buildReplyKeyboard(cid) {
  const inRemove = isRemoveMode(cid);
  const compact = isCompact(cid);
  const rows = [
    [ { text: '➕ Add' }, { text: inRemove ? '✅ Done removing' : '🗑 Remove mode' } ],
    [ { text: '🧹 Clear checks' }, { text: '🔄 Refresh' } ],
    [ { text: compact ? '📝 Full view' : '📋 Compact view' } ],
  ];
  return {
    reply_markup: {
      keyboard: rows,
      resize_keyboard: true,
      one_time_keyboard: false,
      input_field_placeholder: 'Type a task or use buttons…'
    }
  };
}

function ensureChatTracked(cid){
  const key = String(cid);
  let added = false;
  if(!ActiveChats.has(key)) { ActiveChats.add(key); added = true; }
  getState(cid);
  return added;
}

// One-time per run helper to show the reply keyboard
const ReplyKeyboardShown = new Set();
async function ensureReplyKeyboardShown(cid) {
  if (ReplyKeyboardShown.has(cid)) return;
  ReplyKeyboardShown.add(cid);
  await bot.sendMessage(cid, 'Controls ready ⌨️', buildReplyKeyboard(cid));
}

async function sendListInteractive(cid) {
  const items=getList(cid);
  const body = isCompact(cid)
    ? renderHeader(items)
    : `<b>Your checklist</b>\n${renderLines(items)}`;
  // Show list with inline item actions…
  await bot.sendMessage(cid, body, { parse_mode:'HTML', ...buildInlineKeyboard(items) });
  // …and ensure the global reply keyboard is visible (sent once per run)
  await ensureReplyKeyboardShown(cid);
}

async function refreshInlineMessage(cid, mid){
  const items=getList(cid);
  const body = isCompact(cid)
    ? renderHeader(items)
    : `<b>Your checklist</b>\n${renderLines(items)}`;
  return bot.editMessageText(body, {
    chat_id: cid,
    message_id: mid,
    parse_mode:'HTML',
    ...buildInlineKeyboard(items)
  });
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

// ===== Allowlist & permissions =====
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

// ===== Welcome helpers =====
const WelcomedThisRun = new Set();
async function maybeWelcome(cid, newlyTracked) {
  if (WelcomedThisRun.has(cid)) return;
  WelcomedThisRun.add(cid);
  if (newlyTracked) saveData(DB);
  await bot.sendMessage(cid, '👋 Hello! The bot is awake. Use the buttons below or type a task.');
  await sendListInteractive(cid);
}

// ===== Logging & hardening =====
process.on('unhandledRejection', e => console.error('unhandledRejection:', e?.response?.body || e));
process.on('uncaughtException',  e => console.error('uncaughtException:', e?.response?.body || e));
const HEARTBEAT = setInterval(() => { if (VERBOSE) console.log('…heartbeat'); }, 10_000);

// ===== Commands =====
bot.onText(cmdRe('start'), async (msg) => {
  const cid = msg.chat.id; const newlyTracked = ensureChatTracked(cid);
  await maybeWelcome(cid, newlyTracked);
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
     '• /whoallowed'].join('\n'),
    { parse_mode:'HTML' }
  );
});

// /add <text>
bot.onText(cmdRe('add', true), async (msg, m) => {
  const cid = msg.chat.id; const newlyTracked = ensureChatTracked(cid);
  await maybeWelcome(cid, newlyTracked);
  if (!(await canUserAdd(msg))) return bot.sendMessage(cid, '🚫 You are not allowed to add tasks in this chat.');

  const text = (m[1] || '').trim();
  if (!text) return bot.sendMessage(cid, 'Usage: /add <task>');
  getList(cid).push({ text, done: false }); saveData(DB);
  await bot.sendMessage(cid, `Added: <b>${escapeHtml(text)}</b>`, { parse_mode:'HTML' });
  await sendListInteractive(cid);
});

// /list
bot.onText(cmdRe('list'), async (msg) => {
  const cid = msg.chat.id; const newlyTracked = ensureChatTracked(cid);
  await maybeWelcome(cid, newlyTracked);
  await sendListInteractive(cid);
});

// /done <n>
bot.onText(cmdRe('done', true), async (msg, m) => {
  const cid = msg.chat.id; const newlyTracked = ensureChatTracked(cid);
  await maybeWelcome(cid, newlyTracked);

  const i = parseInt(m[1], 10) - 1;
  const items = getList(cid);
  if (i >= 0 && i < items.length) {
    items[i].done = true; saveData(DB);
    await bot.sendMessage(cid, `Marked done: <b>${escapeHtml(items[i].text)}</b> ✅`, { parse_mode:'HTML' });
    await sendListInteractive(cid);
  } else {
    await bot.sendMessage(cid, 'Usage: /done <number>');
  }
});

// /remove <n>
bot.onText(cmdRe('remove', true), async (msg, m) => {
  const cid = msg.chat.id; const newlyTracked = ensureChatTracked(cid);
  await maybeWelcome(cid, newlyTracked);

  const i = parseInt(m[1], 10) - 1;
  const items = getList(cid);
  if (i >= 0 && i < items.length) {
    const r = items.splice(i, 1)[0]; saveData(DB);
    await bot.sendMessage(cid, `Removed: <b>${escapeHtml(r.text)}</b> 🗑️`, { parse_mode:'HTML' });
    await sendListInteractive(cid);
  } else {
    await bot.sendMessage(cid, 'Usage: /remove <number>');
  }
});

// /clear -> uncheck all
bot.onText(cmdRe('clear'), async (msg) => {
  const cid = msg.chat.id; const newlyTracked = ensureChatTracked(cid);
  await maybeWelcome(cid, newlyTracked);

  const { changed, count } = uncheckAll(cid);
  if (count === 0) await bot.sendMessage(cid, 'Nothing to clear — your list is empty.');
  else {
    if (changed) saveData(DB);
    await bot.sendMessage(cid, 'All checkmarks cleared. ⬜️');
  }
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
});
bot.onText(cmdRe('whoallowed'), async (msg) => {
  const cid = msg.chat.id; const allow = getAllow(cid);
  if (allow.length === 0) return bot.sendMessage(cid, 'No one is on the allowlist yet.');
  const lines = [];
  for (const uid of allow) {
    try { const m = await bot.getChatMember(cid, uid); const u = m.user || { id: uid }; lines.push(`• ${formatUser(u)}`); }
    catch { lines.push(`• id:${uid}`); }
  }
  await bot.sendMessage(cid, `<b>Allowlist</b>\n${lines.join('\n')}`, { parse_mode:'HTML' });
});

// ===== Message handler (reply keyboard + free text) =====
bot.on('message', async (msg) => {
  if (!msg.text) return;
  if (/^\/(start|add|list|done|remove|clear|allow|deny|whoallowed)/i.test(msg.text)) return;

  const cid = msg.chat.id;
  const newlyTracked = ensureChatTracked(cid);
  await maybeWelcome(cid, newlyTracked);

  // Handle reply keyboard buttons
  if (msg.text === '🔄 Refresh') { await sendListInteractive(cid); return; }

  if (msg.text === '🧹 Clear checks') {
    const { changed } = uncheckAll(cid);
    if (changed) saveData(DB);
    await bot.sendMessage(cid, 'All checkmarks cleared. ⬜️');
    await sendListInteractive(cid);
    return;
  }

  if (msg.text === '📋 Compact view') {
    setCompact(cid, true); saveData(DB);
    await sendListInteractive(cid);
    return;
  }
  if (msg.text === '📝 Full view') {
    setCompact(cid, false); saveData(DB);
    await sendListInteractive(cid);
    return;
  }

  if (msg.text === '🗑 Remove mode') {
    setRemoveMode(cid, true); saveData(DB);
    await bot.sendMessage(cid, 'Remove mode ON. Send a number or range (e.g., 2 or 1-3 or 1,4).');
    return;
  }
  if (msg.text === '✅ Done removing') {
    setRemoveMode(cid, false); saveData(DB);
    await bot.sendMessage(cid, 'Remove mode OFF.');
    return;
  }

  if (msg.text === '➕ Add') {
    // Prompt once; next user message (reply) becomes the task
    await bot.sendMessage(cid, 'Send the task text:', { reply_markup: { force_reply: true } });
    return;
  }

  // Add via ForceReply
  if (msg.reply_to_message && /Send the task text:/.test(msg.reply_to_message.text || '')) {
    if (!(await canUserAdd(msg))) return bot.sendMessage(cid, `🚫 You are not allowed to add tasks in this chat.`);
    const t = msg.text.trim(); if (!t) return;
    getList(cid).push({ text: t, done: false }); saveData(DB);
    await bot.sendMessage(cid, `Added: <b>${escapeHtml(t)}</b>`, { parse_mode:'HTML' });
    await sendListInteractive(cid);
    return;
  }

  // Remove mode: accept numbers / ranges
  if (isRemoveMode(cid)) {
    const raw = msg.text.replace(/\s+/g,'');
    // patterns like "2", "1-3", "1,4,6", "1-2,5"
    if (/^\d+([,-]\d+)*(\-\d+)?$/.test(raw)) {
      const toRemove = new Set();
      for (const part of raw.split(',')) {
        if (part.includes('-')) {
          const [a,b] = part.split('-').map(x=>parseInt(x,10));
          if (!isNaN(a) && !isNaN(b)) {
            const lo = Math.min(a,b), hi = Math.max(a,b);
            for (let k=lo; k<=hi; k++) toRemove.add(k);
          }
        } else {
          const n = parseInt(part,10);
          if (!isNaN(n)) toRemove.add(n);
        }
      }
      const items = getList(cid);
      const idxs = [...toRemove]
        .map(n => n-1)
        .filter(i => i>=0 && i<items.length)
        .sort((a,b)=>b-a); // delete from end
      if (idxs.length === 0) {
        await bot.sendMessage(cid, 'No matching item numbers to remove.');
      } else {
        const removed = [];
        for (const i of idxs) {
          removed.push(items.splice(i,1)[0]?.text);
        }
        saveData(DB);
        await bot.sendMessage(cid, `Removed ${idxs.length} item(s).`);
        await sendListInteractive(cid);
      }
      return;
    }
    // fallthrough if not valid pattern; ignore to avoid accidental deletes
  }

  // In groups: only add free text when replying to the bot
  if (msg.chat.type !== 'private') {
    if (!(msg.reply_to_message && msg.reply_to_message.from && msg.reply_to_message.from.id === SELF_ID)) return;
  }

  // Free-text add (if allowed)
  if (!(await canUserAdd(msg))) return bot.sendMessage(cid, `🚫 You are not allowed to add tasks in this chat.`);
  const t = msg.text.trim(); if (!t) return;
  getList(cid).push({ text:t, done:false }); saveData(DB);
  await bot.sendMessage(cid, `Added: <b>${escapeHtml(t)}</b>`, { parse_mode:'HTML' });
  await sendListInteractive(cid);
});

// ===== Anti-spam for inline buttons =====
const tapLimiter = new Map(); // key `${cid}:${uid}` -> lastTs

// Inline buttons (per-item)
bot.on('callback_query', async (q) => {
  try{
    const cid = q.message.chat.id; const mid = q.message.message_id;
    ensureChatTracked(cid); // not welcoming here

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
    const [action,arg] = (q.data||'').split(':');

    if(action==='t'){
      const i=parseInt(arg,10);
      if(!isNaN(i)&&items[i]) { items[i].done=!items[i].done; saveData(DB); }
      await refreshInlineMessage(cid, mid);
    } else if(action==='rm'){
      const i=parseInt(arg,10);
      if(!isNaN(i)&&items[i]) {
        const r=items.splice(i,1)[0]; saveData(DB);
        await bot.sendMessage(cid, `Removed: <b>${escapeHtml(r.text)}</b> 🗑️`, { parse_mode:'HTML' });
      }
      await refreshInlineMessage(cid, mid);
    }

    await bot.answerCallbackQuery(q.id);
  }catch(e){
    console.error('callback error:', e?.response?.body || e);
    try{ await bot.answerCallbackQuery(q.id); }catch{}
  }
});

// Polling error visibility (do NOT exit)
bot.on('polling_error', (err)=>{ console.error('polling_error:', err?.response?.body || err); });

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
      await bot.sendMessage(cid, '👋 The bot is awake.');
      await sendListInteractive(cid);
    } catch (e) { console.warn('awake send failed for', cid, e?.response?.body || e); }
  }
}

async function sendReminder(prefix) {
  const targets = new Set(ActiveChats);
  if (ANNOUNCE_CHAT) targets.add(String(ANNOUNCE_CHAT));
  if (VERBOSE) console.log('sendReminder targets:', [...targets]);
  for (const cid of targets) {
    try { await bot.sendMessage(cid, `${prefix}`); await sendListInteractive(cid); }
    catch (e) { console.error('sendReminder error for', cid, e?.response?.body || e); }
  }
}

// Generic “going to sleep soon” notice
async function sendSleepWarning() {
  const targets = new Set(ActiveChats);
  if (ANNOUNCE_CHAT) targets.add(String(ANNOUNCE_CHAT));
  for (const cid of targets) {
    try {
      await bot.sendMessage(cid, '😴 The bot is going to sleep soon.');
      await ensureReplyKeyboardShown(cid);
    } catch {}
  }
}

// ======= Startup =======
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
      params: { timeout: 50, allowed_updates: ['message','callback_query'] },
    });
    console.log('📡 Polling started.');

    if (VERBOSE) console.log('ActiveChats:', [...ActiveChats]);

    // Hello
    await broadcastAwake();

    // Reminders (adjust to your taste)
    const durMs = DURATION_MINUTES * 60 * 1000;
    setTimeout(() => sendReminder('⏱️ 20 minutes gone.'), 20 * 60 * 1000);
    setTimeout(() => sendReminder('⏱️ 25 minutes gone.'), 25 * 60 * 1000);

    // Auto-stop + warning + reset checks
    if (DURATION_MINUTES > 0) {
      const warnMs = Math.max(0, durMs - (SLEEP_WARNING_SECONDS * 1000));
      if (warnMs > 0) setTimeout(() => { console.log('⏰ Sleep warning firing…'); sendSleepWarning(); }, warnMs);

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
process.on('SIGTERM', ()=> { try { if (resetAllChatsChecks()) saveData(DB); } catch {} clearInterval(HEARTBEAT); process.exit(0); });
process.on('SIGINT',  ()=> { try { if (resetAllChatsChecks()) saveData(DB); } catch {} clearInterval(HEARTBEAT); process.exit(0); });
