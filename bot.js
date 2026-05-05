require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const {
  registerChecklistHandlers,
  enterCOS,
  runChecklistStartup,
} = require('./checklist');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

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

function getUserState(chatId) {
  return userState.get(chatId) || getDefaultState();
}

function setUserState(chatId, newState) {
  const current = getUserState(chatId);
  userState.set(chatId, { ...current, ...newState });
}

function resetUserState(chatId) {
  userState.set(chatId, getDefaultState());
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

async function sendMainMenu(chatId, firstName = 'User') {
  resetUserState(chatId);

  const text =
    `Hello ${firstName}.\n\n` +
    `Please select the service you wish to use:\n` +
    `1. COS\n` +
    `2. MC`;

  await bot.sendMessage(chatId, text, mainMenuKeyboard());
}

async function sendHelp(chatId) {
  const text =
    `Available commands:\n\n` +
    `/start - Start the bot\n` +
    `/menu - Return to main menu\n` +
    `/help - Show help\n\n` +
    `Use the keyboard buttons to select a service.`;

  await bot.sendMessage(chatId, text);
}

async function sendAbout(chatId) {
  const text =
    `This is a modular service bot.\n\n` +
    `Current services:\n` +
    `- COS\n` +
    `- MC\n\n` +
    `More services can be added later.`;

  await bot.sendMessage(chatId, text);
}

async function enterMC(chatId) {
  setUserState(chatId, {
    menu: 'SERVICE',
    service: 'MC',
  });

  const text =
    `You are now in MC service.\n\n` +
    `Please choose an option.`;

  await bot.sendMessage(chatId, text, mcMenuKeyboard());
}

async function handleMCMessage(chatId, text) {
  switch (text) {
    case 'Submit MC':
      await bot.sendMessage(
        chatId,
        `Submit MC selected.\n\nReplace this with your MC submission workflow.`
      );
      break;

    case 'MC Status':
      await bot.sendMessage(
        chatId,
        `MC Status selected.\n\nReplace this with your MC status workflow.`
      );
      break;

    case 'MC Help':
      await bot.sendMessage(
        chatId,
        `MC Help:\n` +
          `- Submit MC\n` +
          `- MC Status\n\n` +
          `Select an option from the keyboard.`
      );
      break;

    default:
      await bot.sendMessage(
        chatId,
        `Invalid MC option. Please use the MC menu buttons.`
      );
      break;
  }
}

registerChecklistHandlers(bot, {
  isCosActive: (chatId) => {
    const state = getUserState(chatId);
    return state.menu === 'SERVICE' && state.service === 'COS';
  },
  activateCosMode: async (chatId) => {
    setUserState(chatId, {
      menu: 'SERVICE',
      service: 'COS',
    });
  },
  exitCosMode: async (chatId) => {
    const firstName = 'User';
    await sendMainMenu(chatId, firstName);
  },
});

const serviceHandlers = {
  COS: {
    enter: async (chatId) => {
      setUserState(chatId, {
        menu: 'SERVICE',
        service: 'COS',
      });
      await enterCOS(chatId);
    },
  },
  MC: {
    enter: enterMC,
    handle: handleMCMessage,
  },
};

async function sendStartupGreeting() {
  if (!CHAT_ID) {
    console.log('ℹ️ CHAT_ID not set. Skipping startup greeting.');
    return;
  }

  try {
    await bot.sendMessage(
      CHAT_ID,
      `✅ Bot is now online.\n\nPlease use /start to begin.`
    );
    console.log('✅ Startup greeting sent.');
  } catch (err) {
    console.error('❌ Failed to send startup greeting:', err.message || err);
  }
}

bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from?.first_name || 'User';
  await sendMainMenu(chatId, firstName);
});

bot.onText(/^\/menu$/, async (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from?.first_name || 'User';
  await sendMainMenu(chatId, firstName);
});

bot.onText(/^\/help$/, async (msg) => {
  const chatId = msg.chat.id;
  await sendHelp(chatId);
});

bot.on('message', async (msg) => {
  try {
    const chatId = msg.chat.id;
    const firstName = msg.from?.first_name || 'User';
    const text = msg.text;

    if (!text) return;
    if (text.startsWith('/')) return;

    const state = getUserState(chatId);

    if (text === 'Back to Main Menu') {
      await sendMainMenu(chatId, firstName);
      return;
    }

    if (text === 'Refresh Menu') {
      await sendMainMenu(chatId, firstName);
      return;
    }

    if (text === 'Help') {
      await sendHelp(chatId);
      return;
    }

    if (text === 'About') {
      await sendAbout(chatId);
      return;
    }

    if (state.menu === 'MAIN') {
      if (serviceHandlers[text]) {
        await serviceHandlers[text].enter(chatId);
        return;
      }

      await bot.sendMessage(
        chatId,
        `Invalid selection.\nPlease choose a service from the menu.`,
        mainMenuKeyboard()
      );
      return;
    }

    if (state.menu === 'SERVICE' && state.service === 'COS') {
      return;
    }

    if (state.menu === 'SERVICE' && state.service) {
      const handler = serviceHandlers[state.service];

      if (handler && typeof handler.handle === 'function') {
        await handler.handle(chatId, text);
        return;
      }
    }

    await sendMainMenu(chatId, firstName);
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
