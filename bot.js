require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const {
  registerChecklistHandlers,
  enterCOS,
  runChecklistStartup,
} = require('./checklist');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const COS_ID = Number(process.env.COS_ID || 0);
const COS_TOPIC_URL = process.env.COS_TOPIC_URL || '';

const MC_ID = Number(process.env.MC_ID || 0);
const MC_TOPIC_URL = process.env.MC_TOPIC_URL || '';

const MC_FORM_URL =
  process.env.MC_FORM_URL ||
  'https://docs.google.com/forms/d/e/1FAIpQLSfjeklk85kKJdP_ELHelTWR3UFHLY0EfW5dFEUiKG4PRPB8JQ/viewform?usp=header';

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN is missing in environment variables.');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const userState = new Map();

function getDefaultState() {
  return {
    menu: 'MAIN',
    service: null,
  };
}

function getSessionKey(msg) {
  if (msg.chat.type === 'private') {
    return String(msg.chat.id);
  }
  const threadId = msg.message_thread_id ? String(msg.message_thread_id) : 'main';
  return `${msg.chat.id}:${threadId}:${msg.from?.id || 'unknown'}`;
}

function getUserState(key) {
  return userState.get(key) || getDefaultState();
}

function setUserState(key, newState) {
  const current = getUserState(key);
  userState.set(key, { ...current, ...newState });
}

function resetUserState(key) {
  userState.set(key, getDefaultState());
}

function getThreadOptions(msg) {
  if (msg && msg.chat.type !== 'private' && msg.message_thread_id) {
    return { message_thread_id: msg.message_thread_id };
  }
  return {};
}

function mainMenuKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        ['COS', 'MC'],
        ['Help', 'About'],
        ['Refresh Menu'],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  };
}

function mcMenuKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        ['Submit MC', 'MC Status'],
        ['MC Help'],
        ['Back to Main Menu'],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  };
}

async function sendMainMenu(chatId, firstName = 'User', sessionKey = String(chatId), threadOptions = {}) {
  resetUserState(sessionKey);

  const text =
    `✨ Welcome to *Bravo Menu Bot*, ${firstName}. ✨\n\n` +
    `Please select the service you wish to use:\n\n` +
    `1. COS\n` +
    `2. MC`;

  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    ...mainMenuKeyboard(),
    ...threadOptions,
  });
}

function isCosTopicMessage(msg) {
  if (!msg) return false;
  return Number(msg.message_thread_id || 0) === COS_ID;
}

function isMcTopicMessage(msg) {
  if (!msg) return false;
  return Number(msg.message_thread_id || 0) === MC_ID;
}

async function sendCosTopicRedirect(chatId, threadOptions = {}) {
  const text = `Please use the COS sub-topic to access COS features.`;

  const options = COS_TOPIC_URL
    ? {
        reply_markup: {
          inline_keyboard: [[
            { text: 'Go to COS Topic', url: COS_TOPIC_URL }
          ]]
        },
        ...threadOptions,
      }
    : threadOptions;

  await bot.sendMessage(chatId, text, options);
}

async function sendMcTopicRedirect(chatId, threadOptions = {}) {
  const text = `Please use the MC sub-topic to access MC features.`;

  const options = MC_TOPIC_URL
    ? {
        reply_markup: {
          inline_keyboard: [[
            { text: 'Go to MC Topic', url: MC_TOPIC_URL }
          ]]
        },
        ...threadOptions,
      }
    : threadOptions;

  await bot.sendMessage(chatId, text, options);
}

async function sendHelp(chatId, threadOptions = {}) {
  const text =
    `✨ *Bravo Menu Bot — Help Centre* ✨\n\n` +
    `Welcome to the Bravo Menu Bot.\n` +
    `Use the menu buttons or type commands manually if you prefer.\n\n` +
    `*Available Commands*\n` +
    `• /start — Open the service selection menu\n` +
    `• /menu — Return to the main menu\n` +
    `• /help — Show this help message\n\n` +
    `*Available Services*\n` +
    `• COS\n` +
    `• MC\n\n` +
    `*Manual Input*\n` +
    `You may also reply to the bot and manually type commands instead of pressing the buttons.\n` +
    `For example:\n` +
    `• /start\n` +
    `• /menu\n` +
    `• /help\n\n` +
    `Please select the service you require to continue.`;

  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    ...threadOptions,
  });
}

async function sendAbout(chatId, threadOptions = {}) {
  const text =
    `✨ *About Bravo Menu Bot* ✨\n\n` +
    `Bravo Menu Bot is a service navigation bot designed to help users access different functions from one central menu.\n\n` +
    `*Current Services*\n` +
    `• COS\n` +
    `• MC\n\n` +
    `*Purpose*\n` +
    `This bot helps guide users to the correct service flow quickly and clearly.\n\n` +
    `More services and features may be added in the future.`;

  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    ...threadOptions,
  });
}

async function enterMC(chatId, sessionKey, threadOptions = {}) {
  setUserState(sessionKey, {
    menu: 'SERVICE',
    service: 'MC',
  });

  const text =
    `🩺 *MC Service*\n\n` +
    `Please choose an option below.`;

  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    ...mcMenuKeyboard(),
    ...threadOptions,
  });
}

async function handleMCMessage(chatId, text, msg, sessionKey, threadOptions = {}) {
  if (!isMcTopicMessage(msg)) {
    await sendMcTopicRedirect(chatId, threadOptions);
    return;
  }

  switch (text) {
    case 'Submit MC':
      await bot.sendMessage(
        chatId,
        `🩺 *MC Submission*\n\nPlease use the link below to submit your MC details:\n${MC_FORM_URL}`,
        {
          parse_mode: 'Markdown',
          ...threadOptions,
        }
      );
      break;

    case 'MC Status':
      await bot.sendMessage(
        chatId,
        `MC Status selected.\n\nThis section can be added later.`,
        threadOptions
      );
      break;

    case 'MC Help':
      await bot.sendMessage(
        chatId,
        `🩺 *MC Help*\n\n` +
          `• Submit MC — get the MC form link\n` +
          `• MC Status — check MC-related status later\n\n` +
          `Please use the buttons in the MC sub-topic.`,
        {
          parse_mode: 'Markdown',
          ...threadOptions,
        }
      );
      break;

    case 'Back to Main Menu':
      await sendMainMenu(chatId, msg.from?.first_name || 'User', sessionKey, threadOptions);
      break;

    default:
      await bot.sendMessage(
        chatId,
        `Invalid MC option. Please use the MC menu buttons.`,
        {
          ...mcMenuKeyboard(),
          ...threadOptions,
        }
      );
      break;
  }
}

registerChecklistHandlers(bot, {
  isCosActive: (uid) => {
    const state = getUserState(String(uid));
    return state.menu === 'SERVICE' && state.service === 'COS';
  },
  activateCosMode: async (uid) => {
    setUserState(String(uid), {
      menu: 'SERVICE',
      service: 'COS',
    });
  },
  exitCosMode: async (uid) => {
    await sendMainMenu(uid, 'User', String(uid));
  },
});

const serviceHandlers = {
  COS: {
    enter: async (chatId, msg) => {
      if (!isCosTopicMessage(msg)) {
        await sendCosTopicRedirect(chatId, getThreadOptions(msg));
        return;
      }

      await enterCOS(msg.from.id);
    },
  },
  MC: {
    enter: async (chatId, msg) => {
      if (!isMcTopicMessage(msg)) {
        await sendMcTopicRedirect(chatId, getThreadOptions(msg));
        return;
      }

      const sessionKey = getSessionKey(msg);
      await enterMC(chatId, sessionKey, getThreadOptions(msg));
    },
    handle: handleMCMessage,
  },
};

async function sendStartupGreeting() {
  if (!CHAT_ID) {
    console.log('ℹ️ CHAT_ID not set. Skipping startup greeting.');
    return;
  }

  const text =
    `✨ *Welcome to Bravo Menu Bot* ✨\n\n` +
    `Please use /start to select the service that you require.\n\n` +
    `Available services:\n` +
    `• COS\n` +
    `• MC`;

  try {
    await bot.sendMessage(CHAT_ID, text, {
      parse_mode: 'Markdown',
    });
    console.log('✅ Startup greeting sent.');
  } catch (err) {
    console.error('❌ Failed to send startup greeting:', err.message || err);
  }
}

bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from?.first_name || 'User';
  const sessionKey = getSessionKey(msg);
  await sendMainMenu(chatId, firstName, sessionKey, getThreadOptions(msg));
});

bot.onText(/^\/menu$/, async (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from?.first_name || 'User';
  const sessionKey = getSessionKey(msg);
  await sendMainMenu(chatId, firstName, sessionKey, getThreadOptions(msg));
});

bot.onText(/^\/help$/, async (msg) => {
  await sendHelp(msg.chat.id, getThreadOptions(msg));
});

bot.on('message', async (msg) => {
  try {
    const chatId = msg.chat.id;
    const firstName = msg.from?.first_name || 'User';
    const text = msg.text;

    if (!text) return;
    if (text.startsWith('/')) return;

    const sessionKey = getSessionKey(msg);
    const state = getUserState(sessionKey);
    const threadOptions = getThreadOptions(msg);

    if (text === 'Refresh Menu') {
      await sendMainMenu(chatId, firstName, sessionKey, threadOptions);
      return;
    }

    if (text === 'Help') {
      await sendHelp(chatId, threadOptions);
      return;
    }

    if (text === 'About') {
      await sendAbout(chatId, threadOptions);
      return;
    }

    if (state.menu === 'MAIN') {
      if (serviceHandlers[text]) {
        await serviceHandlers[text].enter(chatId, msg);
        return;
      }

      await bot.sendMessage(
        chatId,
        `Invalid selection.\nPlease choose a service from the menu.`,
        {
          ...mainMenuKeyboard(),
          ...threadOptions,
        }
      );
      return;
    }

    if (state.menu === 'SERVICE' && state.service === 'COS') {
      return;
    }

    if (state.menu === 'SERVICE' && state.service === 'MC') {
      await handleMCMessage(chatId, text, msg, sessionKey, threadOptions);
      return;
    }

    await sendMainMenu(chatId, firstName, sessionKey, threadOptions);
  } catch (err) {
    console.error('❌ Message handler error:', err);
  }
});

bot.on('polling_error', (err) => {
  console.error('❌ Polling error:', err?.message || err);
});

(async () => {
  console.log('✅ Menu bot is running...');
  await sendStartupGreeting();
  await runChecklistStartup();
})();
