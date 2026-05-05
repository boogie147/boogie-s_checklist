const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN is missing (set it in GitHub Secrets).');
  process.exit(1);
}

const VERBOSE = String(process.env.VERBOSE || 'false') === 'true';
const GROUP_CHAT_ID = ((process.env.CHAT_ID || '').trim()) || null;

const DURATION_MINUTES = Number(process.env.DURATION_MINUTES || 30);
const SLEEP_WARNING_SECONDS = Number(process.env.SLEEP_WARNING_SECONDS || 60);

const ADD_REQUIRE_ALLOWLIST = String(process.env.ADD_REQUIRE_ALLOWLIST || 'true') === 'true';
const SEND_MORNING_POLL = String(process.env.SEND_MORNING_POLL || 'true') === 'true';

const MORNING_POLL_SGT_HOUR = Number(process.env.MORNING_POLL_SGT_HOUR || 6);
const MORNING_POLL_SGT_MINUTE = Number(process.env.MORNING_POLL_SGT_MINUTE || 0);
const MORNING_POLL_WINDOW_MINUTES = Number(process.env.MORNING_POLL_WINDOW_MINUTES || 60);

const RESET_CHECKS_ON_BOOT = String(process.env.RESET_CHECKS_ON_BOOT || 'false') === 'true';
const CLEAR_ACTIVE_DUTY_ON_BOOT = String(process.env.CLEAR_ACTIVE_DUTY_ON_BOOT || 'false') === 'true';

const BOOT_ID = new Date().toISOString();

const BASE_ITEMS_PATH = process.env.BASE_ITEMS_PATH
  ? path.resolve(process.env.BASE_ITEMS_PATH)
  : path.resolve(__dirname, 'base_items.json');

function loadBaseItems() {
  const fallback = [
    'Update ration status in COS chat for every meal',
    'Update attendance list',
    'Make sure keypress book is closed properly before HOTO',
    'Make sure all keys are accounted for in keypress',
    'Clear desk policy (inclusive of clearing of shredding tray)',
    'Ensure tidiness in office',
    'Clear trash',
    'Off all relevant switch',
  ];

  try {
    if (!fs.existsSync(BASE_ITEMS_PATH)) return fallback;
    const raw = fs.readFileSync(BASE_ITEMS_PATH, 'utf8');
    const arr = JSON.parse(raw);

    if (!Array.isArray(arr) || !arr.every((x) => typeof x === 'string' && x.trim())) {
      throw new Error('base_items.json must be a JSON array of non-empty strings');
    }

    return arr.map((s) => s.trim());
  } catch (e) {
    console.warn('⚠️ Failed to load base_items.json; using fallback BASE_ITEMS. Reason:', e?.message || e);
    return fallback;
  }
}

const BASE_ITEMS = loadBaseItems();

let bot = null;
let isCosActive = () => false;
let activateCosMode = async () => {};
let exitCosMode = async () => {};

const DATA_PATH = path.resolve(__dirname, 'checklists.json');

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  } catch {
    const init = {};
    fs.writeFileSync(DATA_PATH, JSON.stringify(init, null, 2));
    return init;
  }
}

function saveData(obj) {
  const tmp = DATA_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, DATA_PATH);
}

let DB = loadData();

function ensureRoot() {
  if (!DB || typeof DB !== 'object') DB = {};
  if (!DB.duty) DB.duty = { active: null };
  if (!DB.users) DB.users = {};
  if (!DB.allow) DB.allow = {};
  if (!Array.isArray(DB.sharedExtra)) DB.sharedExtra = [];
  if (!DB.meta) DB.meta = { lastMorningPollDateSgt: null };
  if (!('lastMorningPollDateSgt' in DB.meta)) DB.meta.lastMorningPollDateSgt = null;
}

ensureRoot();

function normalizeSharedExtra() {
  ensureRoot();
  DB.sharedExtra = DB.sharedExtra
    .filter((x) => x && typeof x.text === 'string' && x.text.trim())
    .map((x) => ({ text: x.text.trim() }));
}

function migrateLegacyPerUserExtrasToShared() {
  ensureRoot();
  normalizeSharedExtra();

  let changed = false;

  for (const uid of Object.keys(DB.users)) {
    const st = DB.users[uid];
    if (!st || !Array.isArray(st.extra) || !st.extra.length) continue;

    if (!Array.isArray(st.extraDone)) st.extraDone = [];
    const oldExtra = st.extra;

    for (const item of oldExtra) {
      const text = typeof item?.text === 'string' ? item.text.trim() : '';
      if (!text) continue;

      let idx = DB.sharedExtra.findIndex((x) => x.text === text);
      if (idx === -1) {
        DB.sharedExtra.push({ text });
        idx = DB.sharedExtra.length - 1;

        for (const otherUid of Object.keys(DB.users)) {
          const ust = DB.users[otherUid];
          if (!ust) continue;
          if (!Array.isArray(ust.extraDone)) ust.extraDone = [];
          while (ust.extraDone.length < DB.sharedExtra.length - 1) ust.extraDone.push(false);
          ust.extraDone.push(false);
        }
      }

      while (st.extraDone.length < DB.sharedExtra.length) st.extraDone.push(false);
      if (item.done) st.extraDone[idx] = true;
    }

    delete st.extra;
    changed = true;
  }

  if (changed) saveData(DB);
}

migrateLegacyPerUserExtrasToShared();

function getUserState(uid) {
  ensureRoot();
  normalizeSharedExtra();

  if (!DB.users[uid]) {
    DB.users[uid] = {
      compact: false,
      removeMode: false,
      baseDone: BASE_ITEMS.map(() => false),
      extraDone: DB.sharedExtra.map(() => false),
      menuHintBootId: null,
    };
    saveData(DB);
  }

  const st = DB.users[uid];

  if (typeof st.compact !== 'boolean') st.compact = false;
  if (typeof st.removeMode !== 'boolean') st.removeMode = false;
  if (!('menuHintBootId' in st)) st.menuHintBootId = null;

  if (!Array.isArray(st.baseDone)) st.baseDone = BASE_ITEMS.map(() => false);
  if (st.baseDone.length !== BASE_ITEMS.length) {
    const old = st.baseDone;
    st.baseDone = BASE_ITEMS.map((_, i) => Boolean(old[i]));
  }

  if (!Array.isArray(st.extraDone)) st.extraDone = DB.sharedExtra.map(() => false);
  if (st.extraDone.length !== DB.sharedExtra.length) {
    const old = st.extraDone;
    st.extraDone = DB.sharedExtra.map((_, i) => Boolean(old[i]));
  }

  return st;
}

function getAllowlist(groupId) {
  ensureRoot();
  const k = String(groupId);
  if (!Array.isArray(DB.allow[k])) DB.allow[k] = [];
  return DB.allow[k];
}

function setActiveDuty(userId, groupChatId) {
  ensureRoot();
  DB.duty.active = {
    userId,
    groupChatId: String(groupChatId),
    sinceIso: new Date().toISOString(),
  };
  saveData(DB);
}

function clearActiveDuty() {
  ensureRoot();
  DB.duty.active = null;
  saveData(DB);
}

function getActiveDuty() {
  ensureRoot();
  return DB.duty.active;
}

function addSharedExtraTask(text) {
  ensureRoot();
  normalizeSharedExtra();

  const clean = String(text || '').trim();
  if (!clean) return false;
  if (DB.sharedExtra.some((x) => x.text === clean)) return false;

  DB.sharedExtra.push({ text: clean });

  for (const uid of Object.keys(DB.users)) {
    const st = getUserState(uid);
    st.extraDone.push(false);
  }

  saveData(DB);
  return true;
}

function removeSharedExtraTaskAt(extraIndex) {
  ensureRoot();
  normalizeSharedExtra();

  if (extraIndex < 0 || extraIndex >= DB.sharedExtra.length) return false;

  DB.sharedExtra.splice(extraIndex, 1);

  for (const uid of Object.keys(DB.users)) {
    const st = getUserState(uid);
    if (Array.isArray(st.extraDone)) {
      st.extraDone.splice(extraIndex, 1);
    } else {
      st.extraDone = DB.sharedExtra.map(() => false);
    }
  }

  saveData(DB);
  return true;
}

function resetChecksForUser(uid) {
  const st = getUserState(uid);
  st.baseDone = BASE_ITEMS.map(() => false);
  st.extraDone = DB.sharedExtra.map(() => false);
  st.removeMode = false;
  saveData(DB);
}

function resetAllUsersChecks() {
  ensureRoot();
  for (const uid of Object.keys(DB.users)) {
    const st = getUserState(uid);
    st.baseDone = BASE_ITEMS.map(() => false);
    st.extraDone = DB.sharedExtra.map(() => false);
    st.removeMode = false;
  }
  saveData(DB);
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[m]));

const truncate = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s);

async function safeGetChatMemberName(chatId, userId) {
  try {
    const m = await bot.getChatMember(chatId, userId);
    const u = m?.user || {};
    return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || `id:${userId}`;
  } catch {
    return `id:${userId}`;
  }
}

async function isAdmin(chatId, userId) {
  try {
    const m = await bot.getChatMember(chatId, userId);
    return m && (m.status === 'creator' || m.status === 'administrator');
  } catch {
    return false;
  }
}

async function canUserModifyExtras(uid) {
  if (!ADD_REQUIRE_ALLOWLIST) return true;
  if (!GROUP_CHAT_ID) return false;
  if (await isAdmin(GROUP_CHAT_ID, uid)) return true;
  const allow = getAllowlist(GROUP_CHAT_ID);
  return allow.includes(uid);
}

function nowSgtParts() {
  const now = new Date();
  const sgtMs = now.getTime() + 8 * 60 * 60 * 1000;
  const sgt = new Date(sgtMs);

  const yyyy = sgt.getUTCFullYear();
  const mm = String(sgt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(sgt.getUTCDate()).padStart(2, '0');
  const dateStr = `${yyyy}-${mm}-${dd}`;

  const hour = sgt.getUTCHours();
  const minute = sgt.getUTCMinutes();
  const second = sgt.getUTCSeconds();

  return { dateStr, hour, minute, second };
}

function minutesSinceSgt(h, m, targetH, targetM) {
  return h * 60 + m - (targetH * 60 + targetM);
}

function shouldSendMorningPollNow() {
  if (!SEND_MORNING_POLL) return false;

  const { hour, minute } = nowSgtParts();
  const deltaMin = minutesSinceSgt(hour, minute, MORNING_POLL_SGT_HOUR, MORNING_POLL_SGT_MINUTE);

  return deltaMin >= 0 && deltaMin < MORNING_POLL_WINDOW_MINUTES;
}

function alreadySentMorningPollToday() {
  ensureRoot();
  const { dateStr } = nowSgtParts();
  return DB.meta.lastMorningPollDateSgt === dateStr;
}

function markMorningPollSentToday() {
  ensureRoot();
  const { dateStr } = nowSgtParts();
  DB.meta.lastMorningPollDateSgt = dateStr;
  saveData(DB);
}

async function sendMenuHintOncePerBoot(uid) {
  const st = getUserState(uid);
  if (st.menuHintBootId === BOOT_ID) return;

  await bot.sendMessage(
    uid,
    'If your checklist buttons are missing or unresponsive, send /menu to restore the checklist menu.'
  );

  st.menuHintBootId = BOOT_ID;
  saveData(DB);
}

function helpText(isDm) {
  const scope = isDm ? 'DM checklist' : 'Group chat';
  const allowNote = ADD_REQUIRE_ALLOWLIST
    ? 'Adding/removing EXTRA tasks is restricted: only /allow-listed users (or group admins) may add/remove.'
    : 'Allowlist enforcement is OFF: anyone can add/remove EXTRA tasks in DM.';

  return [
    `<b>Checklist Bot — Help</b>`,
    ``,
    `<b>Scope</b>: ${scope}`,
    ``,
    `<b>Core flow</b>`,
    `• Group: Bot posts <i>Start Duty</i> button whenever it comes online.`,
    `• Tap <i>Start Duty</i> → Bot DMs you the checklist.`,
    `• Group receives status reminders and a final offline status.`,
    ``,
    `<b>DM checklist controls</b>`,
    `• Tap item buttons (#1, #2, …) to toggle ✅/⬜️`,
    `• ➕ Add — add GLOBAL EXTRA task (subject to allowlist)`,
    `• 🧹 Clear checks — uncheck your own checklist`,
    `• 🗑 Remove mode — remove GLOBAL EXTRA tasks only`,
    `• 📋 Compact view / 📝 Full view — switch display`,
    `• 🔄 Refresh — redraw checklist`,
    ``,
    `<b>Commands</b>`,
    `• /start — start DM session + show checklist`,
    `• /help — show this help`,
    `• /menu — restore menu keyboard (use if Telegram hides it)`,
    `• /clear — clear all your checks`,
    ``,
    `<b>Group admin commands</b>`,
    `• /allow — (reply to a user) allow them to add/remove GLOBAL EXTRA tasks in DM`,
    `• /deny — (reply to a user) revoke allowance`,
    `• /whoallowed — list allowlisted users`,
    ``,
    `<b>Automation</b>`,
    `• Morning poll: sends within ${MORNING_POLL_WINDOW_MINUTES} minutes after ${String(MORNING_POLL_SGT_HOUR).padStart(
      2,
      '0'
    )}:${String(MORNING_POLL_SGT_MINUTE).padStart(2, '0')} SGT (once per SGT day).`,
    `• Run reminders: 30/45/50 min — posts checklist status to group and DM duty user.`,
    ``,
    `<b>Allowlist policy</b>`,
    `• ${allowNote}`,
  ].join('\n');
}

function checklistStats(uid) {
  const st = getUserState(uid);
  const total = BASE_ITEMS.length + DB.sharedExtra.length;
  const doneCount = st.baseDone.filter(Boolean).length + st.extraDone.filter(Boolean).length;
  return { total, doneCount, complete: total > 0 && doneCount === total };
}

function formatChecklist(uid) {
  const st = getUserState(uid);

  const baseLines = BASE_ITEMS.map((text, i) => {
    const done = !!st.baseDone[i];
    return `${i + 1}. ${done ? '✅' : '⬜️'} ${escapeHtml(text)}`;
  });

  const extraLines = DB.sharedExtra.length
    ? DB.sharedExtra.map((it, j) => {
        const idx = BASE_ITEMS.length + j + 1;
        return `${idx}. ${st.extraDone[j] ? '✅' : '⬜️'} ${escapeHtml(it.text)}`;
      })
    : [];

  const allLines = baseLines.concat(extraLines);

  const { total, doneCount, complete } = checklistStats(uid);
  const left = total - doneCount;

  if (st.compact) {
    return `<b>Checklist</b> — ${left}/${total} left${complete ? ' ✅' : ''}`;
  }

  return `<b>Your checklist</b>\n${allLines.join('\n')}`;
}

function itemButtonLabel(uid, idx1) {
  const st = getUserState(uid);
  const idx0 = idx1 - 1;

  const baseLen = BASE_ITEMS.length;
  if (idx0 >= 0 && idx0 < baseLen) {
    const done = !!st.baseDone[idx0];
    return `${done ? '✅' : '⬜️'} #${idx1}: ${truncate(BASE_ITEMS[idx0], 28)}`;
  }

  const extraIndex = idx0 - baseLen;
  if (extraIndex >= 0 && extraIndex < DB.sharedExtra.length) {
    const it = DB.sharedExtra[extraIndex];
    return `${st.extraDone[extraIndex] ? '✅' : '⬜️'} #${idx1}: ${truncate(it.text, 28)}`;
  }

  return `#${idx1}`;
}

function buildDmReplyKeyboard(uid) {
  const st = getUserState(uid);
  const total = BASE_ITEMS.length + DB.sharedExtra.length;

  const rows = [
    [{ text: '➕ Add' }, { text: '🔄 Refresh' }],
    [{ text: st.removeMode ? '✅ Done removing' : '🗑 Remove mode' }, { text: '🧹 Clear checks' }],
    [{ text: st.compact ? '📝 Full view' : '📋 Compact view' }],
  ];

  for (let i = 1; i <= total; i++) {
    rows.push([{ text: itemButtonLabel(uid, i) }]);
  }

  return {
    reply_markup: {
      keyboard: rows,
      resize_keyboard: true,
      one_time_keyboard: false,
      input_field_placeholder: 'Tap an item to toggle, or use controls…',
    },
  };
}

async function sendDmChecklist(uid) {
  try {
    await sendMenuHintOncePerBoot(uid);
  } catch {}

  await bot.sendMessage(uid, formatChecklist(uid), {
    parse_mode: 'HTML',
    ...buildDmReplyKeyboard(uid),
  });
}

function formatStatusLine(uid) {
  const { total, doneCount, complete } = checklistStats(uid);
  return complete ? `✅ COMPLETE (${doneCount}/${total})` : `⏳ ${doneCount}/${total} done`;
}

async function sendStartDutyPromptToGroup() {
  if (!GROUP_CHAT_ID) return;

  const active = getActiveDuty();
  let line = 'Tap the button to start duty (DM checklist).';
  if (active && String(active.groupChatId) === String(GROUP_CHAT_ID)) {
    const name = await safeGetChatMemberName(GROUP_CHAT_ID, active.userId);
    line = `Current duty: ${escapeHtml(name)} — ${formatStatusLine(active.userId)}`;
  }

  await bot.sendMessage(GROUP_CHAT_ID, `🧾 <b>Duty Checklist</b>\n${line}`, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[{ text: '✅ Start Duty (DM)', callback_data: 'start_duty' }]],
    },
  });
}

async function sendMorningPollToGroup() {
  if (!GROUP_CHAT_ID) return;
  await bot.sendPoll(
    GROUP_CHAT_ID,
    'Good morning commanders, please indicate whether you will be in camp for today',
    ['Yes', 'No', 'MA/MC', 'OL', 'LL', 'OFF', 'COS Only'],
    { is_anonymous: false, allows_multiple_answers: false }
  );
}

async function announceAwakeToGroup() {
  if (!GROUP_CHAT_ID) return;
  await bot.sendMessage(
    GROUP_CHAT_ID,
    ['🟢 <b>COS Checklist Bot Online</b>', 'Use <b>Start Duty</b> to open your checklist in DM.'].join('\n'),
    { parse_mode: 'HTML' }
  );
}

async function announceSleepWarningToGroup() {
  if (!GROUP_CHAT_ID) return;
  await bot.sendMessage(
    GROUP_CHAT_ID,
    ['🟠 <b>COS Checklist Bot Standby</b>', 'Bot will go offline soon. Ensure your checklist is up to date.'].join(
      '\n'
    ),
    { parse_mode: 'HTML' }
  );
}

async function announceOfflineStatusToGroup(reason) {
  if (!GROUP_CHAT_ID) return;

  const active = getActiveDuty();

  if (!active || String(active.groupChatId) !== String(GROUP_CHAT_ID)) {
    await bot.sendMessage(
      GROUP_CHAT_ID,
      [
        '🔴 <b>COS Checklist Bot Offline</b>',
        'No active duty user recorded.',
        reason ? `<i>Reason:</i> ${escapeHtml(reason)}` : '',
      ].filter(Boolean).join('\n'),
      { parse_mode: 'HTML' }
    );
    return;
  }

  const name = await safeGetChatMemberName(GROUP_CHAT_ID, active.userId);
  const status = formatStatusLine(active.userId);

  await bot.sendMessage(
    GROUP_CHAT_ID,
    [
      '🔴 <b>COS Checklist Bot Offline</b>',
      `<b>Final status</b>: ${escapeHtml(name)} — ${escapeHtml(status)}`,
      'Bot is now offline. Next run will post <b>Start Duty</b> again.',
      reason ? `<i>Reason:</i> ${escapeHtml(reason)}` : '',
    ].filter(Boolean).join('\n'),
    { parse_mode: 'HTML' }
  );
}

async function sendRunReminder(minMark) {
  const active = getActiveDuty();
  if (!active || !active.userId) {
    if (GROUP_CHAT_ID) {
      try {
        await bot.sendMessage(GROUP_CHAT_ID, `⏱️ ${minMark} min — Reminder: no duty user is active.`);
      } catch {}
    }
    return;
  }

  const dutyUid = active.userId;

  if (GROUP_CHAT_ID && String(active.groupChatId) === String(GROUP_CHAT_ID)) {
    try {
      const name = await safeGetChatMemberName(GROUP_CHAT_ID, dutyUid);
      await bot.sendMessage(GROUP_CHAT_ID, `⏱️ ${minMark} min — Duty: ${name} — ${formatStatusLine(dutyUid)}`);
    } catch (e) {
      console.error('group reminder error:', e?.response?.body || e);
    }
  }

  try {
    await bot.sendMessage(dutyUid, `⏱️ ${minMark} min reminder — your status: ${formatStatusLine(dutyUid)}`);
    await sendDmChecklist(dutyUid);
  } catch (e) {
    if (VERBOSE) console.warn('dm reminder failed:', e?.response?.body || e);
  }
}

function scheduleRunReminders() {
  const marks = [30, 45, 50];
  for (const minMark of marks) {
    setTimeout(() => {
      sendRunReminder(minMark).catch((e) => console.error(`reminder ${minMark} error:`, e));
    }, minMark * 60 * 1000);
  }

  if (DURATION_MINUTES > 0) {
    setTimeout(async () => {
      try {
        await announceOfflineStatusToGroup(`Runtime reached ${DURATION_MINUTES} minutes.`);
      } catch (e) {
        console.error('offline announce error:', e?.response?.body || e);
      }
      process.exit(0);
    }, DURATION_MINUTES * 60 * 1000);
  }
}

function cmdRe(name) {
  return new RegExp(`^\\/${name}(?:@\\w+)?(?:\\s|$)`, 'i');
}

function registerChecklistHandlers(botInstance, deps = {}) {
  bot = botInstance;
  isCosActive = deps.isCosActive || (() => false);
  activateCosMode = deps.activateCosMode || (async () => {});
  exitCosMode = deps.exitCosMode || (async () => {});

  bot.onText(cmdRe('start'), async (msg) => {
    if (msg.chat.type !== 'private') return;
    const uid = msg.from?.id;
    if (!uid) return;
    await activateCosMode(uid);
    await bot.sendMessage(uid, 'You are now in COS checklist mode.');
    await sendDmChecklist(uid);
  });

  bot.onText(cmdRe('menu'), async (msg) => {
    if (msg.chat.type !== 'private') return;
    const uid = msg.from?.id;
    if (!uid) return;
    if (!isCosActive(uid)) return;
    await sendDmChecklist(uid);
  });

  bot.onText(cmdRe('help'), async (msg) => {
    const isDm = msg.chat.type === 'private';
    if (isDm) {
      const uid = msg.from?.id;
      if (!uid || !isCosActive(uid)) return;
    }
    await bot.sendMessage(msg.chat.id, helpText(isDm), { parse_mode: 'HTML' });
  });

  bot.onText(cmdRe('clear'), async (msg) => {
    if (msg.chat.type !== 'private') return;
    const uid = msg.from?.id;
    if (!uid || !isCosActive(uid)) return;
    resetChecksForUser(uid);
    await sendDmChecklist(uid);
  });

  bot.onText(cmdRe('allow'), async (msg) => {
    if (!GROUP_CHAT_ID || String(msg.chat.id) !== String(GROUP_CHAT_ID)) return;
    const cid = msg.chat.id;
    const caller = msg.from?.id;
    if (!caller) return;

    if (!(await isAdmin(cid, caller))) {
      await bot.sendMessage(cid, 'Only admins can use /allow.');
      return;
    }
    if (!msg.reply_to_message || !msg.reply_to_message.from) {
      await bot.sendMessage(cid, 'Reply to the user’s message with /allow.');
      return;
    }
    const target = msg.reply_to_message.from;
    const allow = getAllowlist(cid);
    if (!allow.includes(target.id)) {
      allow.push(target.id);
      saveData(DB);
    }
    await bot.sendMessage(
      cid,
      `✅ Allowed: ${escapeHtml(target.first_name || target.username || String(target.id))} (${target.id})`,
      { parse_mode: 'HTML' }
    );
  });

  bot.onText(cmdRe('deny'), async (msg) => {
    if (!GROUP_CHAT_ID || String(msg.chat.id) !== String(GROUP_CHAT_ID)) return;
    const cid = msg.chat.id;
    const caller = msg.from?.id;
    if (!caller) return;

    if (!(await isAdmin(cid, caller))) {
      await bot.sendMessage(cid, 'Only admins can use /deny.');
      return;
    }
    if (!msg.reply_to_message || !msg.reply_to_message.from) {
      await bot.sendMessage(cid, 'Reply to the user’s message with /deny.');
      return;
    }
    const target = msg.reply_to_message.from;
    const allow = getAllowlist(cid);
    const idx = allow.indexOf(target.id);
    if (idx >= 0) {
      allow.splice(idx, 1);
      saveData(DB);
      await bot.sendMessage(
        cid,
        `🚫 Removed from allowlist: ${escapeHtml(target.first_name || target.username || String(target.id))} (${target.id})`,
        { parse_mode: 'HTML' }
      );
    } else {
      await bot.sendMessage(cid, `User (${target.id}) was not on the allowlist.`);
    }
  });

  bot.onText(cmdRe('whoallowed'), async (msg) => {
    if (!GROUP_CHAT_ID || String(msg.chat.id) !== String(GROUP_CHAT_ID)) return;
    const cid = msg.chat.id;
    const allow = getAllowlist(cid);
    if (!allow.length) {
      await bot.sendMessage(cid, 'No one is on the allowlist yet.');
      return;
    }
    const lines = [];
    for (const uid of allow) {
      const name = await safeGetChatMemberName(cid, uid);
      lines.push(`• ${escapeHtml(name)} (${uid})`);
    }
    await bot.sendMessage(cid, `<b>Allowlist</b>\n${lines.join('\n')}`, { parse_mode: 'HTML' });
  });

  bot.on('callback_query', async (q) => {
    const data = q.data;
    const fromId = q.from?.id;
    const msg = q.message;

    try {
      await bot.answerCallbackQuery(q.id);
    } catch {}

    if (!fromId) return;

    if (data === 'start_duty') {
      const groupId = GROUP_CHAT_ID ? String(GROUP_CHAT_ID) : msg ? String(msg.chat.id) : null;
      if (!groupId) return;

      const chatId = q.message?.chat?.id;
      if (!chatId) return;

      if (!isCosActive(chatId)) return;

      const st = getUserState(chatId);
      const data = q.data || '';

      // Refresh
      if (data === 'refresh_checklist') {
        await bot.answerCallbackQuery(q.id, { text: 'Refreshing...' }).catch(() => {});
        await sendDmChecklist(chatId);
        return;
      }

      // Clear checks
      if (data === 'clear_checks') {
        resetChecksForUser(chatId);
        await bot.answerCallbackQuery(q.id, { text: 'Checks cleared.' }).catch(() => {});
        await sendDmChecklist(chatId);
        return;
      }

      // Toggle compact/full
      if (data === 'toggle_compact') {
        st.compact = !st.compact;
        saveData(DB);
        await bot.answerCallbackQuery(q.id).catch(() => {});
        await sendDmChecklist(chatId);
        return;
      }

      // Toggle remove mode
      if (data === 'toggle_remove_mode') {
        if (!(await canUserModifyExtras(chatId))) {
          await bot.answerCallbackQuery(q.id, {
            text: 'Not allowed.',
            show_alert: true,
          }).catch(() => {});
          return;
        }

        st.removeMode = !st.removeMode;
        saveData(DB);
        await bot.answerCallbackQuery(q.id).catch(() => {});
        await sendDmChecklist(chatId);
        return;
        }

      // Toggle base item: base_0, base_1, ...
      if (data.startsWith('base_')) {
        const idx = Number(data.split('_')[1]);
        if (!Number.isNaN(idx) && idx >= 0 && idx < BASE_ITEMS.length) {
          st.baseDone[idx] = !st.baseDone[idx];
          saveData(DB);
          await bot.answerCallbackQuery(q.id).catch(() => {});
          await sendDmChecklist(chatId);
          return;
        }
      }

      // Toggle extra item: extra_0, extra_1, ...
      if (data.startsWith('extra_')) {
        const idx = Number(data.split('_')[1]);
        if (!Number.isNaN(idx) && idx >= 0 && idx < DB.sharedExtra.length) {
          if (st.removeMode) {
            if (!(await canUserModifyExtras(chatId))) {
              await bot.answerCallbackQuery(q.id, {
                text: 'Not allowed.',
                show_alert: true,
              }).catch(() => {});
              return;
             }
              removeSharedExtraTaskAt(idx);
            } else {
              st.extraDone[idx] = !st.extraDone[idx];
              saveData(DB);
            }

            await bot.answerCallbackQuery(q.id).catch(() => {});
            await sendDmChecklist(chatId);
            return;
          }
      }
      setActiveDuty(fromId, groupId);
      await activateCosMode(fromId);

      try {
        const name = await safeGetChatMemberName(groupId, fromId);
        await bot.sendMessage(groupId, `✅ Duty started: ${name}. Checklist will be in DM.`);
      } catch {}

      try {
        await bot.sendMessage(fromId, 'You are now on duty. Here is your checklist:');
        await sendDmChecklist(fromId);
      } catch (e) {
        try {
          await bot.sendMessage(
            groupId,
            '⚠️ I could not DM you. Please open the bot and send /start once, then tap Start Duty again.'
          );
        } catch {}
        console.error('start_duty DM error:', e?.response?.body || e);
      }
      return;
    }
  });

  bot.on('message', async (msg) => {
    if (!msg.text) return;
    if (/^\/(start|help|menu)\b/i.test(msg.text)) return;
    if (/^\/(clear|allow|deny|whoallowed)\b/i.test(msg.text)) return;
    if (msg.chat.type !== 'private') return;

    const uid = msg.from?.id;
    if (!uid) return;
    if (!isCosActive(uid)) return;

    const st = getUserState(uid);

    if (msg.text === '🔄 Refresh') {
      await sendDmChecklist(uid);
      return;
    }

    if (msg.text === '🧹 Clear checks') {
      resetChecksForUser(uid);
      await sendDmChecklist(uid);
      return;
    }

    if (msg.text === '📋 Compact view') {
      st.compact = true;
      saveData(DB);
      await sendDmChecklist(uid);
      return;
    }

    if (msg.text === '📝 Full view') {
      st.compact = false;
      saveData(DB);
      await sendDmChecklist(uid);
      return;
    }

    if (msg.text === '🗑 Remove mode') {
      if (!(await canUserModifyExtras(uid))) {
        await bot.sendMessage(uid, '🚫 You are not allowed to remove tasks. Ask an admin to /allow you in the group.');
        return;
      }
      st.removeMode = true;
      saveData(DB);
      await bot.sendMessage(uid, 'Remove mode ON. Tap a GLOBAL EXTRA item button to delete it for everyone, or press “✅ Done removing”.');
      return;
    }

    if (msg.text === '✅ Done removing') {
      st.removeMode = false;
      saveData(DB);
      await bot.sendMessage(uid, 'Remove mode OFF.');
      await sendDmChecklist(uid);
      return;
    }

    if (msg.text === '➕ Add') {
      if (!(await canUserModifyExtras(uid))) {
        await bot.sendMessage(uid, '🚫 You are not allowed to add tasks. Ask an admin to /allow you in the group.');
        return;
      }
      await bot.sendMessage(uid, 'Send the GLOBAL extra task text:', { reply_markup: { force_reply: true } });
      return;
    }

    if (msg.reply_to_message && /Send the GLOBAL extra task text:/i.test(msg.reply_to_message.text || '')) {
      if (!(await canUserModifyExtras(uid))) {
        await bot.sendMessage(uid, '🚫 You are not allowed to add tasks. Ask an admin to /allow you in the group.');
        return;
      }

      const t = msg.text.trim();
      if (!t) return;

      const added = addSharedExtraTask(t);
      if (!added) {
        await bot.sendMessage(uid, 'Task was not added. It may already exist or be invalid.');
      }
      await sendDmChecklist(uid);
      return;
    }

    const mm = msg.text.match(/^(?:✅|⬜️)\s+#(\d+)\b/);
    if (mm) {
      const n = parseInt(mm[1], 10);
      const idx0 = n - 1;
      const baseLen = BASE_ITEMS.length;
      const extraLen = DB.sharedExtra.length;

      if (idx0 >= 0 && idx0 < baseLen) {
        st.baseDone[idx0] = !st.baseDone[idx0];
        saveData(DB);
        await sendDmChecklist(uid);
        return;
      }

      if (idx0 >= baseLen && idx0 < baseLen + extraLen) {
        const extraIndex = idx0 - baseLen;

        if (st.removeMode) {
          if (!(await canUserModifyExtras(uid))) {
            await bot.sendMessage(uid, '🚫 You are not allowed to remove tasks. Ask an admin to /allow you in the group.');
            return;
          }
          removeSharedExtraTaskAt(extraIndex);
        } else {
          st.extraDone[extraIndex] = !st.extraDone[extraIndex];
          saveData(DB);
        }

        await sendDmChecklist(uid);
        return;
      }
    }

    const t = msg.text.trim();
    if (t) {
      if (!(await canUserModifyExtras(uid))) {
        await bot.sendMessage(uid, '🚫 You are not allowed to add tasks. Ask an admin to /allow you in the group.');
        return;
      }

      const added = addSharedExtraTask(t);
      if (!added) {
        await bot.sendMessage(uid, 'Task was not added. It may already exist or be invalid.');
      }
      await sendDmChecklist(uid);
    }
  });
}

async function enterCOS(chatId) {
  if (!bot) throw new Error('Checklist module not initialized. Call registerChecklistHandlers(bot, deps) first.');
  await activateCosMode(chatId);
  await bot.sendMessage(chatId, 'You are now in COS checklist mode.');
  await sendDmChecklist(chatId);
}

async function runChecklistStartup() {
  if (!bot) throw new Error('Checklist module not initialized. Call registerChecklistHandlers(bot, deps) first.');

  console.log('PollEnv:', { SEND_MORNING_POLL });

  const me = await bot.getMe();
  console.log(`🤖 COS module ready on @${me.username} (ID ${me.id})`);

  if (!GROUP_CHAT_ID) {
    console.warn('⚠️ CHAT_ID is not set. Group announcements will not be sent.');
  }

  ensureRoot();
  normalizeSharedExtra();

  if (CLEAR_ACTIVE_DUTY_ON_BOOT) {
    clearActiveDuty();
    if (VERBOSE) console.log('Boot: active duty cleared.');
  }
  if (RESET_CHECKS_ON_BOOT) {
    resetAllUsersChecks();
    if (VERBOSE) console.log('Boot: all user checks reset.');
  }

  if (GROUP_CHAT_ID) {
    if (VERBOSE) {
      const p = nowSgtParts();
      console.log(
        `Boot SGT=${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')} target=${String(MORNING_POLL_SGT_HOUR).padStart(2, '0')}:${String(MORNING_POLL_SGT_MINUTE).padStart(2, '0')} window=${MORNING_POLL_WINDOW_MINUTES} SEND_MORNING_POLL=${SEND_MORNING_POLL} lastMorningPollDateSgt=${DB?.meta?.lastMorningPollDateSgt}`
      );
    }

    try {
      await announceAwakeToGroup();
    } catch (e) {
      console.warn('⚠️ announceAwakeToGroup failed:', e?.response?.body || e);
    }

    try {
      await sendStartDutyPromptToGroup();
    } catch (e) {
      console.warn('⚠️ sendStartDutyPromptToGroup failed:', e?.response?.body || e);
    }

    const shouldSend = shouldSendMorningPollNow();
    const alreadySent = alreadySentMorningPollToday();

    if (shouldSend && !alreadySent) {
      try {
        await sendMorningPollToGroup();
        markMorningPollSentToday();
      } catch (e) {
        console.warn('⚠️ sendMorningPollToGroup failed:', e?.response?.body || e);
      }
    }
  }

  scheduleRunReminders();
  if (DURATION_MINUTES > 0) {
    const durMs = DURATION_MINUTES * 60 * 1000;
    const warnMs = Math.max(0, durMs - SLEEP_WARNING_SECONDS * 1000);
    if (warnMs > 0) {
      setTimeout(async () => {
        try {
          await announceSleepWarningToGroup();
        } catch {}
      }, warnMs);
    }
  }
}

module.exports = {
  registerChecklistHandlers,
  enterCOS,
  runChecklistStartup,
};
