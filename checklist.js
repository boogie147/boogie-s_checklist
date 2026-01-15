// checklist.js (DM-only checklist, group-only announcements)
// Requires: node-telegram-bot-api
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN is missing (set it in CI/CD secrets).');
  process.exit(1);
}

// ===== Config =====
const VERBOSE = String(process.env.VERBOSE || 'false') === 'true';

// MAIN GROUP CHAT ID (where announcements/polls go)
const ANNOUNCE_CHAT = ((process.env.CHAT_ID || '').trim()) || null;
if (!ANNOUNCE_CHAT) {
  console.error('❌ CHAT_ID (main group chat id) is missing. Set CHAT_ID in secrets.');
  process.exit(1);
}

// How long this run stays online, then exits
const DURATION_MINUTES = Number(process.env.DURATION_MINUTES || 30); // 0 = no auto-stop
const SLEEP_WARNING_SECONDS = Number(process.env.SLEEP_WARNING_SECONDS || 60); // warn before sleep

// Allowlist for who can modify checklist (in DM)
const ADD_REQUIRE_ALLOWLIST = String(process.env.ADD_REQUIRE_ALLOWLIST || 'true') === 'true';

// On startup, delete webhook + optionally drop pending
const DROP_PENDING = String(process.env.DROP_PENDING || 'true') === 'true';

// Default compact view in DM
const DEFAULT_COMPACT = String(process.env.COMPACT || 'false') === 'true';

// Optional: set RUN_KIND=morning/noon/afternoon to control “morning behaviors”
const RUN_KIND = String(process.env.RUN_KIND || '').trim().toLowerCase();

// ===== Bot init =====
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
 * Storage model:
 * DB.meta = { version: 2 }
 * DB.group = {
 *   [groupId]: {
 *     items: [{text, done}],
 *     allow: [userId...],
 *     duty: { userId, dmChatId, name, startedAtIso },
 *     removeMode: boolean,
 *     compact: boolean
 *   }
 * }
 */
if (!DB.meta) DB.meta = { version: 2 };
if (!DB.group) DB.group = {};

const GROUP_ID = String(ANNOUNCE_CHAT);

// ===== Utilities =====
const escapeHtml = (s) => String(s || '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const truncate = (s,n)=> s && s.length>n ? s.slice(0,n-1)+'…' : s;

function nowIso() { return new Date().toISOString(); }

function getGroupState(groupId = GROUP_ID) {
  if (!DB.group[groupId]) {
    DB.group[groupId] = {
      items: [],
      allow: [],
      duty: null,
      removeMode: false,
      compact: DEFAULT_COMPACT
    };
    saveData(DB);
  }
  const st = DB.group[groupId];
  if (!Array.isArray(st.items)) st.items = [];
  if (!Array.isArray(st.allow)) st.allow = [];
  if (typeof st.removeMode !== 'boolean') st.removeMode = false;
  if (typeof st.compact !== 'boolean') st.compact = DEFAULT_COMPACT;
  return st;
}

function getDuty(groupId = GROUP_ID) {
  const st = getGroupState(groupId);
  return st.duty || null;
}

function setDuty(groupId, dutyObjOrNull) {
  const st = getGroupState(groupId);
  st.duty = dutyObjOrNull;
  saveData(DB);
}

function getItems(groupId = GROUP_ID) {
  return getGroupState(groupId).items;
}

function getAllow(groupId = GROUP_ID) {
  return getGroupState(groupId).allow;
}

function isRemoveMode(groupId = GROUP_ID) {
  return getGroupState(groupId).removeMode;
}
function setRemoveMode(groupId, on) {
  getGroupState(groupId).removeMode = !!on;
  saveData(DB);
}
function isCompact(groupId = GROUP_ID) {
  return getGroupState(groupId).compact;
}
function setCompact(groupId, on) {
  getGroupState(groupId).compact = !!on;
  saveData(DB);
}

function isAllDone(items) {
  return items.length > 0 && items.every(x => x.done);
}

function renderLines(items) {
  return items.length
    ? items.map((it,i)=> `${i+1}. ${it.done?'✅':'⬜️'} ${escapeHtml(it.text)}`).join('\n')
    : 'No items yet. Use the buttons below or /add <task>.';
}

function renderHeader(items) {
  const total = items.length;
  const done = items.filter(x => x.done).length;
  const left = total - done;
  return `<b>Checklist</b> — ${total ? `${left}/${total} left${left===0?' ✅':''}` : 'empty'}`;
}

// Each item button label (DM-friendly)
function itemButtonLabel(it, i) {
  return `${it.done ? '✅' : '⬜️'} #${i+1}: ${truncate(it.text, 28)}`;
}

// Reply keyboard for DM checklist controls
function buildReplyKeyboard(groupId = GROUP_ID) {
  const items = getItems(groupId);
  const rows = [
    [ { text:'➕ Add' }, { text:'🔄 Refresh' } ],
    [ { text: isRemoveMode(groupId) ? '✅ Done removing' : '🗑 Remove mode' }, { text:'🧹 Clear checks' } ],
    [ { text: isCompact(groupId) ? '📝 Full view' : '📋 Compact view' } ],
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

// Send list in DM only
async function sendListInteractiveDM(dmChatId, groupId = GROUP_ID) {
  const items = getItems(groupId);
  const body = isCompact(groupId)
    ? renderHeader(items)
    : `<b>Your checklist</b>\n${renderLines(items)}`;

  return bot.sendMessage(dmChatId, body, { parse_mode:'HTML', ...buildReplyKeyboard(groupId) });
}

function uncheckAll(groupId = GROUP_ID) {
  const items = getItems(groupId);
  let changed = false;
  for (const it of items) { if (it.done) { it.done = false; changed = true; } }
  if (changed) saveData(DB);
  return changed;
}

// ===== Permissions =====
async function isAdmin(chatId, userId) {
  try {
    const m = await bot.getChatMember(chatId, userId);
    return m && (m.status === 'creator' || m.status === 'administrator');
  } catch { return false; }
}

// In this model, modifications occur in DM, but permission is tied to the GROUP allowlist/admins.
async function canUserModifyDutyChecklist(userId) {
  if (!userId) return false;

  // Duty user is always allowed
  const duty = getDuty(GROUP_ID);
  if (duty && duty.userId === userId) return true;

  // Group admins allowed
  if (await isAdmin(GROUP_ID, userId)) return true;

  // Allowlist if enabled
  if (!ADD_REQUIRE_ALLOWLIST) return true;
  return getAllow(GROUP_ID).includes(userId);
}

function formatUser(u) {
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || `id:${u.id}`;
  return `${escapeHtml(name)} (${u.id})`;
}

// ===== Group announcements =====
let SELF_USERNAME = null;

function dutyStartLink() {
  // Deep link opens DM and sends /start duty_<groupId>
  // groupId can be negative; Telegram start payload is limited, but negative sign is OK in practice.
  // We’ll encode it safely.
  const payload = `duty_${encodeURIComponent(GROUP_ID)}`;
  return `https://t.me/${SELF_USERNAME}?start=${payload}`;
}

async function announceAwakeToGroup() {
  await bot.sendMessage(GROUP_ID, '👋 Bot is awake.');
}

async function sendDailyPollToGroup() {
  await bot.sendPoll(
    GROUP_ID,
    'Good morning commanders, please indicate whether you will be in camp for today',
    ['Yes', 'No', 'MA/MC', 'OL', 'LL', 'OFF'],
    {
      is_anonymous: false,
      allows_multiple_answers: false
    }
  );
}

async function postStartDutyButtonToGroup() {
  // Must know bot username for deep link
  if (!SELF_USERNAME) return;

  const link = dutyStartLink();
  await bot.sendMessage(
    GROUP_ID,
    '🫡 Duty for today: click the button below to start your DM checklist.',
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Start Duty (DM)', url: link }]
        ]
      }
    }
  );
}

async function announceSleepStatusToGroup() {
  const st = getGroupState(GROUP_ID);
  const duty = st.duty;
  const items = st.items || [];
  const total = items.length;
  const done = items.filter(x => x.done).length;

  let statusLine;
  if (!duty) {
    statusLine = 'No duty user was started during this run.';
  } else if (total === 0) {
    statusLine = `Duty user: ${escapeHtml(duty.name || `id:${duty.userId}`)} — checklist is empty.`;
  } else if (done === total) {
    statusLine = `Duty user: ${escapeHtml(duty.name || `id:${duty.userId}`)} — ✅ checklist COMPLETE (${done}/${total}).`;
  } else {
    statusLine = `Duty user: ${escapeHtml(duty.name || `id:${duty.userId}`)} — ⚠️ checklist INCOMPLETE (${done}/${total}).`;
  }

  await bot.sendMessage(GROUP_ID, `😴 Bot is going to sleep.\n${statusLine}`, { parse_mode: 'HTML' });
}

// ===== Duty assignment via DM deep-link =====
function parseStartPayload(text) {
  // /start duty_<groupId>
  const m = text.match(/^\/start(?:@\w+)?\s+(.+)\s*$/i);
  return m ? m[1].trim() : '';
}

async function assignDutyFromDM(msg, groupIdStr) {
  const uid = msg.from?.id;
  const dmChatId = msg.chat.id;
  if (!uid) return;

  // Optional safety: only allow assignment if user is in group
  // (Telegram may throw if bot cannot see membership; we’ll best-effort.)
  try {
    await bot.getChatMember(GROUP_ID, uid);
  } catch {
    await bot.sendMessage(dmChatId, '🚫 I cannot confirm you are in the group. Please click the “Start Duty” button from the group chat.');
    return;
  }

  const displayName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ')
    || msg.from?.username
    || `id:${uid}`;

  setDuty(GROUP_ID, {
    userId: uid,
    dmChatId,
    name: displayName,
    startedAtIso: nowIso()
  });

  // DM confirmation + show checklist
  await bot.sendMessage(dmChatId, `✅ Duty started.\nThis checklist is DM-only. Use the keyboard below.`, { parse_mode: 'HTML' });
  await sendListInteractiveDM(dmChatId, GROUP_ID);

  // Group confirmation (minimal)
  await bot.sendMessage(GROUP_ID, `✅ Duty started by: <b>${escapeHtml(displayName)}</b>. Checklist is in DM.`, { parse_mode: 'HTML' });
}

function requireDutyDM(msg) {
  const duty = getDuty(GROUP_ID);
  if (!duty) return { ok: false, reason: 'No duty user has started yet. Click “Start Duty (DM)” in the group.' };
  if (msg.chat.type !== 'private') return { ok: false, reason: 'Checklist is DM-only. Please use DM.' };
  if (duty.dmChatId !== msg.chat.id) return { ok: false, reason: 'You are not the active duty user. Click “Start Duty (DM)” in the group to take duty.' };
  return { ok: true, duty };
}

// ===== Logging & safety =====
process.on('unhandledRejection', e => console.error('unhandledRejection:', e?.response?.body || e));
process.on('uncaughtException',  e => console.error('uncaughtException:', e?.response?.body || e));
const HEARTBEAT = setInterval(() => { if (VERBOSE) console.log('…heartbeat'); }, 10_000);

// ===== Commands (DM-focused) =====

// /start
bot.onText(cmdRe('start', true), async (msg, m) => {
  // If started with payload, handle duty assignment
  const payload = (m && m[1]) ? String(m[1]).trim() : '';
  if (msg.chat.type === 'private' && payload.startsWith('duty_')) {
    const encodedGroup = payload.slice('duty_'.length);
    const groupId = decodeURIComponent(encodedGroup);
    if (String(groupId) !== String(GROUP_ID)) {
      await bot.sendMessage(msg.chat.id, '⚠️ This duty link is not for the configured group. Please use the button from the correct group chat.');
      return;
    }
    await assignDutyFromDM(msg, groupId);
    return;
  }

  // Default /start behavior
  if (msg.chat.type === 'private') {
    await bot.sendMessage(
      msg.chat.id,
      '👋 Hello. This bot uses DM for checklist.\nTo begin, click “Start Duty (DM)” in the group chat.',
    );
    return;
  }

  // In group: do not spam checklist; just show the start-duty button
  await bot.sendMessage(GROUP_ID, 'Checklist is DM-only. Use the button to start duty in DM.');
  await postStartDutyButtonToGroup();
});

// /menu (DM) – re-send keyboard (menu recovery)
bot.onText(cmdRe('menu'), async (msg) => {
  if (msg.chat.type !== 'private') return;
  const dutyCheck = requireDutyDM(msg);
  if (!dutyCheck.ok) {
    await bot.sendMessage(msg.chat.id, dutyCheck.reason);
    return;
  }
  await bot.sendMessage(msg.chat.id, '🔁 Restoring menu…');
  await sendListInteractiveDM(msg.chat.id, GROUP_ID);
});

// /list (DM)
bot.onText(cmdRe('list'), async (msg) => {
  if (msg.chat.type !== 'private') return;
  const dutyCheck = requireDutyDM(msg);
  if (!dutyCheck.ok) { await bot.sendMessage(msg.chat.id, dutyCheck.reason); return; }
  await sendListInteractiveDM(msg.chat.id, GROUP_ID);
});

// /add <task> (DM)
bot.onText(cmdRe('add', true), async (msg, m) => {
  if (msg.chat.type !== 'private') return;
  const dutyCheck = requireDutyDM(msg);
  if (!dutyCheck.ok) { await bot.sendMessage(msg.chat.id, dutyCheck.reason); return; }

  const uid = msg.from?.id;
  if (!(await canUserModifyDutyChecklist(uid))) {
    await bot.sendMessage(msg.chat.id, '🚫 You are not allowed to add tasks.');
    return;
  }

  const text = (m[1] || '').trim();
  if (!text) { await bot.sendMessage(msg.chat.id, 'Usage: /add <task>'); return; }

  getItems(GROUP_ID).push({ text, done:false });
  saveData(DB);
  await sendListInteractiveDM(msg.chat.id, GROUP_ID);
});

// /done <n> (DM)
bot.onText(cmdRe('done', true), async (msg, m) => {
  if (msg.chat.type !== 'private') return;
  const dutyCheck = requireDutyDM(msg);
  if (!dutyCheck.ok) { await bot.sendMessage(msg.chat.id, dutyCheck.reason); return; }

  const i = parseInt(m[1],10)-1;
  const items = getItems(GROUP_ID);
  if (i>=0 && i<items.length) {
    items[i].done = true;
    saveData(DB);
    await sendListInteractiveDM(msg.chat.id, GROUP_ID);
  } else {
    await bot.sendMessage(msg.chat.id, 'Usage: /done <number>');
  }
});

// /remove <n> (DM)
bot.onText(cmdRe('remove', true), async (msg, m) => {
  if (msg.chat.type !== 'private') return;
  const dutyCheck = requireDutyDM(msg);
  if (!dutyCheck.ok) { await bot.sendMessage(msg.chat.id, dutyCheck.reason); return; }

  const uid = msg.from?.id;
  if (!(await canUserModifyDutyChecklist(uid))) {
    await bot.sendMessage(msg.chat.id, '🚫 You are not allowed to remove tasks.');
    return;
  }

  const i = parseInt(m[1],10)-1;
  const items = getItems(GROUP_ID);
  if (i>=0 && i<items.length) {
    items.splice(i,1);
    saveData(DB);
    await sendListInteractiveDM(msg.chat.id, GROUP_ID);
  } else {
    await bot.sendMessage(msg.chat.id, 'Usage: /remove <number>');
  }
});

// /clear (DM) – uncheck all
bot.onText(cmdRe('clear'), async (msg) => {
  if (msg.chat.type !== 'private') return;
  const dutyCheck = requireDutyDM(msg);
  if (!dutyCheck.ok) { await bot.sendMessage(msg.chat.id, dutyCheck.reason); return; }

  uncheckAll(GROUP_ID);
  await sendListInteractiveDM(msg.chat.id, GROUP_ID);
});

// Allowlist admin commands are done in the GROUP (reply-to-user), same as your original flow.
// We keep them group-side so admins can manage it in group without needing DM.
bot.onText(cmdRe('allow'), async (msg) => {
  if (String(msg.chat.id) !== String(GROUP_ID)) return; // only in main group
  if (!(await isAdmin(GROUP_ID, msg.from.id))) return bot.sendMessage(GROUP_ID, 'Only admins can use /allow.');
  if (!msg.reply_to_message || !msg.reply_to_message.from) return bot.sendMessage(GROUP_ID, 'Reply to the user’s message with /allow.');
  const target = msg.reply_to_message.from;
  const allow = getAllow(GROUP_ID);
  if (!allow.includes(target.id)) { allow.push(target.id); saveData(DB); }
  await bot.sendMessage(GROUP_ID, `✅ Allowed: ${formatUser(target)}`, { parse_mode:'HTML' });
});

bot.onText(cmdRe('deny'), async (msg) => {
  if (String(msg.chat.id) !== String(GROUP_ID)) return;
  if (!(await isAdmin(GROUP_ID, msg.from.id))) return bot.sendMessage(GROUP_ID, 'Only admins can use /deny.');
  if (!msg.reply_to_message || !msg.reply_to_message.from) return bot.sendMessage(GROUP_ID, 'Reply to the user’s message with /deny.');
  const target = msg.reply_to_message.from;
  const allow = getAllow(GROUP_ID);
  const idx = allow.indexOf(target.id);
  if (idx >= 0) { allow.splice(idx, 1); saveData(DB); await bot.sendMessage(GROUP_ID, `🚫 Removed from allowlist: ${formatUser(target)}`, { parse_mode:'HTML' }); }
  else { await bot.sendMessage(GROUP_ID, `${formatUser(target)} was not on the allowlist.`, { parse_mode:'HTML' }); }
});

bot.onText(cmdRe('whoallowed'), async (msg) => {
  if (String(msg.chat.id) !== String(GROUP_ID)) return;
  const allow = getAllow(GROUP_ID);
  if (allow.length === 0) return bot.sendMessage(GROUP_ID, 'No one is on the allowlist yet.');
  const lines = [];
  for (const uid of allow) {
    try {
      const m = await bot.getChatMember(GROUP_ID, uid);
      const u = m.user || { id: uid };
      lines.push(`• ${formatUser(u)}`);
    } catch {
      lines.push(`• id:${uid}`);
    }
  }
  await bot.sendMessage(GROUP_ID, `<b>Allowlist</b>\n${lines.join('\n')}`, { parse_mode:'HTML' });
});

// ===== DM message handler (reply keyboard buttons + free text) =====
bot.on('message', async (msg) => {
  if (!msg.text) return;

  // Ignore bot commands handled by onText
  if (/^\/(start|menu|add|list|done|remove|clear|allow|deny|whoallowed)/i.test(msg.text)) return;

  // Only process DM for checklist interactions
  if (msg.chat.type !== 'private') return;

  const dutyCheck = requireDutyDM(msg);
  if (!dutyCheck.ok) {
    // In DM, gently instruct
    await bot.sendMessage(msg.chat.id, dutyCheck.reason);
    return;
  }

  const uid = msg.from?.id;

  // Global buttons
  if (msg.text === '🔄 Refresh') { await sendListInteractiveDM(msg.chat.id, GROUP_ID); return; }

  if (msg.text === '🧹 Clear checks') {
    uncheckAll(GROUP_ID);
    await sendListInteractiveDM(msg.chat.id, GROUP_ID);
    return;
  }

  if (msg.text === '📋 Compact view') {
    setCompact(GROUP_ID, true);
    await sendListInteractiveDM(msg.chat.id, GROUP_ID);
    return;
  }
  if (msg.text === '📝 Full view') {
    setCompact(GROUP_ID, false);
    await sendListInteractiveDM(msg.chat.id, GROUP_ID);
    return;
  }

  if (msg.text === '🗑 Remove mode') {
    if (!(await canUserModifyDutyChecklist(uid))) { await bot.sendMessage(msg.chat.id, '🚫 You are not allowed to remove tasks.'); return; }
    setRemoveMode(GROUP_ID, true);
    await bot.sendMessage(msg.chat.id, 'Remove mode ON. Tap any item button to delete it, or press “✅ Done removing”.');
    return;
  }
  if (msg.text === '✅ Done removing') {
    setRemoveMode(GROUP_ID, false);
    await bot.sendMessage(msg.chat.id, 'Remove mode OFF.');
    await sendListInteractiveDM(msg.chat.id, GROUP_ID);
    return;
  }

  if (msg.text === '➕ Add') {
    await bot.sendMessage(msg.chat.id, 'Send the task text:', { reply_markup: { force_reply: true } });
    return;
  }

  // Add via force-reply
  if (msg.reply_to_message && /Send the task text:/.test(msg.reply_to_message.text || '')) {
    if (!(await canUserModifyDutyChecklist(uid))) { await bot.sendMessage(msg.chat.id, '🚫 You are not allowed to add tasks.'); return; }
    const t = msg.text.trim(); if (!t) return;
    getItems(GROUP_ID).push({ text:t, done:false });
    saveData(DB);
    await sendListInteractiveDM(msg.chat.id, GROUP_ID);
    return;
  }

  // Item buttons: match "#N"
  const m = msg.text.match(/#(\d+)/);
  if (m) {
    const n = parseInt(m[1], 10) - 1;
    const items = getItems(GROUP_ID);
    if (n >= 0 && n < items.length) {
      if (isRemoveMode(GROUP_ID)) {
        if (!(await canUserModifyDutyChecklist(uid))) { await bot.sendMessage(msg.chat.id, '🚫 You are not allowed to remove tasks.'); return; }
        items.splice(n, 1);
        saveData(DB);
      } else {
        items[n].done = !items[n].done;
        saveData(DB);
      }
      await sendListInteractiveDM(msg.chat.id, GROUP_ID);
      return;
    }
  }

  // Free text add fallback
  if (!(await canUserModifyDutyChecklist(uid))) { await bot.sendMessage(msg.chat.id, '🚫 You are not allowed to add tasks.'); return; }
  const t = msg.text.trim(); if (!t) return;
  getItems(GROUP_ID).push({ text:t, done:false });
  saveData(DB);
  await sendListInteractiveDM(msg.chat.id, GROUP_ID);
});

// ===== Startup / Timed behavior =====
async function sendReminderDMOnly(text) {
  const duty = getDuty(GROUP_ID);
  if (!duty || !duty.dmChatId) return;
  try {
    await bot.sendMessage(duty.dmChatId, text);
    await sendListInteractiveDM(duty.dmChatId, GROUP_ID);
  } catch (e) {
    console.warn('DM reminder failed:', e?.response?.body || e);
  }
}

async function sendSleepWarningGroup() {
  try {
    await bot.sendMessage(GROUP_ID, '😴 Bot is going to sleep soon.');
  } catch {}
}

(async function main(){
  try {
    const me = await bot.getMe();
    SELF_USERNAME = me.username;
    console.log(`🤖 Bot @${me.username} (ID ${me.id}) starting…`);

    // Ensure group state exists
    getGroupState(GROUP_ID);

    try {
      await bot.deleteWebHook({ drop_pending_updates: DROP_PENDING });
      console.log(`✅ Webhook cleared. (drop_pending_updates=${DROP_PENDING})`);
    } catch (e) {
      console.warn('⚠️ deleteWebHook failed (continuing):', e?.response?.body || e);
    }

    await bot.startPolling({
      interval: 300,
      params: {
        timeout: 50,
        // We need messages for DM + group commands; no callback_query required (we use URL deep link)
        allowed_updates: ['message']
      },
    });
    console.log('📡 Polling started.');

    // Announce awake in group
    await announceAwakeToGroup();

    // Morning: poll + start-duty button
    // If your CI starts the bot at 06:00 SGT, this triggers immediately.
    // If you want it ONLY for morning runs, set RUN_KIND=morning in CI.
    const shouldDoMorning = !RUN_KIND || RUN_KIND === 'morning';
    if (shouldDoMorning) {
      await sendDailyPollToGroup();
      await postStartDutyButtonToGroup();
    } else {
      // still provide duty button when not morning, but do not poll
      await postStartDutyButtonToGroup();
    }

    // Optional: your 20/25 min nudges should go only to duty user in DM
    setTimeout(() => sendReminderDMOnly('⏱️ 20 minutes gone.'), 20 * 60 * 1000);
    setTimeout(() => sendReminderDMOnly('⏱️ 25 minutes gone.'), 25 * 60 * 1000);

    // Auto-stop
    if (DURATION_MINUTES > 0) {
      const durMs = DURATION_MINUTES * 60 * 1000;
      const warnMs = Math.max(0, durMs - (SLEEP_WARNING_SECONDS * 1000));

      if (warnMs > 0) {
        setTimeout(() => {
          console.log('⏰ Sleep warning firing…');
          sendSleepWarningGroup();
        }, warnMs);
      }

      setTimeout(async () => {
        console.log(`⏱️ ${DURATION_MINUTES} minutes elapsed — stopping bot.`);
        // Before exiting, post group completion status
        try { await announceSleepStatusToGroup(); } catch {}
        clearInterval(HEARTBEAT);
        try { await bot.stopPolling(); } catch {}
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
process.on('SIGTERM', async ()=> {
  try { await announceSleepStatusToGroup(); } catch {}
  clearInterval(HEARTBEAT);
  process.exit(0);
});
process.on('SIGINT', async ()=> {
  try { await announceSleepStatusToGroup(); } catch {}
  clearInterval(HEARTBEAT);
  process.exit(0);
});
