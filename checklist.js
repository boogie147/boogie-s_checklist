// checklist.js
// DM-only checklist + group announcements (poll + "Start Duty" button)
// - Group chat: bot posts "Start Duty" inline button whenever it comes online (and optionally morning poll)
// - Duty user clicks button -> bot DMs them and shows reply-keyboard checklist UI
// - Checklist items are HARD-CODED (baseline) + optional per-user extra items (added via DM)
// - DM UI supports: Refresh, Add, Clear checks, Compact/Full view, Remove mode (removes EXTRA items only)
// - /menu command restores the reply keyboard (and tells user it is restoring)
// - Inline "Restore menu" fallback button in DM in case Telegram hides the reply keyboard
// - Before sleeping, bot reports checklist completion status to the GROUP
// - NEW: Checklist items are tappable via the reply-keyboard (one button per item)

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
// Put your group chat id here as env var. Example: -1001234567890
const GROUP_CHAT_ID = ((process.env.CHAT_ID || "").trim()) || null;

// Optional run kind (useful if your CI runs multiple times/day)
const RUN_KIND = String(process.env.RUN_KIND || "manual"); // e.g., morning/noon/afternoon/manual

// How long to keep bot online before auto-stop. (GitHub Actions often sets this)
const DURATION_MINUTES = Number(process.env.DURATION_MINUTES || 30); // 0 = no auto-stop
const SLEEP_WARNING_SECONDS = Number(process.env.SLEEP_WARNING_SECONDS || 60); // warn before sleep

// Permissions
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
 * Schema (kept intentionally simple):
 * DB = {
 *   duty: { active: { userId, groupChatId, sinceIso } | null },
 *   users: {
 *     [userId]: {
 *       compact: boolean,
 *       removeMode: boolean,
 *       baseDone: boolean[],         // same length as BASE_ITEMS
 *       extra: [{ text, done }],     // per-user extra tasks (optional)
 *     }
 *   },
 *   allow: { [groupChatId]: number[] } // allowlist for adding/removing extras
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

  // migrate/normalize
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
    const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || `id:${userId}`;
    return name;
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

// In group: allow add/remove extras only if admin or allowlisted (or allowlist disabled)
async function canUserModifyExtrasInGroup(chatId, msg) {
  const uid = msg.from?.id;
  if (!uid) return false;
  if (await isAdmin(chatId, uid)) return true;
  if (!ADD_REQUIRE_ALLOWLIST) return true;
  return getAllowlist(chatId).includes(uid);
}

// ===================== DM Checklist Rendering =====================
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

  const all = baseLines.concat(extraLines);

  const total = BASE_ITEMS.length + st.extra.length;
  const doneCount =
    st.baseDone.filter(Boolean).length + st.extra.filter((x) => x.done).length;
  const left = total - doneCount;

  if (st.compact) {
    return `<b>Checklist</b> — ${left}/${total} left${left === 0 ? " ✅" : ""}`;
  }

  return `<b>Your checklist</b>\n${all.join("\n")}`;
}

// Button label for each item in the reply keyboard (tap-to-toggle)
function itemButtonLabel(done, number, text) {
  return `${done ? "✅" : "⬜️"} #${number}: ${truncate(String(text), 28)}`;
}

function buildDmReplyKeyboard(uid) {
  const st = getUserState(uid);

  const rows = [
    [{ text: "➕ Add" }, { text: "🔄 Refresh" }],
    [{ text: st.removeMode ? "✅ Done removing" : "🗑 Remove mode" }, { text: "🧹 Clear checks" }],
    [{ text: st.compact ? "📝 Full view" : "📋 Compact view" }],
  ];

  // NEW: item buttons (base + extra), one per row to keep mobile-friendly
  // Base
  for (let i = 0; i < BASE_ITEMS.length; i++) {
    rows.push([{ text: itemButtonLabel(!!st.baseDone[i], i + 1, BASE_ITEMS[i]) }]);
  }
  // Extra
  for (let j = 0; j < st.extra.length; j++) {
    const n = BASE_ITEMS.length + j + 1;
    rows.push([{ text: itemButtonLabel(!!st.extra[j].done, n, st.extra[j].text) }]);
  }

  return {
    reply_markup: {
      keyboard: rows,
      resize_keyboard: true,
      one_time_keyboard: false,
      input_field_placeholder: "Tap a button or type a task…",
    },
  };
}

async function sendDmChecklist(uid) {
  await bot.sendMessage(uid, formatChecklist(uid), {
    parse_mode: "HTML",
    ...buildDmReplyKeyboard(uid),
  });

  // Inline fallback in case Telegram hides reply keyboard on mobile/desktop
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

function checklistStats(uid) {
  const st = getUserState(uid);
  const total = BASE_ITEMS.length + st.extra.length;
  const doneCount = st.baseDone.filter(Boolean).length + st.extra.filter((x) => x.done).length;
  return { total, doneCount, complete: total > 0 && doneCount === total };
}

// ===================== Group Messages (Start Duty + Poll + Status) =====================
async function sendStartDutyPromptToGroup() {
  if (!GROUP_CHAT_ID) return;

  const active = getActiveDuty();
  let line = "Tap the button to start duty (DM checklist).";
  if (active && String(active.groupChatId) === String(GROUP_CHAT_ID)) {
    const name = await safeGetChatMemberName(GROUP_CHAT_ID, active.userId);
    const { total, doneCount, complete } = checklistStats(active.userId);
    line = `Current duty: ${escapeHtml(name)} — ${complete ? "✅ COMPLETE" : `⏳ ${doneCount}/${total} done`}`;
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
  const { total, doneCount, complete } = checklistStats(active.userId);

  await bot.sendMessage(
    GROUP_CHAT_ID,
    `😴 Bot is going to sleep.\nDuty user: ${name} — ${complete ? "✅ checklist COMPLETE" : `⏳ ${doneCount}/${total} done`}.`
  );
}

// ===================== Commands =====================
const cmdRe = (name, hasArg = false) =>
  new RegExp(`^\\/${name}(?:@\\w+)?${hasArg ? "\\s+(.+)" : "\\s*$"}`, "i");

// /start
bot.onText(cmdRe("start"), async (msg) => {
  const isPrivate = msg.chat.type === "private";
  const uid = msg.from?.id;
  if (!uid) return;

  if (!isPrivate) {
    await bot.sendMessage(msg.chat.id, "This bot runs checklist in DM only. Use the button in the group message to start duty.");
    return;
  }

  await bot.sendMessage(uid, "Welcome. This checklist runs in DM. Restoring your menu…");
  await sendDmChecklist(uid);
});

// /menu (DM only) - restore reply keyboard explicitly
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

// /allow and /deny and /whoallowed (GROUP only, admins)
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
        await bot.sendMessage(groupId, "⚠️ I could not DM you. Please open the bot and send /start once, then tap Start Duty again.");
      } catch {}
      console.error("start_duty DM error:", e?.response?.body || e);
    }

    return;
  }
});

// ===================== DM message handler (reply keyboard + tap-to-toggle) =====================
bot.on("message", async (msg) => {
  if (!msg.text) return;

  // ignore commands handled elsewhere
  if (/^\/(start|menu|clear|allow|deny|whoallowed)\b/i.test(msg.text)) return;

  // DM-only checklist interaction
  if (msg.chat.type !== "private") return;

  const uid = msg.from?.id;
  if (!uid) return;

  const st = getUserState(uid);

  // Buttons
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
    await bot.sendMessage(uid, "Send the extra task text:", { reply_markup: { force_reply: true } });
    return;
  }

  // Force-reply add
  if (msg.reply_to_message && /Send the extra task text:/i.test(msg.reply_to_message.text || "")) {
    const t = msg.text.trim();
    if (!t) return;
    st.extra.push({ text: t, done: false });
    saveData(DB);
    await sendDmChecklist(uid);
    return;
  }

  // Tap-to-toggle (from menu): parse "#N"
  // Works for both direct number messages and menu button labels like "✅ #3: ..."
  const m = msg.text.match(/#(\d+)/);
  if (m) {
    const n = parseInt(m[1], 10);
    const idx0 = n - 1;
    const baseLen = BASE_ITEMS.length;
    const extraLen = st.extra.length;

    if (idx0 >= 0 && idx0 < baseLen) {
      // toggle base item (never removed)
      st.baseDone[idx0] = !st.baseDone[idx0];
      saveData(DB);
      await sendDmChecklist(uid);
      return;
    }

    if (idx0 >= baseLen && idx0 < baseLen + extraLen) {
      const extraIndex = idx0 - baseLen;
      if (st.removeMode) {
        st.extra.splice(extraIndex, 1);
      } else {
        st.extra[extraIndex].done = !st.extra[extraIndex].done;
      }
      saveData(DB);
      await sendDmChecklist(uid);
      return;
    }
  }

  // Free text fallback: treat as "add extra task"
  const t = msg.text.trim();
  if (t) {
    st.extra.push({ text: t, done: false });
    saveData(DB);
    await sendDmChecklist(uid);
  }
});

// ===================== Timed helpers (optional, for longer runs) =====================
const MS_IN_DAY = 24 * 60 * 60 * 1000;

function msUntilNextSgt(hour, minute) {
  const now = new Date();
  const targetUtc = new Date(now);
  targetUtc.setUTCHours(hour - 8, minute, 0, 0); // SGT=UTC+8
  let delta = targetUtc.getTime() - now.getTime();
  if (delta < 0) delta += MS_IN_DAY;
  return delta;
}

function scheduleDailyAtSgt(hour, minute, fn) {
  const d = msUntilNextSgt(hour, minute);
  if (VERBOSE) console.log(`Scheduling daily at ${hour}:${minute} SGT in ${Math.round(d / 1000)}s`);
  setTimeout(async () => {
    try { await fn(); } catch (e) { console.error("daily task error:", e?.response?.body || e); }
    setInterval(async () => {
      try { await fn(); } catch (e) { console.error("daily task error:", e?.response?.body || e); }
    }, MS_IN_DAY);
  }, d);
}

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
      console.warn("⚠️ CHAT_ID (GROUP_CHAT_ID) is not set. Group announcements will not be sent.");
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

    // When bot comes online:
    // 1) announce awake (group)
    // 2) send duty start prompt with inline button (group)
    // 3) optionally send poll (typically only morning run, but you can decide)
    if (GROUP_CHAT_ID) {
      await announceAwakeToGroup();
      await sendStartDutyPromptToGroup();

      if (SEND_MORNING_POLL && (RUN_KIND === "morning" || RUN_KIND === "manual")) {
        await sendMorningPollToGroup();
      }
    }

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
