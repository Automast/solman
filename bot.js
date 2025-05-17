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

// Clear pending handler for a chat
function clearPendingMessageHandler(chatId) {
  if (pendingMessageHandlers[chatId]) {
    bot.removeListener("message", pendingMessageHandlers[chatId])
    delete pendingMessageHandlers[chatId]
  }
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
        `
        UPDATE users
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
        `
        UPDATE users
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
        { text: "📈 PNL", callback_data: "PNL_MENU" },
        { text: "⚙️ Settings", callback_data: "SETTINGS_MENU" },
      ],
      [
        { text: "❓ Help", callback_data: "SHOW_HELP" },
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

// PNL time period selection keyboard
function pnlTimeframeKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "24 Hours", callback_data: "PNL_24H" },
        { text: "3 Days", callback_data: "PNL_3D" },
      ],
      [
        { text: "7 Days", callback_data: "PNL_7D" },
        { text: "1 Month", callback_data: "PNL_1M" },
      ],
      [
        { text: "1 Year", callback_data: "PNL_1Y" },
        { text: "All Time", callback_data: "PNL_ALL" },
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
  } catch (err) {
    logger.error("editMessageText error:", err.message)
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

// Show main menu
async function showMainMenu(chatId, messageId) {
  try {
    const u = await getUserRow(chatId);
    const solMarketData = await getSolMarketData();
    
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
    await bot.sendMessage(chatId, "Error loading wallet overview. Please try again.");
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

    // Send loading message first
    const loadingMsg = await bot.sendMessage(chatId, `🚀 Loading Solana Memesbot...`, {
      parse_mode: "Markdown"
    });

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

    // Send loading message first
    const loadingMsg = await bot.sendMessage(chatId, `🔄 Loading wallet overview...`, {
      parse_mode: "Markdown"
    });

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
    
    // Start the import flow
    const pm = await bot.sendMessage(chatId, "Please enter your private key to connect your wallet.", {
      reply_markup: {
        inline_keyboard: [[{ text: "« Cancel", callback_data: "BACK_MAIN" }]],
      },
    });

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

          // Attempt to delete user message and the prompt
          try {
            await bot.deleteMessage(chatId, msg2.message_id);
            await bot.deleteMessage(chatId, pm.message_id);
          } catch(e) {
            logger.error("deleteMessage error:", e.message);
          }

          await bot.sendMessage(chatId, "✅ Your wallet has been successfully connected!", {
            parse_mode: "Markdown"
          });

          // Show the main menu with updated wallet info
          const loadingMsg = await bot.sendMessage(chatId, `🔄 Loading wallet...`, {
            parse_mode: "Markdown"
          });
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
          const pm = await bot.sendMessage(c, "Please enter your private key.", {
            reply_markup: {
              inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
            },
          })

          pendingMessageHandlers[c] = async (msg2) => {
            try {
              if (msg2.chat.id !== c) return
              if (!msg2.text) {
                await bot.sendMessage(c, "Invalid input. Import cancelled.", {
                  reply_markup: {
                    inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                  },
                })
                return
              }
              const b58 = msg2.text.trim()
              try {
                const kp = loadKeypairFromSecretBase58(b58)
                const pubk = kp.publicKey.toBase58()
                await setUserRow(c, query.from.username, pubk, b58)

                // Attempt to delete user message and the prompt
                try {
                  await bot.deleteMessage(c, msg2.message_id)
                  await bot.deleteMessage(c, pm.message_id)
                } catch(e) {
                  logger.error("deleteMessage error:", e.message)
                }

                await bot.sendMessage(c, "✅ Your wallet has been successfully imported.", {
                  parse_mode: "Markdown"
                })

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
                  const link = "https://solscan.io/account/" + uu.public_key
                  let txt = "💳 *Your Wallet*\n"
                  txt += " ↳ " + uu.public_key + " [Solscan](" + link + ")\n"
                  txt += " ↳ Balance: *" + sb.toFixed(4) + " SOL*\n\n"
                  txt += "💰 *SOL Price:* $" + sp.toFixed(2)
                  const ae = Boolean(uu.auto_trade_enabled)
                  await bot.sendMessage(c, txt, {
                    parse_mode: "Markdown",
                    reply_markup: mainMenuKeyboard(ae),
                    disable_web_page_preview: true,
                  })
                } else {
                  await bot.sendMessage(c, "An error occurred. Please try /start again.", {
                    reply_markup: {
                      inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                    },
                  })
                }
              } catch(e) {
                logger.error(e)
                await bot.sendMessage(c, "Invalid private key. Import cancelled.", {
                  reply_markup: {
                    inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                  },
                })
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
          // *** BALANCE UPGRADE ***
          // We fetch the user's SOL balance, plus aggregator info for each token
          const sb = await getSolBalance(u.public_key)
          const sp = await getSolPriceUSD()
          const su = sb.mul(sp)

          let txt = `📊 *Your Positions*\n\n` +  // Changed from "Wallet Address"
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

          await bot.sendMessage(c, txt, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
            },
          })
        }
        break

        case "PNL_MENU":
  await bot.answerCallbackQuery(query.id)
  {
    const txt = `📈 *Profit and Loss Analysis*\n\nSelect a time period to view your trading performance:`
    await editMessageText(c, mid, txt, pnlTimeframeKeyboard())
  }
  break

  case "PNL_24H":
    case "PNL_3D":
    case "PNL_7D":
    case "PNL_1M": 
    case "PNL_1Y":
    case "PNL_ALL":
      await bot.answerCallbackQuery(query.id, { text: "Calculating PNL..." })
      {
        // Map callback data to period string
        const periodMap = {
          "PNL_24H": "24h",
          "PNL_3D": "3d",
          "PNL_7D": "7d",
          "PNL_1M": "1m",
          "PNL_1Y": "1y",
          "PNL_ALL": "all"
        }
        
        const period = periodMap[d]
        
        // Display loading message
        await editMessageText(c, mid, "📊 *Calculating PNL*\n\nAnalyzing your trading history. This may take a moment...", {
          inline_keyboard: [
            [{ text: "« Back", callback_data: "PNL_MENU" }]
          ]
        })
        
        // Calculate PNL for the selected period
        const pnlData = await calculatePNL(u.public_key, period)
        
        // Add wallet address to the PNL data for links
        pnlData.walletAddress = u.public_key
        
        // Display the results
        await displayPNL(c, pnlData)
      }
      break

      case "BACK_MAIN":
        await bot.answerCallbackQuery(query.id)
        await showMainMenu(c, mid)
        break

      case "SETTINGS_MENU":
        await bot.answerCallbackQuery(query.id)
        {
          const txt = `⚙️ *Wallet Settings*\n\nManage your wallet preferences and security.`
          await editMessageText(c, mid, txt, settingsKeyboard())
        }
        break

      case "REMOVE_WALLET":
        await bot.answerCallbackQuery(query.id)
        {
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
          })
        }
        break

      case "REMOVE_WALLET_CONFIRM":
        await bot.answerCallbackQuery(query.id)
        {
          await removeUserRow(c)
          await bot.sendMessage(c, "✅ Your wallet has been removed from the bot.", {
            reply_markup: {
              inline_keyboard: [[{ text: "« Back to Main", callback_data: "BACK_MAIN" }]],
            },
          })
          // Show main menu which will now show the "no wallet" state
          await showMainMenu(c, mid)
        }
        break

      // Add this case - alphabetical order with other V* cases
      case "VIEW_PRIVKEY":
        await bot.answerCallbackQuery(query.id)
        {
          // Security precaution - don't send private key in clear text
          await bot.sendMessage(c, "For security reasons, private keys are not displayed here. Please keep your key safe and never share it.", {
            reply_markup: {
              inline_keyboard: [[{ text: "« Back", callback_data: "SETTINGS_MENU" }]],
            },
          })
        }
        break

      // Add this case to your callback_query switch statement
      case "SHOW_HELP":
        await bot.answerCallbackQuery(query.id);
        {
          const helpMessage = `
🚀 *Solana Memesbot Help*  

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

          await bot.sendMessage(c, helpMessage, {
            parse_mode: "Markdown",
            disable_web_page_preview: true,
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
            const aE = Boolean(u.auto_trade_enabled);
            const sb2 = await getSolBalance(u.public_key);
            const minA2 = await getMinAutoTradeUsd();
            const optimalA2 = await getOptimalAutoTradeUsd();
            const solPrice = await getSolPriceUSD();
            const userSolUsd = sb2.mul(solPrice);
    
            const userBalMsg = 
`🚀 *Auto-Trade Activation*  
*Current Balance:* ${sb2.toFixed(4)} SOL ($${userSolUsd.toFixed(2)})
                
💎 *Beat the snipers*—your wallet gets first access!
                
⬇ *Allocate SOL to secure your advantage:*  
▸ *Minimum:* ${minA2.toFixed(1)} SOL
▸ *Optimal:* ${optimalA2.toFixed(0)}+ SOL (Max Priority)
                
💡 *Pro Tip:*
Higher allocations get *priority access + optimized trade execution*`;
    
            if (aE) {
                await bot.sendMessage(c, 
                    "🤖 *Auto-Trade Status*: 🟢 ACTIVE\n\n" +
                    "Would you like to disable Auto-Trade?",
                    {
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
                const promptMsg = await bot.sendMessage(c, userBalMsg, {
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
                        await bot.sendMessage(
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
        await bot.sendMessage(c, "Auto-Trade turned OFF 🔴", {
          reply_markup: {
            inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
          },
        })
        break

      case "WITHDRAW_MENU":
        await bot.answerCallbackQuery(query.id)
        {
          const askA = await bot.sendMessage(c, "Enter recipient Solana address:", {
            reply_markup: {
              inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
            },
          })

          pendingMessageHandlers[c] = async (m2) => {
            try {
              if (m2.chat.id !== c) return
              if (!m2.text) {
                await bot.sendMessage(c, "Invalid address. Cancelled.", {
                  reply_markup: {
                    inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                  },
                })
                return
              }
              const address = m2.text.trim()
              if (address.length !== 44) {
                await bot.sendMessage(c, "Invalid address. Cancelled.", {
                  reply_markup: {
                    inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                  },
                })
                return
              }
              const askAmt = await bot.sendMessage(c, "Enter SOL amount", {
                reply_markup: {
                  inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                },
              })

              pendingMessageHandlers[c] = async (m3) => {
                try {
                  if (m3.chat.id !== c) return
                  if (!m3.text) {
                    await bot.sendMessage(c, "Invalid amount. Cancelled.", {
                      reply_markup: {
                        inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                      },
                    })
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
                      })
                      return
                    }
                  } catch {
                    await bot.sendMessage(c, "Invalid amount. Cancelled.", {
                      reply_markup: {
                        inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                      },
                    })
                    return
                  }
                  const sb = await getSolBalance(u.public_key)
                  if (amt.gt(sb)) {
                    await bot.sendMessage(c, "Insufficient SOL. You have " + sb.toFixed(4), {
                      reply_markup: {
                        inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                      },
                    })
                    return
                  }
                  await bot.sendMessage(c, "Processing your withdrawal...")
                  const uk = loadKeypairFromSecretBase58(u.private_key)
                  const txSig = await withdrawSol(uk, address, amt.toNumber())
                  if (txSig) {
                    await bot.sendMessage(c, `*Withdrawal Successful!*\nTX: [View in Explorer](https://solscan.io/tx/${txSig})`, {
                      parse_mode: "Markdown",
                      reply_markup: {
                        inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                      },
                    })
                  } else {
                    await bot.sendMessage(c, "Withdrawal failed due to transaction error.", {
                      reply_markup: {
                        inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                      },
                    })
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
          // Make sure we have a session object for this user
          userSessions[c] = userSessions[c] || {}
          userSessions[c].tokenInfo = null

          // Show user balance here so they know how much SOL they have before picking a token
          const userSolBal = await getSolBalance(u.public_key)
          const buyPrompt = `Your SOL Balance: *${userSolBal.toFixed(4)} SOL*\nEnter token symbol or address to buy:`
          const am = await bot.sendMessage(c, buyPrompt, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
            },
          })

          pendingMessageHandlers[c] = async (m2) => {
            try {
              if (m2.chat.id !== c) return
              const mint = m2.text ? m2.text.trim() : ""
              if (!mint || mint.length < 3) {
                await bot.sendMessage(c, "Invalid mint/symbol. Cancelled.", {
                  reply_markup: {
                    inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                  },
                })
                return
              }

              // Fetch extended data from DexScreener
              const info = await getTokenInfoFromAggregator(mint)
              if (!info) {
                await bot.sendMessage(c, "Token not found on DexScreener. Cancelled.", {
                  reply_markup: {
                    inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                  },
                })
                return
              }

              // Store in userSessions
              userSessions[c].tokenInfo = info

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

${wBalanceLine}`

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

              await bot.sendMessage(c, msgText, {
                parse_mode: "Markdown",
                reply_markup: buyKeyboard,
                disable_web_page_preview: false,
              })
            } catch (err) {
              logger.error("Error in pending message handler (BUY_MENU mint):", err)
            }
          }
          bot.once("message", pendingMessageHandlers[c])
        }
        break

      case "BUY_TOKEN_CANCEL":
        await bot.answerCallbackQuery(query.id, { text: "Cancelled." })
        await showMainMenu(c, mid)
        break

      case "BUY_TOKEN_SWAP":
        await bot.answerCallbackQuery(query.id)
        {
          const infoObj = userSessions[c] && userSessions[c].tokenInfo
          if (!infoObj) {
            await bot.sendMessage(c, "Token info not found in session. Please try again.", {
              reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] },
            })
            return
          }
          await bot.sendMessage(c, `Enter the *from token mint* (or 'So1111...' if SOL) you want to swap *into* ${infoObj.mint}:`, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
            },
          })

          clearPendingMessageHandler(c)
          pendingMessageHandlers[c] = async (msg2) => {
            try {
              if (msg2.chat.id !== c) return
              const fromMint = msg2.text ? msg2.text.trim() : ""
              if (!fromMint || fromMint.length < 3) {
                await bot.sendMessage(c, "Invalid from-mint. Swap cancelled.", {
                  reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] },
                })
                return
              }
              userSessions[c].swapFromMint = fromMint

              // Step 2: Ask how much from-token
              await bot.sendMessage(c, `How much of that token do you want to swap into ${infoObj.symbol}?`, {
                parse_mode: "Markdown",
                reply_markup: {
                  inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                },
              })

              clearPendingMessageHandler(c)
              pendingMessageHandlers[c] = async (msg3) => {
                try {
                  if (msg3.chat.id !== c) return
                  let amt
                  try {
                    amt = new Decimal(msg3.text.trim())
                  } catch(e) {
                    await bot.sendMessage(c, "Invalid number. Cancelled.", {
                      reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] },
                    })
                    return
                  }
                  if (amt.lte(0)) {
                    await bot.sendMessage(c, "Amount must be > 0. Cancelled.", {
                      reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] },
                    })
                    return
                  }

                  await bot.sendMessage(c, `Swapping ${amt.toFixed(4)} of ${userSessions[c].swapFromMint} into ${infoObj.mint}...`)
                  const kp = loadKeypairFromSecretBase58(u.private_key)
                  const txid = await performSwap({
                    userKeypair: kp,
                    fromTokenMint: userSessions[c].swapFromMint,
                    toTokenMint: infoObj.mint,
                    amount: amt.toNumber(),
                    slippage: DEFAULT_SLIPPAGE,
                  })
                  if (txid) {
                    await bot.sendMessage(c, `*Swap Successful!*\nTX: [View in Explorer](https://solscan.io/tx/${txid})`, {
                      parse_mode: "Markdown",
                      reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] },
                    })
                  } else {
                    await bot.sendMessage(c, "Swap failed (no route or aggregator error).", {
                      reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] },
                    })
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
          const infoObj = userSessions[c] && userSessions[c].tokenInfo
          if (!infoObj) {
            await bot.sendMessage(c, "Token info not found in session. Please try again.", {
              reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] },
            })
            return
          }
          let solAmt = d === "BUY_TOKEN_1" ? new Decimal(1) : new Decimal(5)
          const userSolBal = await getSolBalance(u.public_key)
          if (solAmt.gt(userSolBal)) {
            await bot.sendMessage(c, "Insufficient SOL. You have " + userSolBal.toFixed(4) + ".", {
              reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] },
            })
            return
          }
          await bot.sendMessage(c, `Buying ${solAmt.toFixed(1)} SOL worth of ${infoObj.symbol}...`)
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
            await bot.sendMessage(c, `*Buy Successful!*\nTX: [View in Explorer](https://solscan.io/tx/${txid})`, {
              parse_mode: "Markdown",
              reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] },
            })
          } else {
            await bot.sendMessage(c, "Buy failed (no route or aggregator error).", {
              reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] },
            })
          }
        }
        break

      case "BUY_TOKEN_X":
        await bot.answerCallbackQuery(query.id, { text: "Enter the SOL amount..." })
        {
          const infoObj = userSessions[c] && userSessions[c].tokenInfo
          if (!infoObj) {
            await bot.sendMessage(c, "Token info not found in session. Please try again.", {
              reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] },
            })
            return
          }
          const userSolBal = await getSolBalance(u.public_key)
          const askMsg = `Your current SOL balance is *${userSolBal.toFixed(4)} SOL*.\nEnter SOL amount`
          await bot.sendMessage(c, askMsg, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
            },
          })

          pendingMessageHandlers[c] = async (m2) => {
            try {
              if (m2.chat.id !== c) return
              if (!m2.text) {
                await bot.sendMessage(c, "Invalid amount. Cancelled.", {
                  reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] },
                })
                return
              }
              let amt
              try {
                amt = new Decimal(m2.text.trim())
              } catch(e) {
                await bot.sendMessage(c, "Invalid number. Cancelled.", {
                  reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] },
                })
                return
              }
              if (amt.lte(0)) {
                await bot.sendMessage(c, "Amount must be > 0. Cancelled.", {
                  reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] },
                })
                return
              }
              const userBal = await getSolBalance(u.public_key)
              if (amt.gt(userBal)) {
                await bot.sendMessage(c, `Insufficient balance. You only have ${userBal.toFixed(4)} SOL. Cancelled.`, {
                  reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] },
                })
                return
              }
              // Perform swap
              await bot.sendMessage(c, `Buying ${amt.toFixed(4)} SOL worth of ${infoObj.symbol}...`)
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
                await bot.sendMessage(c, `*Buy Successful!*\nTX: [View in Explorer](https://solscan.io/tx/${txid})`, {
                  parse_mode: "Markdown",
                  reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] },
                })
              } else {
                await bot.sendMessage(c, "Buy failed (no route or aggregator error).", {
                  reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] },
                })
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
          userSessions[c] = userSessions[c] || {}
          // We'll fetch all user tokens, do aggregator calls, skip those that have no symbol/price
          const bal2 = await getAllTokenBalances(u.public_key)
          const solPrice = await getSolPriceUSD()
          // Filter out SOL pseudo mint and 0 balances
          const nonSolTokens = bal2.filter(t => 
            t.mint !== "So11111111111111111111111111111111111111112" && t.amount.gt(0)
          )
          if (!nonSolTokens.length) {
            await bot.sendMessage(c, "You do not have any tokens yet! Start trading in the Buy menu.", {
              reply_markup: {
                inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
              },
            })
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
            await bot.sendMessage(c, "No known tokens to sell. (Aggregator info not found for your tokens.)", {
              reply_markup: {
                inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
              },
            })
            return
          }

          // We'll store them in userSessions with pagination
          userSessions[c].sellTokens = tokenSellList
          userSessions[c].sellPage = 0

          await showSellTokensList(c) // function to show up to 6 tokens at a time
        }
        break

      // We'll handle next/prev/refresh if needed
      case "SELL_PAGE_NEXT":
        await bot.answerCallbackQuery(query.id)
        {
          userSessions[c].sellPage = (userSessions[c].sellPage || 0) + 1
          await showSellTokensList(c)
        }
        break

      case "SELL_PAGE_PREV":
        await bot.answerCallbackQuery(query.id)
        {
          userSessions[c].sellPage = Math.max((userSessions[c].sellPage || 0) - 1, 0)
          await showSellTokensList(c)
        }
        break

      case "SELL_PAGE_REFRESH":
        await bot.answerCallbackQuery(query.id, { text: "Refreshing..." })
        {
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
          userSessions[c].sellTokens = newList
          userSessions[c].sellPage = 0
          if (!newList.length) {
            await bot.sendMessage(c, "No known tokens to sell after refresh.", {
              reply_markup: {
                inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
              },
            })
          } else {
            await showSellTokensList(c)
          }
        }
        break

      default:
        // Possibly it's a SELL_TOKEN_INDEX_ pattern
        if (d.startsWith("SELL_TOKEN_INDEX_")) {
          await bot.answerCallbackQuery(query.id)
          {
            const idx = parseInt(d.replace("SELL_TOKEN_INDEX_",""),10)
            const list = userSessions[c]?.sellTokens || []
            if (!list[idx]) {
              await bot.sendMessage(c, "Token index not found. Please refresh the list.", {
                reply_markup: {
                  inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                },
              })
              return
            }
            // Show user the details, ask how much they want to sell
            const tk = list[idx]
            const sb = await getSolBalance(u.public_key)
            const userSolBalUsd = sb.mul(await getSolPriceUSD())
            // Example message:
            const sellMsg =
`*Select a token to sell* (${list.length} total)
*Balance:* ${sb.toFixed(4)} SOL (${userSolBalUsd.toFixed(2)})

[**🄲 ${tk.symbol}**](${tk.chartLink})
Token Balance: ${tk.tokenBalance.toFixed(tk.decimals)}
In SOL: ${tk.solValue.toFixed(4)} SOL
In USD: ${tk.usdValue.toFixed(2)}

How many *${tk.symbol}* do you want to sell?`

            await bot.sendMessage(c, sellMsg, {
              parse_mode: "Markdown",
              disable_web_page_preview: false,
              reply_markup: {
                inline_keyboard: [
                  [{ text: "« Back", callback_data: "SELL_MENU" }],
                ],
              },
            })

            // Wait for user to enter amount
            pendingMessageHandlers[c] = async (m2) => {
              try {
                if (m2.chat.id !== c) return
                if (!m2.text) {
                  await bot.sendMessage(c, "Invalid amount. Cancelled.", {
                    reply_markup: {
                      inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                    },
                  })
                  return
                }
                let sAmt
                try {
                  sAmt = new Decimal(m2.text.trim())
                  if (sAmt.lte(0)) {
                    await bot.sendMessage(c, "Amount must be > 0. Cancelled.", {
                      reply_markup: {
                        inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                      },
                    })
                    return
                  }
                } catch {
                  await bot.sendMessage(c, "Invalid amount. Cancelled.", {
                    reply_markup: {
                      inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                    },
                  })
                  return
                }

                if (sAmt.gt(tk.tokenBalance)) {
                  await bot.sendMessage(c, `Insufficient tokens. You only have ${tk.tokenBalance.toFixed(tk.decimals)}.`, {
                    reply_markup: {
                      inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                    },
                  })
                  return
                }

                // Next: ask user to proceed or cancel
                const confirmTxt = `You are about to sell *${sAmt.toFixed(tk.decimals)}* of ${tk.symbol}.\nProceed to convert to SOL?`
                const proceedMsg = await bot.sendMessage(c, confirmTxt, {
                  parse_mode: "Markdown",
                  reply_markup: {
                    inline_keyboard: [
                      [
                        { text: "Proceed", callback_data: `SELL_PROCEED_${idx}_${sAmt.toString()}` },
                        { text: "Cancel", callback_data: "SELL_MENU" },
                      ],
                    ],
                  },
                })
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
            const list = userSessions[c]?.sellTokens || []
            if (!list[idx]) {
              await bot.sendMessage(c, "Token index not found. Please refresh the list.", {
                reply_markup: {
                  inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                },
              })
              return
            }
            const tk = list[idx]
            // Double-check user balance
            const bals = await getAllTokenBalances(u.public_key)
            const fTok = bals.find((b) => b.mint === tk.mint)
            if (!fTok || fTok.amount.lt(amt)) {
              await bot.sendMessage(c, "Insufficient tokens at the time of sell. Sell cancelled.", {
                reply_markup: {
                  inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                },
              })
              return
            }
            await bot.sendMessage(c, "Processing your sell order...")

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
              await bot.sendMessage(c, `*Sell Successful!*\nTX: [View in Explorer](https://solscan.io/tx/${txid})`, {
                parse_mode: "Markdown",
                reply_markup: {
                  inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                },
              })
            } else {
              await bot.sendMessage(c, "Sell failed (aggregator error or no route).", {
                reply_markup: {
                  inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
                },
              })
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
// *** SELL UPGRADE *** function
// ---------------------------------------------------------
async function showSellTokensList(chatId) {
  try {
    const u = await getUserRow(chatId)
    if (!u) return
    const userData = userSessions[chatId]
    if (!userData || !userData.sellTokens) return

    const tokens = userData.sellTokens
    const page = userData.sellPage || 0
    const pageSize = 6
    const startIndex = page * pageSize
    const endIndex = Math.min(startIndex + pageSize, tokens.length)

    const userSolBal = await getSolBalance(u.public_key)
    const userSolBalUsd = userSolBal.mul(await getSolPriceUSD())

    let txt = `**Select a token to sell** (${tokens.length} found)\n` +
              `**Balance**: ${userSolBal.toFixed(4)} SOL (${userSolBalUsd.toFixed(2)})\n\n`

    for (let i = startIndex; i < endIndex; i++) {
      const tk = tokens[i]
      // Example line: [**🄲 {symbol}**](chart) — {solValue} SOL ($usdValue) [Hide]
      txt += `[**🄲 ${tk.symbol}**](${tk.chartLink}) — ${tk.solValue.toFixed(4)} SOL (${tk.usdValue.toFixed(2)})\n`
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

    await bot.sendMessage(chatId, txt, {
      parse_mode: "Markdown",
      disable_web_page_preview: false,
      reply_markup: {
        inline_keyboard: inlineKb
      },
    })
  } catch (err) {
    logger.error("showSellTokensList error:", err)
    await bot.sendMessage(chatId, "Error displaying token list. Please try again or /start.", {
      reply_markup: {
        inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
      },
    })
  }
}

// ---------------------------------------------------------
// Helper functions for PNL calculations
// ---------------------------------------------------------

// Get timestamp for a specific time period ago
function getTimestampForPeriod(period) {
  const now = new Date()
  let timestamp
  
  switch(period) {
    case "24h":
      timestamp = Math.floor(now.setHours(now.getHours() - 24) / 1000)
      break
    case "3d":
      timestamp = Math.floor(now.setDate(now.getDate() - 3) / 1000)
      break
    case "7d":
      timestamp = Math.floor(now.setDate(now.getDate() - 7) / 1000)
      break
    case "1m":
      timestamp = Math.floor(now.setMonth(now.getMonth() - 1) / 1000)
      break
    case "1y":
      timestamp = Math.floor(now.setFullYear(now.getFullYear() - 1) / 1000)
      break
    default: // All time
      timestamp = 0
  }
  
  return timestamp
}

// Format percentage with +/- sign and emoji
function formatPercentage(percentage) {
  if (percentage > 0) {
    return `+${percentage.toFixed(2)}% 📈`
  } else if (percentage < 0) {
    return `${percentage.toFixed(2)}% 📉`
  } else {
    return `0.00% ↔️`
  }
}

// Fetch transaction history for wallet from Solana blockchain
async function getTransactionHistory(pubkeyStr, startTime) {
  try {
    const c = new Connection(SOLANA_RPC_URL, "confirmed")
    const pubkey = new PublicKey(pubkeyStr)
    
    // Get confirmed signatures for address
    const signatures = await c.getSignaturesForAddress(
      pubkey, 
      { 
        limit: 100,
        until: startTime ? new Signature(startTime) : undefined, 
      }
    )
    
    // Filter transactions after the start time if specified
    const filteredSignatures = startTime 
      ? signatures.filter(sig => sig.blockTime >= startTime) 
      : signatures

    // Get transaction details
    const transactions = []
    for (const sig of filteredSignatures) {
      try {
        const tx = await c.getTransaction(sig.signature, { commitment: "confirmed" })
        if (tx) {
          transactions.push({
            signature: sig.signature,
            blockTime: sig.blockTime,
            transaction: tx,
          })
        }
      } catch (err) {
        logger.error(`Error fetching transaction details for ${sig.signature}:`, err)
      }
    }
    
    return transactions
  } catch (err) {
    logger.error("Error fetching transaction history:", err)
    return []
  }
}

// Parse transactions to identify trades for PNL calculation
async function calculatePNL(pubkeyStr, period) {
  try {
    // Convert period to timestamp
    const startTimestamp = getTimestampForPeriod(period)
    
    // Initialize tracking variables
    let totalProfit = new Decimal(0)
    let totalLoss = new Decimal(0)
    let totalFees = new Decimal(0)
    let winningTrades = 0
    let losingTrades = 0
    let tradeDetails = []
    
    // Get current SOL price for USD calculations
    const currentSolPrice = await getSolPriceUSD()
    
    // Track token balances by mint address
    const tokenTracker = {}
    
    try {
      // Connect to Solana
      const connection = new Connection(SOLANA_RPC_URL, "confirmed")
      const publicKey = new PublicKey(pubkeyStr)
      
      // Get transaction signatures (most recent first)
      const signatures = await connection.getSignaturesForAddress(
        publicKey,
        { limit: 100 }
      )
      
      // Filter by time period if needed
      const filteredSignatures = startTimestamp > 0 
        ? signatures.filter(sig => sig.blockTime && sig.blockTime >= startTimestamp)
        : signatures
      
      logger.info(`Found ${filteredSignatures.length} transactions for PNL analysis`)
      
      // Process each transaction
      for (const sigInfo of filteredSignatures) {
        if (sigInfo.err) continue // Skip failed transactions
        
        try {
          // Get full transaction data
          const txData = await connection.getTransaction(
            sigInfo.signature,
            { commitment: "confirmed", maxSupportedTransactionVersion: 0 }
          )
          
          if (!txData || !txData.meta) continue
          
          // Track transaction fee
          totalFees = totalFees.add(new Decimal(txData.meta.fee).div(1_000_000_000))
          
          // Check if this is a swap transaction by looking at token balance changes
          if (txData.meta.preTokenBalances && txData.meta.postTokenBalances) {
            const preBalances = txData.meta.preTokenBalances
            const postBalances = txData.meta.postTokenBalances
            
            // Map wallet token accounts to balances for easier lookup
            const preBalanceMap = {}
            const postBalanceMap = {}
            
            // Only include the user's token accounts
            for (const balance of preBalances) {
              if (balance.owner === pubkeyStr) {
                preBalanceMap[balance.mint] = new Decimal(
                  balance.uiTokenAmount.uiAmount || 0
                )
              }
            }
            
            for (const balance of postBalances) {
              if (balance.owner === pubkeyStr) {
                postBalanceMap[balance.mint] = new Decimal(
                  balance.uiTokenAmount.uiAmount || 0
                )
              }
            }
            
            // Find tokens whose balance changed
            const allMints = new Set([
              ...Object.keys(preBalanceMap),
              ...Object.keys(postBalanceMap)
            ])
            
            // Track which tokens increased/decreased
            const increaseTokens = []
            const decreaseTokens = []
            
            for (const mint of allMints) {
              const preBal = preBalanceMap[mint] || new Decimal(0)
              const postBal = postBalanceMap[mint] || new Decimal(0)
              const change = postBal.minus(preBal)
              
              // Skip SOL pseudo token for now
              if (mint === "So11111111111111111111111111111111111111112") {
                continue
              }
              
              if (change.gt(0)) {
                increaseTokens.push({
                  mint,
                  amount: change
                })
              } else if (change.lt(0)) {
                decreaseTokens.push({
                  mint,
                  amount: change.abs()
                })
              }
            }
            
            // Now check for SOL balance changes
            const solMint = "So11111111111111111111111111111111111111112"
            const preSolBal = preBalanceMap[solMint] || new Decimal(0)
            const postSolBal = postBalanceMap[solMint] || new Decimal(0)
            const solChange = postSolBal.minus(preSolBal)
            
            // Simple heuristic for swaps - one token's balance increases while another decreases
            
            // Case 1: SOL → Token (BUY)
            if (solChange.lt(0) && increaseTokens.length === 1) {
              const boughtToken = increaseTokens[0]
              const soldAmount = solChange.abs()
              
              // Initialize token tracking if needed
              if (!tokenTracker[boughtToken.mint]) {
                tokenTracker[boughtToken.mint] = {
                  totalBought: new Decimal(0),
                  totalSold: new Decimal(0),
                  totalSpentSol: new Decimal(0),
                  totalReceivedSol: new Decimal(0),
                  averageBuyPrice: new Decimal(0),
                  symbol: "Unknown"
                }
                
                // Try to get token info
                try {
                  const tokenInfo = await getTokenInfoFromAggregator(boughtToken.mint)
                  if (tokenInfo && tokenInfo.symbol) {
                    tokenTracker[boughtToken.mint].symbol = tokenInfo.symbol
                  }
                } catch (err) {
                  logger.error(`Error getting token info for ${boughtToken.mint}:`, err)
                }
              }
              
              // Update token tracking
              const tracker = tokenTracker[boughtToken.mint]
              const oldTotal = tracker.totalBought
              const oldSpent = tracker.totalSpentSol
              
              tracker.totalBought = tracker.totalBought.add(boughtToken.amount)
              tracker.totalSpentSol = tracker.totalSpentSol.add(soldAmount)
              
              // Update average buy price
              if (tracker.totalBought.gt(0)) {
                tracker.averageBuyPrice = tracker.totalSpentSol.div(tracker.totalBought)
              }
              
              tradeDetails.push({
                type: "BUY",
                timestamp: sigInfo.blockTime,
                signature: sigInfo.signature,
                tokenMint: boughtToken.mint,
                tokenAmount: boughtToken.amount,
                solAmount: soldAmount,
                symbol: tracker.symbol
              })
              
              logger.info(`Detected BUY trade: ${soldAmount.toFixed(4)} SOL -> ${boughtToken.amount.toFixed(4)} ${tracker.symbol}`)
            }
            
            // Case 2: Token → SOL (SELL)
            else if (solChange.gt(0) && decreaseTokens.length === 1) {
              const soldToken = decreaseTokens[0]
              const receivedAmount = solChange
              
              // Skip if we've never tracked this token
              if (!tokenTracker[soldToken.mint]) {
                // This could be a token we received via transfer or airdrop
                // Initialize tracking with what we know
                tokenTracker[soldToken.mint] = {
                  totalBought: soldToken.amount, // Assume we somehow acquired this amount
                  totalSold: soldToken.amount,   // And now we're selling it
                  totalSpentSol: new Decimal(0), // Unknown cost basis
                  totalReceivedSol: receivedAmount,
                  averageBuyPrice: new Decimal(0),
                  symbol: "Unknown"
                }
                
                // Try to get token info
                try {
                  const tokenInfo = await getTokenInfoFromAggregator(soldToken.mint)
                  if (tokenInfo && tokenInfo.symbol) {
                    tokenTracker[soldToken.mint].symbol = tokenInfo.symbol
                  }
                } catch (err) {
                  logger.error(`Error getting token info for ${soldToken.mint}:`, err)
                }
              } else {
                // Update existing tracker
                const tracker = tokenTracker[soldToken.mint]
                tracker.totalSold = tracker.totalSold.add(soldToken.amount)
                tracker.totalReceivedSol = tracker.totalReceivedSol.add(receivedAmount)
              }
              
              const tracker = tokenTracker[soldToken.mint]
              
              // Calculate profit/loss for this trade
              const costBasis = tracker.averageBuyPrice.mul(soldToken.amount)
              const tradePnL = receivedAmount.minus(costBasis)
              
              // Track as winning or losing trade
              if (tradePnL.gt(0)) {
                totalProfit = totalProfit.add(tradePnL)
                winningTrades++
              } else {
                totalLoss = totalLoss.add(tradePnL.abs())
                losingTrades++
              }
              
              tradeDetails.push({
                type: "SELL",
                timestamp: sigInfo.blockTime,
                signature: sigInfo.signature,
                tokenMint: soldToken.mint,
                tokenAmount: soldToken.amount,
                solAmount: receivedAmount,
                pnl: tradePnL,
                symbol: tracker.symbol
              })
              
              logger.info(`Detected SELL trade: ${soldToken.amount.toFixed(4)} ${tracker.symbol} -> ${receivedAmount.toFixed(4)} SOL (PnL: ${tradePnL.toFixed(4)})`)
            }
            
            // Case 3: Token → Token (Swap)
            else if (increaseTokens.length === 1 && decreaseTokens.length === 1) {
              const boughtToken = increaseTokens[0]
              const soldToken = decreaseTokens[0]
              
              // Initialize token tracking if needed for bought token
              if (!tokenTracker[boughtToken.mint]) {
                tokenTracker[boughtToken.mint] = {
                  totalBought: new Decimal(0),
                  totalSold: new Decimal(0),
                  totalSpentSol: new Decimal(0),
                  totalReceivedSol: new Decimal(0),
                  averageBuyPrice: new Decimal(0),
                  symbol: "Unknown"
                }
                
                // Try to get token info
                try {
                  const tokenInfo = await getTokenInfoFromAggregator(boughtToken.mint)
                  if (tokenInfo && tokenInfo.symbol) {
                    tokenTracker[boughtToken.mint].symbol = tokenInfo.symbol
                  }
                } catch (err) {
                  logger.error(`Error getting token info for ${boughtToken.mint}:`, err)
                }
              }
              
              // Initialize token tracking if needed for sold token
              if (!tokenTracker[soldToken.mint]) {
                tokenTracker[soldToken.mint] = {
                  totalBought: soldToken.amount, // Assume we somehow acquired this amount
                  totalSold: soldToken.amount,   // And now we're selling it
                  totalSpentSol: new Decimal(0), // Unknown cost basis
                  totalReceivedSol: new Decimal(0),
                  averageBuyPrice: new Decimal(0),
                  symbol: "Unknown"
                }
                
                // Try to get token info
                try {
                  const tokenInfo = await getTokenInfoFromAggregator(soldToken.mint)
                  if (tokenInfo && tokenInfo.symbol) {
                    tokenTracker[soldToken.mint].symbol = tokenInfo.symbol
                  }
                } catch (err) {
                  logger.error(`Error getting token info for ${soldToken.mint}:`, err)
                }
              }
              
              // Getting token prices to estimate SOL value
              try {
                const [soldTokenInfo, boughtTokenInfo] = await Promise.all([
                  getTokenInfoFromAggregator(soldToken.mint),
                  getTokenInfoFromAggregator(boughtToken.mint)
                ])
                
                if (soldTokenInfo && soldTokenInfo.price && boughtTokenInfo && boughtTokenInfo.price) {
                  const soldTokenSolPrice = new Decimal(soldTokenInfo.price).div(currentSolPrice)
                  const boughtTokenSolPrice = new Decimal(boughtTokenInfo.price).div(currentSolPrice)
                  
                  const soldSolValue = soldToken.amount.mul(soldTokenSolPrice)
                  const boughtSolValue = boughtToken.amount.mul(boughtTokenSolPrice)
                  
                  // Update token trackers
                  const soldTracker = tokenTracker[soldToken.mint]
                  soldTracker.totalSold = soldTracker.totalSold.add(soldToken.amount)
                  soldTracker.totalReceivedSol = soldTracker.totalReceivedSol.add(boughtSolValue)
                  
                  const boughtTracker = tokenTracker[boughtToken.mint]
                  boughtTracker.totalBought = boughtTracker.totalBought.add(boughtToken.amount)
                  boughtTracker.totalSpentSol = boughtTracker.totalSpentSol.add(soldSolValue)
                  
                  // Update average buy price
                  if (boughtTracker.totalBought.gt(0)) {
                    boughtTracker.averageBuyPrice = boughtTracker.totalSpentSol.div(boughtTracker.totalBought)
                  }
                  
                  // This is a token-token swap, so we'll track it but not include in PnL calculation
                  // since the PnL will be realized when the received token is sold for SOL
                  tradeDetails.push({
                    type: "SWAP",
                    timestamp: sigInfo.blockTime,
                    signature: sigInfo.signature,
                    fromTokenMint: soldToken.mint,
                    fromTokenAmount: soldToken.amount,
                    fromTokenSymbol: soldTracker.symbol,
                    toTokenMint: boughtToken.mint,
                    toTokenAmount: boughtToken.amount,
                    toTokenSymbol: boughtTracker.symbol,
                    estimatedSolValue: soldSolValue
                  })
                  
                  logger.info(`Detected token SWAP: ${soldToken.amount.toFixed(4)} ${soldTracker.symbol} -> ${boughtToken.amount.toFixed(4)} ${boughtTracker.symbol}`)
                }
              } catch (err) {
                logger.error(`Error processing token swap:`, err)
              }
            }
          }
        } catch (err) {
          logger.error(`Error processing transaction ${sigInfo.signature}:`, err)
        }
      }
    } catch (err) {
      logger.error("Error fetching transaction history:", err)
    }
    
    // Calculate final results for each token
    const tokenPnLs = []
    
    for (const [mint, data] of Object.entries(tokenTracker)) {
      // Only include tokens with both buys and sells
      if (data.totalBought.gt(0)) {
        // Calculate realized profit/loss
        let realizedPnL = new Decimal(0)
        if (data.totalSold.gt(0)) {
          const costBasisForSold = data.totalSold.mul(data.averageBuyPrice)
          realizedPnL = data.totalReceivedSol.minus(costBasisForSold)
        }
        
        // Calculate unrealized profit/loss for remaining tokens
        const remainingTokens = data.totalBought.minus(data.totalSold)
        let unrealizedPnL = new Decimal(0)
        
        if (remainingTokens.gt(0)) {
          try {
            // Get current token price
            const tokenInfo = await getTokenInfoFromAggregator(mint)
            if (tokenInfo && tokenInfo.price > 0) {
              const tokenSolPrice = new Decimal(tokenInfo.price).div(currentSolPrice)
              const currentValue = remainingTokens.mul(tokenSolPrice)
              const costBasis = remainingTokens.mul(data.averageBuyPrice)
              unrealizedPnL = currentValue.minus(costBasis)
            }
          } catch (err) {
            logger.error(`Error calculating unrealized PnL for ${mint}:`, err)
          }
        }
        
        const totalPnL = realizedPnL.add(unrealizedPnL)
        const roi = data.totalSpentSol.gt(0) 
          ? totalPnL.div(data.totalSpentSol).mul(100) 
          : new Decimal(0)
        
        tokenPnLs.push({
          mint,
          symbol: data.symbol,
          realizedPnL,
          unrealizedPnL,
          totalPnL,
          roi,
          remainingTokens
        })
      }
    }
    
    // Sort tokens by total PnL (highest first)
    tokenPnLs.sort((a, b) => b.totalPnL.minus(a.totalPnL).toNumber())
    
    // Calculate overall PnL
    const netPnL = totalProfit.minus(totalLoss)
    const totalTrades = winningTrades + losingTrades
    const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0
    
    return {
      period,
      netPnL,
      totalProfit,
      totalLoss,
      totalFees,
      winningTrades,
      losingTrades,
      totalTrades,
      winRate,
      tokenPnLs,
      tradeDetails
    }
  } catch (err) {
    logger.error("Error calculating PNL:", err)
    return {
      period,
      netPnL: new Decimal(0),
      totalProfit: new Decimal(0),
      totalLoss: new Decimal(0),
      totalFees: new Decimal(0),
      winningTrades: 0,
      losingTrades: 0,
      totalTrades: 0,
      winRate: 0,
      tokenPnLs: [],
      tradeDetails: []
    }
  }
}

// Format and display PNL information
// Format and display PNL information
async function displayPNL(chatId, pnlData) {
  try {
    // Format the PNL summary
    let periodText
    switch(pnlData.period) {
      case "24h": periodText = "24 Hours"; break
      case "3d": periodText = "3 Days"; break
      case "7d": periodText = "7 Days"; break
      case "1m": periodText = "1 Month"; break
      case "1y": periodText = "1 Year"; break
      default: periodText = "All Time"
    }
    
    const solPrice = await getSolPriceUSD()
    const netPnLusd = pnlData.netPnL.mul(solPrice)
    
    let message = `📊 *PNL Summary (${periodText})*\n\n`
    
    // Net PNL with color indicator
    if (pnlData.netPnL.gt(0)) {
      message += `🟢 *Net Profit/Loss:* +${pnlData.netPnL.toFixed(4)} SOL ($${netPnLusd.toFixed(2)})\n`
    } else if (pnlData.netPnL.lt(0)) {
      message += `🔴 *Net Profit/Loss:* ${pnlData.netPnL.toFixed(4)} SOL ($${netPnLusd.toFixed(2)})\n`
    } else {
      message += `⚪ *Net Profit/Loss:* 0.0000 SOL ($0.00)\n`
    }
    
    // Trade statistics
    message += `\n*Trade Statistics:*\n`
    message += `• Total Trades: ${pnlData.totalTrades}\n`
    message += `• Winning: ${pnlData.winningTrades} | Losing: ${pnlData.losingTrades}\n`
    message += `• Win Rate: ${pnlData.winRate.toFixed(2)}%\n`
    message += `• Trading Fees: ${pnlData.totalFees.toFixed(4)} SOL\n`
    
    // Top performing tokens (limit to top 5)
    const topTokens = pnlData.tokenPnLs.slice(0, 5)
    if (topTokens.length > 0) {
      message += `\n*Token Performance:*\n`
      
      for (const token of topTokens) {
        const roiFormatted = formatPercentage(token.roi.toNumber())
        const remainingText = token.remainingTokens.gt(0) 
          ? ` (${token.remainingTokens.toFixed(4)} tokens held)`
          : ``
        
        if (token.totalPnL.gt(0)) {
          message += `• ${token.symbol}: +${token.totalPnL.toFixed(4)} SOL (ROI: ${roiFormatted})${remainingText}\n`
        } else {
          message += `• ${token.symbol}: ${token.totalPnL.toFixed(4)} SOL (ROI: ${roiFormatted})${remainingText}\n`
        }
      }
    }
    
    // Show instructions if needed
    if (pnlData.tradeDetails.length === 0 && pnlData.tokenPnLs.length === 0) {
      message += `\n*No trades found for this time period.*\n\n`
      message += `Note: PNL tracking works by analyzing your on-chain transaction history for token swaps. `
      message += `If you've made trades that aren't showing, try selecting a longer time period.`
    } 
    // Show recent trades info
    else if (pnlData.tradeDetails.length > 0) {
      // Get up to 5 most recent trades
      const recentTrades = pnlData.tradeDetails
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 5)
        
      message += `\n*Recent Transactions:*\n`
      
      for (const trade of recentTrades) {
        const date = new Date(trade.timestamp * 1000)
        const dateStr = `${date.getMonth()+1}/${date.getDate()}`
        
        if (trade.type === "BUY") {
          message += `• 💰 Buy: ${trade.solAmount.toFixed(4)} SOL → ${trade.tokenAmount.toFixed(4)} ${trade.symbol} (${dateStr})\n`
        } else if (trade.type === "SELL") {
          const pnlText = trade.pnl 
            ? (trade.pnl.gt(0) ? ` (+${trade.pnl.toFixed(4)})` : ` (${trade.pnl.toFixed(4)})`) 
            : ""
          message += `• 💱 Sell: ${trade.tokenAmount.toFixed(4)} ${trade.symbol} → ${trade.solAmount.toFixed(4)} SOL${pnlText} (${dateStr})\n`
        } else if (trade.type === "SWAP") {
          message += `• 🔄 Swap: ${trade.fromTokenAmount.toFixed(4)} ${trade.fromTokenSymbol} → ${trade.toTokenAmount.toFixed(4)} ${trade.toTokenSymbol} (${dateStr})\n`
        }
      }
      
      // Add a link to view more details
      message += `\n*View details:* [Solscan](https://solscan.io/address/${pnlData.walletAddress || ""})`
    }
    
    // Send the message
    await bot.sendMessage(chatId, message, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "« Back to Time Periods", callback_data: "PNL_MENU" }],
          [{ text: "« Back to Main Menu", callback_data: "BACK_MAIN" }]
        ]
      },
      disable_web_page_preview: true
    })
  } catch (err) {
    logger.error("Error displaying PNL:", err)
    await bot.sendMessage(chatId, "Error displaying PNL information. Please try again.", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "« Back", callback_data: "BACK_MAIN" }]
        ]
      }
    })
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
  { command: "pnl", description: "View your trading profit and loss" },
  { command: "settings", description: "Manage wallet settings" },
  { command: "help", description: "Show help info" },
]);

// /help
bot.onText(/\/help/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    clearPendingForSlash(chatId);
    
    const helpMessage = `
🚀 *Solana Memesbot Help*  

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
              `*SOL Balance:* ${sb.toFixed(4)} SOL (~${su.toFixed(2)})\n\n`

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
               `(~${ti.solValue.toFixed(4)} SOL / ${ti.usdValue.toFixed(2)})\n`
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

// /withdraww
bot.onText(/\/withdraw/, (msg) => {
  try {
    const c = msg.chat.id
    clearPendingForSlash(c)
    bot.sendMessage(c, "Use the main menu ( /start ) => 💸 Withdraw.")
  } catch (err) {
    logger.error("/withdraw command error:", err)
  }
})

// /pnl
bot.onText(/\/pnl/, async (msg) => {
  try {
    const chatId = msg.chat.id
    clearPendingForSlash(chatId)
    
    const u = await getUserRow(chatId)
    if (!u || !u.public_key) {
      return bot.sendMessage(chatId, "No wallet found. Please /start => create or import one.")
    }
    
    const txt = `📈 *Profit and Loss Analysis*\n\nSelect a time period to view your trading performance:`
    await bot.sendMessage(chatId, txt, {
      parse_mode: "Markdown",
      reply_markup: pnlTimeframeKeyboard()
    })
  } catch (err) {
    logger.error("/pnl command error:", err)
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
