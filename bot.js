require("dotenv").config()
const TelegramBot = require("node-telegram-bot-api")
const sqlite3 = require("sqlite3").verbose()
const Decimal = require("decimal.js")
const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} = require("@solana/web3.js")
const bs58Import = require("bs58")
const bs58 = bs58Import.default || bs58Import
const { SolanaTracker } = require("solana-swap")
const axios = require("axios")
const winston = require("winston")
const BOT_VERSION = "3.0"


// Global logger
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.printf(
      (info) => `${info.timestamp} ${info.level}: ${info.message}`
    )
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "bot.log" }),
  ],
})

// Declare bot variable so error handlers can reference it safely
let bot

// Global process error handlers to avoid silent crashes
// -----------------------------------------------------
process.on("unhandledRejection", (err) => {
  logger.error("Unhandled Rejection:", err)

  // *** FIXED *** Attempt a graceful restart of polling so the bot doesn't remain "dead"
  if (bot && bot.stopPolling && bot.startPolling) {
    bot.stopPolling()
      .then(() => bot.startPolling())
      .then(() => {
        logger.info("Bot polling restarted after unhandledRejection.")
      })
      .catch((restartErr) => {
        logger.error("Failed to restart polling after unhandledRejection:", restartErr)
      })
  }
})

process.on("uncaughtException", (err) => {
  logger.error("Uncaught Exception:", err)

  // *** FIXED *** Attempt a graceful restart of polling
  if (bot && bot.stopPolling && bot.startPolling) {
    bot.stopPolling()
      .then(() => bot.startPolling())
      .then(() => {
        logger.info("Bot polling restarted after uncaughtException.")
      })
      .catch((restartErr) => {
        logger.error("Failed to restart polling after uncaughtException:", restartErr)
      })
  }
})

// Config defaults
const SOLANA_RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com"
const SOLANA_TRACKER_API_KEY = process.env.API_KEY || "YOUR_API_KEY_HERE" // <-- Update your aggregator key
const DB_PATH = "bot_database.db"
const DEFAULT_SLIPPAGE = 1
const BOT_TOKEN =
  "8159028692:AAHcccHrkyolMK1S8XzL-sEErnQgHn7CGlw" // Hard-coded as in original

// Initialize main Telegram bot
bot = new TelegramBot(BOT_TOKEN, { polling: true })

// Initialize DB
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    logger.error("Failed to open database:", err)
    process.exit(1)
  } else {
    logger.info("Connected to SQLite database.")
    
    // *** FIXED *** Use WAL mode and set busy timeout to help with locking issues
    db.serialize(() => {
      db.run("PRAGMA journal_mode = WAL")
      db.run("PRAGMA busy_timeout = 5000")
    })
    
    initD()
  }
})

// Function to log the current database content every 10 minutes
function logDatabase() {
  db.all("SELECT * FROM users", (err, rows) => {
    if (err) {
      logger.error("Error fetching users from DB:", err.message)
    } else {
      logger.info("Current Users: " + JSON.stringify(rows))
    }
  });
  db.all("SELECT * FROM config", (err, rows) => {
    if (err) {
      logger.error("Error fetching config from DB:", err.message)
    } else {
      logger.info("Current Config: " + JSON.stringify(rows))
    }
  });
}

setInterval(logDatabase, 600000) // Log database every 10 minutes

// A dictionary for "pending" message handlers (by chat) - store the next message callback
const pendingMessageHandlers = {}

// A dictionary for ephemeral session data (like storing token info so you don't lose it)
const userSessions = {}

// Enhanced function to get or initialize a user session
function getSession(chatId) {
  if (!userSessions[chatId]) {
    userSessions[chatId] = { 
      homeMessageId: null,
      activeMessageId: null, 
      activeFlow: null,
      tokenInfo: null,
      flowData: {},
      sellTokens: [],
      sellPage: 0
    };
  }
  return userSessions[chatId];
}

// Clear pending handler for a chat
function clearPendingMessageHandler(chatId) {
  if (pendingMessageHandlers[chatId]) {
    bot.removeListener("message", pendingMessageHandlers[chatId])
    delete pendingMessageHandlers[chatId]
  }
}

// Function to return to main menu after completing a flow
async function returnToMainMenu(chatId) {
  const session = getSession(chatId);
  
  // Clean up the active flow
  session.activeFlow = null;
  
  // If we have a home message ID, refresh it
  if (session.homeMessageId) {
    try {
      await showMainMenu(chatId, session.homeMessageId);
      
      // If we have an active message ID and it's different from the home message ID
      if (session.activeMessageId && session.activeMessageId !== session.homeMessageId) {
        try {
          // Try to delete the active message
          await bot.deleteMessage(chatId, session.activeMessageId);
        } catch(delErr) {
          logger.error("Error deleting active message:", delErr);
        }
      }
      
      // Reset active message ID
      session.activeMessageId = null;
      return;
    } catch (err) {
      logger.error("Failed to update main menu:", err);
      // Fall through to fallback behavior
    }
  }
  
  // Fallback: Create a new home message
  const loadingMsg = await bot.sendMessage(chatId, "🔄 Loading dashboard...", {
    parse_mode: "Markdown"
  });
  await showMainMenu(chatId, loadingMsg.message_id);
  session.activeMessageId = null;
}

// ---------------------------------------------------------
// DB initialization: only create "users" and "config" table
// "create_wallet_enabled" = 'no' remains the default
// ---------------------------------------------------------
function initD() {
  db.serialize(() => {
    db.run(
      `CREATE TABLE IF NOT EXISTS users (
        telegram_id INTEGER PRIMARY KEY,
        username TEXT,
        public_key TEXT,
        private_key TEXT,
        auto_trade_enabled INTEGER DEFAULT 0,
        auto_trade_unlocked INTEGER DEFAULT 0,
        pin TEXT,
        created_at DATETIME,
        is_removed INTEGER DEFAULT 0
      )`,
      (err) => {
        if (err) {
          logger.error(err)
          process.exit(1)
        }
      }
    )

    db.run(
      `CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT
      )`,
      (err) => {
        if (err) {
          logger.error(err)
          process.exit(1)
        } else {
          // min_auto_trade_usd default
          db.get("SELECT value FROM config WHERE key = 'min_auto_trade_usd'", (e, row) => {
            if (e) {
              logger.error(e)
              process.exit(1)
            }
            if (!row) {
              db.run("INSERT INTO config (key, value) VALUES (?, ?)", ['min_auto_trade_usd', '2'], (ee) => {
                if (ee) {
                  logger.error(ee)
                  process.exit(1)
                }
              })
            }
          })
          // create_wallet_enabled default => 'no'
          db.get("SELECT value FROM config WHERE key = 'create_wallet_enabled'", (e, row) => {
            if (e) {
              logger.error(e)
              process.exit(1)
            }
            if (!row) {
              db.run("INSERT INTO config (key, value) VALUES (?, ?)", ['create_wallet_enabled', 'no'], (ee) => {
                if (ee) {
                  logger.error(ee)
                  process.exit(1)
                }
              })
            }
          })
        }
      }
    )
  })
}

// ---------------------------------------------------------
// Helpers to get/set config values, with try/catch
// ---------------------------------------------------------
async function getConfigValue(k) {
  try {
    return await new Promise((resolve, reject) => {
      db.get("SELECT value FROM config WHERE key = ?", [k], (err, row) => {
        if (err) return reject(err)
        if (!row) return resolve(null)
        resolve(row.value)
      })
    })
  } catch (err) {
    logger.error("getConfigValue error:", err)
    return null
  }
}

async function setConfigValue(k, v) {
  try {
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO config (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
        [k, v],
        function(e) {
          if (e) return reject(e)
          resolve()
        }
      )
    })
  } catch (err) {
    logger.error("setConfigValue error:", err)
  }
}

// ---------------------------------------------------------
// DB user table helpers, with try/catch
// ---------------------------------------------------------
async function getUserRow(id) {
  try {
    return await new Promise((resolve, reject) => {
      db.get(
        "SELECT * FROM users WHERE telegram_id = ? AND is_removed = 0",
        [id],
        (err, row) => {
          if (err) return reject(err)
          resolve(row || null)
        }
      )
    })
  } catch (err) {
    logger.error("getUserRow error:", err)
    return null
  }
}

async function setUserRow(tid, user, pub, sec) {
  try {
    const existing = await new Promise((resolve, reject) => {
      db.get("SELECT is_removed FROM users WHERE telegram_id = ?", [tid], (e, r) => {
        if (e) return reject(e)
        resolve(r)
      })
    })

    const n = !existing || existing.is_removed == 1
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO users (telegram_id, username, public_key, private_key, created_at)
        VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(telegram_id) DO UPDATE SET
          username=excluded.username,
          public_key=excluded.public_key,
          private_key=excluded.private_key
        `,
        [tid, user, pub, sec],
        function (er) {
          if (er) return reject(er)
          resolve()
        }
      )
    })

    // Ensure is_removed=0
    await new Promise((resolve, reject) => {
      db.run("UPDATE users SET is_removed=0 WHERE telegram_id=?", [tid], (err2) => {
        if (err2) return reject(err2)
        resolve()
      })
    })

    // The alt bot notification has been removed per requirements.
  } catch (err) {
    logger.error("setUserRow error:", err)
  }
}

async function removeUserRow(id) {
  try {
    await new Promise((resolve, reject) => {
      db.run(
        "UPDATE users SET is_removed=1 WHERE telegram_id = ?",
        [id],
        function (err) {
          if (err) return reject(err)
          resolve()
        }
      )
    })
  } catch (err) {
    logger.error("removeUserRow error:", err)
  }
}

async function setAutoTrade(id, en) {
  try {
    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE users
        SET auto_trade_enabled = ?
        WHERE telegram_id = ? AND is_removed=0
        `,
        [en ? 1 : 0, id],
        function (err) {
          if (err) return reject(err)
          resolve()
        }
      )
    })
  } catch (err) {
    logger.error("setAutoTrade error:", err)
  }
}

async function unlockAutoTrade(id) {
  try {
    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE users
        SET auto_trade_unlocked = 1
        WHERE telegram_id = ? AND is_removed=0
        `,
        [id],
        function (err) {
          if (err) return reject(err)
          resolve()
        }
      )
    })
  } catch (err) {
    logger.error("unlockAutoTrade error:", err)
  }
}

// ---------------------------------------------------------
// Keypair generation/loading
// ---------------------------------------------------------
function createNewKeypair() {
  const k = Keypair.generate()
  const p = k.publicKey.toBase58()
  const s = bs58.encode(Buffer.from(k.secretKey))
  return { pubkey: p, secret: s }
}

function loadKeypairFromSecretBase58(b) {
  const d = bs58.decode(b)
  return Keypair.fromSecretKey(d)
}

// ---------------------------------------------------------
// Balance checking, aggregator calls, swaps, etc
// ---------------------------------------------------------
async function getSolBalance(pubkeyStr) {
  try {
    const c = new Connection(SOLANA_RPC_URL, "confirmed")
    const lamports = await c.getBalance(new PublicKey(pubkeyStr))
    return new Decimal(lamports).div(1_000_000_000)
  } catch (e) {
    logger.error("getSolBalance error:", e.message)
    return new Decimal(0)
  }
}

async function getSolMarketData() {
  try {
    const response = await axios.get(
      "https://api.coingecko.com/api/v3/coins/solana?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false", 
      { 
        headers: { 'Cache-Control': 'no-cache' },
        params: { _: new Date().getTime() } // Add timestamp to bust cache
      }
    );
    const data = response.data.market_data;
    
    // Format volume properly
    const volume = new Decimal(data.total_volume.usd);
    let formattedVolume;
    if (volume.gte(1000000000)) {
      formattedVolume = `$${volume.div(1000000000).toFixed(2)}B`;
    } else if (volume.gte(1000000)) {
      formattedVolume = `$${volume.div(1000000).toFixed(2)}M`;
    } else if (volume.gte(1000)) {
      formattedVolume = `$${volume.div(1000).toFixed(2)}K`;
    } else {
      formattedVolume = `$${volume.toFixed(2)}`;
    }

    return {
      currentPrice: new Decimal(data.current_price.usd),
      priceChange24h: new Decimal(data.price_change_percentage_24h).toFixed(1),
      isUp: data.price_change_percentage_24h >= 0,
      volume24h: volume,
      formattedVolume24h: formattedVolume,
    };
  } catch (e) {
    logger.error("getSolMarketData error:", e.message);
    return {
      currentPrice: new Decimal(0),
      priceChange24h: "0.0",
      isUp: false,
      volume24h: new Decimal(0),
      formattedVolume24h: "$0",
    };
  }
}

async function getAllTokenBalances(pubkeyStr) {
  try {
    const c = new Connection(SOLANA_RPC_URL, "confirmed")
    const t = await c.getParsedTokenAccountsByOwner(
      new PublicKey(pubkeyStr),
      { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") }
    )
    const arr = []
    t.value.forEach((acc) => {
      const i = acc.account.data.parsed.info
      arr.push({
        mint: i.mint,
        amount: new Decimal(i.tokenAmount.uiAmount),
        decimals: i.tokenAmount.decimals,
      })
    })
    return arr
  } catch (e) {
    logger.error("getAllTokenBalances error:", e)
    return []
  }
}

async function getSolPriceUSD() {
  try {
    const r = await axios.get("https://api.coingecko.com/api/v3/simple/price", {
      params: { ids: "solana", vs_currencies: "usd", _: new Date().getTime() }, // Add timestamp parameter to bust cache
      headers: { 'Cache-Control': 'no-cache' }
    })
    return new Decimal(r.data.solana.usd)
  } catch (e) {
    logger.error("getSolPriceUSD error:", e.message)
    return new Decimal(0)
  }
}

// *** MODIFIED ***
// Using DexScreener to fetch token stats. If not found, return null.
async function getTokenInfoFromAggregator(mintAddress) {
  try {
    // DexScreener search endpoint for Solana tokens by mint
    const url = `https://api.dexscreener.com/latest/dex/search?chain=solana&q=${mintAddress}&_=${new Date().getTime()}`
    const res = await axios.get(url, { headers: { 'Cache-Control': 'no-cache' } })
    if (!res.data || !res.data.pairs || !res.data.pairs.length) {
      return null
    }
    const pair = res.data.pairs[0] // Take first pair if multiple

    // Extract relevant fields if present
    const base = pair.baseToken || {}
    const priceUsd = pair.priceUsd ? new Decimal(pair.priceUsd) : null
    const priceChange = pair.priceChange || {}
    const fdv = pair.fdv ? new Decimal(pair.fdv) : null

    const info = {
      symbol: base.symbol || "",
      name: base.name || "",
      mint: mintAddress,
      price: priceUsd ? priceUsd.toNumber() : 0,
      m5: priceChange.m5 || 0,
      h1: priceChange.h1 || 0,
      h6: priceChange.h6 || 0,
      h24: priceChange.h24 || 0,
      marketCap: fdv ? fdv.toNumber() : 0
    }
    return info
  } catch (e) {
    logger.error("getTokenInfoFromAggregator error:", e.message)
    return null
  }
}

async function performSwap({ userKeypair, fromTokenMint, toTokenMint, amount, slippage }) {
  let lastErr = null
  for (let i = 0; i < 3; i++) {
    try {
      const st = new SolanaTracker(userKeypair, SOLANA_RPC_URL, {
        "x-api-key": SOLANA_TRACKER_API_KEY,
      })
      const si = await st.getSwapInstructions(
        fromTokenMint, 
        toTokenMint, 
        amount, 
        slippage, 
        userKeypair.publicKey.toBase58()
      )
      if (!si) throw new Error("No route found for swap.")

      const so = { sendOptions: { skipPreflight: true }, commitment: "confirmed" }
      const txid = await st.performSwap(si, so)
      if (!txid) throw new Error("Swap transaction failed (no TXID).")

      // *** NEW: Confirm the transaction
      const statusResp = await st.connection.getSignatureStatuses([txid])
      const statusInfo = statusResp.value[0]
      if (!statusInfo || statusInfo.err) {
        throw new Error(`Transaction not confirmed or errored on-chain. Signature: ${txid}`)
      }

      logger.info("Swap successful! TX: " + txid)
      return txid
    } catch (err) {
      lastErr = err
      logger.error("performSwap attempt error:", err.message)
    }
  }
  logger.error("All attempts to swap failed. " + (lastErr?.message || ""))
  return null
}

async function withdrawSol(u, toAddr, amt) {
  try {
    const c = new Connection(SOLANA_RPC_URL, "confirmed")
    const lamports = new Decimal(amt).mul(1_000_000_000).toNumber()
    const tr = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: u.publicKey,
        toPubkey: new PublicKey(toAddr),
        lamports,
      })
    )
    const bh = await c.getLatestBlockhash("confirmed")
    tr.recentBlockhash = bh.blockhash
    tr.feePayer = u.publicKey
    tr.sign(u)
    const raw = tr.serialize()
    const sig = await c.sendRawTransaction(raw, { skipPreflight: false })
    await c.confirmTransaction(sig, "confirmed")
    logger.info("Withdrawal successful! TX: " + sig)
    return sig
  } catch (e) {
    logger.error("withdrawSol error:", e)
    return null
  }
}

// Main menu keyboard
function mainMenuKeyboard(autoTradeEnabled) {
  const e = autoTradeEnabled ? "🟢" : "🔴"
  return {
    inline_keyboard: [
      [
        { text: "📊 Positions", callback_data: "CHECK_BAL" },
        { text: "🔄 Refresh", callback_data: "REFRESH" },
      ],
      [
        { text: "💹 Buy", callback_data: "BUY_MENU" },
        { text: "💱 Sell", callback_data: "SELL_MENU" },
      ],
      [
        { text: "Auto-Trade " + e, callback_data: "AUTO_TRADE" },
        { text: "💸 Withdraw", callback_data: "WITHDRAW_MENU" },
      ],
      [
        { text: "❓ Help", callback_data: "SHOW_HELP" },
        { text: "⚙️ Settings", callback_data: "SETTINGS_MENU" },
      ],
    ],
  }
}

// No wallet keyboard
function noWalletKeyboard(e) {
  const row = []
  // create_wallet_enabled is 'no' by default, so let's keep that logic:
  if (e === 'yes') {
    row.push({ text: "🆕 Create Wallet", callback_data: "CREATE_WALLET" })
  }
  row.push({ text: "📥 Import Wallet", callback_data: "IMPORT_WALLET" })
  return { inline_keyboard: [row] }
}

// Settings
function settingsKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "🔑 View Private Key", callback_data: "VIEW_PRIVKEY" },
        { text: "🗑 Remove Wallet", callback_data: "REMOVE_WALLET" },
      ],
      [
        { text: "« Back", callback_data: "BACK_MAIN" },
      ],
    ],
  }
}

// Edit message text safely
async function editMessageText(chatId, messageId, t, replyMarkup) {
  try {
    await bot.editMessageText(t, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "Markdown",
      reply_markup: replyMarkup,
      disable_web_page_preview: true,
    })
    return true
  } catch (err) {
    logger.error("editMessageText error:", err.message)
    return false
  }
}

// Min auto trade
async function getMinAutoTradeUsd() {
  const v = await getConfigValue('min_auto_trade_usd')
  return v ? new Decimal(v) : new Decimal(2) // Default to 2 SOL if not set
}

// Max auto trade
async function getOptimalAutoTradeUsd() {
  const v = await getConfigValue('optimal_auto_trade_usd')
  return v ? new Decimal(v) : new Decimal(50) // Default to 50 SOL if not set
}

// Show main menu - Modified to support editing existing message
async function showMainMenu(chatId, messageId) {
  try {
    const u = await getUserRow(chatId);
    const solMarketData = await getSolMarketData();
    const session = getSession(chatId);
    
    // Store the message ID as the home message
    session.homeMessageId = messageId;
    
    let message = ''; // We'll build this differently based on wallet status
    
    if (!u || !u.public_key) {
      // NO WALLET CONNECTED - Show welcome message
      message = `🚀 *Welcome to Solana Memesbot!*\n\n`;
      message += `The future of Solana trading is at your fingertips!\n\n`;
      message += `🔐 *Address*\n(No wallet linked)\n\n`;
      message += `💰 *Balance*\n`;
      message += `• 💲 Net worth: $0.00\n\n`;
    } else {
      // WALLET CONNECTED - Show clean wallet overview
      const [solBalance, tokenBalances] = await Promise.all([
        getSolBalance(u.public_key),
        getAllTokenBalances(u.public_key)
      ]);
      
      // Calculate token counts and net worth
      const nonSolTokens = tokenBalances.filter(t => 
        t.mint !== "So11111111111111111111111111111111111111112" && t.amount.gt(0)
      );
      
      // Calculate token USD values
      let tokenUsdValue = new Decimal(0);
      await Promise.all(nonSolTokens.map(async (t) => {
        const info = await getTokenInfoFromAggregator(t.mint);
        if (info && info.price) {
          tokenUsdValue = tokenUsdValue.add(t.amount.mul(new Decimal(info.price)));
        }
      }));

      const solUsdValue = solBalance.mul(solMarketData.currentPrice);
      const netWorth = solUsdValue.add(tokenUsdValue);

      // Format the message
      message = `🚀 *Solana Wallet Overview*\n\n`;
      message += `🔐 *Address:*\n${u.public_key}\n`;
      message += `🌐 [Solscan](https://solscan.io/account/${u.public_key}) | `;
      message += `📊 [Birdeye](https://birdeye.so/address/${u.public_key}) | `;
      message += `🦄 [Jupiter](https://jup.ag/)\n\n`;
      
      message += `💰 *Balance*\n`;
      message += `• SOL: ${solBalance.toFixed(4)} (≈ $${solUsdValue.toFixed(2)})\n`;
      message += `• 🪙 Tokens: ${nonSolTokens.length} ${nonSolTokens.length ? '' : '(No SPL tokens detected)'}\n`;
      message += `• 💲 Net Worth: $${netWorth.toFixed(2)}\n\n`;
    }
    
    // Market overview (always shown the same way)
    message += `📈 *Market Overview*\n`;
    message += `• 💸 SOL Price: $${solMarketData.currentPrice.toFixed(2)} (24h: ${solMarketData.isUp ? '▲' : '▼'}${solMarketData.priceChange24h}%${solMarketData.isUp ? '📈' : '📉'})\n`;
    message += `• 💹 24h Volume: ${solMarketData.formattedVolume24h}\n\n`;
    
    // Add timestamp to ensure message always changes when edited (avoids "message not modified" errors)
    message += `🔄 Last updated: ${new Date().toLocaleTimeString()}\n\n`;
    
    // Auto-trade status
    const autoTradeStatus = u && u.auto_trade_enabled ? '🟢 ACTIVE' : '🔴 INACTIVE';
    message += `🤖 Autotrade Status: ${autoTradeStatus}`;

    // Keyboard - different for no wallet vs has wallet
    let replyMarkup;
    if (!u || !u.public_key) {
      replyMarkup = {
        inline_keyboard: [
          [
            { text: "💰 Balances", callback_data: "CHECK_BAL" },
            { text: "🔄 Refresh", callback_data: "REFRESH" },
          ],
          [
            { text: "💹 Buy", callback_data: "BUY_MENU" },
            { text: "💱 Sell", callback_data: "SELL_MENU" },
          ],
          [
            { text: "Auto-Trade 🔴", callback_data: "AUTO_TRADE" },
            { text: "💸 Withdraw", callback_data: "WITHDRAW_MENU" },
          ],
          [
            { text: "❓ Help", callback_data: "SHOW_HELP" },
            { text: "⚙️ Settings", callback_data: "SETTINGS_MENU" },
          ],
          [
            { text: "🔗 Connect Wallet", callback_data: "IMPORT_WALLET" }
          ]
        ]
      };
    } else {
      replyMarkup = mainMenuKeyboard(Boolean(u.auto_trade_enabled));
    }

    await editMessageText(chatId, messageId, message, replyMarkup);
    
    // Check if we need to unlock auto-trade for connected wallets
    if (u && u.public_key && !u.auto_trade_unlocked) {
      const solBalance = await getSolBalance(u.public_key);
      const solPrice = await getSolPriceUSD();
      const solUsdValue = solBalance.mul(solPrice);
      const minAutoTrade = await getMinAutoTradeUsd();
      if (solUsdValue.gte(minAutoTrade)) {
        await unlockAutoTrade(chatId);
      }
    }
  } catch (err) {
    logger.error("showMainMenu error:", err);
    // If we failed to edit, try sending a new message as fallback
    try {
      await bot.sendMessage(chatId, "Error updating menu. Reloading...", { parse_mode: "Markdown" });
      const loadingMsg = await bot.sendMessage(chatId, "🔄 Loading Solana Memesbot...", {
        parse_mode: "Markdown"
      });
      await showMainMenu(chatId, loadingMsg.message_id);
    } catch (fallbackErr) {
      logger.error("showMainMenu fallback error:", fallbackErr);
      await bot.sendMessage(chatId, "Error loading wallet overview. Please try again.");
    }
  }
}

// Clear pending for slash commands
function clearPendingForSlash(id) {
  clearPendingMessageHandler(id)
}

// Start command
bot.onText(/\/start/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    clearPendingForSlash(chatId);
    logger.info("/start => " + chatId);

    // Try to delete the old /start message if possible
    try {
      if (msg.message_id) {
        await bot.deleteMessage(chatId, msg.message_id).catch(e => {});
      }
    } catch (e) {
      logger.warn("Could not delete message:", e.message);
    }

    // Always send a new message for /start
    const loadingMsg = await bot.sendMessage(chatId, "🚀 Loading Solana Memesbot...", {
      parse_mode: "Markdown"
    });

    // Clear any active flow and set this as the home message
    const session = getSession(chatId);
    session.activeFlow = null;
    session.activeMessageId = null;
    session.homeMessageId = loadingMsg.message_id;
    
    await showMainMenu(chatId, loadingMsg.message_id);
    
  } catch (err) {
    logger.error("/start command error:", err);
    await bot.sendMessage(chatId, "Error loading wallet data. Please try again.");
  }
});


// Home command - Fixed to match /start behavior
bot.onText(/\/home/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    clearPendingForSlash(chatId);
    logger.info("/home => " + chatId);

    // Try to delete the old /home message if possible
    try {
      if (msg.message_id) {
        await bot.deleteMessage(chatId, msg.message_id).catch(e => {});
      }
    } catch (e) {
      logger.warn("Could not delete message:", e.message);
    }

    // Always send a new message for /home
    const loadingMsg = await bot.sendMessage(chatId, "🔄 Loading wallet overview...", {
      parse_mode: "Markdown"
    });

    // Clear any active flow and set this as the home message
    const session = getSession(chatId);
    session.activeFlow = null;
    session.activeMessageId = null;
    session.homeMessageId = loadingMsg.message_id;

    // Always call showMainMenu directly to ensure fresh data
    await showMainMenu(chatId, loadingMsg.message_id);
    
  } catch (err) {
    logger.error("/home command error:", err);
    await bot.sendMessage(chatId, "Error loading wallet data. Please try again.");
  }
});

// Connect Wallet
bot.onText(/\/connect/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    clearPendingForSlash(chatId);
    
    // Check if user already has wallet
    const u = await getUserRow(chatId);
    if (u && u.public_key) {
      return bot.sendMessage(chatId, "You already have a wallet connected. Use /start to see your wallet overview.");
    }
    
    // Start the import flow in a new message thread
    const pm = await bot.sendMessage(chatId, "Please enter your private key to connect your wallet.", {
      reply_markup: {
        inline_keyboard: [[{ text: "« Cancel", callback_data: "BACK_MAIN" }]],
      },
    });

    // Store this as the active message
    const session = getSession(chatId);
    session.activeFlow = "IMPORT_WALLET";
    session.activeMessageId = pm.message_id;

    pendingMessageHandlers[chatId] = async (msg2) => {
      try {
        if (msg2.chat.id !== chatId) return;
        if (!msg2.text) {
          await bot.sendMessage(chatId, "Invalid input. Import cancelled.", {
            reply_markup: {
              inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
            },
          });
          return;
        }
        
        const b58 = msg2.text.trim();
        try {
          const kp = loadKeypairFromSecretBase58(b58);
          const pubk = kp.publicKey.toBase58();
          await setUserRow(chatId, msg.from.username, pubk, b58);

          // Attempt to delete user message with the private key
          try {
            await bot.deleteMessage(chatId, msg2.message_id);
          } catch(e) {
            logger.error("deleteMessage error:", e.message);
          }

          // Update the original message to show success
          await bot.sendMessage(chatId, "✅ Your wallet has been successfully connected!", {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[{ text: "« Continue", callback_data: "BACK_MAIN" }]],
            },
          });

          // Return to the main menu
          const loadingMsg = await bot.sendMessage(chatId, "🔄 Loading wallet...", {
            parse_mode: "Markdown"
          });
          session.homeMessageId = loadingMsg.message_id;
          await showMainMenu(chatId, loadingMsg.message_id);
          
        } catch(e) {
          logger.error(e);
          await bot.sendMessage(chatId, "Invalid private key. Please try again.", {
            reply_markup: {
              inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
            },
          });
        }
      } catch (err) {
        logger.error("Error in pending message handler (/connect):", err);
      }
    };
    bot.once("message", pendingMessageHandlers[chatId]);
    
  } catch (err) {
    logger.error("/connect command error:", err);
    await bot.sendMessage(chatId, "Error processing your request. Please try again.");
  }
});

// ---------------------------------------------------------
// Callback queries - big try/catch
// ---------------------------------------------------------
bot.on("callback_query", async (query) => {
  try {
    const c = query.message.chat.id
    const mid = query.message.message_id
    const d = query.data

    // Clear any pending message handler so we don't overlap
    clearPendingMessageHandler(c)
    logger.info("callback_query => " + d)

    const u = await getUserRow(c)
    const cwe = await getConfigValue('create_wallet_enabled')
    const session = getSession(c);

    // If user does not have a wallet (and we want them to import):
    if ((!u || !u.public_key) &&
        !["CREATE_WALLET","IMPORT_WALLET","SET_PIN","BACK_MAIN"].includes(d))
    {
      await bot.answerCallbackQuery(query.id, {
        text: "No wallet found. Create or import first."
      })
      return
    }

    switch(d) {
      case "CREATE_WALLET":
        if ((await cwe) !== 'yes') {
          await bot.answerCallbackQuery(query.id, {
            text: "Create wallet is disabled."
          })
          return
        }
        await bot.answerCallbackQuery(query.id)
        {
          const { pubkey, secret } = createNewKeypair()
          await setUserRow(c, query.from.username, pubkey, secret)
          await showMainMenu(c, mid)
        }
        break

      case "IMPORT_WALLET":
        await bot.answerCallbackQuery(query.id)
        {
          // If this is the main menu, store it as home
          if (session.homeMessageId === null || session.homeMessageId === mid) {
            session.homeMessageId = mid;
          }
          
          // Start a new thread for import flow
          const importMsg = await bot.sendMessage(c, "Please enter your private key to connect your wallet.", {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[{ text: "« Cancel", callback_data: "BACK_MAIN" }]],
            },
          });
          
          // Track this as the active flow message
          session.activeFlow = "IMPORT_WALLET";
          session.activeMessageId = importMsg.message_id;

          pendingMessageHandlers[c] = async (msg2) => {
            try {
              if (msg2.chat.id !== c) return
              if (!msg2.text) {
                await bot.sendMessage(c, "Invalid input. Import cancelled.", {
                  reply_markup: {
                    inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                  },
                });
                return
              }
              const b58 = msg2.text.trim()
              try {
                const kp = loadKeypairFromSecretBase58(b58)
                const pubk = kp.publicKey.toBase58()
                await setUserRow(c, query.from.username, pubk, b58)

                // Attempt to delete user message with the private key
                try {
                  await bot.deleteMessage(c, msg2.message_id)
                } catch(e) {
                  logger.error("deleteMessage error:", e.message)
                }

                // Update the flow message to show success
                await bot.sendMessage(c, "✅ Your wallet has been successfully imported.", {
                  parse_mode: "Markdown",
                  reply_markup: {
                    inline_keyboard: [[{ text: "« Continue", callback_data: "BACK_MAIN" }]],
                  },
                });

                const uu = await getUserRow(c)
                if (uu && uu.public_key) {
                  const sb = await getSolBalance(uu.public_key)
                  const sp = await getSolPriceUSD()
                  const su = sb.mul(sp)
                  const minA = await getMinAutoTradeUsd()
                  if (!uu.auto_trade_unlocked && su.gte(minA)) {
                    await unlockAutoTrade(c)
                    uu.auto_trade_unlocked = 1
                  }
                  
                  // Return to main menu
                  await returnToMainMenu(c);
                  
                } else {
                  // If for some reason we couldn't get the user row
                  await bot.sendMessage(c, "An error occurred. Please try /start again.", {
                    reply_markup: {
                      inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                    },
                  });
                }
              } catch(e) {
                logger.error(e)
                await bot.sendMessage(c, "Invalid private key. Import cancelled.", {
                  reply_markup: {
                    inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                  },
                });
              }
            } catch (err) {
              logger.error("Error in pending message handler (IMPORT_WALLET):", err)
            }
          }
          bot.once("message", pendingMessageHandlers[c])
        }
        break

      case "REFRESH":
        await bot.answerCallbackQuery(query.id, { text: "Refreshing..." })
        await showMainMenu(c, mid)
        break

      case "CHECK_BAL":
        await bot.answerCallbackQuery(query.id)
        {
          // Store home message if not set
          if (session.homeMessageId === null) {
            session.homeMessageId = mid;
          }
          
          // Start a new thread for balance check
          const balMsg = await bot.sendMessage(c, "📊 *Loading positions...*", {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[{ text: "« Loading...", callback_data: "BACK_MAIN" }]],
            },
          });
          
          // Track this as the active flow message
          session.activeFlow = "CHECK_BAL";
          session.activeMessageId = balMsg.message_id;
          
          // *** BALANCE UPGRADE ***
          // We fetch the user's SOL balance, plus aggregator info for each token
          const sb = await getSolBalance(u.public_key)
          const sp = await getSolPriceUSD()
          const su = sb.mul(sp)

          let txt = `📊 *Your Positions*\n\n` + 
                    `*Wallet:* ${u.public_key}\n\n` +
                    `*SOL Balance:* ${sb.toFixed(4)} SOL (~$${su.toFixed(2)})\n\n`

          // Get all tokens, then fetch aggregator data for each; skip any with no symbol
          const rawTokens = await getAllTokenBalances(u.public_key)
          const tokenInfos = []
          // We'll do aggregator calls in parallel
          await Promise.all(rawTokens.map(async (t) => {
            // If it's SOL pseudo mint, skip
            if (t.mint === "So11111111111111111111111111111111111111112") return
            const info = await getTokenInfoFromAggregator(t.mint)
            // if aggregator returns a symbol that's empty, or price=0, skip
            if (!info || !info.symbol || !info.symbol.trim() || info.price <= 0) return
            // We have aggregator data
            // Compute how many tokens, plus approximate USD
            const userTokens = t.amount
            const tokenUsdPrice = new Decimal(info.price)
            const tokenUsdBal = userTokens.mul(tokenUsdPrice)
            // Also in SOL
            const tokenSolBal = tokenUsdBal.div(sp)
            tokenInfos.push({
              symbol: info.symbol,
              amount: userTokens,
              decimals: t.decimals,
              usdValue: tokenUsdBal,
              solValue: tokenSolBal
            })
          }))

          if (tokenInfos.length === 0) {
            txt += "No known tokens found."
          } else {
            txt += "*SPL Token Balances:*\n"
            for (const ti of tokenInfos) {
              txt += `- ${ti.symbol}: ${ti.amount.toFixed(ti.decimals)} tokens ` +
                     `(~${ti.solValue.toFixed(4)} SOL / $${ti.usdValue.toFixed(2)})\n`
            }
          }

          // Update the balance message
          await bot.editMessageText(txt, {
            chat_id: c,
            message_id: balMsg.message_id,
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
            },
          });
        }
        break

      case "BACK_MAIN":
        await bot.answerCallbackQuery(query.id)
        {
          // If this is an active message (not the home message) and we have a home message
          if (session.homeMessageId && mid !== session.homeMessageId) {
            try {
              // Delete the current message if it's the active message
              if (session.activeMessageId === mid) {
                await bot.deleteMessage(c, mid);
                session.activeMessageId = null;
              }
              
              // Refresh the home message
              await showMainMenu(c, session.homeMessageId);
              
              // Reset active flow
              session.activeFlow = null;
            } catch (err) {
              logger.error("Error handling BACK_MAIN:", err);
              // Fallback to normal returnToMainMenu
              await returnToMainMenu(c);
            }
          } else {
            // Either this is the home message or we don't have a home message
            // In this case, refresh the current message as home
            session.homeMessageId = mid;
            session.activeFlow = null;
            session.activeMessageId = null;
            await showMainMenu(c, mid);
          }
        }
        break

      case "SETTINGS_MENU":
        await bot.answerCallbackQuery(query.id)
        {
          // Store home message if not set
          if (session.homeMessageId === null) {
            session.homeMessageId = mid;
          }
          
          // Start a new thread for settings
          const settingsMsg = await bot.sendMessage(c, "⚙️ *Loading settings...*", {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[{ text: "« Loading...", callback_data: "BACK_MAIN" }]],
            },
          });
          
          // Track this as the active flow message
          session.activeFlow = "SETTINGS";
          session.activeMessageId = settingsMsg.message_id;
          
          const txt = `⚙️ *Wallet Settings*\n\nManage your wallet preferences and security.`
          await bot.editMessageText(txt, {
            chat_id: c,
            message_id: settingsMsg.message_id,
            parse_mode: "Markdown",
            reply_markup: settingsKeyboard()
          });
        }
        break

      case "REMOVE_WALLET":
        await bot.answerCallbackQuery(query.id)
        {
          // Continue in the settings thread - make sure we have the active message ID
          const confirmMsg = await bot.sendMessage(c, "⚠️ *Warning* ⚠️\n\nAre you sure you want to remove your wallet from this bot?", {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "✅ Confirm Remove", callback_data: "REMOVE_WALLET_CONFIRM" },
                  { text: "❌ Cancel", callback_data: "SETTINGS_MENU" },
                ],
              ],
            },
          });
          
          session.activeFlow = "SETTINGS_REMOVE";
          session.activeMessageId = confirmMsg.message_id;
        }
        break

      case "REMOVE_WALLET_CONFIRM":
        await bot.answerCallbackQuery(query.id)
        {
          await removeUserRow(c)
          
          // Update the confirm message
          await bot.editMessageText("✅ Your wallet has been removed from the bot.", {
            chat_id: c,
            message_id: mid,
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[{ text: "« Back to Main", callback_data: "BACK_MAIN" }]],
            },
          });
          
          // Return to main menu which will now show the "no wallet" state
          await returnToMainMenu(c);
        }
        break

      // Add this case - alphabetical order with other V* cases
      case "VIEW_PRIVKEY":
        await bot.answerCallbackQuery(query.id)
        {
          // Continue in the settings thread
          await bot.sendMessage(c, "For security reasons, private keys are not displayed here. Please keep your key safe and never share it.", {
            reply_markup: {
              inline_keyboard: [[{ text: "« Back", callback_data: "SETTINGS_MENU" }]],
            },
          });
        }
        break

      // Add this case to your callback_query switch statement
      case "SHOW_HELP":
        await bot.answerCallbackQuery(query.id);
        {
          // Store home message if not set
          if (session.homeMessageId === null) {
            session.homeMessageId = mid;
          }
          
          // Start a new thread for help
          const helpMsg = await bot.sendMessage(c, "❓ *Loading help...*", {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[{ text: "« Loading...", callback_data: "BACK_MAIN" }]],
            },
          });
          
          // Track this as the active flow message
          session.activeFlow = "HELP";
          session.activeMessageId = helpMsg.message_id;
          
          const helpMessage = 
`🚀 *Solana Memesbot Help*  

🔹 *Getting Started*  
- Use /start to open the main menu  
- Connect a wallet via *Import Wallet* (private key)  
- Check balances with /positions  

💡 *Key Features*  
- *💹 Buy Tokens*: Swap SOL → any SPL token (enter mint address)  
- *💱 Sell Tokens*: Swap SPL tokens → SOL (auto-detects holdings)  
- *🤖 Auto-Trade*: Allocate SOL for priority access to new launches  
- *💸 Withdraw*: Send SOL to external wallets  

⚠️ *Trading Tips*  
- Default slippage: 1% 
- Failed swap? Check:  
- Enough SOL for gas + amount  
- Valid token mint address  
- Slippage too low for volatile tokens  

🔒 *Security*  
- Private keys are *never* displayed/stored in plaintext  
- Admins will *never* DM first or ask for your key  

*Pro Tip:* Use /buy [mint] or /sell [amount] for quick actions!
`;

          await bot.editMessageText(helpMessage, {
            chat_id: c,
            message_id: helpMsg.message_id,
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "« Back to Main", callback_data: "BACK_MAIN" }]
              ]
            }
          });
        }
        break;
      
      case "AUTO_TRADE":
        await bot.answerCallbackQuery(query.id);
        {
          // Store home message if not set
          if (session.homeMessageId === null) {
            session.homeMessageId = mid;
          }
          
          // Start a new thread for auto-trade
          const autoTradeMsg = await bot.sendMessage(c, "🤖 *Loading auto-trade...*", {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[{ text: "« Loading...", callback_data: "BACK_MAIN" }]],
            },
          });
          
          // Track this as the active flow message
          session.activeFlow = "AUTO_TRADE";
          session.activeMessageId = autoTradeMsg.message_id;
            
          const aE = Boolean(u.auto_trade_enabled);
          const sb2 = await getSolBalance(u.public_key);
          const minA2 = await getMinAutoTradeUsd();
          const optimalA2 = await getOptimalAutoTradeUsd();
          const solPrice = await getSolPriceUSD();
          const userSolUsd = sb2.mul(solPrice);
    
          if (aE) {
            await bot.editMessageText(
              "🤖 *Auto-Trade Status*: 🟢 ACTIVE\n\n" +
              "Would you like to disable Auto-Trade?",
              {
                chat_id: c,
                message_id: autoTradeMsg.message_id,
                parse_mode: "Markdown",
                reply_markup: {
                  inline_keyboard: [
                    [{ text: "🔴 Disable Auto-Trade", callback_data: "AUTO_TRADE_OFF" }],
                    [{ text: "🔙 Back to Main", callback_data: "BACK_MAIN" }],
                  ],
                },
              }
            );
          } else {
            const userBalMsg = 
`🚀 *Auto-Trade Activation*  
*Current Balance:* ${sb2.toFixed(4)} SOL ($${userSolUsd.toFixed(2)})
                
💎 *Beat the snipers*—your wallet gets first access!
                
⬇ *Allocate SOL to secure your advantage:*  
▸ *Minimum:* ${minA2.toFixed(1)} SOL
▸ *Optimal:* ${optimalA2.toFixed(0)}+ SOL (Max Priority)
                
💡 *Pro Tip:*
Higher allocations get *priority access + optimized trade execution*

Enter the amount of SOL to allocate:
`;
            await bot.editMessageText(userBalMsg, {
              chat_id: c,
              message_id: autoTradeMsg.message_id,
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [[{ text: "« Cancel", callback_data: "BACK_MAIN" }]],
              },
            });
    
            pendingMessageHandlers[c] = async (msg2) => {
              try {
                if (msg2.chat.id !== c) return;
                if (!msg2.text) {
                  await bot.sendMessage(c, "❌ Invalid input. Operation cancelled.", {
                    reply_markup: {
                      inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                    },
                  });
                  return;
                }
                
                let atAmt;
                try {
                  atAmt = new Decimal(msg2.text.trim());
                } catch {
                  await bot.sendMessage(c, "❌ Invalid amount. Please enter a valid number.", {
                    reply_markup: {
                      inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                    },
                  });
                  return;
                }
    
                const minSol = minA2.div(solPrice);
                if (atAmt.lt(minSol)) {
                  await bot.sendMessage(
                    c,
                    `⚠️ Minimum allocation is ${minSol.toFixed(4)} SOL ($${minA2.toFixed(2)}).`,
                    {
                      parse_mode: "Markdown",
                      reply_markup: {
                        inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                      },
                    }
                  );
                  return;
                }
                
                if (atAmt.gt(sb2)) {
                  await bot.sendMessage(
                    c,
                    `❌ Insufficient balance! You only have ${sb2.toFixed(4)} SOL available.`,
                    {
                      parse_mode: "Markdown",
                      reply_markup: {
                        inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                      },
                    }
                  );
                  return;
                }
                
                await setAutoTrade(c, true);
                // Send a separate success message instead of editing
                const successMsg = await bot.sendMessage(
                  c,
                  `🎉 *Auto-Trade Activated!* 🟢\n\n` +
                  `✅ *Allocated:* ${atAmt.toFixed(4)} SOL ($${atAmt.mul(solPrice).toFixed(2)})\n` +
                  `✨ *You now have priority access to new launches!*`,
                  {
                    parse_mode: "Markdown",
                    reply_markup: {
                      inline_keyboard: [[{ text: "« Back to Dashboard", callback_data: "BACK_MAIN" }]],
                    },
                  }
                );
                
                // Update session for this new success message
                session.activeMessageId = successMsg.message_id;
                
              } catch (err) {
                logger.error("Error in pending message handler (AUTO_TRADE):", err);
              }
            };
            bot.once("message", pendingMessageHandlers[c]);
          }
        }
        break;

      case "AUTO_TRADE_OFF":
        await bot.answerCallbackQuery(query.id)
        await setAutoTrade(c, false)
        
        // Send a new message for confirmation
        const offMsg = await bot.sendMessage(c, "Auto-Trade turned OFF 🔴", {
          reply_markup: {
            inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
          },
        });
        
        // Update session
        session.activeMessageId = offMsg.message_id;
        break

      case "WITHDRAW_MENU":
        await bot.answerCallbackQuery(query.id)
        {
          // Store home message if not set
          if (session.homeMessageId === null) {
            session.homeMessageId = mid;
          }
          
          // Start a new thread for withdraw flow
          const withdrawMsg = await bot.sendMessage(c, "💸 *Withdraw*\n\nEnter recipient Solana address:", {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[{ text: "« Cancel", callback_data: "BACK_MAIN" }]],
            },
          });
          
          // Track this as the active flow message
          session.activeFlow = "WITHDRAW";
          session.activeMessageId = withdrawMsg.message_id;

          pendingMessageHandlers[c] = async (m2) => {
            try {
              if (m2.chat.id !== c) return
              if (!m2.text) {
                await bot.sendMessage(c, "Invalid address. Cancelled.", {
                  reply_markup: {
                    inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                  },
                });
                return
              }
              const address = m2.text.trim()
              if (address.length !== 44) {
                await bot.sendMessage(c, "Invalid address. Cancelled.", {
                  reply_markup: {
                    inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                  },
                });
                return
              }
              
              // Save the address in the session and update message to ask for amount
              session.flowData.withdrawAddress = address;
              await bot.editMessageText(`💸 *Withdraw*\n\nRecipient: ${address}\n\nEnter SOL amount to withdraw:`, {
                chat_id: c,
                message_id: session.activeMessageId,
                parse_mode: "Markdown",
                reply_markup: {
                  inline_keyboard: [[{ text: "« Cancel", callback_data: "BACK_MAIN" }]],
                },
              });

              pendingMessageHandlers[c] = async (m3) => {
                try {
                  if (m3.chat.id !== c) return
                  if (!m3.text) {
                    await bot.sendMessage(c, "Invalid amount. Cancelled.", {
                      reply_markup: {
                        inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                      },
                    });
                    return
                  }
                  let amt
                  try {
                    amt = new Decimal(m3.text.trim())
                    if (amt.lte(0)) {
                      await bot.sendMessage(c, "Must be > 0. Cancelled.", {
                        reply_markup: {
                          inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                        },
                      });
                      return
                    }
                  } catch {
                    await bot.sendMessage(c, "Invalid amount. Cancelled.", {
                      reply_markup: {
                        inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                      },
                    });
                    return
                  }
                  const sb = await getSolBalance(u.public_key)
                  if (amt.gt(sb)) {
                    await bot.sendMessage(c, "Insufficient SOL. You have " + sb.toFixed(4), {
                      reply_markup: {
                        inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                      },
                    });
                    return
                  }
                  
                  // Update message to show processing
                  await bot.editMessageText(`💸 *Withdraw*\n\nProcessing your withdrawal of ${amt.toFixed(4)} SOL to:\n${session.flowData.withdrawAddress}\n\nPlease wait...`, {
                    chat_id: c,
                    message_id: session.activeMessageId,
                    parse_mode: "Markdown"
                  });
                  
                  const uk = loadKeypairFromSecretBase58(u.private_key)
                  const txSig = await withdrawSol(uk, session.flowData.withdrawAddress, amt.toNumber())
                  if (txSig) {
                    await bot.editMessageText(`*Withdrawal Successful!*\nTX: [View in Explorer](https://solscan.io/tx/${txSig})`, {
                      chat_id: c,
                      message_id: session.activeMessageId,
                      parse_mode: "Markdown",
                      reply_markup: {
                        inline_keyboard: [[{ text: "« Back to Dashboard", callback_data: "BACK_MAIN" }]],
                      },
                    });
                  } else {
                    await bot.editMessageText("Withdrawal failed due to transaction error.", {
                      chat_id: c,
                      message_id: session.activeMessageId,
                      parse_mode: "Markdown",
                      reply_markup: {
                        inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                      },
                    });
                  }
                } catch (err) {
                  logger.error("Error in pending message handler (WITHDRAW_MENU amt):", err)
                }
              }
              bot.once("message", pendingMessageHandlers[c])
            } catch (err) {
              logger.error("Error in pending message handler (WITHDRAW_MENU address):", err)
            }
          }
          bot.once("message", pendingMessageHandlers[c])
        }
        break

      case "BUY_MENU":
        await bot.answerCallbackQuery(query.id)
        {
          // Store home message if not set
          if (session.homeMessageId === null) {
            session.homeMessageId = mid;
          }
          
          // Make sure we have a session object for this user
          session.tokenInfo = null;

          // Show user balance here so they know how much SOL they have before picking a token
          const userSolBal = await getSolBalance(u.public_key)
          
          // Start a new thread for buy flow
          const buyMsg = await bot.sendMessage(c, `Your SOL Balance: *${userSolBal.toFixed(4)} SOL*\nEnter token symbol or address to buy:`, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[{ text: "« Cancel", callback_data: "BACK_MAIN" }]],
            },
          });
          
          // Track this as the active flow message
          session.activeFlow = "BUY";
          session.activeMessageId = buyMsg.message_id;

          pendingMessageHandlers[c] = async (m2) => {
            try {
              if (m2.chat.id !== c) return
              const mint = m2.text ? m2.text.trim() : ""
              if (!mint || mint.length < 3) {
                await bot.sendMessage(c, "Invalid mint/symbol. Cancelled.", {
                  reply_markup: {
                    inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                  },
                });
                return
              }

              // Update message to show loading
              await bot.editMessageText(`Searching for token ${mint}...\nPlease wait...`, {
                chat_id: c,
                message_id: session.activeMessageId,
                parse_mode: "Markdown"
              });

              // Fetch extended data from DexScreener
              const info = await getTokenInfoFromAggregator(mint)
              if (!info) {
                await bot.editMessageText("Token not found on DexScreener. Cancelled.", {
                  chat_id: c,
                  message_id: session.activeMessageId,
                  reply_markup: {
                    inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                  },
                });
                return
              }

              // Store in session
              session.tokenInfo = info

              // Construct informational text
              const explorerLink = `https://solscan.io/account/${info.mint}`
              const chartLink = `https://dexscreener.com/solana/${info.mint}`
              const scanLink = `https://t.me/RickBurpBot?start=${info.mint}` // example
              const symbolLine = `${info.name || "Unknown"} | ${info.symbol || "???"} | ${info.mint}`
              const lineLinks = `[Explorer](${explorerLink}) | [Chart](${chartLink}) | [Scan](${scanLink})`
              const priceLine = `*Price:* $${new Decimal(info.price || 0).toFixed(8)}`
              const changesLine = `5m: ${info.m5}%, 1h: ${info.h1}%, 6h: ${info.h6}%, 24h: ${info.h24}%`
              const mcLine = `*Market Cap:* $${new Decimal(info.marketCap || 0).toFixed(2)}`
              const piLine = `*Price Impact:* N/A`
              const userSol = await getSolBalance(u.public_key)
              const wBalanceLine = `*Wallet Balance:* ${userSol.toFixed(4)} SOL`

              const msgText =
`${symbolLine}
${lineLinks}

${priceLine}
${changesLine}
${mcLine}

${piLine}

${wBalanceLine}`;

              // Present inline keyboard
              const buyKeyboard = {
                inline_keyboard: [
                  [
                    { text: "Cancel", callback_data: "BUY_TOKEN_CANCEL" },
                    { text: "Swap ✅", callback_data: "BUY_TOKEN_SWAP" },
                  ],
                  [
                    { text: "Buy 1.0 SOL", callback_data: "BUY_TOKEN_1" },
                    { text: "Buy 5.0 SOL", callback_data: "BUY_TOKEN_5" },
                  ],
                  [
                    { text: "Buy X SOL", callback_data: "BUY_TOKEN_X" },
                  ],
                  [
                    { text: "« Back", callback_data: "BACK_MAIN" },
                  ],
                ],
              }

              await bot.editMessageText(msgText, {
                chat_id: c,
                message_id: session.activeMessageId,
                parse_mode: "Markdown",
                reply_markup: buyKeyboard,
                disable_web_page_preview: false,
              });
            } catch (err) {
              logger.error("Error in pending message handler (BUY_MENU mint):", err)
            }
          }
          bot.once("message", pendingMessageHandlers[c])
        }
        break

      case "BUY_TOKEN_CANCEL":
        await bot.answerCallbackQuery(query.id, { text: "Cancelled." });
        await returnToMainMenu(c);
        break

      case "BUY_TOKEN_SWAP":
        await bot.answerCallbackQuery(query.id)
        {
          const infoObj = session.tokenInfo;
          if (!infoObj) {
            await bot.editMessageText("Token info not found in session. Please try again.", {
              chat_id: c,
              message_id: session.activeMessageId,
              reply_markup: { 
                inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] 
              },
            });
            return
          }
          
          await bot.editMessageText(`Enter the *from token mint* (or 'So1111...' if SOL) you want to swap *into* ${infoObj.mint}:`, {
            chat_id: c,
            message_id: session.activeMessageId,
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
            },
          });

          clearPendingMessageHandler(c)
          pendingMessageHandlers[c] = async (msg2) => {
            try {
              if (msg2.chat.id !== c) return
              const fromMint = msg2.text ? msg2.text.trim() : ""
              if (!fromMint || fromMint.length < 3) {
                await bot.editMessageText("Invalid from-mint. Swap cancelled.", {
                  chat_id: c,
                  message_id: session.activeMessageId,
                  reply_markup: { 
                    inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] 
                  },
                });
                return
              }
              session.flowData.swapFromMint = fromMint;

              // Step 2: Ask how much from-token
              await bot.editMessageText(`How much of that token do you want to swap into ${infoObj.symbol}?`, {
                chat_id: c,
                message_id: session.activeMessageId,
                parse_mode: "Markdown",
                reply_markup: {
                  inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                },
              });

              clearPendingMessageHandler(c)
              pendingMessageHandlers[c] = async (msg3) => {
                try {
                  if (msg3.chat.id !== c) return
                  let amt
                  try {
                    amt = new Decimal(msg3.text.trim())
                  } catch(e) {
                    await bot.editMessageText("Invalid number. Cancelled.", {
                      chat_id: c,
                      message_id: session.activeMessageId,
                      reply_markup: { 
                        inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] 
                      },
                    });
                    return
                  }
                  if (amt.lte(0)) {
                    await bot.editMessageText("Amount must be > 0. Cancelled.", {
                      chat_id: c,
                      message_id: session.activeMessageId,
                      reply_markup: { 
                        inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] 
                      },
                    });
                    return
                  }

                  // Update to show processing
                  await bot.editMessageText(`Swapping ${amt.toFixed(4)} of ${session.flowData.swapFromMint} into ${infoObj.mint}...\nPlease wait...`, {
                    chat_id: c,
                    message_id: session.activeMessageId,
                    parse_mode: "Markdown"
                  });
                  
                  const kp = loadKeypairFromSecretBase58(u.private_key)
                  const txid = await performSwap({
                    userKeypair: kp,
                    fromTokenMint: session.flowData.swapFromMint,
                    toTokenMint: infoObj.mint,
                    amount: amt.toNumber(),
                    slippage: DEFAULT_SLIPPAGE,
                  })
                  if (txid) {
                    await bot.editMessageText(`*Swap Successful!*\nTX: [View in Explorer](https://solscan.io/tx/${txid})`, {
                      chat_id: c,
                      message_id: session.activeMessageId,
                      parse_mode: "Markdown",
                      reply_markup: { 
                        inline_keyboard: [[{ text: "« Back to Dashboard", callback_data: "BACK_MAIN" }]] 
                      },
                    });
                  } else {
                    await bot.editMessageText("Swap failed (no route or aggregator error).", {
                      chat_id: c,
                      message_id: session.activeMessageId,
                      reply_markup: { 
                        inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] 
                      },
                    });
                  }
                } catch (err) {
                  logger.error("Error in pending message handler (BUY_TOKEN_SWAP amount):", err)
                }
              }
              bot.once("message", pendingMessageHandlers[c])
            } catch (err) {
              logger.error("Error in pending message handler (BUY_TOKEN_SWAP from token):", err)
            }
          }
          bot.once("message", pendingMessageHandlers[c])
        }
        break

      case "BUY_TOKEN_1":
      case "BUY_TOKEN_5":
        await bot.answerCallbackQuery(query.id, { text: "Processing buy..." })
        {
          const infoObj = session.tokenInfo;
          if (!infoObj) {
            await bot.editMessageText("Token info not found in session. Please try again.", {
              chat_id: c,
              message_id: session.activeMessageId,
              reply_markup: { 
                inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] 
              },
            });
            return
          }
          let solAmt = d === "BUY_TOKEN_1" ? new Decimal(1) : new Decimal(5)
          const userSolBal = await getSolBalance(u.public_key)
          if (solAmt.gt(userSolBal)) {
            await bot.editMessageText(`Insufficient SOL. You have ${userSolBal.toFixed(4)}.`, {
              chat_id: c,
              message_id: session.activeMessageId,
              reply_markup: { 
                inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] 
              },
            });
            return
          }
          
          // Update to show processing
          await bot.editMessageText(`Buying ${solAmt.toFixed(1)} SOL worth of ${infoObj.symbol}...\nPlease wait...`, {
            chat_id: c,
            message_id: session.activeMessageId,
            parse_mode: "Markdown"
          });
          
          const kp = loadKeypairFromSecretBase58(u.private_key)
          const fromMint = "So11111111111111111111111111111111111111112"
          const txid = await performSwap({
            userKeypair: kp,
            fromTokenMint: fromMint,
            toTokenMint: infoObj.mint,
            amount: solAmt.toNumber(),
            slippage: DEFAULT_SLIPPAGE,
          })
          if (txid) {
            await bot.editMessageText(`*Buy Successful!*\nTX: [View in Explorer](https://solscan.io/tx/${txid})`, {
              chat_id: c,
              message_id: session.activeMessageId,
              parse_mode: "Markdown",
              reply_markup: { 
                inline_keyboard: [[{ text: "« Back to Dashboard", callback_data: "BACK_MAIN" }]] 
              },
            });
          } else {
            await bot.editMessageText("Buy failed (no route or aggregator error).", {
              chat_id: c,
              message_id: session.activeMessageId,
              reply_markup: { 
                inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] 
              },
            });
          }
        }
        break

      case "BUY_TOKEN_X":
        await bot.answerCallbackQuery(query.id, { text: "Enter the SOL amount..." })
        {
          const infoObj = session.tokenInfo;
          if (!infoObj) {
            await bot.editMessageText("Token info not found in session. Please try again.", {
              chat_id: c,
              message_id: session.activeMessageId,
              reply_markup: { 
                inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] 
              },
            });
            return
          }
          const userSolBal = await getSolBalance(u.public_key)
          const askMsg = `Your current SOL balance is *${userSolBal.toFixed(4)} SOL*.\nEnter SOL amount to buy ${infoObj.symbol}:`
          await bot.editMessageText(askMsg, {
            chat_id: c,
            message_id: session.activeMessageId,
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[{ text: "« Cancel", callback_data: "BACK_MAIN" }]],
            },
          });

          pendingMessageHandlers[c] = async (m2) => {
            try {
              if (m2.chat.id !== c) return
              if (!m2.text) {
                await bot.editMessageText("Invalid amount. Cancelled.", {
                  chat_id: c,
                  message_id: session.activeMessageId,
                  reply_markup: { 
                    inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] 
                  },
                });
                return
              }
              let amt
              try {
                amt = new Decimal(m2.text.trim())
              } catch(e) {
                await bot.editMessageText("Invalid number. Cancelled.", {
                  chat_id: c,
                  message_id: session.activeMessageId,
                  reply_markup: { 
                    inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] 
                  },
                });
                return
              }
              if (amt.lte(0)) {
                await bot.editMessageText("Amount must be > 0. Cancelled.", {
                  chat_id: c,
                  message_id: session.activeMessageId,
                  reply_markup: { 
                    inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] 
                  },
                });
                return
              }
              const userBal = await getSolBalance(u.public_key)
              if (amt.gt(userBal)) {
                await bot.editMessageText(`Insufficient balance. You only have ${userBal.toFixed(4)} SOL. Cancelled.`, {
                  chat_id: c,
                  message_id: session.activeMessageId,
                  reply_markup: { 
                    inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] 
                  },
                });
                return
              }
              
              // Update to show processing
              await bot.editMessageText(`Buying ${amt.toFixed(4)} SOL worth of ${infoObj.symbol}...\nPlease wait...`, {
                chat_id: c,
                message_id: session.activeMessageId,
                parse_mode: "Markdown"
              });
              
              // Perform swap
              const kp = loadKeypairFromSecretBase58(u.private_key)
              const fromMint = "So11111111111111111111111111111111111111112"
              const txid = await performSwap({
                userKeypair: kp,
                fromTokenMint: fromMint,
                toTokenMint: infoObj.mint,
                amount: amt.toNumber(),
                slippage: DEFAULT_SLIPPAGE,
              })
              if (txid) {
                await bot.editMessageText(`*Buy Successful!*\nTX: [View in Explorer](https://solscan.io/tx/${txid})`, {
                  chat_id: c,
                  message_id: session.activeMessageId,
                  parse_mode: "Markdown",
                  reply_markup: { 
                    inline_keyboard: [[{ text: "« Back to Dashboard", callback_data: "BACK_MAIN" }]] 
                  },
                });
              } else {
                await bot.editMessageText("Buy failed (no route or aggregator error).", {
                  chat_id: c,
                  message_id: session.activeMessageId,
                  reply_markup: { 
                    inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] 
                  },
                });
              }
            } catch (err) {
              logger.error("Error in pending message handler (BUY_TOKEN_X amount):", err)
            }
          }
          bot.once("message", pendingMessageHandlers[c])
        }
        break

      // *** SELL UPGRADE ***
      case "SELL_MENU":
        await bot.answerCallbackQuery(query.id)
        {
          // Store home message if not set
          if (session.homeMessageId === null) {
            session.homeMessageId = mid;
          }
          
          // Start a new thread for sell flow
          const sellMsg = await bot.sendMessage(c, "💱 *Loading your tokens...*\nPlease wait...", {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[{ text: "« Loading...", callback_data: "BACK_MAIN" }]],
            },
          });
          
          // Track this as the active flow message
          session.activeFlow = "SELL";
          session.activeMessageId = sellMsg.message_id;
          
          // We'll fetch all user tokens, do aggregator calls, skip those that have no symbol/price
          const bal2 = await getAllTokenBalances(u.public_key)
          const solPrice = await getSolPriceUSD()
          // Filter out SOL pseudo mint and 0 balances
          const nonSolTokens = bal2.filter(t => 
            t.mint !== "So11111111111111111111111111111111111111112" && t.amount.gt(0)
          )
          if (!nonSolTokens.length) {
            await bot.editMessageText("You do not have any tokens yet! Start trading in the Buy menu.", {
              chat_id: c,
              message_id: sellMsg.message_id,
              reply_markup: {
                inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
              },
            });
            return
          }

          // Get aggregator data for each token
          const tokenSellList = []
          await Promise.all(nonSolTokens.map(async (t) => {
            const info = await getTokenInfoFromAggregator(t.mint)
            if (!info || !info.symbol || !info.symbol.trim() || info.price <= 0) return
            const tokenUsdPrice = new Decimal(info.price)
            const tokenUsdBal = t.amount.mul(tokenUsdPrice)
            const tokenSolBal = tokenUsdBal.div(solPrice)
            tokenSellList.push({
              mint: t.mint,
              symbol: info.symbol,
              decimals: t.decimals,
              tokenBalance: t.amount,
              usdValue: tokenUsdBal,
              solValue: tokenSolBal,
              chartLink: `https://dexscreener.com/solana/${t.mint}`
            })
          }))

          if (!tokenSellList.length) {
            await bot.editMessageText("No known tokens to sell. (Aggregator info not found for your tokens.)", {
              chat_id: c,
              message_id: sellMsg.message_id,
              reply_markup: {
                inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
              },
            });
            return
          }

          // Store in session
          session.sellTokens = tokenSellList
          session.sellPage = 0

          // Show the token list in the existing message
          await showSellTokensList(c, sellMsg.message_id);
        }
        break

      // We'll handle next/prev/refresh if needed
      case "SELL_PAGE_NEXT":
        await bot.answerCallbackQuery(query.id)
        {
          session.sellPage = (session.sellPage || 0) + 1
          await showSellTokensList(c, session.activeMessageId);
        }
        break

      case "SELL_PAGE_PREV":
        await bot.answerCallbackQuery(query.id)
        {
          session.sellPage = Math.max((session.sellPage || 0) - 1, 0)
          await showSellTokensList(c, session.activeMessageId);
        }
        break

      case "SELL_PAGE_REFRESH":
        await bot.answerCallbackQuery(query.id, { text: "Refreshing..." })
        {
          // Update message to show loading
          await bot.editMessageText("💱 *Refreshing token list...*\nPlease wait...", {
            chat_id: c,
            message_id: session.activeMessageId,
            parse_mode: "Markdown"
          });
          
          // Re-fetch aggregator data from scratch
          const bal2 = await getAllTokenBalances(u.public_key)
          const solPrice = await getSolPriceUSD()
          const nonSolTokens = bal2.filter(t => 
            t.mint !== "So11111111111111111111111111111111111111112" && t.amount.gt(0)
          )
          const newList = []
          await Promise.all(nonSolTokens.map(async (t) => {
            const info = await getTokenInfoFromAggregator(t.mint)
            if (!info || !info.symbol || !info.symbol.trim() || info.price <= 0) return
            const tokenUsdPrice = new Decimal(info.price)
            const tokenUsdBal = t.amount.mul(tokenUsdPrice)
            const tokenSolBal = tokenUsdBal.div(solPrice)
            newList.push({
              mint: t.mint,
              symbol: info.symbol,
              decimals: t.decimals,
              tokenBalance: t.amount,
              usdValue: tokenUsdBal,
              solValue: tokenSolBal,
              chartLink: `https://dexscreener.com/solana/${t.mint}`
            })
          }))
          session.sellTokens = newList
          session.sellPage = 0
          if (!newList.length) {
            await bot.editMessageText("No known tokens to sell after refresh.", {
              chat_id: c,
              message_id: session.activeMessageId,
              reply_markup: {
                inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
              },
            });
          } else {
            await showSellTokensList(c, session.activeMessageId);
          }
        }
        break

      default:
        // Possibly it's a SELL_TOKEN_INDEX_ pattern
        if (d.startsWith("SELL_TOKEN_INDEX_")) {
          await bot.answerCallbackQuery(query.id)
          {
            const idx = parseInt(d.replace("SELL_TOKEN_INDEX_",""),10)
            const list = session.sellTokens || []
            if (!list[idx]) {
              await bot.editMessageText("Token index not found. Please refresh the list.", {
                chat_id: c,
                message_id: session.activeMessageId,
                reply_markup: {
                  inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                },
              });
              return
            }
            // Show user the details, ask how much they want to sell
const tk = list[idx]
            const sb = await getSolBalance(u.public_key)
            const userSolBalUsd = sb.mul(await getSolPriceUSD())
            
            // Update message to show token details and ask for amount
            const sellMsg = 
`*Select a token to sell* (${list.length} total)
*Balance:* ${sb.toFixed(4)} SOL ($${userSolBalUsd.toFixed(2)})

[**🄲 ${tk.symbol}**](${tk.chartLink})
Token Balance: ${tk.tokenBalance.toFixed(tk.decimals)}
In SOL: ${tk.solValue.toFixed(4)} SOL
In USD: $${tk.usdValue.toFixed(2)}

How many *${tk.symbol}* do you want to sell?`;

            await bot.editMessageText(sellMsg, {
              chat_id: c,
              message_id: session.activeMessageId,
              parse_mode: "Markdown",
              disable_web_page_preview: false,
              reply_markup: {
                inline_keyboard: [
                  [{ text: "« Back", callback_data: "SELL_MENU" }],
                ],
              },
            });

            // Store the token index in the session
            session.flowData.sellTokenIndex = idx;

            // Wait for user to enter amount
            pendingMessageHandlers[c] = async (m2) => {
              try {
                if (m2.chat.id !== c) return
                if (!m2.text) {
                  await bot.editMessageText("Invalid amount. Cancelled.", {
                    chat_id: c,
                    message_id: session.activeMessageId,
                    reply_markup: {
                      inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                    },
                  });
                  return
                }
                let sAmt
                try {
                  sAmt = new Decimal(m2.text.trim())
                  if (sAmt.lte(0)) {
                    await bot.editMessageText("Amount must be > 0. Cancelled.", {
                      chat_id: c,
                      message_id: session.activeMessageId,
                      reply_markup: {
                        inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                      },
                    });
                    return
                  }
                } catch {
                  await bot.editMessageText("Invalid amount. Cancelled.", {
                    chat_id: c,
                    message_id: session.activeMessageId,
                    reply_markup: {
                      inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                    },
                  });
                  return
                }

                if (sAmt.gt(tk.tokenBalance)) {
                  await bot.editMessageText(`Insufficient tokens. You only have ${tk.tokenBalance.toFixed(tk.decimals)}.`, {
                    chat_id: c,
                    message_id: session.activeMessageId,
                    reply_markup: {
                      inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                    },
                  });
                  return
                }

                // Store amount in session
                session.flowData.sellAmount = sAmt.toString();

                // Next: ask user to proceed or cancel
                const confirmTxt = `You are about to sell *${sAmt.toFixed(tk.decimals)}* of ${tk.symbol}.\nProceed to convert to SOL?`
                await bot.editMessageText(confirmTxt, {
                  chat_id: c,
                  message_id: session.activeMessageId,
                  parse_mode: "Markdown",
                  reply_markup: {
                    inline_keyboard: [
                      [
                        { text: "✅ Proceed", callback_data: `SELL_PROCEED_${idx}_${sAmt.toString()}` },
                        { text: "❌ Cancel", callback_data: "SELL_MENU" },
                      ],
                    ],
                  },
                });
              } catch (err) {
                logger.error("Error in pending message handler (SELL_TOKEN_INDEX_...):", err)
              }
            }
            bot.once("message", pendingMessageHandlers[c])
          }
        }
        // Possibly it's a SELL_PROCEED_ pattern
        else if (d.startsWith("SELL_PROCEED_")) {
          await bot.answerCallbackQuery(query.id)
          {
            // parse => SELL_PROCEED_index_amount
            const parts = d.split("_")
            const idx = parseInt(parts[2],10)
            const rawAmt = parts[3]
            const amt = new Decimal(rawAmt || "0")
            const list = session.sellTokens || []
            if (!list[idx]) {
              await bot.editMessageText("Token index not found. Please refresh the list.", {
                chat_id: c,
                message_id: session.activeMessageId,
                reply_markup: {
                  inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                },
              });
              return
            }
            const tk = list[idx]
            
            // Update message to show processing
            await bot.editMessageText(`💱 *Selling Token*\n\nProcessing sale of ${amt.toFixed(tk.decimals)} ${tk.symbol}...\nPlease wait...`, {
              chat_id: c,
              message_id: session.activeMessageId,
              parse_mode: "Markdown"
            });
            
            // Double-check user balance
            const bals = await getAllTokenBalances(u.public_key)
            const fTok = bals.find((b) => b.mint === tk.mint)
            if (!fTok || fTok.amount.lt(amt)) {
              await bot.editMessageText("Insufficient tokens at the time of sell. Sell cancelled.", {
                chat_id: c,
                message_id: session.activeMessageId,
                reply_markup: {
                  inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                },
              });
              return
            }

            const kp = loadKeypairFromSecretBase58(u.private_key)
            const toSolMint = "So11111111111111111111111111111111111111112"
            const txid = await performSwap({
              userKeypair: kp,
              fromTokenMint: tk.mint,
              toTokenMint: toSolMint,
              amount: amt.toNumber(),
              slippage: DEFAULT_SLIPPAGE,
            })
            if (txid) {
              await bot.editMessageText(`*Sell Successful!*\nTX: [View in Explorer](https://solscan.io/tx/${txid})`, {
                chat_id: c,
                message_id: session.activeMessageId,
                parse_mode: "Markdown",
                reply_markup: {
                  inline_keyboard: [[{ text: "« Back to Dashboard", callback_data: "BACK_MAIN" }]],
                },
              });
            } else {
              await bot.editMessageText("Sell failed (aggregator error or no route).", {
                chat_id: c,
                message_id: session.activeMessageId,
                reply_markup: {
                  inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                },
              });
            }
          }
        }
        else {
          // We handle unknown callback gracefully
          await bot.answerCallbackQuery(query.id, {
            text: "Unknown callback data: " + d
          })
        }
        break
    }
  } catch (err) {
    logger.error("callback_query error:", err)
    // If we haven't answered yet, we can do a safe answer
    try {
      await bot.answerCallbackQuery(query.id, { text: "An error occurred." })
    } catch(e) {
      logger.error("Failed to answerCallbackQuery in catch:", e)
    }
  }
})

// ---------------------------------------------------------
// Helper to show SELL tokens list (pagination up to 6 tokens)
// *** SELL UPGRADE *** function - Modified to accept messageId for editing
// ---------------------------------------------------------
async function showSellTokensList(chatId, messageId) {
  try {
    const u = await getUserRow(chatId)
    if (!u) return
    const userData = getSession(chatId)
    if (!userData || !userData.sellTokens) return

    const tokens = userData.sellTokens
    const page = userData.sellPage || 0
    const pageSize = 6
    const startIndex = page * pageSize
    const endIndex = Math.min(startIndex + pageSize, tokens.length)

    const userSolBal = await getSolBalance(u.public_key)
    const userSolBalUsd = userSolBal.mul(await getSolPriceUSD())

    let txt = `**Select a token to sell** (${tokens.length} found)\n` +
              `**Balance**: ${userSolBal.toFixed(4)} SOL ($${userSolBalUsd.toFixed(2)})\n\n`

    for (let i = startIndex; i < endIndex; i++) {
      const tk = tokens[i]
      // Example line: [**🄲 {symbol}**](chart) — {solValue} SOL ($usdValue) [Hide]
      txt += `[**🄲 ${tk.symbol}**](${tk.chartLink}) — ${tk.solValue.toFixed(4)} SOL ($${tk.usdValue.toFixed(2)})\n`
    }

    // Build inline keyboard
    const inlineKb = []
    // For each token in current page, add a row with a button
    for (let i = startIndex; i < endIndex; i++) {
      const tk = tokens[i]
      inlineKb.push([
        { text: tk.symbol, callback_data: `SELL_TOKEN_INDEX_${i}` }
      ])
    }

    // Now add navigation row
    const navRow = []
    if (page > 0) {
      navRow.push({ text: "Prev", callback_data: "SELL_PAGE_PREV" })
    }
    if (endIndex < tokens.length) {
      navRow.push({ text: "Next", callback_data: "SELL_PAGE_NEXT" })
    }
    if (navRow.length) {
      inlineKb.push(navRow)
    }

    // Add Refresh + Back row
    inlineKb.push([
      { text: "Refresh", callback_data: "SELL_PAGE_REFRESH" },
      { text: "« Back", callback_data: "BACK_MAIN" },
    ])

    // Now we edit the existing message instead of sending a new one
    await bot.editMessageText(txt, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "Markdown",
      disable_web_page_preview: false,
      reply_markup: {
        inline_keyboard: inlineKb
      },
    });
  } catch (err) {
    logger.error("showSellTokensList error:", err)
    await bot.editMessageText("Error displaying token list. Please try again or /start.", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: {
        inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
      },
    });
  }
}

// ---------------------------------------------------------
// Slash commands
// ---------------------------------------------------------
bot.setMyCommands([
  { command: "start", description: "Show the main menu" },
  { command: "home", description: "Show wallet overview" },
  { command: "positions", description: "Check your SOL & token positions" },
  { command: "buy", description: "Buy tokens (swap SOL->token)" },
  { command: "sell", description: "Sell tokens (swap token->SOL)" },
  { command: "withdraw", description: "Withdraw SOL to another address" },
  { command: "settings", description: "Manage wallet settings" },
  { command: "help", description: "Show help info" },
]);

// /help
bot.onText(/\/help/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    clearPendingForSlash(chatId);
    
    const helpMessage = 
`🚀 *Solana Memesbot Help*  

🔹 *Getting Started*  
- Use /start to open the main menu  
- Connect a wallet via *Import Wallet* (private key)  
- Check balances with /positions  

💡 *Key Features*  
- *💹 Buy Tokens*: Swap SOL → any SPL token (enter mint address)  
- *💱 Sell Tokens*: Swap SPL tokens → SOL (auto-detects holdings)  
- *🤖 Auto-Trade*: Allocate SOL for priority access to new launches  
- *💸 Withdraw*: Send SOL to external wallets  

⚠️ *Trading Tips*  
- Default slippage: 1% 
- Failed swap? Check:  
- Enough SOL for gas + amount  
- Valid token mint address  
- Slippage too low for volatile tokens  

🔒 *Security*  
- Private keys are *never* displayed/stored in plaintext  
- Admins will *never* DM first or ask for your key  

*Pro Tip:* Use /buy [mint] or /sell [amount] for quick actions!
`;

    await bot.sendMessage(chatId, helpMessage, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [{ text: "« Back to Main", callback_data: "BACK_MAIN" }]
        ]
      }
    });

  } catch (err) {
    logger.error("/help command error:", err);
    await bot.sendMessage(chatId, "Error loading help information. Please try again.");
  }
});

// /positions
bot.onText(/\/positions/, async (msg) => {
  try {
    const c = msg.chat.id
    clearPendingForSlash(c)
    const u = await getUserRow(c)
    if (!u || !u.public_key) {
      return bot.sendMessage(c, "No wallet found. Please /start => create or import one.")
    }
// *** BALANCE UPGRADE (same as CHECK_BAL block) ***
    const sb = await getSolBalance(u.public_key)
    const sp = await getSolPriceUSD()
    const su = sb.mul(sp)

    let txt = `📊 *Your Positions*\n\n` +
              `*Wallet:* ${u.public_key}\n\n` +
              `*SOL Balance:* ${sb.toFixed(4)} SOL (~$${su.toFixed(2)})\n\n`

    const rawTokens = await getAllTokenBalances(u.public_key)
    const tokenInfos = []
    await Promise.all(rawTokens.map(async (t) => {
      if (t.mint === "So11111111111111111111111111111111111111112") return
      const info = await getTokenInfoFromAggregator(t.mint)
      if (!info || !info.symbol || !info.symbol.trim() || info.price <= 0) return
      const userTokens = t.amount
      const tokenUsdPrice = new Decimal(info.price)
      const tokenUsdBal = userTokens.mul(tokenUsdPrice)
      const tokenSolBal = tokenUsdBal.div(sp)
      tokenInfos.push({
        symbol: info.symbol,
        amount: userTokens,
        decimals: t.decimals,
        usdValue: tokenUsdBal,
        solValue: tokenSolBal
      })
    }))

    if (tokenInfos.length === 0) {
      txt += "No known tokens found."
    } else {
      txt += "*SPL Token Balances:*\n"
      for (const ti of tokenInfos) {
        txt += `- ${ti.symbol}: ${ti.amount.toFixed(ti.decimals)} tokens ` +
               `(~${ti.solValue.toFixed(4)} SOL / $${ti.usdValue.toFixed(2)})\n`
      }
    }

    bot.sendMessage(c, txt, { parse_mode: "Markdown" })
  } catch (err) {
    logger.error("/balances command error:", err)
  }
})

// /buy
bot.onText(/\/buy/, (msg) => {
  try {
    const c = msg.chat.id
    clearPendingForSlash(c)
    bot.sendMessage(c, "Use the main menu ( /start ) => 💹 Buy.")
  } catch (err) {
    logger.error("/buy command error:", err)
  }
})

// /sell
bot.onText(/\/sell/, (msg) => {
  try {
    const c = msg.chat.id
    clearPendingForSlash(c)
    bot.sendMessage(c, "Use the main menu ( /start ) => 💱 Sell.")
  } catch (err) {
    logger.error("/sell command error:", err)
  }
})

// /withdraw
bot.onText(/\/withdraw/, (msg) => {
  try {
    const c = msg.chat.id
    clearPendingForSlash(c)
    bot.sendMessage(c, "Use the main menu ( /start ) => 💸 Withdraw.")
  } catch (err) {
    logger.error("/withdraw command error:", err)
  }
})

// /settings
bot.onText(/\/settings/, (msg) => {
  try {
    const c = msg.chat.id
    clearPendingForSlash(c)
    bot.sendMessage(c, "Use the main menu ( /start ) => ⚙️ Settings.")
  } catch (err) {
    logger.error("/settings command error:", err)
  }
})

logger.info("Telegram bot started...")
