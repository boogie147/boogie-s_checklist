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
const ANNOUNCE_CHAT = process.env.CHAT_ID || null;          // optional; can be empty
const DURATION_MINUTES = Number(process.env.DURATION_MINUTES || 30); // 0 = no auto-stop
const STARTUP_REMINDER = String(process.env.STARTUP_REMINDER || 'true') === 'true';

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

const ActiveChats = new Set(Object.keys(DB));
const getList = (cid) => (DB[cid] ||= []);
const isAllDone = (items) => items.length > 0 && items.every(x => x.done);
const escapeHtml = (s) => s.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const truncate = (s,n)=> s && s.length>n ? s.slice(0,n-1)+'…' : s;

function renderLines(items) {
  return items.length
    ? items.map((it,i)=> `${i+1}. ${it.done ? '✅' : '⬜️'} ${escapeHtml(it.text)}`).join('\n')
    : 'No items yet. Use /add &lt;task&gt; or the + button.';
}
function buildKeyboard(items) {
  const rows = items.map((it,i)=> ([
    { text: `${it.done?'✅':'⬜️'} ${truncate(it.text,40)}`, callback_data: `t:${i}` },
    { text: '🗑', callback_data: `rm:${i}` },
  ]));
  rows.push([{ text: '➕ Add', callback_data: 'add_prompt' },
             { text: '🧹 Clear', callback_data: 'clear_all' },
             { text: '🔄 Refresh', callback_data: 'refresh' }]);
  return { reply_markup: { inline_keyboard: rows } };
}
async function reply(cid, html, extra={}) { return bot.sendMessage(cid, html, { parse_mode:'HTML', ...extra }); }
async function edit(cid, mid, html, extra={}) {
  return bot.editMessageText(html, { chat_id: cid, message_id: mid, parse_mode:'HTML', ...extra });
}

// Track + persist new chats; return true if this call newly added it
function ensureChatTracked(cid){
  const key = String(cid);
  let added = false;
  if (!ActiveChats.has(key)) { ActiveChats.add(key); added = true; }
  if (!DB[cid]) { DB[cid] = []; added = true; }
  return added;
}

async function sendListInteractive(cid) {
  const items=getList(cid);
  return reply(cid, `<b>Your checklist</b>\n${renderLines(items)}`, buildKeyboard(items));
}
async function refreshMessage(cid, mid){
  const items=getList(cid);
  return edit(cid, mid, `<b>Your checklist</b>\n${renderLines(items)}`, buildKeyboard(items));
}

// ===== Welcome-on-first-contact helpers =====
const WelcomedThisRun = new Set();

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

async function maybeWelcome(cid, newlyTracked) {
  if (WelcomedThisRun.has(cid)) return;
  WelcomedThisRun.add(cid);

  // Persist the chat immediately so future runs can broadcast to it at startup
  if (newlyTracked) saveData(DB);

  await reply(cid, '👋 Hello! The bot is awake. Use /list or the buttons below.');
  await sendListInteractive(cid);
  if (STARTUP_REMINDER) {
    await sendReminderToChat(cid, '🟢 Bot awake: ');
  }
}

// ======= Logging & hardening =======
process.on('unhandledRejection', e => console.error('unhandledRejection:', e?.response?.body || e));
process.on('uncaughtException',  e => console.error('uncaughtException:', e?.response?.body || e));
const HEARTBEAT = setInterval(() => { if (VERBOSE) console.log('…heartbeat'); }, 10_000);

// ======= Commands =======
// /start
bot.onText(cmdRe('start'), async (msg) => {
  const cid = msg.chat.id;
  const newlyTracked = ensureChatTracked(cid);
  await maybeWelcome(cid, newlyTracked);

  // Optional extra /start help (keep or remove if too chatty)
  await reply(
    cid,
    ['<b>Checklist Bot</b> is awake 👋',
     'Use buttons or commands:',
     '• /add &lt;text&gt;',
     '• /list',
     '• /done &lt;number&gt;',
     '• /remove &lt;number&gt;',
     '• /clear'].join('\n'),
    buildKeyboard(getList(cid))
  );
});

// /add <text>
bot.onText(cmdRe('add', true), async (msg, m) => {
  const cid = msg.chat.id;
  const newlyTracked = ensureChatTracked(cid);
  await maybeWelcome(cid, newlyTracked);

  const text = (m[1] || '').trim();
  if (!text) return reply(cid, 'Usage: /add &lt;task&gt;');
  getList(cid).push({ text, done: false }); saveData(DB);
  await reply(cid, `Added: <b>${escapeHtml(text)}</b>`); await sendListInteractive(cid);
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

// /clear
bot.onText(cmdRe('clear'), async (msg) => {
  const cid = msg.chat.id;
  const newlyTracked = ensureChatTracked(cid);
  await maybeWelcome(cid, newlyTracked);

  DB[cid] = []; saveData(DB);
  await reply(cid, 'Cleared your checklist.'); await sendListInteractive(cid);
});

// Non-command text -> add item (works in 1:1 chats; in groups, privacy mode may block non-commands)
bot.on('message', async (msg)=>{
  if(!msg.text) return;
  if(/^\/(start|add|list|done|remove|clear)/i.test(msg.text)) return; // commands handled above
  const cid=msg.chat.id;
  const newlyTracked = ensureChatTracked(cid);
  await maybeWelcome(cid, newlyTracked);

  const t = msg.text.trim(); if(!t) return;
  getList(cid).push({ text:t, done:false }); saveData(DB);
  await reply(cid, `Added: <b>${escapeHtml(t)}</b>`); await sendListInteractive(cid);
});

// Inline buttons
bot.on('callback_query', async (q)=>{
  try{
    const cid = q.message.chat.id; const mid = q.message.message_id;
    const newlyTracked = ensureChatTracked(cid);
    await maybeWelcome(cid, newlyTracked);

    const items = getList(cid);
    const [action,arg] = (q.data||'').split(':');

    if(action==='t'){ const i=parseInt(arg,10); if(!isNaN(i)&&items[i]) { items[i].done=!items[i].done; saveData(DB); } await refreshMessage(cid, mid); }
    else if(action==='rm'){ const i=parseInt(arg,10); if(!isNaN(i)&&items[i]) { const r=items.splice(i,1)[0]; saveData(DB); await reply(cid,`Removed: <b>${escapeHtml(r.text)}</b> 🗑️`);} await refreshMessage(cid, mid); }
    else if(action==='clear_all'){ DB[cid]=[]; saveData(DB); await refreshMessage(cid, mid); }
    else if(action==='refresh'){ await refreshMessage(cid, mid); }
    else if(action==='add_prompt'){ await reply(cid, 'Send me the task text, and I will add it.'); }

    await bot.answerCallbackQuery(q.id);
  }catch(e){
    console.error('callback error:', e?.response?.body || e);
    try{ await bot.answerCallbackQuery(q.id); }catch{}
  }
});

// Polling error visibility (do NOT exit)
bot.on('polling_error', (err)=>{
  console.error('polling_error:', err?.response?.body || err);
});

if (VERBOSE) {
  bot.on('message', (m) => console.log('msg from', m.chat?.id, m.text));
  bot.on('callback_query', (q) => console.log('callback from', q.message?.chat?.id, q.data));
}

// ======= Reminders / Awake =======
async function broadcastAwake() {
  const targets = new Set(ActiveChats);
  if (ANNOUNCE_CHAT) targets.add(String(ANNOUNCE_CHAT));

  if (VERBOSE) console.log('broadcast targets:', [...targets]);
  if (targets.size === 0) console.log('No targets to notify (ActiveChats empty and CHAT_ID not set).');

  for (const cid of targets) {
    try {
      await reply(cid, '👋 Hello! The bot is awake. Use /list or the buttons below.');
      await sendListInteractive(cid);
      if (STARTUP_REMINDER) {
        await sendReminderToChat(cid, '🟢 Bot awake: ');
      }
    } catch (e) { console.warn('awake send failed for', cid, e?.response?.body || e); }
  }
}

async function sendReminder(prefix){
  const targets = new Set(ActiveChats);
  if (ANNOUNCE_CHAT) targets.add(String(ANNOUNCE_CHAT));

  for (const cid of targets) {
    await sendReminderToChat(cid, prefix);
  }
}

// ======= Startup =======
(async function main(){
  try {
    const me = await bot.getMe(); // token check early
    console.log(`🤖 Bot @${me.username} (ID ${me.id}) starting…`);

    // Clear webhook so polling can work
    try {
      await bot.deleteWebHook({ drop_pending_updates: false });
      console.log('✅ Webhook cleared.');
    } catch (e) {
      console.warn('⚠️ deleteWebHook failed (continuing):', e?.response?.body || e);
    }

    // Start polling explicitly with sane params
    await bot.startPolling({
      interval: 300, // ms between polls
      params: { timeout: 50, allowed_updates: ['message','callback_query'] },
    });
    console.log('📡 Polling started.');

    if (VERBOSE) console.log('ActiveChats:', [...ActiveChats]);

    // 🔔 Startup broadcasts (only to known chats / CHAT_ID)
    await broadcastAwake();

    // Global timed reminders (relative to job start)
    if (DURATION_MINUTES <= 0 || DURATION_MINUTES > 20)
      setTimeout(()=> sendReminder('⏱️ 20 minutes gone. '), 20*60*1000);
    if (DURATION_MINUTES <= 0 || DURATION_MINUTES > 25)
      setTimeout(()=> sendReminder('⏱️ 25 minutes gone. '), 25*60*1000);

    // Optional auto-stop
    if (DURATION_MINUTES > 0) {
      setTimeout(async ()=>{
        console.log(`⏱️ ${DURATION_MINUTES} minutes elapsed — stopping bot.`);
        try { await bot.stopPolling(); } catch {}
        saveData(DB);
        clearInterval(HEARTBEAT);
        process.exit(0);
      }, DURATION_MINUTES * 60 * 1000);
    } else {
      console.log('🟢 Auto-stop disabled (DURATION_MINUTES=0).');
    }

  } catch (e) {
    console.error('❌ Fatal startup error:', e?.response?.body || e);
    process.exit(1);
  }
})();

// Persist on shutdown
process.on('SIGTERM', ()=> { try { saveData(DB); } catch {} clearInterval(HEARTBEAT); process.exit(0); });
process.on('SIGINT',  ()=> { try { saveData(DB); } catch {} clearInterval(HEARTBEAT); process.exit(0); });
