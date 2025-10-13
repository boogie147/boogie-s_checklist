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
const RUN_KIND = (process.env.RUN_KIND || 'manual');                // 'morning' | 'noon' | 'manual'
const DURATION_MINUTES = Number(process.env.DURATION_MINUTES || 30); // 0 = no auto-stop
const SLEEP_WARNING_SECONDS = Number(process.env.SLEEP_WARNING_SECONDS || 60);
const ADD_REQUIRE_ALLOWLIST = String(process.env.ADD_REQUIRE_ALLOWLIST || 'true') === 'true';
const SPAM_GAP_MS = Number(process.env.SPAM_GAP_MS || 800);
const DROP_PENDING = String(process.env.DROP_PENDING || 'true') === 'true';

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
 * DB[chatId]:
 * - OLD: Array of items
 * - NEW: { items: [...], allow: [userId, ...] }
 */
function getState(cid) {
  let v = DB[cid];
  if (!v) { v = { items: [], allow: [] }; DB[cid] = v; return v; }
  if (Array.isArray(v)) { v = { items: v, allow: [] }; DB[cid] = v; return v; }
  if (!Array.isArray(v.items)) v.items = [];
  if (!Array.isArray(v.allow)) v.allow = [];
  return v;
}
const getList  = (cid) => getState(cid).items;
const getAllow = (cid) => getState(cid).allow;

const ActiveChats = new Set(Object.keys(DB));
const isAllDone = (items) => items.length > 0 && items.every((x) => x.done);
const escapeHtml = (s) => s.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const truncate = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s);

// Render & UI
function renderLines(items) {
  return items.length
    ? items.map((it, i) => `${i + 1}. ${it.done ? '✅' : '⬜️'} ${escapeHtml(it.text)}`).join('\n')
    : 'No items yet. Use /add &lt;task&gt; or the + button.';
}
function buildKeyboard(items) {
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
async function reply(cid, html, extra = {}) { return bot.sendMessage(cid, html, { parse_mode: 'HTML', ...extra }); }
async function edit(cid, mid, html, extra = {}) { return bot.editMessageText(html, { chat_id: cid, message_id: mid, parse_mode: 'HTML', ...extra }); }

// Track + persist new chats
function ensureChatTracked(cid) {
  const key = String(cid);
  let added = false;
  if (!ActiveChats.has(key)) { ActiveChats.add(key); added = true; }
  getState(cid);
  return added;
}
async function sendListInteractive(cid) {
  const items = getList(cid);
  return reply(cid, `<b>Your checklist</b>\n${renderLines(items)}`, buildKeyboard(items));
}
async function refreshMessage(cid, mid) {
  const items = getList(cid);
  return edit(cid, mid, `<b>Your checklist</b>\n${renderLines(items)}`, buildKeyboard(items));
}

// “Clear checks”
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

// Allowlist
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

// Welcome-on-first-contact
const WelcomedThisRun = new Set();
async function maybeWelcome(cid, newlyTracked) {
  if (WelcomedThisRun.has(cid)) return;
  WelcomedThisRun.add(cid);
  if (newlyTracked) saveData(DB);
  await reply(cid, '👋 Hello! The bot is awake. Use /list or the buttons below.');
  await sendListInteractive(cid);
}
async function sendReminderToChat(cid, prefix) {
  const items = getList(cid);
  if (isAllDone(items)) {
    await reply(cid, `${prefix}🎉 Awesome — your list is complete!`);
  } else if (items.length === 0) {
    await reply(cid, `${prefix}Your list is empty. Tap ➕ Add to start.`, buildKeyboard(items));
  } else {
    await reply(cid, `${prefix}Keep going!\n\n${renderLines(items)}`, buildKeyboard(items));
  }
}

// Logging & safety
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e?.response?.body || e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e?.response?.body || e));
const HEARTBEAT = setInterval(() => { if (VERBOSE) console.log('…heartbeat'); }, 10_000);

// ===== Commands =====
bot.onText(cmdRe('start'), async (msg) => {
  const cid = msg.chat.id;
  const newlyTracked = ensureChatTracked(cid);
  await maybeWelcome(cid, newlyTracked);
  await reply(
    cid,
    [
      '<b>Checklist Bot</b> is awake 👋',
      'Use buttons or commands:',
      '• /add &lt;text&gt;',
      '• /list',
      '• /done &lt;number&gt;',
      '• /remove &lt;number&gt;',
      '• /clear  (uncheck all)',
      '• /allow (admin, reply to a user)',
      '• /deny  (admin, reply to a user)',
      '• /whoallowed'
    ].join('\n'),
    buildKeyboard(getList(cid))
  );
});
bot.onText(cmdRe('add', true), async (msg, m) => {
  const cid = msg.chat.id;
  const newlyTracked = ensureChatTracked(cid);
  await maybeWelcome(cid, newlyTracked);
  if (!(await canUserAdd(msg))) return reply(cid, '🚫 You are not allowed to add tasks in this chat.');
  const text = (m[1] || '').trim();
  if (!text) return reply(cid, 'Usage: /add &lt;task&gt;');
  getList(cid).push({ text, done: false }); saveData(DB);
  await reply(cid, `Added: <b>${escapeHtml(text)}</b>`); await sendListInteractive(cid);
});
bot.onText(cmdRe('list'), async (msg) => {
  const cid = msg.chat.id; const newlyTracked = ensureChatTracked(cid);
  await maybeWelcome(cid, newlyTracked); await sendListInteractive(cid);
});
bot.onText(cmdRe('done', true), async (msg, m) => {
  const cid = msg.chat.id; const newlyTracked = ensureChatTracked(cid);
  await maybeWelcome(cid, newlyTracked);
  const i = parseInt(m[1], 10) - 1; const items = getList(cid);
  if (i >= 0 && i < items.length) {
    items[i].done = true; saveData(DB);
    await reply(cid, `Marked done: <b>${escapeHtml(items[i].text)}</b> ✅`);
    await sendListInteractive(cid);
  } else { await reply(cid, 'Usage: /done &lt;number&gt;'); }
});
bot.onText(cmdRe('remove', true), async (msg, m) => {
  const cid = msg.chat.id; const newlyTracked = ensureChatTracked(cid);
  await maybeWelcome(cid, newlyTracked);
  const i = parseInt(m[1], 10) - 1; const items = getList(cid);
  if (i >= 0 && i < items.length) {
    const r = items.splice(i, 1)[0]; saveData(DB);
    await reply(cid, `Removed: <b>${escapeHtml(r.text)}</b> 🗑️`);
    await sendListInteractive(cid);
  } else { await reply(cid, 'Usage: /remove &lt;number&gt;'); }
});
bot.onText(cmdRe('clear'), async (msg) => {
  const cid = msg.chat.id; const newlyTracked = ensureChatTracked(cid);
  await maybeWelcome(cid, newlyTracked);
  const { changed, count } = uncheckAll(cid);
  if (count === 0) await reply(cid, 'Nothing to clear — your list is empty.');
  else { if (changed) saveData(DB); await reply(cid, 'All checkmarks cleared. ⬜️'); }
  await sendListInteractive(cid);
});
bot.onText(cmdRe('allow'), async (msg) => {
  const cid = msg.chat.id;
  if (!(await isAdmin(cid, msg.from.id))) return reply(cid, 'Only admins can use /allow.');
  if (!msg.reply_to_message || !msg.reply_to_message.from) return reply(cid, 'Reply to the user’s message with /allow.');
  const target = msg.reply_to_message.from;
  const allow = getAllow(cid);
  if (!allow.includes(target.id)) { allow.push(target.id); saveData(DB); }
  await reply(cid, `✅ Allowed: ${formatUser(target)}`);
});
bot.onText(cmdRe('deny'), async (msg) => {
  const cid = msg.chat.id;
  if (!(await isAdmin(cid, msg.from.id))) return reply(cid, 'Only admins can use /deny.');
  if (!msg.reply_to_message || !msg.reply_to_message.from) return reply(cid, 'Reply to the user’s message with /deny.');
  const target = msg.reply_to_message.from;
  const allow = getAllow(cid); const idx = allow.indexOf(target.id);
  if (idx >= 0) { allow.splice(idx, 1); saveData(DB); await reply(cid, `🚫 Removed from allowlist: ${formatUser(target)}`); }
  else { await reply(cid, `${formatUser(target)} was not on the allowlist.`); }
});
bot.onText(cmdRe('whoallowed'), async (msg) => {
  const cid = msg.chat.id; const allow = getAllow(cid);
  if (allow.length === 0) return reply(cid, 'No one is on the allowlist yet.');
  const lines = [];
  for (const uid of allow) {
    try { const m = await bot.getChatMember(cid, uid); const u = m.user || { id: uid }; lines.push(`• ${formatUser(u)}`); }
    catch { lines.push(`• id:${uid}`); }
  }
  await reply(cid, `<b>Allowlist</b>\n${lines.join('\n')}`);
});

// Non-command text -> add (private) or reply-to-bot (group)
bot.on('message', async (msg) => {
  if (!msg.text) return;
  if (/^\/(start|add|list|done|remove|clear|allow|deny|whoallowed)/i.test(msg.text)) return;
  const cid = msg.chat.id; const newlyTracked = ensureChatTracked(cid);
  await maybeWelcome(cid, newlyTracked);
  if (msg.chat.type !== 'private') {
    if (!(msg.reply_to_message && msg.reply_to_message.from && msg.reply_to_message.from.id === SELF_ID)) return;
  }
  if (!(await canUserAdd(msg))) return reply(cid, '🚫 You are not allowed to add tasks in this chat.');
  const t = msg.text.trim(); if (!t) return;
  getList(cid).push({ text: t, done: false }); saveData(DB);
  await reply(cid, `Added: <b>${escapeHtml(t)}</b>`); await sendListInteractive(cid);
});

// Anti-spam for inline buttons
const tapLimiter = new Map();
bot.on('callback_query', async (q) => {
  try {
    const cid = q.message.chat.id; const mid = q.message.message_id;
    const newlyTracked = ensureChatTracked(cid); await maybeWelcome(cid, newlyTracked);
    const key = `${cid}:${q.from.id}`; const now = Date.now(); const last = tapLimiter.get(key) || 0;
    if (now - last < SPAM_GAP_MS) { await bot.answerCallbackQuery(q.id, { text: 'Please wait…', show_alert: false }); return; }
    tapLimiter.set(key, now);
    const items = getList(cid);
    const [action, arg] = (q.data || '').split(':');
    if (action === 't') {
      const i = parseInt(arg, 10);
      if (!isNaN(i) && items[i]) { items[i].done = !items[i].done; saveData(DB); }
      await refreshMessage(cid, mid);
    } else if (action === 'rm') {
      const i = parseInt(arg, 10);
      if (!isNaN(i) && items[i]) { const r = items.splice(i, 1)[0]; saveData(DB); await reply(cid, `Removed: <b>${escapeHtml(r.text)}</b> 🗑️`); }
      await refreshMessage(cid, mid);
    } else if (action === 'clear_checks') {
      const { changed } = uncheckAll(cid); if (changed) saveData(DB);
      await refreshMessage(cid, mid);
    } else if (action === 'refresh') {
      await refreshMessage(cid, mid);
    } else if (action === 'add_prompt') {
      const fakeMsg = { chat: { id: cid, type: q.message.chat.type }, from: q.from };
      if (!(await canUserAdd(fakeMsg))) { await reply(cid, '🚫 You are not allowed to add tasks in this chat.'); }
      else {
        await bot.sendMessage(cid, 'Send the task text as a reply to this message.', { reply_markup: { force_reply: true } });
      }
    }
    await bot.answerCallbackQuery(q.id);
  } catch (e) {
    console.error('callback error:', e?.response?.body || e);
    try { await bot.answerCallbackQuery(q.id); } catch {}
  }
});

// Polling error visibility
bot.on('polling_error', (err) => { console.error('polling_error:', err?.response?.body || err); });
if (VERBOSE) {
  bot.on('message', (m) => console.log('msg from', m.chat?.id, m.text));
  bot.on('callback_query', (q) => console.log('callback from', q.message?.chat?.id, q.data));
}

// ===== Reminders / Poll / Awake / Sleep =====
async function broadcastAwake() {
  const targets = new Set(ActiveChats);
  if (ANNOUNCE_CHAT) targets.add(String(ANNOUNCE_CHAT));
  if (VERBOSE) console.log('broadcast targets:', [...targets]);
  for (const cid of targets) {
    try {
      await reply(cid, '👋 Hello! The bot is awake. Use /list or the buttons below.');
      await sendListInteractive(cid);
    } catch (e) { console.warn('awake send failed for', cid, e?.response?.body || e); }
  }
}

async function sendReminder(prefix) {
  const targets = new Set(ActiveChats);
  if (ANNOUNCE_CHAT) targets.add(String(ANNOUNCE_CHAT));
  if (VERBOSE) console.log('sendReminder targets:', [...targets]);
  for (const cid of targets) {
    try { await sendReminderToChat(cid, prefix); }
    catch (e) { console.error('sendReminder error for', cid, e?.response?.body || e); }
  }
}

// NEW: Morning attendance poll (non-anonymous)
const POLL_QUESTION = 'Good morning commanders, please indicate whether you will be in camp for today';
const POLL_OPTIONS = ['Yes', 'No', 'MA/MC', 'OL', 'LL', 'OFF'];
async function broadcastMorningPoll() {
  const targets = new Set(ActiveChats);
  if (ANNOUNCE_CHAT) targets.add(String(ANNOUNCE_CHAT));
  if (targets.size === 0) {
    if (VERBOSE) console.log('No targets for poll.');
    return;
  }
  for (const cid of targets) {
    try {
      await bot.sendPoll(cid, POLL_QUESTION, POLL_OPTIONS, {
        is_anonymous: false,
        allows_multiple_answers: false
      });
      if (VERBOSE) console.log('Poll sent to', cid);
    } catch (e) {
      console.error('poll send failed for', cid, e?.response?.body || e);
    }
  }
}

// SGT helpers (UTC+8, no DST)
const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;
function msUntilTodaySGT(hh, mm = 0, ss = 0) {
  const nowUTC = Date.now();
  const nowSGT = new Date(nowUTC + SGT_OFFSET_MS);
  const targetSGT = new Date(
    nowSGT.getFullYear(), nowSGT.getMonth(), nowSGT.getDate(), hh, mm, ss, 0
  );
  const targetUTC = targetSGT.getTime() - SGT_OFFSET_MS;
  return targetUTC - nowUTC;
}
function scheduleIfPositive(ms, fn, label = '') {
  if (ms > 0) {
    if (VERBOSE) console.log(`⏰ Scheduling ${label} in ${(ms/60000).toFixed(1)} min`);
    setTimeout(fn, ms);
  } else {
    if (VERBOSE) console.log(`⏭️ Skipping ${label} (time already passed this run)`);
  }
}

// ======= Startup =======
(async function main() {
  try {
    const me = await bot.getMe();
    SELF_ID = me.id;
    console.log(`🤖 Bot @${me.username} (ID ${me.id}) starting…`);

    // Ensure at least one target this run if CHAT_ID is set
    if (ANNOUNCE_CHAT) ensureChatTracked(ANNOUNCE_CHAT);

    try {
      await bot.deleteWebHook({ drop_pending_updates: DROP_PENDING });
      console.log(`✅ Webhook cleared. (drop_pending_updates=${DROP_PENDING})`);
    } catch (e) {
      console.warn('⚠️ deleteWebHook failed (continuing):', e?.response?.body || e);
    }

    await bot.startPolling({
      interval: 300,
      params: { timeout: 50, allowed_updates: ['message', 'callback_query'] },
    });
    console.log('📡 Polling started.');

    if (VERBOSE) console.log('ActiveChats:', [...ActiveChats]);

    // Hello
    await broadcastAwake();

    // NEW: Morning attendance poll at start of morning runs
    if (RUN_KIND === 'morning') {
      await broadcastMorningPoll();
    }

    // Relative nudges (20 & 25 minutes after start)
    setTimeout(() => { sendReminder('⏱️ 20 minutes gone. ').catch(()=>{}); }, 20 * 60 * 1000);
    setTimeout(() => { sendReminder('⏱️ 25 minutes gone. ').catch(()=>{}); }, 25 * 60 * 1000);

    // Absolute SGT “10 minutes before” announcements
    if (RUN_KIND === 'morning') {
      // 09:50 SGT (handover-10min)
      scheduleIfPositive(
        msUntilTodaySGT(9, 50, 0),
        () => sendReminder('🔔 Handover in ~10 minutes (10:00 SGT). ').catch(()=>{}),
        '09:50 SGT handover warn'
      );
    } else if (RUN_KIND === 'noon') {
      // 16:50 SGT (EOD-10min)
      scheduleIfPositive(
        msUntilTodaySGT(16, 50, 0),
        () => sendReminder('🔔 End of day in ~10 minutes (17:00 SGT). ').catch(()=>{}),
        '16:50 SGT EOD warn'
      );
    }

    // Auto-stop + short "sleeping" notice right before exit
    const durMs = DURATION_MINUTES * 60 * 1000;
    if (DURATION_MINUTES > 0) {
      const warnMs = Math.max(0, durMs - (SLEEP_WARNING_SECONDS * 1000));
      setTimeout(() => {
        sendReminder('😴 The bot is going to sleep soon. ').catch(()=>{});
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
