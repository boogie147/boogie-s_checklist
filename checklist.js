// checklist.js
// DM-only checklist + group announcements (poll + "Start Duty" button)
// ✅ Morning poll ONLY runs when RUN_KIND === "morning"
// ✅ DM checklist supports ticking items via reply-keyboard menu (one button per item)
// ✅ DM UI: Refresh, Add, Clear checks, Compact/Full view, Remove mode (removes EXTRA items only)
// ✅ /menu restores the reply keyboard (restoring + restored)
// ✅ Inline "Restore menu" fallback button in DM
// ✅ Group: bot posts "Start Duty" inline button whenever it comes online
// ✅ Before sleeping, bot reports checklist completion status to the GROUP
// ✅ Reminders at 30/45/50 minutes after start (group + DM duty user)
// ✅ NEW: /help command (DM + group)
// ✅ NEW: In DM, adding extra tasks is DENIED unless user is allowlisted (or admin in group) when ADD_REQUIRE_ALLOWLIST=true

const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");

// ===================== Hard-coded baseline checklist =====================
const BASE_ITEMS = [
  "Update ration status in COS chat for every meal",
  "Update attendance list",
  "Make sure keypress book is closed properly before HOTO",
  "Make sure all keys are accounted for in keypress",
  "Clear desk policy (inclusive of clearing of shredding tray)",
  "Ensure tidiness in office",
  "Clear trash",
  "Off all relevant switch",
];

// ===================== Config / env =====================
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN is missing (set it in GitHub/GitLab Secrets).");
  process.exit(1);
}

const VERBOSE = String(process.env.VERBOSE || "false") === "true";

// REQUIRED for your group announcements (poll + start-duty prompt + sleep summary)
const GROUP_CHAT_ID = ((process.env.CHAT_ID || "").trim()) || null;

// Useful if your CI runs multiple times/day
const RUN_KIND = String(process.env.RUN_KIND || "manual"); // morning/noon/afternoon/manual

// How long to keep bot online before auto-stop
const DURATION_MINUTES = Number(process.env.DURATION_MINUTES || 30); // 0 = no auto-stop
const SLEEP_WARNING_SECONDS = Number(process.env.SLEEP_WARNING_SECONDS || 60);

// Allowlist enforcement
const ADD_REQUIRE_ALLOWLIST = String(process.env.ADD_REQUIRE_ALLOWLIST || "true") === "true";

// Poll behavior
const SEND_MORNING_POLL = String(process.env.SEND_MORNING_POLL || "true") === "true";

// Safety
const DROP_PENDING = String(process.env.DROP_PENDING || "true") === "true";

// ===================== Bot =====================
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// ===================== Persistence =====================
const DATA_PATH = path.resolve(__dirname, "checklists.json");

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  } catch {
    const init = {};
    fs.writeFileSync(DATA_PATH, JSON.stringify(init, null, 2));
    return init;
  }
}
function saveData(obj) {
  const tmp = DATA_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, DATA_PATH);
}

let DB = loadData();

/**
 * Schema:
 * DB = {
 *   duty: { active: { userId, groupChatId, sinceIso } | null },
 *   users: {
 *     [userId]: {
 *       compact: boolean,
 *       removeMode: boolean,
 *       baseDone: boolean[],
 *       extra: [{ text, done }]
 *     }
 *   },
 *   allow: { [groupChatId]: number[] }
 * }
 */
function ensureRoot() {
  if (!DB || typeof DB !== "object") DB = {};
  if (!DB.duty) DB.duty = { active: null };
  if (!DB.users) DB.users = {};
  if (!DB.allow) DB.allow = {};
}
ensureRoot();

function getUserState(uid) {
  ensureRoot();
  if (!DB.users[uid]) {
    DB.users[uid] = {
      compact: false,
      removeMode: false,
      baseDone: BASE_ITEMS.map(() => false),
      extra: [],
    };
    saveData(DB);
  }

  const st = DB.users[uid];

  // normalize/migrate
  if (typeof st.compact !== "boolean") st.compact = false;
  if (typeof st.removeMode !== "boolean") st.removeMode = false;

  if (!Array.isArray(st.baseDone)) st.baseDone = BASE_ITEMS.map(() => false);
  if (st.baseDone.length !== BASE_ITEMS.length) {
    const old = st.baseDone;
    st.baseDone = BASE_ITEMS.map((_, i) => Boolean(old[i]));
  }

  if (!Array.isArray(st.extra)) st.extra = [];

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

// ===================== Utils =====================
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[m]));

const truncate = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s);

async function safeGetChatMemberName(chatId, userId) {
  try {
    const m = await bot.getChatMember(chatId, userId);
    const u = m?.user || {};
    return (
      [u.first_name, u.last_name].filter(Boolean).join(" ") ||
      u.username ||
      `id:${userId}`
    );
  } catch {
    return `id:${userId}`;
  }
}

async function isAdmin(chatId, userId) {
  try {
    const m = await bot.getChatMember(chatId, userId);
    return m && (m.status === "creator" || m.status === "administrator");
  } catch {
    return false;
  }
}

// Determine if a user is allowed to add/remove EXTRA tasks in DM.
// Policy:
// - If allowlist enforcement is OFF => allowed
// - If GROUP_CHAT_ID is not set => deny (cannot validate allowlist)
// - If user is admin in group => allowed
// - If user is in /allow list => allowed
async function canUserModifyExtras(uid) {
  if (!ADD_REQUIRE_ALLOWLIST) return true;
  if (!GROUP_CHAT_ID) return false;

  if (await isAdmin(GROUP_CHAT_ID, uid)) return true;
  const allow = getAllowlist(GROUP_CHAT_ID);
  return allow.includes(uid);
}

// ===================== Help text =====================
function helpText(isDm) {
  const scope = isDm ? "DM checklist" : "Group chat";
  const allowNote = ADD_REQUIRE_ALLOWLIST
    ? "Adding/removing EXTRA tasks is restricted: only /allow-listed users (or group admins) may add/remove."
    : "Allowlist enforcement is OFF: anyone can add/remove EXTRA tasks in DM.";

  return [
    `<b>Checklist Bot — Help</b>`,
    ``,
    `<b>Scope</b>: ${scope}`,
    ``,
    `<b>Core flow</b>`,
    `• Group: Bot posts <i>Start Duty</i> button whenever it comes online.`,
    `• Tap <i>Start Duty</i> → Bot DMs you the checklist.`,
    `• Group receives status reminders and a sleep summary.`,
    ``,
    `<b>DM checklist controls</b>`,
    `• Tap item buttons (#1, #2, …) to toggle ✅/⬜️`,
    `• ➕ Add — add EXTRA task (subject to allowlist)`,
    `• 🧹 Clear checks — uncheck everything`,
    `• 🗑 Remove mode — remove EXTRA tasks only`,
    `• 📋 Compact view / 📝 Full view — switch display`,
    `• 🔄 Refresh — redraw checklist`,
    ``,
    `<b>Commands</b>`,
    `• /start — start DM session + show checklist`,
    `• /help — show this help`,
    `• /menu — restore menu keyboard (use if Telegram hides it)`,
    `• /clear — clear all checks`,
    ``,
    `<b>Group admin commands</b>`,
    `• /allow — (reply to a user) allow them to add/remove EXTRA tasks in DM`,
    `• /deny — (reply to a user) revoke allowance`,
    `• /whoallowed — list allowlisted users`,
    ``,
    `<b>Automation</b>`,
    `• Morning poll: only sends when RUN_KIND="morning" (and SEND_MORNING_POLL=true).`,
    `• Run reminders: 30/45/50 min — posts checklist status to group and DM duty user.`,
    ``,
    `<b>Allowlist policy</b>`,
    `• ${allowNote}`,
  ].join("\n");
}

// ===================== Checklist stats/render =====================
function checklistStats(uid) {
  const st = getUserState(uid);
  const total = BASE_ITEMS.length + st.extra.length;
  const doneCount =
    st.baseDone.filter(Boolean).length + st.extra.filter((x) => x.done).length;
  return { total, doneCount, complete: total > 0 && doneCount === total };
}

function formatChecklist(uid) {
  const st = getUserState(uid);

  const baseLines = BASE_ITEMS.map((text, i) => {
    const done = !!st.baseDone[i];
    return `${i + 1}. ${done ? "✅" : "⬜️"} ${escapeHtml(text)}`;
  });

  const extraLines = st.extra.length
    ? st.extra.map((it, j) => {
        const idx = BASE_ITEMS.length + j + 1;
        return `${idx}. ${it.done ? "✅" : "⬜️"} ${escapeHtml(it.text)}`;
      })
    : [];

  const allLines = baseLines.concat(extraLines);

  const { total, doneCount, complete } = checklistStats(uid);
  const left = total - doneCount;

  if (st.compact) {
    return `<b>Checklist</b> — ${left}/${total} left${complete ? " ✅" : ""}`;
  }

  return `<b>Your checklist</b>\n${allLines.join("\n")}`;
}

// Button labels for item toggles (reply keyboard)
function itemButtonLabel(uid, idx1) {
  const st = getUserState(uid);
  const idx0 = idx1 - 1;

  const baseLen = BASE_ITEMS.length;
  if (idx0 >= 0 && idx0 < baseLen) {
    const done = !!st.baseDone[idx0];
    return `${done ? "✅" : "⬜️"} #${idx1}: ${truncate(BASE_ITEMS[idx0], 28)}`;
  }

  const extraIndex = idx0 - baseLen;
  if (extraIndex >= 0 && extraIndex < st.extra.length) {
    const it = st.extra[extraIndex];
    return `${it.done ? "✅" : "⬜️"} #${idx1}: ${truncate(it.text, 28)}`;
  }

  return `#${idx1}`;
}

// Reply keyboard includes item buttons so users can tap to toggle
function buildDmReplyKeyboard(uid) {
  const st = getUserState(uid);
  const total = BASE_ITEMS.length + st.extra.length;

  const rows = [
    [{ text: "➕ Add" }, { text: "🔄 Refresh" }],
    [
      { text: st.removeMode ? "✅ Done removing" : "🗑 Remove mode" },
      { text: "🧹 Clear checks" },
    ],
    [{ text: st.compact ? "📝 Full view" : "📋 Compact view" }],
  ];

  for (let i = 1; i <= total; i++) {
    rows.push([{ text: itemButtonLabel(uid, i) }]);
  }

  return {
    reply_markup: {
      keyboard: rows,
      resize_keyboard: true,
      one_time_keyboard: false,
      input_field_placeholder: "Tap an item to toggle, or use controls…",
    },
  };
}

async function sendDmChecklist(uid) {
  await bot.sendMessage(uid, formatChecklist(uid), {
    parse_mode: "HTML",
    ...buildDmReplyKeyboard(uid),
  });

  // Inline fallback in case Telegram hides reply keyboard (esp. mobile)
  await bot.sendMessage(uid, "If your menu is missing, tap below to restore it:", {
    reply_markup: {
      inline_keyboard: [[{ text: "🔧 Restore menu", callback_data: "restore_menu" }]],
    },
  });
}

function resetChecksForUser(uid) {
  const st = getUserState(uid);
  st.baseDone = BASE_ITEMS.map(() => false);
  for (const it of st.extra) it.done = false;
  saveData(DB);
}

function formatStatusLine(uid) {
  const { total, doneCount, complete } = checklistStats(uid);
  return complete ? `✅ COMPLETE (${doneCount}/${total})` : `⏳ ${doneCount}/${total} done`;
}

// ===================== Group Messages (Start Duty + Poll + Status) =====================
async function sendStartDutyPromptToGroup() {
  if (!GROUP_CHAT_ID) return;

  const active = getActiveDuty();
  let line = "Tap the button to start duty (DM checklist).";
  if (active && String(active.groupChatId) === String(GROUP_CHAT_ID)) {
    const name = await safeGetChatMemberName(GROUP_CHAT_ID, active.userId);
    line = `Current duty: ${escapeHtml(name)} — ${formatStatusLine(active.userId)}`;
  }

  await bot.sendMessage(GROUP_CHAT_ID, `🧾 <b>Duty Checklist</b>\n${line}`, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[{ text: "✅ Start Duty (DM)", callback_data: "start_duty" }]],
    },
  });
}

async function sendMorningPollToGroup() {
  if (!GROUP_CHAT_ID) return;
  await bot.sendPoll(
    GROUP_CHAT_ID,
    "Good morning commanders, please indicate whether you will be in camp for today",
    ["Yes", "No", "MA/MC", "OL", "LL", "OFF", "COS Only"],
    { is_anonymous: false, allows_multiple_answers: false }
  );
}

async function announceAwakeToGroup() {
  if (!GROUP_CHAT_ID) return;
  await bot.sendMessage(GROUP_CHAT_ID, "👋 Bot awake");
}

async function announceSleepWarningToGroup() {
  if (!GROUP_CHAT_ID) return;
  await bot.sendMessage(GROUP_CHAT_ID, "😴 Bot is going to sleep soon.");
}

async function announceSleepSummaryToGroup() {
  if (!GROUP_CHAT_ID) return;

  const active = getActiveDuty();
  if (!active || String(active.groupChatId) !== String(GROUP_CHAT_ID)) {
    await bot.sendMessage(GROUP_CHAT_ID, "😴 Bot is going to sleep. No duty user was active.");
    return;
  }

  const name = await safeGetChatMemberName(GROUP_CHAT_ID, active.userId);
  await bot.sendMessage(
    GROUP_CHAT_ID,
    `😴 Bot is going to sleep.\nDuty user: ${name} — ${formatStatusLine(active.userId)}.`
  );
}

// ===================== Reminders at 30/45/50 minutes =====================
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

  // Group reminder (minimal status)
  if (GROUP_CHAT_ID && String(active.groupChatId) === String(GROUP_CHAT_ID)) {
    try {
      const name = await safeGetChatMemberName(GROUP_CHAT_ID, dutyUid);
      await bot.sendMessage(
        GROUP_CHAT_ID,
        `⏱️ ${minMark} min — Duty: ${name} — ${formatStatusLine(dutyUid)}`
      );
    } catch (e) {
      console.error("group reminder error:", e?.response?.body || e);
    }
  }

  // DM reminder with status + checklist view
  try {
    await bot.sendMessage(
      dutyUid,
      `⏱️ ${minMark} min reminder — your status: ${formatStatusLine(dutyUid)}`
    );
    await sendDmChecklist(dutyUid);
  } catch (e) {
    if (VERBOSE) console.warn("dm reminder failed:", e?.response?.body || e);
  }
}

function scheduleRunReminders() {
  const marks = [30, 45, 50];
  for (const m of marks) {
    if (DURATION_MINUTES > 0 && m >= DURATION_MINUTES) continue;
    setTimeout(() => {
      sendRunReminder(m).catch((e) =>
        console.error("sendRunReminder error:", e?.response?.body || e)
      );
    }, m * 60 * 1000);

    if (VERBOSE) console.log(`Reminder scheduled at +${m}min`);
  }
}

// ===================== Commands =====================
const cmdRe = (name, hasArg = false) =>
  new RegExp(`^\\/${name}(?:@\\w+)?${hasArg ? "\\s+(.+)" : "\\s*$"}`, "i");

// /help (DM + group)
bot.onText(cmdRe("help"), async (msg) => {
  const isDm = msg.chat.type === "private";
  const cid = msg.chat.id;
  await bot.sendMessage(cid, helpText(isDm), { parse_mode: "HTML" });
});

// /start
bot.onText(cmdRe("start"), async (msg) => {
  const isPrivate = msg.chat.type === "private";
  const uid = msg.from?.id;
  if (!uid) return;

  if (!isPrivate) {
    await bot.sendMessage(
      msg.chat.id,
      "This bot runs checklist in DM only. Use the Start Duty button in the group message.\nSend /help for features."
    );
    return;
  }

  await bot.sendMessage(uid, "Welcome. Restoring your menu…");
  await sendDmChecklist(uid);
  await bot.sendMessage(uid, "Menu restored.\nSend /help to see all features.");
});

// /menu (DM only)
bot.onText(cmdRe("menu"), async (msg) => {
  if (msg.chat.type !== "private") return;
  const uid = msg.from?.id;
  if (!uid) return;

  await bot.sendMessage(uid, "Restoring menu…");
  await sendDmChecklist(uid);
  await bot.sendMessage(uid, "Menu restored.");
});

// /clear (DM only)
bot.onText(cmdRe("clear"), async (msg) => {
  if (msg.chat.type !== "private") return;
  const uid = msg.from?.id;
  if (!uid) return;

  resetChecksForUser(uid);
  await sendDmChecklist(uid);
});

// /allow, /deny, /whoallowed (GROUP only, admins)
bot.onText(cmdRe("allow"), async (msg) => {
  if (!GROUP_CHAT_ID || String(msg.chat.id) !== String(GROUP_CHAT_ID)) return;
  const cid = msg.chat.id;
  const caller = msg.from?.id;
  if (!caller) return;

  if (!(await isAdmin(cid, caller))) {
    await bot.sendMessage(cid, "Only admins can use /allow.");
    return;
  }
  if (!msg.reply_to_message || !msg.reply_to_message.from) {
    await bot.sendMessage(cid, "Reply to the user’s message with /allow.");
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
    { parse_mode: "HTML" }
  );
});

bot.onText(cmdRe("deny"), async (msg) => {
  if (!GROUP_CHAT_ID || String(msg.chat.id) !== String(GROUP_CHAT_ID)) return;
  const cid = msg.chat.id;
  const caller = msg.from?.id;
  if (!caller) return;

  if (!(await isAdmin(cid, caller))) {
    await bot.sendMessage(cid, "Only admins can use /deny.");
    return;
  }
  if (!msg.reply_to_message || !msg.reply_to_message.from) {
    await bot.sendMessage(cid, "Reply to the user’s message with /deny.");
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
      { parse_mode: "HTML" }
    );
  } else {
    await bot.sendMessage(cid, `User (${target.id}) was not on the allowlist.`);
  }
});

bot.onText(cmdRe("whoallowed"), async (msg) => {
  if (!GROUP_CHAT_ID || String(msg.chat.id) !== String(GROUP_CHAT_ID)) return;
  const cid = msg.chat.id;
  const allow = getAllowlist(cid);
  if (!allow.length) {
    await bot.sendMessage(cid, "No one is on the allowlist yet.");
    return;
  }
  const lines = [];
  for (const uid of allow) {
    const name = await safeGetChatMemberName(cid, uid);
    lines.push(`• ${escapeHtml(name)} (${uid})`);
  }
  await bot.sendMessage(cid, `<b>Allowlist</b>\n${lines.join("\n")}`, { parse_mode: "HTML" });
});

// ===================== Callback queries (inline buttons) =====================
bot.on("callback_query", async (q) => {
  const data = q.data;
  const fromId = q.from?.id;
  const msg = q.message;

  try { await bot.answerCallbackQuery(q.id); } catch {}

  if (!fromId) return;

  if (data === "restore_menu") {
    try {
      await bot.sendMessage(fromId, "Restoring menu…");
      await sendDmChecklist(fromId);
      await bot.sendMessage(fromId, "Menu restored.");
    } catch (e) {
      console.error("restore_menu error:", e?.response?.body || e);
    }
    return;
  }

  if (data === "start_duty") {
    const groupId = GROUP_CHAT_ID ? String(GROUP_CHAT_ID) : (msg ? String(msg.chat.id) : null);
    if (!groupId) return;

    setActiveDuty(fromId, groupId);

    try {
      const name = await safeGetChatMemberName(groupId, fromId);
      await bot.sendMessage(groupId, `✅ Duty started: ${name}. Checklist will be in DM.`);
    } catch {}

    try {
      await bot.sendMessage(fromId, "You are now on duty. Here is your checklist:");
      await sendDmChecklist(fromId);
    } catch (e) {
      try {
        await bot.sendMessage(
          groupId,
          "⚠️ I could not DM you. Please open the bot and send /start once, then tap Start Duty again."
        );
      } catch {}
      console.error("start_duty DM error:", e?.response?.body || e);
    }
    return;
  }
});

// ===================== DM message handler (reply keyboard + item toggles) =====================
bot.on("message", async (msg) => {
  if (!msg.text) return;

  // ignore commands handled elsewhere
  if (/^\/(start|help|menu|clear|allow|deny|whoallowed)\b/i.test(msg.text)) return;

  // DM-only checklist interaction
  if (msg.chat.type !== "private") return;

  const uid = msg.from?.id;
  if (!uid) return;

  const st = getUserState(uid);

  // Global buttons
  if (msg.text === "🔄 Refresh") {
    await sendDmChecklist(uid);
    return;
  }

  if (msg.text === "🧹 Clear checks") {
    resetChecksForUser(uid);
    await sendDmChecklist(uid);
    return;
  }

  if (msg.text === "📋 Compact view") {
    st.compact = true;
    saveData(DB);
    await sendDmChecklist(uid);
    return;
  }

  if (msg.text === "📝 Full view") {
    st.compact = false;
    saveData(DB);
    await sendDmChecklist(uid);
    return;
  }

  if (msg.text === "🗑 Remove mode") {
    // Remove mode affects EXTRA tasks only; still restrict entry to those who can modify extras
    if (!(await canUserModifyExtras(uid))) {
      await bot.sendMessage(uid, "🚫 You are not allowed to remove tasks. Ask an admin to /allow you in the group.");
      return;
    }
    st.removeMode = true;
    saveData(DB);
    await bot.sendMessage(uid, "Remove mode ON. Tap an EXTRA item button to delete it, or press “✅ Done removing”.");
    return;
  }

  if (msg.text === "✅ Done removing") {
    st.removeMode = false;
    saveData(DB);
    await bot.sendMessage(uid, "Remove mode OFF.");
    await sendDmChecklist(uid);
    return;
  }

  if (msg.text === "➕ Add") {
    if (!(await canUserModifyExtras(uid))) {
      await bot.sendMessage(uid, "🚫 You are not allowed to add tasks. Ask an admin to /allow you in the group.");
      return;
    }
    await bot.sendMessage(uid, "Send the extra task text:", { reply_markup: { force_reply: true } });
    return;
  }

  // Force-reply add
  if (msg.reply_to_message && /Send the extra task text:/i.test(msg.reply_to_message.text || "")) {
    if (!(await canUserModifyExtras(uid))) {
      await bot.sendMessage(uid, "🚫 You are not allowed to add tasks. Ask an admin to /allow you in the group.");
      return;
    }
    const t = msg.text.trim();
    if (!t) return;
    st.extra.push({ text: t, done: false });
    saveData(DB);
    await sendDmChecklist(uid);
    return;
  }

  // Item button press: parse "#N"
  const mm = msg.text.match(/#(\d+)/);
  if (mm) {
    const n = parseInt(mm[1], 10);
    const idx0 = n - 1;
    const baseLen = BASE_ITEMS.length;
    const extraLen = st.extra.length;

    // Base items: anyone can toggle
    if (idx0 >= 0 && idx0 < baseLen) {
      st.baseDone[idx0] = !st.baseDone[idx0];
      saveData(DB);
      await sendDmChecklist(uid);
      return;
    }

    // Extra items: toggling is allowed, removing requires permission if removeMode is on
    if (idx0 >= baseLen && idx0 < baseLen + extraLen) {
      const extraIndex = idx0 - baseLen;

      if (st.removeMode) {
        if (!(await canUserModifyExtras(uid))) {
          await bot.sendMessage(uid, "🚫 You are not allowed to remove tasks. Ask an admin to /allow you in the group.");
          return;
        }
        st.extra.splice(extraIndex, 1);
      } else {
        // toggling done is ok even if not allowlisted
        st.extra[extraIndex].done = !st.extra[extraIndex].done;
      }

      saveData(DB);
      await sendDmChecklist(uid);
      return;
    }
  }

  // Free text fallback: treat as "add extra task" BUT enforce allowlist
  const t = msg.text.trim();
  if (t) {
    if (!(await canUserModifyExtras(uid))) {
      await bot.sendMessage(uid, "🚫 You are not allowed to add tasks. Ask an admin to /allow you in the group.");
      return;
    }
    st.extra.push({ text: t, done: false });
    saveData(DB);
    await sendDmChecklist(uid);
  }
});

// ===================== Startup / Shutdown =====================
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e?.response?.body || e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e?.response?.body || e));

const HEARTBEAT = setInterval(() => {
  if (VERBOSE) console.log("…heartbeat");
}, 10_000);

async function gracefulShutdown(reason) {
  try {
    if (VERBOSE) console.log("Shutdown:", reason);
    await announceSleepSummaryToGroup();
  } catch {}
  try { clearInterval(HEARTBEAT); } catch {}
  process.exit(0);
}

(async function main() {
  try {
    const me = await bot.getMe();
    console.log(`🤖 Bot @${me.username} (ID ${me.id}) starting…`);

    if (!GROUP_CHAT_ID) {
      console.warn("⚠️ CHAT_ID is not set. Group announcements will not be sent.");
    }

    try {
      await bot.deleteWebHook({ drop_pending_updates: DROP_PENDING });
      console.log(`✅ Webhook cleared. (drop_pending_updates=${DROP_PENDING})`);
    } catch (e) {
      console.warn("⚠️ deleteWebHook failed (continuing):", e?.response?.body || e);
    }

    await bot.startPolling({
      interval: 300,
      params: { timeout: 50, allowed_updates: ["message", "callback_query"] },
    });
    console.log("📡 Polling started.");

    // When bot comes online
    if (GROUP_CHAT_ID) {
      await announceAwakeToGroup();
      await sendStartDutyPromptToGroup();

      // Poll ONLY on morning run
      if (SEND_MORNING_POLL && RUN_KIND === "morning") {
        await sendMorningPollToGroup();
      }
    }

    // Schedule run reminders at 30/45/50 minutes
    scheduleRunReminders();

    // Auto-stop
    if (DURATION_MINUTES > 0) {
      const durMs = DURATION_MINUTES * 60 * 1000;
      const warnMs = Math.max(0, durMs - (SLEEP_WARNING_SECONDS * 1000));

      if (warnMs > 0) {
        setTimeout(async () => {
          try { await announceSleepWarningToGroup(); } catch {}
        }, warnMs);
      }

      setTimeout(() => gracefulShutdown("duration elapsed"), durMs);
    } else {
      console.log("🟢 Auto-stop disabled (DURATION_MINUTES=0).");
    }
  } catch (e) {
    console.error("❌ Fatal startup error:", e?.response?.body || e);
    process.exit(1);
  }
})();

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
