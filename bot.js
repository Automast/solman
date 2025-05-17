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

const BOT_VERSION = "3.0.1-PNL" // Updated version

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

const pendingMessageHandlers = {}
const userSessions = {}

function clearPendingMessageHandler(chatId) {
  if (pendingMessageHandlers[chatId]) {
    bot.removeListener("message", pendingMessageHandlers[chatId])
    delete pendingMessageHandlers[chatId]
  }
}

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

    await new Promise((resolve, reject) => {
      db.run("UPDATE users SET is_removed=0 WHERE telegram_id=?", [tid], (err2) => {
        if (err2) return reject(err2)
        resolve()
      })
    })
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
        params: { _: new Date().getTime() }
      }
    );
    const data = response.data.market_data;
    
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
      params: { ids: "solana", vs_currencies: "usd", _: new Date().getTime() },
      headers: { 'Cache-Control': 'no-cache' }
    })
    return new Decimal(r.data.solana.usd)
  } catch (e) {
    logger.error("getSolPriceUSD error:", e.message)
    return new Decimal(0)
  }
}

async function getTokenInfoFromAggregator(mintAddress) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/search?q=${mintAddress}&_=${new Date().getTime()}` // Removed chain=solana as q can be pair address too
    const res = await axios.get(url, { headers: { 'Cache-Control': 'no-cache' } })
    
    // Try to find a pair on Solana chain first
    let pair = null;
    if (res.data && res.data.pairs && res.data.pairs.length) {
        pair = res.data.pairs.find(p => p.chainId === 'solana' && (p.baseToken.address.toLowerCase() === mintAddress.toLowerCase() || p.pairAddress.toLowerCase() === mintAddress.toLowerCase() )) || res.data.pairs[0];
    }
    if(!pair) return null;


    const base = pair.baseToken || {}
    const priceUsd = pair.priceUsd ? new Decimal(pair.priceUsd) : null
    const priceChange = pair.priceChange || {}
    const fdv = pair.fdv ? new Decimal(pair.fdv) : null

    const info = {
      symbol: base.symbol || "",
      name: base.name || "",
      mint: base.address || mintAddress, // Prefer baseToken.address if available
      price: priceUsd ? priceUsd.toNumber() : 0,
      m5: priceChange.m5 || 0,
      h1: priceChange.h1 || 0,
      h6: priceChange.h6 || 0,
      h24: priceChange.h24 || 0,
      marketCap: fdv ? fdv.toNumber() : 0
    }
    return info
  } catch (e) {
    logger.error(`getTokenInfoFromAggregator error for ${mintAddress}:`, e.message)
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
        { text: "📈 PnL", callback_data: "SHOW_PNL_OPTIONS" },
      ],
      [
        { text: "🔄 Refresh", callback_data: "REFRESH" }, // Keep Refresh accessible
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

// PnL options keyboard
function pnlOptionsKeyboard() {
    return {
        inline_keyboard: [
            [
                { text: "⏱ Last 24H", callback_data: "CALCULATE_PNL_24H" },
                { text: "🗓 Last 3 Days", callback_data: "CALCULATE_PNL_3D" },
            ],
            [
                { text: "🗓 Last 7 Days", callback_data: "CALCULATE_PNL_7D" },
                { text: "🗓 Last 1 Month", callback_data: "CALCULATE_PNL_1M" },
            ],
            [
                { text: "🗓 Last 1 Year", callback_data: "CALCULATE_PNL_1Y" },
            ],
            [
                { text: "« Back to Main", callback_data: "BACK_MAIN" },
            ],
        ],
    };
}


function noWalletKeyboard(e) {
  const row = []
  if (e === 'yes') {
    row.push({ text: "🆕 Create Wallet", callback_data: "CREATE_WALLET" })
  }
  row.push({ text: "📥 Import Wallet", callback_data: "IMPORT_WALLET" })
  return { inline_keyboard: [row] }
}

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
    // Ignore "message is not modified" error which is common
    if (!err.message || !err.message.includes("message is not modified")) {
        logger.error("editMessageText error:", err.message)
    }
  }
}

async function getMinAutoTradeUsd() {
  const v = await getConfigValue('min_auto_trade_usd')
  return v ? new Decimal(v) : new Decimal(2)
}

async function getOptimalAutoTradeUsd() {
  const v = await getConfigValue('optimal_auto_trade_usd')
  return v ? new Decimal(v) : new Decimal(50)
}

async function showMainMenu(chatId, messageId) {
  try {
    const u = await getUserRow(chatId);
    const solMarketData = await getSolMarketData();
    
    let message = ''; 
    
    if (!u || !u.public_key) {
      message = `🚀 *Welcome to Solana Memesbot!*\n\n`;
      message += `The future of Solana trading is at your fingertips!\n\n`;
      message += `🔐 *Address*\n(No wallet linked)\n\n`;
      message += `💰 *Balance*\n`;
      message += `• 💲 Net worth: $0.00\n\n`;
    } else {
      const [solBalance, tokenBalances] = await Promise.all([
        getSolBalance(u.public_key),
        getAllTokenBalances(u.public_key)
      ]);
      
      const nonSolTokens = tokenBalances.filter(t => 
        t.mint !== "So11111111111111111111111111111111111111112" && t.amount.gt(0)
      );
      
      let tokenUsdValue = new Decimal(0);
      await Promise.all(nonSolTokens.map(async (t) => {
        const info = await getTokenInfoFromAggregator(t.mint);
        if (info && info.price) {
          tokenUsdValue = tokenUsdValue.add(t.amount.mul(new Decimal(info.price)));
        }
      }));

      const solUsdValue = solBalance.mul(solMarketData.currentPrice);
      const netWorth = solUsdValue.add(tokenUsdValue);

      message = `🚀 *Solana Wallet Overview*\n\n`;
      message += `🔐 *Address:*\n\`${u.public_key}\`\n`; // Markdown for address
      message += `🌐 [Solscan](https://solscan.io/account/${u.public_key}) | `;
      message += `📊 [Birdeye](https://birdeye.so/address/${u.public_key}) | `;
      message += `🦄 [Jupiter](https://jup.ag/)\n\n`;
      
      message += `💰 *Balance*\n`;
      message += `• SOL: ${solBalance.toFixed(4)} (≈ $${solUsdValue.toFixed(2)})\n`;
      message += `• 🪙 Tokens: ${nonSolTokens.length} ${nonSolTokens.length ? '' : '(No SPL tokens detected)'}\n`;
      message += `• 💲 Net Worth: $${netWorth.toFixed(2)}\n\n`;
    }
    
    message += `📈 *Market Overview*\n`;
    message += `• 💸 SOL Price: $${solMarketData.currentPrice.toFixed(2)} (24h: ${solMarketData.isUp ? '▲' : '▼'}${solMarketData.priceChange24h}%${solMarketData.isUp ? '📈' : '📉'})\n`;
    message += `• 💹 24h Volume: ${solMarketData.formattedVolume24h}\n\n`;
    
    const autoTradeStatus = u && u.auto_trade_enabled ? '🟢 ACTIVE' : '🔴 INACTIVE';
    message += `🤖 Autotrade Status: ${autoTradeStatus}`;

    let replyMarkup;
    if (!u || !u.public_key) {
      replyMarkup = {
        inline_keyboard: [
          // Using mainMenuKeyboard structure for consistency if wallet is not connected for some buttons
          [
            { text: "📊 Positions", callback_data: "CHECK_BAL" }, // Still allow if no wallet (will say "no wallet")
            { text: "📈 PnL", callback_data: "SHOW_PNL_OPTIONS" }, // Same
          ],
          [ { text: "🔄 Refresh", callback_data: "REFRESH" } ],
          [
            { text: "💹 Buy", callback_data: "BUY_MENU" },
            { text: "💱 Sell", callback_data: "SELL_MENU" },
          ],
          [
            { text: "Auto-Trade 🔴", callback_data: "AUTO_TRADE" }, // Default to off if no wallet
            { text: "💸 Withdraw", callback_data: "WITHDRAW_MENU" },
          ],
          [
            { text: "❓ Help", callback_data: "SHOW_HELP" },
            { text: "⚙️ Settings", callback_data: "SETTINGS_MENU" }, // Settings might have "Connect"
          ],
          [
            { text: "🔗 Connect Wallet", callback_data: "IMPORT_WALLET" }
          ]
        ]
      };
    } else {
      replyMarkup = mainMenuKeyboard(Boolean(u.auto_trade_enabled));
    }

    // If messageId is provided, edit. Otherwise, send new.
    if (messageId) {
        await editMessageText(chatId, messageId, message, replyMarkup);
    } else {
        await bot.sendMessage(chatId, message, {
            parse_mode: "Markdown",
            reply_markup: replyMarkup,
            disable_web_page_preview: true,
        });
    }
    
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
    const errorMsg = "Error loading wallet overview. Please try /start again.";
    if (messageId) {
        await editMessageText(chatId, messageId, errorMsg, { inline_keyboard: [[{ text: "🔁 Try /start", callback_data: "REFRESH"}]]}); // Provide a way to retry
    } else {
        await bot.sendMessage(chatId, errorMsg);
    }
  }
}


function clearPendingForSlash(id) {
  clearPendingMessageHandler(id)
}

bot.onText(/\/start/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    clearPendingForSlash(chatId);
    logger.info("/start => " + chatId);

    try {
      if (msg.message_id) {
        await bot.deleteMessage(chatId, msg.message_id).catch(e => {});
      }
    } catch (e) {
      logger.warn("Could not delete /start message:", e.message);
    }

    const loadingMsg = await bot.sendMessage(chatId, `🚀 Loading Solana Memesbot...`, {
      parse_mode: "Markdown"
    });

    await showMainMenu(chatId, loadingMsg.message_id);
    
  } catch (err) {
    logger.error("/start command error:", err);
    await bot.sendMessage(chatId, "Error loading wallet data. Please try /start again.");
  }
});


bot.onText(/\/home/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    clearPendingForSlash(chatId);
    logger.info("/home => " + chatId);

    try {
      if (msg.message_id) {
        await bot.deleteMessage(chatId, msg.message_id).catch(e => {});
      }
    } catch (e) {
      logger.warn("Could not delete /home message:", e.message);
    }

    const loadingMsg = await bot.sendMessage(chatId, `🔄 Loading wallet overview...`, {
      parse_mode: "Markdown"
    });
    await showMainMenu(chatId, loadingMsg.message_id);
    
  } catch (err) {
    logger.error("/home command error:", err);
    await bot.sendMessage(chatId, "Error loading wallet data. Please try /start again.");
  }
});

bot.onText(/\/connect/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    clearPendingForSlash(chatId);
    
    const u = await getUserRow(chatId);
    if (u && u.public_key) {
      return bot.sendMessage(chatId, "You already have a wallet connected. Use /start to see your wallet overview.");
    }
    
    const pm = await bot.sendMessage(chatId, "Please enter your private key to connect your wallet.", {
      reply_markup: {
        inline_keyboard: [[{ text: "« Cancel", callback_data: "BACK_MAIN" }]],
      },
    });

    pendingMessageHandlers[chatId] = async (msg2) => {
      try {
        if (msg2.chat.id !== chatId) return;
        // Attempt to delete user message with private key and the bot's prompt
        if(pm.message_id) await bot.deleteMessage(chatId, pm.message_id).catch(e => logger.warn("deleteMessage error:", e.message));
        if(msg2.message_id) await bot.deleteMessage(chatId, msg2.message_id).catch(e => logger.warn("deleteMessage error:", e.message));
        clearPendingMessageHandler(chatId); // Clear immediately

        if (!msg2.text) {
          await bot.sendMessage(chatId, "Invalid input. Import cancelled.", {
            reply_markup: {
              inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
            },
          });
          // Reshow main menu after cancellation attempt
          const newLoadingMsg = await bot.sendMessage(chatId, `🔄 Loading...`);
          await showMainMenu(chatId, newLoadingMsg.message_id);
          return;
        }
        
        const b58 = msg2.text.trim();
        try {
          const kp = loadKeypairFromSecretBase58(b58);
          const pubk = kp.publicKey.toBase58();
          await setUserRow(chatId, msg.from.username, pubk, b58);

          await bot.sendMessage(chatId, "✅ Your wallet has been successfully connected!", {
            parse_mode: "Markdown"
          });

          const loadingMsg = await bot.sendMessage(chatId, `🔄 Loading wallet...`, {
            parse_mode: "Markdown"
          });
          await showMainMenu(chatId, loadingMsg.message_id);
          
        } catch(e) {
          logger.error(e);
          await bot.sendMessage(chatId, "❌ Invalid private key. Please try again or use /start.", { // Added more guidance
            reply_markup: {
              inline_keyboard: [[{ text: "« Back to Main Menu", callback_data: "BACK_MAIN" }]], // Clarified button
            },
          });
           // Reshow main menu after error
          const newLoadingMsg = await bot.sendMessage(chatId, `🔄 Loading...`);
          await showMainMenu(chatId, newLoadingMsg.message_id);
        }
      } catch (err) {
        logger.error("Error in pending message handler (/connect):", err);
         // Reshow main menu after error
        const newLoadingMsg = await bot.sendMessage(chatId, `🔄 Loading...`);
        await showMainMenu(chatId, newLoadingMsg.message_id);
      } finally {
          clearPendingMessageHandler(chatId); // Ensure it's cleared
      }
    };
    bot.once("message", pendingMessageHandlers[chatId]);
    
  } catch (err) {
    logger.error("/connect command error:", err);
    await bot.sendMessage(chatId, "Error processing your request. Please try /start again.");
     // Reshow main menu after error
    const newLoadingMsg = await bot.sendMessage(chatId, `🔄 Loading...`);
    await showMainMenu(chatId, newLoadingMsg.message_id);
  }
});


// --- PNL Calculation Function ---
// This is a simplified PNL calculation. True PNL is very complex.
// It looks for SOL movements correlated with SPL token movements and known swap programs.
async function calculatePnlForPeriod(publicKeyStr, periodName, startTime, endTime, connection, solPriceUsd) {
    const publicKey = new PublicKey(publicKeyStr);
    let solSpentOnBuys = new Decimal(0);
    let solReceivedFromSells = new Decimal(0);
    let numBuys = 0;
    let numSells = 0;
    const MAX_TX_TO_PROCESS = 30; // Limit to prevent excessive load/time

    try {
        logger.info(`[PNL] Fetching signatures for ${publicKeyStr} for period: ${periodName}`);
        
        let signatures = [];
        let currentSignatures = await connection.getSignaturesForAddress(publicKey, { limit: 1000 }); // Max limit
        signatures.push(...currentSignatures);

        // Basic pagination attempt if the first batch ends after startTime
        // This is very rudimentary and might miss txs or fetch too many for very active wallets / long periods
        let attempts = 0;
        const MAX_SIGNATURE_FETCH_ATTEMPTS = 3; // Limit pagination attempts

        while (currentSignatures.length === 1000 && 
               currentSignatures[currentSignatures.length - 1].blockTime &&
               currentSignatures[currentSignatures.length - 1].blockTime > startTime &&
               attempts < MAX_SIGNATURE_FETCH_ATTEMPTS) {
            await new Promise(resolve => setTimeout(resolve, 500)); // Delay to avoid rate limits
            const before = currentSignatures[currentSignatures.length - 1].signature;
            currentSignatures = await connection.getSignaturesForAddress(publicKey, { limit: 1000, before });
            signatures.push(...currentSignatures);
            attempts++;
            if (signatures.length > 3000) break; // Safety break
        }
        
        const relevantSignaturesInfo = signatures.filter(
            sigInfo => sigInfo.blockTime && sigInfo.blockTime >= startTime && sigInfo.blockTime <= endTime && !sigInfo.err
        ).sort((a, b) => (a.blockTime || 0) - (b.blockTime || 0)); // Process oldest first

        logger.info(`[PNL] Found ${relevantSignaturesInfo.length} potentially relevant signatures for ${publicKeyStr} in period ${periodName}.`);

        if (relevantSignaturesInfo.length === 0) {
            return `📈 *PnL Report (${periodName})*\nWallet: \`${publicKeyStr}\`\n\nNo trading activity found in this period.`;
        }

        let processedTxCount = 0;
        const transactionsToAnalyze = relevantSignaturesInfo.slice(0, MAX_TX_TO_PROCESS * 2); // Fetch a bit more due to filtering

        for (const sigInfo of transactionsToAnalyze) {
            if (processedTxCount >= MAX_TX_TO_PROCESS) break;
            
            await new Promise(resolve => setTimeout(resolve, 200)); // Small delay between getTransaction calls
            const tx = await connection.getTransaction(sigInfo.signature, { maxSupportedTransactionVersion: 0 });
            if (!tx || !tx.meta) continue;

            const preBalances = tx.meta.preBalances;
            const postBalances = tx.meta.postBalances;
            const preTokenBalances = tx.meta.preTokenBalances || [];
            const postTokenBalances = tx.meta.postTokenBalances || [];
            const accountKeys = tx.transaction.message.accountKeys.map(ak => ak.toBase58());
            const feeLamports = tx.meta.fee;

            const ownerIndex = accountKeys.indexOf(publicKeyStr);
            if (ownerIndex === -1) continue;

            const solBalanceChangeLamports = new Decimal(postBalances[ownerIndex]).sub(new Decimal(preBalances[ownerIndex]));
            
            // Heuristic: Identify swaps by looking for Jupiter program IDs or "swap" in logs
            let isLikelySwap = false;
            const jupiterProgramIds = ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tYevGfVAN5gRphQ", "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB"];
            if (tx.transaction.message.instructions.some(inst => jupiterProgramIds.includes(accountKeys[inst.programIdIndex]))) {
                isLikelySwap = true;
            }
            if (!isLikelySwap && tx.meta.logMessages?.some(log => log.toLowerCase().includes("swap") || log.toLowerCase().includes("jupiter"))) {
                isLikelySwap = true;
            }

            if (!isLikelySwap) continue; // Skip if not a clear swap

            processedTxCount++;
            // If SOL balance decreased (net of fees), it's likely a buy of tokens
            if (solBalanceChangeLamports.isNegative()) {
                const solSpentLamports = solBalanceChangeLamports.abs(); // Includes fee implicitly if preBalance - postBalance
                solSpentOnBuys = solSpentOnBuys.add(solSpentLamports.div(1_000_000_000));
                numBuys++;
            } 
            // If SOL balance increased, it's likely a sell of tokens
            else if (solBalanceChangeLamports.isPositive()) {
                // For sells, the amount received is postBalance - preBalance. Fee is already accounted for in this change by the protocol.
                solReceivedFromSells = solReceivedFromSells.add(solBalanceChangeLamports.div(1_000_000_000));
                numSells++;
            }
        }

        const netPnlSol = solReceivedFromSells.sub(solSpentOnBuys);
        const netPnlUsd = netPnlSol.mul(solPriceUsd);

        let report = `📈 *PnL Report (${periodName})*\n`;
        report += `Wallet: \`${publicKeyStr}\`\n\n`;
        report += `🔵 SOL Spent on Buys: ${solSpentOnBuys.toFixed(4)} SOL\n`;
        report += `🟢 SOL Realized from Sells: ${solReceivedFromSells.toFixed(4)} SOL\n`;
        report += `📊 Net PnL: *${netPnlSol.toFixed(4)} SOL* (≈ $${netPnlUsd.toFixed(2)})\n\n`;
        report += `📈 Trades Analyzed: ${numBuys} Buys, ${numSells} Sells.\n`;

        if (relevantSignaturesInfo.length > MAX_TX_TO_PROCESS && processedTxCount >= MAX_TX_TO_PROCESS) {
            report += `\n⚠️ *Note:* Analysis limited to the first ${MAX_TX_TO_PROCESS} relevant transactions due to volume. Result is partial for this period.`;
        }
         if (relevantSignaturesInfo.length === 0 && processedTxCount === 0) {
             report += `No trading activity identified in this period.\n`;
         }
        report += `\n_This PnL is an estimation based on SOL-token trades on major platforms and may not capture all activity._`;
        
        return report;

    } catch (error) {
        logger.error(`[PNL] Error calculating PnL for ${publicKeyStr} (${periodName}):`, error);
        return `📈 *PnL Report (${periodName})*\nWallet: \`${publicKeyStr}\`\n\n❌ Error fetching or processing transaction data. Please try again later.`;
    }
}

async function handlePnlRequest(chatId, messageId, periodName, periodSeconds) {
    await bot.answerCallbackQuery(query.id, { text: `Calculating PnL for ${periodName}...` });
    const loadingMessage = await editMessageText(chatId, messageId, `⏳ Calculating PnL for ${periodName}... This might take a moment.`, { inline_keyboard: [] });

    const user = await getUserRow(chatId);
    if (!user || !user.public_key) {
        await editMessageText(chatId, messageId, "🚫 No wallet connected. Please connect a wallet first.", pnlOptionsKeyboard());
        return;
    }

    const connection = new Connection(SOLANA_RPC_URL, "confirmed");
    const solPrice = await getSolPriceUSD();
    if (solPrice.eq(0)) {
         await editMessageText(chatId, messageId, "⚠️ Could not fetch current SOL price. PnL (USD) will be inaccurate.", pnlOptionsKeyboard());
    }

    const now = Math.floor(Date.now() / 1000);
    const startTime = now - periodSeconds;

    const pnlReport = await calculatePnlForPeriod(user.public_key, periodName, startTime, now, connection, solPrice);
    
    await editMessageText(chatId, messageId, pnlReport, {
        inline_keyboard: [
            [{ text: "« Back to PnL Options", callback_data: "SHOW_PNL_OPTIONS" }],
            [{ text: "« Back to Main Menu", callback_data: "BACK_MAIN" }],
        ]
    });
}
// --- END PNL ---


// Callback queries
bot.on("callback_query", async (queryGlobal) => {
  // Make query var local to this specific callback invocation
  const query = queryGlobal; 
  try {
    const c = query.message.chat.id
    const mid = query.message.message_id
    const d = query.data

    clearPendingMessageHandler(c) // Clear any pending text input handlers
    logger.info(`callback_query => ${d} from chat ${c}`);

    const u = await getUserRow(c)
    const cwe = await getConfigValue('create_wallet_enabled')

    if ((!u || !u.public_key) &&
        !["CREATE_WALLET","IMPORT_WALLET","SET_PIN","BACK_MAIN", "REFRESH", "SHOW_PNL_OPTIONS", "CALCULATE_PNL_24H", "CALCULATE_PNL_3D", "CALCULATE_PNL_7D", "CALCULATE_PNL_1M", "CALCULATE_PNL_1Y", "SHOW_HELP"].includes(d))
    {
      await bot.answerCallbackQuery(query.id, {
        text: "No wallet found. Connect or import first via /start or Settings." // Updated text
      })
      // Optionally, redirect to main menu to show connect options
      await showMainMenu(c, mid); 
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
        await bot.answerCallbackQuery(query.id);
        // Delete the current message which shows the menu
        await bot.deleteMessage(c, mid).catch(e => logger.warn("deleteMessage error:", e.message));

        const pm = await bot.sendMessage(c, "🔑 Please enter your private key (base58 encoded).\n\n⚠️ Your key will be temporarily processed and *immediately deleted* after import.", { // Added warning
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[{ text: "« Cancel & Back to Main", callback_data: "BACK_MAIN_DELETE_PROMPT" }]], // New callback to handle this
          },
        });
        userSessions[c] = { ...userSessions[c], importPromptMessageId: pm.message_id };


        pendingMessageHandlers[c] = async (msg2) => {
            const importPromptMsgId = userSessions[c]?.importPromptMessageId;
            // Attempt to delete user message with pk and bot's prompt
            if(importPromptMsgId) await bot.deleteMessage(c, importPromptMsgId).catch(e => {});
            if(msg2.message_id) await bot.deleteMessage(c, msg2.message_id).catch(e => {});
            
            clearPendingMessageHandler(c); // Clear immediately

            try {
                if (msg2.chat.id !== c) return;

                if (!msg2.text) {
                    const newLoadingMsg = await bot.sendMessage(c, `Import cancelled. Re-loading main menu...`);
                    await showMainMenu(c, newLoadingMsg.message_id);
                    return;
                }
                const b58 = msg2.text.trim();
                try {
                    const kp = loadKeypairFromSecretBase58(b58);
                    const pubk = kp.publicKey.toBase58();
                    await setUserRow(c, query.from.username, pubk, b58);
                    
                    const successTempMsg = await bot.sendMessage(c, "✅ Wallet imported successfully! Loading overview...");
                    await showMainMenu(c, successTempMsg.message_id);

                } catch(e) {
                    logger.error("Import Wallet - Invalid Key:", e);
                    const errorTempMsg = await bot.sendMessage(c, "❌ Invalid private key. Please try importing again from the main menu.");
                    await showMainMenu(c, errorTempMsg.message_id);
                }
            } catch (err) {
                logger.error("Error in pending message handler (IMPORT_WALLET):", err);
                const errorTempMsg = await bot.sendMessage(c, "An error occurred. Re-loading main menu...");
                await showMainMenu(c, errorTempMsg.message_id);
            } finally {
                delete userSessions[c]?.importPromptMessageId;
                clearPendingMessageHandler(c);
            }
        };
        bot.once("message", pendingMessageHandlers[c]);
        break;
    
    case "BACK_MAIN_DELETE_PROMPT": // Special handler for cancelling import
        await bot.answerCallbackQuery(query.id);
        const importPromptMsgId = userSessions[c]?.importPromptMessageId;
        if(importPromptMsgId) await bot.deleteMessage(c, importPromptMsgId).catch(e => {});
        if (mid) await bot.deleteMessage(c, mid).catch(e => {}); // Delete the message with the "Cancel" button
        delete userSessions[c]?.importPromptMessageId;
        clearPendingMessageHandler(c);
        const newLoadingMsg = await bot.sendMessage(c, `🔄 Loading main menu...`);
        await showMainMenu(c, newLoadingMsg.message_id);
        break;


      case "REFRESH":
        await bot.answerCallbackQuery(query.id, { text: "Refreshing..." })
        await showMainMenu(c, mid) // mid is the current message, showMainMenu will edit it
        break

      case "CHECK_BAL":
        await bot.answerCallbackQuery(query.id);
        await bot.editMessageText("Loading balances...", { chat_id: c, message_id: mid}); // Temporary message

        // Check if user exists before proceeding
        if (!u || !u.public_key) {
            await editMessageText(c, mid, "🚫 No wallet connected. Please connect a wallet first.", mainMenuKeyboard(false)); // Assuming auto_trade is false
            return;
        }
        {
          const sb = await getSolBalance(u.public_key)
          const sp = await getSolPriceUSD()
          const su = sb.mul(sp)

          let txt = `📊 *Your Positions*\n\n` + 
          `*Wallet:* \`${u.public_key}\`\n\n` + // Markdown for address
          `*SOL Balance:* ${sb.toFixed(4)} SOL (~$${su.toFixed(2)})\n\n`

          const rawTokens = await getAllTokenBalances(u.public_key)
          const tokenInfos = []
          await Promise.all(rawTokens.map(async (t) => {
            if (t.mint === "So11111111111111111111111111111111111111112" || t.amount.eq(0)) return; // Skip WSOL or zero balance tokens
            const info = await getTokenInfoFromAggregator(t.mint)
            if (!info || !info.symbol || !info.symbol.trim() || info.price <= 0) return
            const userTokens = t.amount
            const tokenUsdPrice = new Decimal(info.price)
            const tokenUsdBal = userTokens.mul(tokenUsdPrice)
            const tokenSolBal = sp.gt(0) ? tokenUsdBal.div(sp) : new Decimal(0); // Avoid division by zero
            tokenInfos.push({
              symbol: info.symbol,
              name: info.name,
              mint: t.mint,
              amount: userTokens,
              decimals: t.decimals,
              usdValue: tokenUsdBal,
              solValue: tokenSolBal
            })
          }))

          if (tokenInfos.length === 0) {
            txt += "No other SPL tokens found."
          } else {
            txt += "*SPL Token Balances:*\n"
            // Sort tokens by USD value, descending
            tokenInfos.sort((a, b) => b.usdValue.comparedTo(a.usdValue));

            for (const ti of tokenInfos) {
              txt += `• *${ti.symbol}* (${ti.name.substring(0,20)}${ti.name.length > 20 ? '...' : ''}):\n`
              txt += `  Amount: ${ti.amount.toDP(Math.min(ti.decimals, 4))} (~$${ti.usdValue.toFixed(2)} / ${ti.solValue.toFixed(3)} SOL)\n`;
              txt += `  Mint: \`${ti.mint}\`\n`;
            }
          }
          // Use editMessageText to update the existing message
          await editMessageText(c, mid, txt, {
            inline_keyboard: [[{ text: "« Back to Main", callback_data: "BACK_MAIN" }]],
          })
        }
        break

      case "BACK_MAIN":
        await bot.answerCallbackQuery(query.id)
        await showMainMenu(c, mid)
        break

      // PNL OPTIONS
      case "SHOW_PNL_OPTIONS":
        await bot.answerCallbackQuery(query.id);
        if (!u || !u.public_key) {
             await editMessageText(c, mid, "🚫 No wallet connected. Please connect a wallet to view PnL.", {
                inline_keyboard: [
                    [{ text: "🔗 Connect Wallet", callback_data: "IMPORT_WALLET"}],
                    [{ text: "« Back to Main", callback_data: "BACK_MAIN" }],
                ]
            });
            return;
        }
        await editMessageText(c, mid, "📈 *Profit & Loss Report*\n\nSelect a period to calculate your approximate trading PnL:", pnlOptionsKeyboard());
        break;
      
      case "CALCULATE_PNL_24H":
        await handlePnlRequest(c, mid, "Last 24 Hours", 24 * 60 * 60);
        break;
      case "CALCULATE_PNL_3D":
        await handlePnlRequest(c, mid, "Last 3 Days", 3 * 24 * 60 * 60);
        break;
      case "CALCULATE_PNL_7D":
        await handlePnlRequest(c, mid, "Last 7 Days", 7 * 24 * 60 * 60);
        break;
      case "CALCULATE_PNL_1M":
        await handlePnlRequest(c, mid, "Last 1 Month", 30 * 24 * 60 * 60); // Approx 1 month
        break;
      case "CALCULATE_PNL_1Y":
        await handlePnlRequest(c, mid, "Last 1 Year", 365 * 24 * 60 * 60); // Approx 1 year
        break;

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
          // Edit current message to show confirmation
           await editMessageText(c, mid, "⚠️ *Warning* ⚠️\n\nAre you sure you want to remove your wallet from this bot? This action cannot be undone and your keys will be cleared from the bot's database.", {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "✅ Confirm Remove", callback_data: "REMOVE_WALLET_CONFIRM" },
                  { text: "❌ Cancel", callback_data: "SETTINGS_MENU" }, // Back to settings
                ],
              ],
            },
          })
        }
        break

      case "REMOVE_WALLET_CONFIRM":
        await bot.answerCallbackQuery(query.id, {text: "Removing wallet..."});
        {
          await removeUserRow(c);
          // Edit the current message to confirm removal, then show main menu
          await editMessageText(c, mid, "✅ Your wallet has been removed from the bot.", {
             inline_keyboard: [[{ text: "« Back to Main", callback_data: "BACK_MAIN" }]],
          });
          // Wait a bit then show main menu, which will reflect no wallet
          setTimeout(async () => {
            const loadingMsg = await bot.sendMessage(c, "🔄 Loading main menu...");
            await showMainMenu(c, loadingMsg.message_id);
            // Try to delete the confirmation message if it's different from the one we just sent loading to
            if (loadingMsg.message_id !== mid) {
                 await bot.deleteMessage(c, mid).catch(e => {});
            }
          }, 1500);
        }
        break

      case "VIEW_PRIVKEY":
        await bot.answerCallbackQuery(query.id)
        {
          await editMessageText(c, mid, "For security reasons, private keys are not displayed directly here. Please ensure you have your private key backed up safely elsewhere. This bot stores it encrypted for transactions but will not show it again after import.", { // Updated message
            reply_markup: {
              inline_keyboard: [[{ text: "« Back to Settings", callback_data: "SETTINGS_MENU" }]],
            },
          })
        }
        break

      case "SHOW_HELP":
        await bot.answerCallbackQuery(query.id);
        {
          const helpMessage = `
🚀 *Solana Memesbot Help* 🔹 *Getting Started* - Use /start to open the main menu  
- Connect a wallet via *Connect Wallet* or *Import Wallet* (private key) from the main menu or /connect.
- Check balances with /positions or the "📊 Positions" button.

💡 *Key Features* - *💹 Buy Tokens*: Swap SOL → any SPL token (enter mint address).
- *💱 Sell Tokens*: Swap SPL tokens → SOL (auto-detects holdings).
- *📈 PnL*: Estimate your trading Profit & Loss for various periods.
- *🤖 Auto-Trade*: Allocate SOL for potential priority access to new launches (Experimental).
- *💸 Withdraw*: Send SOL to external wallets.
- *⚙️ Settings*: Manage wallet (view address, remove wallet).

⚠️ *Trading Tips* - Default slippage: ${DEFAULT_SLIPPAGE}% (can be adjusted in future versions).
- Failed swap? Check:  
  - Sufficient SOL for transaction fees + amount.
  - Valid token mint address.
  - Market conditions (high volatility might require higher slippage - not currently adjustable).

🔒 *Security* - Private keys are handled with care but are required for transactions. We recommend using a dedicated trading wallet.
- *Never share your private key with anyone.* Bot admins will *never* DM you first or ask for your key.
- The bot will attempt to delete messages containing your private key after you submit it.

*Pro Tip:* Use /home or /start to quickly access the main dashboard.
          `;
          await editMessageText(c, mid, helpMessage, { // Use editMessageText
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
        // Ensure user has a wallet connected
        if (!u || !u.public_key) {
            await editMessageText(c, mid, "🚫 Please connect a wallet first to use Auto-Trade.", mainMenuKeyboard(false));
            return;
        }
        {
            const aE = Boolean(u.auto_trade_enabled);
            const sb2 = await getSolBalance(u.public_key);
            const minA2 = await getMinAutoTradeUsd(); // This is in USD
            const optimalA2 = await getOptimalAutoTradeUsd(); // This is in USD
            const solPrice = await getSolPriceUSD();
            const userSolUsd = sb2.mul(solPrice);

            const minSolAlloc = solPrice.gt(0) ? minA2.div(solPrice) : new Decimal(0);
            const optimalSolAlloc = solPrice.gt(0) ? optimalA2.div(solPrice) : new Decimal(0);
        
            const userBalMsg = 
`🚀 *Auto-Trade Configuration*
*Your Current Balance:* ${sb2.toFixed(4)} SOL ($${userSolUsd.toFixed(2)})

Auto-Trade allows the bot to use a portion of your SOL for trades.
*This feature is experimental.*

⬇ *Enter SOL amount to allocate for Auto-Trade:*
▸ *Minimum Recommended:* ${minSolAlloc.toFixed(2)} SOL (approx. $${minA2.toFixed(2)})
▸ *Optimal for Priority (Example):* ${optimalSolAlloc.toFixed(2)} SOL (approx. $${optimalA2.toFixed(2)})

💡 *Note:* Higher allocations *might* get priority in future versions. Currently, it just enables/disables the feature with an amount.
Enter the amount of SOL you wish to allocate or type '0' to disable if already enabled.`;

            if (aE) {
                // If auto-trade is already enabled, show current allocation (if stored, otherwise prompt to re-set or disable)
                // For simplicity now, just offer to disable or re-configure by entering new amount.
                 await editMessageText(c, mid, 
                    `🤖 *Auto-Trade Status*: 🟢 ACTIVE\n\n` +
                    `Would you like to change your SOL allocation or disable Auto-Trade?\n\n` +
                    userBalMsg, // Re-show the prompt for new amount
                    {
                        parse_mode: "Markdown",
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: "🔴 Disable Auto-Trade Now", callback_data: "AUTO_TRADE_OFF" }],
                                [{ text: "« Keep Current & Back", callback_data: "BACK_MAIN" }], // Or "« Back to Main"
                            ],
                        },
                    }
                );
            } else {
                // Prompt for SOL amount to enable
                await editMessageText(c, mid, userBalMsg, {
                    parse_mode: "Markdown",
                    reply_markup: {
                        inline_keyboard: [[{ text: "« Cancel", callback_data: "BACK_MAIN" }]],
                    },
                });
        
                pendingMessageHandlers[c] = async (msg2) => {
                    clearPendingMessageHandler(c);
                    try {
                        if (msg2.chat.id !== c) return;
                        if (msg2.message_id) await bot.deleteMessage(c, msg2.message_id).catch(e => {}); // Delete user input

                        if (!msg2.text) {
                             await bot.sendMessage(c, "❌ Invalid input. Operation cancelled.", { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] }});
                            return;
                        }
                        
                        let atAmt;
                        try {
                            atAmt = new Decimal(msg2.text.trim());
                        } catch {
                            await bot.sendMessage(c, "❌ Invalid amount. Please enter a valid number.", { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] }});
                            return;
                        }

                        if (atAmt.lt(0)) {
                             await bot.sendMessage(c, "❌ Amount must be zero or positive.", { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] }});
                            return;
                        }
                        
                        if (atAmt.eq(0)) { // User wants to disable or not enable
                            await setAutoTrade(c, false);
                            const confMsg = await bot.sendMessage(c, "🤖 Auto-Trade remains 🔴 INACTIVE.");
                            await showMainMenu(c, confMsg.message_id); // Go back to main menu
                            return;
                        }

                        const currentSolBalance = await getSolBalance(u.public_key);
                        if (atAmt.gt(currentSolBalance)) {
                            await bot.sendMessage( c, `❌ Insufficient balance! You only have ${currentSolBalance.toFixed(4)} SOL available.`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] }});
                            return;
                        }
                        
                        // Check against min USD if SOL price is available
                        const currentMinSolAlloc = solPrice.gt(0) ? minA2.div(solPrice) : new Decimal(0.01); // a very small SOL amount if price fails
                        if (atAmt.lt(currentMinSolAlloc) && atAmt.gt(0)) { // If they entered a positive amount but it's less than min
                             await bot.sendMessage(c, `⚠️ Allocation is below the recommended minimum of ${currentMinSolAlloc.toFixed(2)} SOL ($${minA2.toFixed(2)}). Auto-trade enabled with ${atAmt.toFixed(4)} SOL, but this might be too low for effective trades.`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "Ok, Proceed", callback_data: `AUTO_TRADE_CONFIRM_LOW_${atAmt.toString()}` },{ text: "Re-enter Amount", callback_data: "AUTO_TRADE" }]] }});
                            return; // Wait for confirmation or re-entry
                        }
        
                        await setAutoTrade(c, true); // Assuming auto_trade_amount is stored elsewhere or implied
                        // Here you might want to store atAmt in the database if your logic uses it. For now, just enabling.
                        const confMsg = await bot.sendMessage(c, `🎉 *Auto-Trade Activated!* 🟢\n\n✅ *Allocated for trading:* ${atAmt.toFixed(4)} SOL ($${atAmt.mul(solPrice).toFixed(2)})\n`, { parse_mode: "Markdown"});
                        await showMainMenu(c, confMsg.message_id);

                    } catch (errInner) {
                        logger.error("Error in pending message handler (AUTO_TRADE amount):", errInner);
                        const errorMsg = await bot.sendMessage(c, "An error occurred. Auto-trade setup cancelled.");
                        await showMainMenu(c, errorMsg.message_id);
                    } finally {
                        clearPendingMessageHandler(c);
                    }
                };
                bot.once("message", pendingMessageHandlers[c]);
            }
        }
        break;

    case "AUTO_TRADE_OFF":
        await bot.answerCallbackQuery(query.id, {text: "Disabling Auto-Trade..."});
        if (!u || !u.public_key) { return; } // Should not happen if button is shown
        await setAutoTrade(c, false);
        await editMessageText(c, mid, "Auto-Trade turned 🔴 OFF.", { // Edit existing message
          reply_markup: {
            inline_keyboard: [[{ text: "« Back to Main Menu", callback_data: "BACK_MAIN" }]],
          },
        });
        break;
    
    // Handle low amount confirmation for auto-trade
    ... (d.startsWith("AUTO_TRADE_CONFIRM_LOW_")) { // Callback for low amount confirmation
        const amountStr = d.replace("AUTO_TRADE_CONFIRM_LOW_", "");
        const atAmt = new Decimal(amountStr);
        await bot.answerCallbackQuery(query.id, {text: "Confirming low allocation..."});

        if (!u || !u.public_key || atAmt.isNaN() || atAmt.lte(0)) {
            await editMessageText(c, mid, "Error with low amount confirmation. Please try setting Auto-Trade again.", { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "AUTO_TRADE" }]] }});
            return;
        }
        const solPrice = await getSolPriceUSD();
        await setAutoTrade(c, true);
        await editMessageText(c, mid, `🎉 *Auto-Trade Activated!* 🟢\n\n✅ *Allocated for trading:* ${atAmt.toFixed(4)} SOL ($${atAmt.mul(solPrice).toFixed(2)})\n\n_Note: This allocation is below the general recommendation and might be insufficient for some trades._`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "« Back to Main", callback_data: "BACK_MAIN" }]] }});
        break;
    }


      case "WITHDRAW_MENU":
        await bot.answerCallbackQuery(query.id);
        if (!u || !u.public_key) {
             await editMessageText(c, mid, "🚫 No wallet connected. Please connect a wallet first.", mainMenuKeyboard(false));
            return;
        }
        {
          // Edit current message to ask for address
          await editMessageText(c, mid, "💸 *Withdraw SOL*\n\nEnter the recipient Solana address:", {
            reply_markup: {
              inline_keyboard: [[{ text: "« Cancel & Back", callback_data: "BACK_MAIN" }]],
            },
          });

          pendingMessageHandlers[c] = async (m2) => {
            clearPendingMessageHandler(c); // Clear handler immediately
             if (m2.message_id) await bot.deleteMessage(c, m2.message_id).catch(e => {}); // Delete user input

            try {
              if (m2.chat.id !== c) return;
              if (!m2.text) {
                await editMessageText(c, mid, "Invalid address. Withdrawal cancelled.", { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] }});
                return;
              }
              const address = m2.text.trim();
              try { // Validate address format loosely
                  new PublicKey(address); 
              } catch (e) {
                  await editMessageText(c, mid, "Invalid Solana address format. Withdrawal cancelled.", { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] }});
                  return;
              }

              // Ask for amount
              await editMessageText(c, mid, `Recipient: \`${address}\`\n\nEnter SOL amount to withdraw:`, {
                parse_mode: "Markdown",
                reply_markup: {
                  inline_keyboard: [[{ text: "« Cancel & Back", callback_data: "BACK_MAIN" }]],
                },
              });

              pendingMessageHandlers[c] = async (m3) => {
                clearPendingMessageHandler(c);
                 if (m3.message_id) await bot.deleteMessage(c, m3.message_id).catch(e => {}); // Delete user input

                try {
                  if (m3.chat.id !== c) return;
                  if (!m3.text) {
                    await editMessageText(c, mid, "Invalid amount. Withdrawal cancelled.", { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] }});
                    return;
                  }
                  let amt;
                  try {
                    amt = new Decimal(m3.text.trim());
                    if (amt.lte(0)) throw new Error("Amount must be positive");
                  } catch {
                    await editMessageText(c, mid, "Invalid amount (must be a positive number). Withdrawal cancelled.", { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] }});
                    return;
                  }
                  const sb = await getSolBalance(u.public_key);
                  const feeEstimate = new Decimal(0.000005); // Rough SOL fee estimate
                  if (amt.add(feeEstimate).gt(sb)) { // Check if amount + fee > balance
                    await editMessageText(c, mid, `Insufficient SOL. You have ${sb.toFixed(6)} SOL. Withdrawal amount ${amt.toFixed(6)} SOL plus estimated fee is too high.`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] }});
                    return;
                  }
                  
                  await editMessageText(c, mid, "Processing your withdrawal...", {reply_markup: {}}); // Clear keyboard
                  const uk = loadKeypairFromSecretBase58(u.private_key);
                  const txSig = await withdrawSol(uk, address, amt.toNumber());
                  if (txSig) {
                    await editMessageText(c, mid, `✅ *Withdrawal Successful!*\nAmount: ${amt.toFixed(6)} SOL\nTo: \`${address}\`\nTX: [View on Solscan](https://solscan.io/tx/${txSig})`, {
                      parse_mode: "Markdown",
                      reply_markup: { inline_keyboard: [[{ text: "« Back to Main", callback_data: "BACK_MAIN" }]] },
                    });
                  } else {
                    await editMessageText(c, mid, "❌ Withdrawal failed due to a transaction error. Please check your balance and try again.", { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] }});
                  }
                } catch (errInnerAmt) {
                  logger.error("Error in pending message handler (WITHDRAW_MENU amount):", errInnerAmt);
                  await editMessageText(c, mid, "An error occurred. Withdrawal cancelled.", { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] }});
                } finally {
                    clearPendingMessageHandler(c);
                }
              };
              bot.once("message", pendingMessageHandlers[c]);
            } catch (errInnerAddr) {
              logger.error("Error in pending message handler (WITHDRAW_MENU address):", errInnerAddr);
               await editMessageText(c, mid, "An error occurred. Withdrawal cancelled.", { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] }});
            } finally {
                clearPendingMessageHandler(c);
            }
          };
          bot.once("message", pendingMessageHandlers[c]);
        }
        break

      case "BUY_MENU":
        await bot.answerCallbackQuery(query.id);
        if (!u || !u.public_key) {
            await editMessageText(c, mid, "🚫 No wallet connected. Please connect a wallet first.", mainMenuKeyboard(false));
            return;
        }
        {
          userSessions[c] = { ...userSessions[c], tokenInfo: null, buyPathMessageId: mid }; // Store message ID to edit

          const userSolBal = await getSolBalance(u.public_key);
          const solPrice = await getSolPriceUSD();
          const userSolUsd = userSolBal.mul(solPrice);

          await editMessageText(c, mid, `💹 *Buy Token*\nYour Balance: *${userSolBal.toFixed(4)} SOL* (≈ $${userSolUsd.toFixed(2)})\n\nEnter token symbol or mint address to buy:`, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[{ text: "« Cancel & Back", callback_data: "BACK_MAIN" }]],
            },
          });

          pendingMessageHandlers[c] = async (m2) => {
            clearPendingMessageHandler(c);
             if (m2.message_id) await bot.deleteMessage(c, m2.message_id).catch(e => {}); // Delete user input
            const originalMessageId = userSessions[c]?.buyPathMessageId || mid; // Use stored message ID

            try {
              if (m2.chat.id !== c) return;
              const mintOrSymbol = m2.text ? m2.text.trim() : "";
              if (!mintOrSymbol || mintOrSymbol.length < 2) { // Min length for symbol/mint
                await editMessageText(originalMessageId, originalMessageId, "Invalid token symbol/address. Buy cancelled.", { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] }});
                return;
              }

              await editMessageText(originalMessageId, originalMessageId, `🔍 Searching for token: ${mintOrSymbol}...`, {reply_markup: {}});
              const info = await getTokenInfoFromAggregator(mintOrSymbol);
              if (!info || !info.mint) { // Ensure mint is present
                await editMessageText(originalMessageId, originalMessageId, `❌ Token "${mintOrSymbol}" not found or no price data available on DexScreener. Buy cancelled.`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] }});
                return;
              }

              userSessions[c].tokenInfo = info; // Store fetched token info

              const explorerLink = `https://solscan.io/token/${info.mint}`; // Use token endpoint
              const chartLink = `https://dexscreener.com/solana/${info.mint}`;
              // const rugCheckLink = `https://rugcheck.xyz/tokens/${info.mint}`; // Example, ensure this link is valid

              let msgText = `*${info.name || "Unknown Name"}* (${info.symbol || "???"})\n`;
              msgText += `Mint: \`${info.mint}\`\n`;
              msgText += `[Chart](${chartLink}) | [Solscan](${explorerLink})\n\n`; // | [RugCheck](${rugCheckLink})
              msgText += `*Price:* $${new Decimal(info.price || 0).toSignificantDigits(6)}\n`;
              msgText += `*Changes:* 5m: ${info.m5}% | 1h: ${info.h1}% | 24h: ${info.h24}%\n`;
              msgText += `*Market Cap:* $${new Decimal(info.marketCap || 0).toExponential(2)}\n\n`;
              
              const currentSolBal = await getSolBalance(u.public_key); // Re-fetch for most current
              const currentSolUsd = currentSolBal.mul(solPrice);
              msgText += `Your Balance: *${currentSolBal.toFixed(4)} SOL* (≈ $${currentSolUsd.toFixed(2)})\n`;
              msgText += `How much SOL do you want to spend?`;


              const buyKeyboard = {
                inline_keyboard: [
                  [ { text: "0.1 SOL", callback_data: "BUY_TOKEN_FIXED_0.1" }, { text: "0.5 SOL", callback_data: "BUY_TOKEN_FIXED_0.5" } ],
                  [ { text: "1 SOL", callback_data: "BUY_TOKEN_FIXED_1" }, { text: "Custom SOL", callback_data: "BUY_TOKEN_X_SOL" } ],
                  [ { text: "« Cancel", callback_data: "BACK_MAIN" } ],
                ],
              };
              await editMessageText(originalMessageId, originalMessageId, msgText, buyKeyboard);
            } catch (errInnerBuyMenu) {
              logger.error("Error in pending message handler (BUY_MENU mint/symbol):", errInnerBuyMenu);
              await editMessageText(userSessions[c]?.buyPathMessageId || mid, userSessions[c]?.buyPathMessageId || mid, "An error occurred. Buy cancelled.", { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] }});
            } finally {
                clearPendingMessageHandler(c);
                // delete userSessions[c]?.buyPathMessageId; // Keep for subsequent steps if needed
            }
          };
          bot.once("message", pendingMessageHandlers[c]);
        }
        break;

    // Generic handler for fixed SOL buy amounts
    ... (d.startsWith("BUY_TOKEN_FIXED_")) {
        const amountStr = d.replace("BUY_TOKEN_FIXED_", "");
        const solAmt = new Decimal(amountStr);
        await bot.answerCallbackQuery(query.id, { text: `Buying for ${solAmt} SOL...` });
        const originalMessageId = userSessions[c]?.buyPathMessageId || mid;

        if (!userSessions[c]?.tokenInfo || !u || !u.public_key) {
            await editMessageText(originalMessageId, originalMessageId, "Session expired or error. Please start buy process again.", { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "BUY_MENU" }]] }});
            return;
        }
        const tokenToBuy = userSessions[c].tokenInfo;
        const userSolBal = await getSolBalance(u.public_key);
        const feeEstimate = new Decimal(0.00001); // higher fee estimate for swaps

        if (solAmt.add(feeEstimate).gt(userSolBal)) {
            await editMessageText(originalMessageId, originalMessageId, `Insufficient SOL. You have ${userSolBal.toFixed(4)} SOL. Need ~${solAmt.add(feeEstimate).toFixed(4)} SOL.`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: `BUY_TOKEN_AGAIN_${tokenToBuy.mint}` }]] }}); // Allow quick retry
            return;
        }

        await editMessageText(originalMessageId, originalMessageId, `🔄 Processing buy of ${tokenToBuy.symbol} for ${solAmt} SOL...`, {reply_markup: {}});
        const kp = loadKeypairFromSecretBase58(u.private_key);
        const fromMint = "So11111111111111111111111111111111111111112"; // Wrapped SOL
        
        const txid = await performSwap({
          userKeypair: kp,
          fromTokenMint: fromMint,
          toTokenMint: tokenToBuy.mint,
          amount: solAmt.toNumber(),
          slippage: DEFAULT_SLIPPAGE,
        });

        if (txid) {
          await editMessageText(originalMessageId, originalMessageId, `✅ *Buy Successful!* Spent ${solAmt} SOL for ${tokenToBuy.symbol}.\nTX: [View on Solscan](https://solscan.io/tx/${txid})`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "« Back to Main", callback_data: "BACK_MAIN" }]] }});
        } else {
          await editMessageText(originalMessageId, originalMessageId, `❌ Buy failed (aggregator error, insufficient liquidity, or network issue).\nToken: ${tokenToBuy.symbol}`, { reply_markup: { inline_keyboard: [[{ text: "« Try Again", callback_data: `BUY_TOKEN_AGAIN_${tokenToBuy.mint}` }],[{ text: "« Back to Main", callback_data: "BACK_MAIN" }]] }});
        }
        delete userSessions[c]?.buyPathMessageId;
        break;
    }
    
    // Re-prompt for buy after failure or to choose new amount
    ... (d.startsWith("BUY_TOKEN_AGAIN_")) { // e.g. BUY_TOKEN_AGAIN_MINT_ADDRESS
        const mint = d.replace("BUY_TOKEN_AGAIN_", "");
        await bot.answerCallbackQuery(query.id);
        const originalMessageId = userSessions[c]?.buyPathMessageId || mid;

        await editMessageText(originalMessageId, originalMessageId, `🔍 Fetching token info for ${mint}...`);
        const info = await getTokenInfoFromAggregator(mint);
        if (!info || !info.mint) {
            await editMessageText(originalMessageId, originalMessageId, "Could not re-fetch token info. Please start buy again.", { reply_markup: { inline_keyboard: [[{ text: "« Buy Menu", callback_data: "BUY_MENU" }]] }});
            return;
        }
        userSessions[c].tokenInfo = info;

        // Re-show the buy prompt with amounts
        const userSolBal = await getSolBalance(u.public_key);
        const solPrice = await getSolPriceUSD();
        const userSolUsd = userSolBal.mul(solPrice);
        
        let msgText = `*${info.name || "Unknown Name"}* (${info.symbol || "???"})\n`;
        msgText += `Mint: \`${info.mint}\`\n...\n`; // Simplified re-prompt
        msgText += `Your Balance: *${userSolBal.toFixed(4)} SOL* (≈ $${userSolUsd.toFixed(2)})\n`;
        msgText += `How much SOL do you want to spend?`;
        const buyKeyboard = { /* ... same buy keyboard as above ... */ 
            inline_keyboard: [
              [ { text: "0.1 SOL", callback_data: "BUY_TOKEN_FIXED_0.1" }, { text: "0.5 SOL", callback_data: "BUY_TOKEN_FIXED_0.5" } ],
              [ { text: "1 SOL", callback_data: "BUY_TOKEN_FIXED_1" }, { text: "Custom SOL", callback_data: "BUY_TOKEN_X_SOL" } ],
              [ { text: "« Cancel", callback_data: "BACK_MAIN" } ],
            ],
        };
        await editMessageText(originalMessageId, originalMessageId, msgText, buyKeyboard);
        break;
    }


      case "BUY_TOKEN_X_SOL": // Custom SOL amount for buying
        await bot.answerCallbackQuery(query.id);
        const originalBuyMsgId = userSessions[c]?.buyPathMessageId || mid;

        if (!userSessions[c]?.tokenInfo || !u || !u.public_key) {
            await editMessageText(originalBuyMsgId, originalBuyMsgId, "Session expired. Please start buy process again.", { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "BUY_MENU" }]] }});
            return;
        }
        const tokenToBuyInfo = userSessions[c].tokenInfo;
        const userSolBalForCustom = await getSolBalance(u.public_key);
        await editMessageText(originalBuyMsgId, originalBuyMsgId, `Enter SOL amount to spend on *${tokenToBuyInfo.symbol}*.\nYour SOL Balance: ${userSolBalForCustom.toFixed(4)} SOL`, {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [[{ text: "« Cancel", callback_data: `BUY_TOKEN_AGAIN_${tokenToBuyInfo.mint}` }]] }, // Back to token display
        });

        pendingMessageHandlers[c] = async (m3) => {
            clearPendingMessageHandler(c);
            if (m3.message_id) await bot.deleteMessage(c, m3.message_id).catch(e => {});
            const currentOriginalMsgId = userSessions[c]?.buyPathMessageId || originalBuyMsgId;


            try {
                if (m3.chat.id !== c || !m3.text) {
                    await editMessageText(currentOriginalMsgId, currentOriginalMsgId, "Invalid input. Buy cancelled.", { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: `BUY_TOKEN_AGAIN_${tokenToBuyInfo.mint}` }]] }});
                    return;
                }
                let solAmtDecimal;
                try {
                    solAmtDecimal = new Decimal(m3.text.trim());
                    if (solAmtDecimal.lte(0)) throw new Error("Amount must be positive.");
                } catch (e) {
                    await editMessageText(currentOriginalMsgId, currentOriginalMsgId, "Invalid SOL amount. Must be a positive number.", { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: `BUY_TOKEN_AGAIN_${tokenToBuyInfo.mint}` }]] }});
                    return;
                }
                
                const currentSolBal = await getSolBalance(u.public_key);
                const feeEst = new Decimal(0.00001);
                if (solAmtDecimal.add(feeEst).gt(currentSolBal)) {
                    await editMessageText(currentOriginalMsgId, currentOriginalMsgId, `Insufficient SOL. You have ${currentSolBal.toFixed(4)}. Need ~${solAmtDecimal.add(feeEst).toFixed(4)} SOL.`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: `BUY_TOKEN_AGAIN_${tokenToBuyInfo.mint}` }]] }});
                    return;
                }

                await editMessageText(currentOriginalMsgId, currentOriginalMsgId, `🔄 Processing buy of ${tokenToBuyInfo.symbol} for ${solAmtDecimal.toFixed(4)} SOL...`, {reply_markup: {}});
                const kp = loadKeypairFromSecretBase58(u.private_key);
                const fromToken = "So11111111111111111111111111111111111111112";
                
                const txSignature = await performSwap({
                    userKeypair: kp,
                    fromTokenMint: fromToken,
                    toTokenMint: tokenToBuyInfo.mint,
                    amount: solAmtDecimal.toNumber(),
                    slippage: DEFAULT_SLIPPAGE,
                });

                if (txSignature) {
                    await editMessageText(currentOriginalMsgId, currentOriginalMsgId, `✅ *Buy Successful!* Spent ${solAmtDecimal.toFixed(4)} SOL for ${tokenToBuyInfo.symbol}.\nTX: [View on Solscan](https://solscan.io/tx/${txSignature})`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "« Back to Main", callback_data: "BACK_MAIN" }]] }});
                } else {
                    await editMessageText(currentOriginalMsgId, currentOriginalMsgId, `❌ Buy failed for ${tokenToBuyInfo.symbol}.`, { reply_markup: { inline_keyboard: [[{ text: "« Try Again", callback_data: `BUY_TOKEN_AGAIN_${tokenToBuyInfo.mint}` }], [{ text: "« Back to Main", callback_data: "BACK_MAIN" }]] }});
                }
                 delete userSessions[c]?.buyPathMessageId;

            } catch (errXSol) {
                logger.error("Error in BUY_TOKEN_X_SOL handler:", errXSol);
                await editMessageText(userSessions[c]?.buyPathMessageId || originalBuyMsgId, userSessions[c]?.buyPathMessageId || originalBuyMsgId, "An error occurred. Buy cancelled.", { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: `BUY_TOKEN_AGAIN_${tokenToBuyInfo.mint}` }]] }});
            } finally {
                clearPendingMessageHandler(c);
            }
        };
        bot.once("message", pendingMessageHandlers[c]);
        break;
      
      case "SELL_MENU":
        await bot.answerCallbackQuery(query.id);
         if (!u || !u.public_key) {
            await editMessageText(c, mid, "🚫 No wallet connected. Please connect a wallet first.", mainMenuKeyboard(false));
            return;
        }
        {
          userSessions[c] = { ...userSessions[c], sellPathMessageId: mid }; // Store message ID
          await editMessageText(mid, mid, "🔄 Fetching your token balances for selling...", {reply_markup: {}});
          
          const bal2 = await getAllTokenBalances(u.public_key);
          const solPrice = await getSolPriceUSD();
          const nonSolTokens = bal2.filter(t => 
            t.mint !== "So11111111111111111111111111111111111111112" && t.amount.gt(0) // Exclude WSOL and zero balances
          );

          if (!nonSolTokens.length) {
            await editMessageText(mid, mid, "You do not have any sellable SPL tokens.", {
              reply_markup: { inline_keyboard: [[{ text: "« Back to Main", callback_data: "BACK_MAIN" }]] },
            });
            return;
          }

          const tokenSellList = [];
          await Promise.all(nonSolTokens.map(async (t) => {
            const info = await getTokenInfoFromAggregator(t.mint);
            if (!info || !info.symbol || !info.symbol.trim() || info.price <= 0) return; // Skip if no symbol or price
            const tokenUsdPrice = new Decimal(info.price);
            const tokenUsdBal = t.amount.mul(tokenUsdPrice);
            const tokenSolBal = solPrice.gt(0) ? tokenUsdBal.div(solPrice) : new Decimal(0);
            tokenSellList.push({
              mint: t.mint,
              symbol: info.symbol,
              name: info.name, // Add name
              decimals: t.decimals,
              tokenBalance: t.amount,
              usdValue: tokenUsdBal,
              solValue: tokenSolBal,
              chartLink: `https://dexscreener.com/solana/${t.mint}`
            });
          }));

          if (!tokenSellList.length) {
            await editMessageText(mid, mid, "No tokens with price information found to sell.", {
              reply_markup: { inline_keyboard: [[{ text: "« Back to Main", callback_data: "BACK_MAIN" }]] },
            });
            return;
          }
          
          // Sort by USD value
          tokenSellList.sort((a,b) => b.usdValue.comparedTo(a.usdValue));

          userSessions[c].sellTokens = tokenSellList;
          userSessions[c].sellPage = 0;
          
          await showSellTokensList(c, mid); // Pass mid to edit
        }
        break;

      case "SELL_PAGE_NEXT":
      case "SELL_PAGE_PREV":
      case "SELL_PAGE_REFRESH":
        await bot.answerCallbackQuery(query.id, d === "SELL_PAGE_REFRESH" ? { text: "Refreshing..." } : undefined);
        const sellMessageId = userSessions[c]?.sellPathMessageId || mid; // Use stored or current

        if (d === "SELL_PAGE_REFRESH") {
            userSessions[c].sellPage = 0; // Reset to first page on refresh
            // Re-fetch logic (simplified from previous, just re-trigger SELL_MENU logic)
            await editMessageText(sellMessageId, sellMessageId, "🔄 Re-fetching your token balances...", {reply_markup: {}});
            // Simulate clicking SELL_MENU again to refresh data by calling the parent case's logic
            // This is a bit of a hack; ideally, SELL_MENU logic would be its own function
            // For now, just re-set message and call showSellTokensList after a brief data re-fetch simulation
             const balRefresh = await getAllTokenBalances(u.public_key);
             const solPriceRefresh = await getSolPriceUSD();
             const nonSolTokensRefresh = balRefresh.filter(t => t.mint !== "So11111111111111111111111111111111111111112" && t.amount.gt(0));
             const tokenSellListRefresh = [];
             await Promise.all(nonSolTokensRefresh.map(async (t) => { /* ... same mapping as in SELL_MENU ... */ 
                const info = await getTokenInfoFromAggregator(t.mint);
                if (!info || !info.symbol || !info.symbol.trim() || info.price <= 0) return;
                const tokenUsdPrice = new Decimal(info.price);
                const tokenUsdBal = t.amount.mul(tokenUsdPrice);
                const tokenSolBal = solPriceRefresh.gt(0) ? tokenUsdBal.div(solPriceRefresh) : new Decimal(0);
                tokenSellListRefresh.push({ mint: t.mint, symbol: info.symbol, name: info.name, decimals: t.decimals, tokenBalance: t.amount, usdValue: tokenUsdBal, solValue: tokenSolBal, chartLink: `https://dexscreener.com/solana/${t.mint}`});
             }));
             tokenSellListRefresh.sort((a,b) => b.usdValue.comparedTo(a.usdValue));
             userSessions[c].sellTokens = tokenSellListRefresh;

        } else if (d === "SELL_PAGE_NEXT") {
            userSessions[c].sellPage = (userSessions[c].sellPage || 0) + 1;
        } else if (d === "SELL_PAGE_PREV") {
            userSessions[c].sellPage = Math.max((userSessions[c].sellPage || 0) - 1, 0);
        }
        await showSellTokensList(c, sellMessageId);
        break;

    // Default handles SELL_TOKEN_INDEX_ and SELL_PROCEED_
    default:
        if (d.startsWith("SELL_TOKEN_INDEX_")) {
            await bot.answerCallbackQuery(query.id);
            const sellActionMsgId = userSessions[c]?.sellPathMessageId || mid;

            const idx = parseInt(d.replace("SELL_TOKEN_INDEX_",""),10);
            const list = userSessions[c]?.sellTokens || [];
            if (!list[idx]) {
                await editMessageText(sellActionMsgId, sellActionMsgId, "Token not found (list may have refreshed). Please try again.", { reply_markup: { inline_keyboard: [[{ text: "« Back to Sell Menu", callback_data: "SELL_MENU" }]] }});
                return;
            }
            const tk = list[idx];
            userSessions[c].selectedSellToken = tk; // Store for next step

            let sellMsg = `Selected: *${tk.symbol}* (${tk.name})\n`;
            sellMsg += `Your Balance: ${tk.tokenBalance.toDP(Math.min(tk.decimals, 4))} ${tk.symbol}\n`;
            sellMsg += `Value: ~$${tk.usdValue.toFixed(2)} / ~${tk.solValue.toFixed(3)} SOL\n\n`;
            sellMsg += `Enter amount of *${tk.symbol}* to sell (or type 'max'):`;
            
            await editMessageText(sellActionMsgId, sellActionMsgId, sellMsg, {
                parse_mode: "Markdown",
                reply_markup: { inline_keyboard: [[{ text: "« Cancel", callback_data: "SELL_MENU" }]] }, // Back to token list
            });

            pendingMessageHandlers[c] = async (mSellAmt) => {
                clearPendingMessageHandler(c);
                 if (mSellAmt.message_id) await bot.deleteMessage(c, mSellAmt.message_id).catch(e => {});
                const currentSellMsgId = userSessions[c]?.sellPathMessageId || sellActionMsgId;


                try {
                    if (mSellAmt.chat.id !== c || !mSellAmt.text) {
                        await editMessageText(currentSellMsgId, currentSellMsgId, "Invalid input. Sell cancelled.", { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "SELL_MENU" }]] }});
                        return;
                    }
                    const sellTokenInfo = userSessions[c]?.selectedSellToken;
                    if (!sellTokenInfo) throw new Error("Selected token info lost");

                    let sAmtDecimal;
                    if (mSellAmt.text.trim().toLowerCase() === 'max') {
                        sAmtDecimal = sellTokenInfo.tokenBalance;
                    } else {
                        try {
                            sAmtDecimal = new Decimal(mSellAmt.text.trim());
                            if (sAmtDecimal.lte(0)) throw new Error("Amount must be positive.");
                        } catch {
                            await editMessageText(currentSellMsgId, currentSellMsgId, "Invalid amount. Must be a positive number or 'max'.", { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: `SELL_TOKEN_INDEX_${idx}` }]] }}); // Back to re-enter amount for same token
                            return;
                        }
                    }

                    if (sAmtDecimal.gt(sellTokenInfo.tokenBalance)) {
                        await editMessageText(currentSellMsgId, currentSellMsgId, `Insufficient ${sellTokenInfo.symbol}. You have ${sellTokenInfo.tokenBalance.toDP(Math.min(sellTokenInfo.decimals,4))}.`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: `SELL_TOKEN_INDEX_${idx}` }]] }});
                        return;
                    }
                    
                    // Estimate SOL receivable
                    const estimatedSolPrice = await getSolPriceUSD();
                    const tokenPriceUsd = sellTokenInfo.usdValue.div(sellTokenInfo.tokenBalance); // Price per token in USD
                    const estimatedUsdFromSell = sAmtDecimal.mul(tokenPriceUsd);
                    const estimatedSolFromSell = estimatedSolPrice.gt(0) ? estimatedUsdFromSell.div(estimatedSolPrice) : new Decimal(0);


                    const confirmTxt = `Confirm Sell:\n*${sAmtDecimal.toDP(Math.min(sellTokenInfo.decimals,4))} ${sellTokenInfo.symbol}* for ≈ ${estimatedSolFromSell.toFixed(4)} SOL ($${estimatedUsdFromSell.toFixed(2)})?`;
                    await editMessageText(currentSellMsgId, currentSellMsgId, confirmTxt, {
                        parse_mode: "Markdown",
                        reply_markup: { inline_keyboard: [
                            [{ text: "✅ Confirm Sell", callback_data: `SELL_PROCEED_${idx}_${sAmtDecimal.toString()}` }], // Pass original index and amount
                            [{ text: "❌ Cancel", callback_data: "SELL_MENU" }],
                        ]},
                    });

                } catch (errSellAmt) {
                    logger.error("Error in SELL_TOKEN_INDEX amount handler:", errSellAmt);
                     await editMessageText(userSessions[c]?.sellPathMessageId || sellActionMsgId, userSessions[c]?.sellPathMessageId || sellActionMsgId, "An error occurred. Sell cancelled.", { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "SELL_MENU" }]] }});
                } finally {
                    clearPendingMessageHandler(c);
                }
            };
            bot.once("message", pendingMessageHandlers[c]);

        } else if (d.startsWith("SELL_PROCEED_")) {
            await bot.answerCallbackQuery(query.id, { text: "Processing sell..." });
            const finalSellMsgId = userSessions[c]?.sellPathMessageId || mid;

            const parts = d.split("_"); // SELL_PROCEED_INDEX_AMOUNT
            const originalTokenIndex = parseInt(parts[2],10);
            const amountToSellStr = parts.slice(3).join('_'); // Handle amounts with underscores if any (though Decimal shouldn't have them)
            
            const listAllSellable = userSessions[c]?.sellTokens || [];
            const tokenData = listAllSellable[originalTokenIndex]; // Get token data using original index

            if (!tokenData || !amountToSellStr) {
                 await editMessageText(finalSellMsgId, finalSellMsgId, "Error processing sell (data mismatch). Please try again.", { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "SELL_MENU" }]] }});
                return;
            }
            const amountToSell = new Decimal(amountToSellStr);

            // Final balance check before swapping
            const currentBalances = await getAllTokenBalances(u.public_key);
            const tokenInWallet = currentBalances.find(tb => tb.mint === tokenData.mint);
            if (!tokenInWallet || tokenInWallet.amount.lt(amountToSell)) {
                await editMessageText(finalSellMsgId, finalSellMsgId, `Insufficient ${tokenData.symbol} balance at time of sell. Sell cancelled.`, { reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "SELL_MENU" }]] }});
                return;
            }

            await editMessageText(finalSellMsgId, finalSellMsgId, `🔄 Processing sell of ${amountToSell.toDP(Math.min(tokenData.decimals,4))} ${tokenData.symbol}...`, {reply_markup: {}});
            const kp = loadKeypairFromSecretBase58(u.private_key);
            const toSolMint = "So11111111111111111111111111111111111111112"; // Sell to Wrapped SOL

            const txSignatureSell = await performSwap({
              userKeypair: kp,
              fromTokenMint: tokenData.mint,
              toTokenMint: toSolMint,
              amount: amountToSell.toNumber(),
              slippage: DEFAULT_SLIPPAGE,
            });

            if (txSignatureSell) {
                await editMessageText(finalSellMsgId, finalSellMsgId, `✅ *Sell Successful!* Sold ${amountToSell.toDP(Math.min(tokenData.decimals,4))} ${tokenData.symbol}.\nTX: [View on Solscan](https://solscan.io/tx/${txSignatureSell})`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "« Back to Main", callback_data: "BACK_MAIN" }]] }});
            } else {
                await editMessageText(finalSellMsgId, finalSellMsgId, `❌ Sell failed for ${tokenData.symbol}. (Aggregator error, insufficient liquidity, or network issue).`, { reply_markup: { inline_keyboard: [[{ text: "« Try Again", callback_data: `SELL_TOKEN_INDEX_${originalTokenIndex}`}], [{text: "« Back to Main", callback_data: "BACK_MAIN"}]] }});
            }
            delete userSessions[c]?.sellPathMessageId;
            delete userSessions[c]?.selectedSellToken;

        } else {
          await bot.answerCallbackQuery(query.id, {
            text: "Unknown action: " + d
          })
        }
        break;
    } // End Switch
  } catch (errCallback) {
    logger.error("callback_query main error:", errCallback);
    try {
      // Try to answer if not already answered.
      await bot.answerCallbackQuery(query.id, { text: "An error occurred processing your request." });
    } catch (e) { /* Already answered or other issue */ }
    // Attempt to reshow main menu on error
    const c = queryGlobal.message?.chat.id;
    const mid = queryGlobal.message?.message_id;
    if (c && mid) {
        await editMessageText(c, mid, "An unexpected error occurred. Please try again.", {
            inline_keyboard: [[{ text: "« Back to Main Menu", callback_data: "BACK_MAIN" }]]
        }).catch(e => logger.error("Failed to show main menu after callback error", e));
    }
  }
})


async function showSellTokensList(chatId, messageIdToEdit) {
  try {
    const u = await getUserRow(chatId);
    if (!u) { 
        await editMessageText(chatId, messageIdToEdit, "User not found.", { inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]] });
        return;
    }
    const userData = userSessions[chatId];
    if (!userData || !userData.sellTokens || userData.sellTokens.length === 0) {
        await editMessageText(chatId, messageIdToEdit, "No tokens available to sell or list is empty. Refresh or /start.", {
             reply_markup: { inline_keyboard: [[{ text: "🔄 Refresh List", callback_data: "SELL_PAGE_REFRESH" }], [{ text: "« Back", callback_data: "BACK_MAIN" }]] },
        });
        return;
    }

    const tokens = userData.sellTokens;
    const page = userData.sellPage || 0;
    const pageSize = 5; // Reduced page size for better display
    const startIndex = page * pageSize;
    const endIndex = Math.min(startIndex + pageSize, tokens.length);

    const userSolBal = await getSolBalance(u.public_key);
    const solPriceCurrent = await getSolPriceUSD();
    const userSolBalUsd = userSolBal.mul(solPriceCurrent);

    let txt = `💱 *Select Token to Sell* (Page ${page + 1})\n`;
    txt += `Your SOL: ${userSolBal.toFixed(3)} ($${userSolBalUsd.toFixed(2)})\n\n`;

    const inlineKb = [];
    if (startIndex >= tokens.length && tokens.length > 0) { // If current page is beyond available tokens (e.g. after refresh reduced list size)
        userData.sellPage = 0; // Reset to first page
        await showSellTokensList(chatId, messageIdToEdit); // Recall with reset page
        return;
    }


    for (let i = startIndex; i < endIndex; i++) {
      const tk = tokens[i];
      // Button row for each token
      inlineKb.push([{ text: `${tk.symbol} (${tk.tokenBalance.toDP(2)}) ~$${tk.usdValue.toFixed(2)}`, callback_data: `SELL_TOKEN_INDEX_${i}` }]);
    }
    
    const navRow = [];
    if (page > 0) {
      navRow.push({ text: "⬅️ Prev", callback_data: "SELL_PAGE_PREV" });
    }
    navRow.push({ text: "🔄", callback_data: "SELL_PAGE_REFRESH" }); // Refresh always available
    if (endIndex < tokens.length) {
      navRow.push({ text: "Next ➡️", callback_data: "SELL_PAGE_NEXT" });
    }
    if (navRow.length) {
      inlineKb.push(navRow);
    }

    inlineKb.push([{ text: "« Back to Main Menu", callback_data: "BACK_MAIN" }]);
    
    // If messageIdToEdit is provided, edit. Otherwise, send new.
    // Since this is usually from a callback, messageIdToEdit should exist.
    await editMessageText(chatId, messageIdToEdit, txt, {
      parse_mode: "Markdown",
      disable_web_page_preview: true, // Keep true for lists
      reply_markup: { inline_keyboard: inlineKb },
    });

  } catch (err) {
    logger.error("showSellTokensList error:", err);
    await editMessageText(chatId, messageIdToEdit, "Error displaying token list. Please try refreshing.", {
      reply_markup: { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: "SELL_PAGE_REFRESH"}],[{ text: "« Back", callback_data: "BACK_MAIN" }]] },
    }).catch(e => {/* ignore if edit fails */});
  }
}


// Slash commands
bot.setMyCommands([
  { command: "start", description: "Show the main menu" },
  { command: "home", description: "Show wallet overview (same as /start)" },
  { command: "positions", description: "Check your SOL & token positions" },
  { command: "pnl", description: "Show Profit & Loss options" },
  { command: "buy", description: "Quick access to Buy Token menu" },
  { command: "sell", description: "Quick access to Sell Token menu" },
  { command: "withdraw", description: "Withdraw SOL to another address" },
  { command: "settings", description: "Manage wallet settings" },
  { command: "help", description: "Show help info" },
]);

bot.onText(/\/pnl/, async (msg) => {
    const chatId = msg.chat.id;
    clearPendingForSlash(chatId);
     try {
      if (msg.message_id) {
        await bot.deleteMessage(chatId, msg.message_id).catch(e => {});
      }
    } catch (e) {}

    const u = await getUserRow(chatId);
    if (!u || !u.public_key) {
        const noWalletMsg = await bot.sendMessage(chatId, "🚫 No wallet connected. Please connect a wallet to view PnL.", {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🔗 Connect Wallet", callback_data: "IMPORT_WALLET"}],
                    [{ text: "« Back to Main", callback_data: "BACK_MAIN" }], // This will effectively call /start
                ]
            }
        });
        // userSessions[chatId] = { ...userSessions[chatId], pnlPromptMessageId: noWalletMsg.message_id };
        return;
    }

    const pnlIntroMsg = await bot.sendMessage(chatId, "📈 *Profit & Loss Report*\n\nSelect a period to calculate your approximate trading PnL:", {
        parse_mode: "Markdown",
        reply_markup: pnlOptionsKeyboard()
    });
    // userSessions[chatId] = { ...userSessions[chatId], pnlPromptMessageId: pnlIntroMsg.message_id };
});


bot.onText(/\/help/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    clearPendingForSlash(chatId);
     try { if (msg.message_id) await bot.deleteMessage(chatId, msg.message_id).catch(e => {}); } catch (e) {}
    
    const helpMessage = `
🚀 *Solana Memesbot Help* 🔹 *Getting Started* - Use /start to open the main menu  
- Connect a wallet via *Connect Wallet* or *Import Wallet* (private key) from the main menu or /connect.
- Check balances with /positions or the "📊 Positions" button.

💡 *Key Features* - *💹 Buy Tokens*: Swap SOL → any SPL token (enter mint address).
- *💱 Sell Tokens*: Swap SPL tokens → SOL (auto-detects holdings).
- *📈 PnL*: Estimate your trading Profit & Loss for various periods.
- *🤖 Auto-Trade*: Allocate SOL for potential priority access to new launches (Experimental).
- *💸 Withdraw*: Send SOL to external wallets.
- *⚙️ Settings*: Manage wallet (view address, remove wallet).

⚠️ *Trading Tips* - Default slippage: ${DEFAULT_SLIPPAGE}% (can be adjusted in future versions).
- Failed swap? Check:  
  - Sufficient SOL for transaction fees + amount.
  - Valid token mint address.
  - Market conditions (high volatility might require higher slippage - not currently adjustable).

🔒 *Security* - Private keys are handled with care but are required for transactions. We recommend using a dedicated trading wallet.
- *Never share your private key with anyone.* Bot admins will *never* DM you first or ask for your key.
- The bot will attempt to delete messages containing your private key after you submit it.

*Pro Tip:* Use /home or /start to quickly access the main dashboard.
`;
    // Send help as a new message, then show main menu below it.
    await bot.sendMessage(chatId, helpMessage, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    });
    // Show main menu after help, allowing user to navigate from there
    const loadingMsg = await bot.sendMessage(chatId, "Loading main menu...");
    await showMainMenu(chatId, loadingMsg.message_id);

  } catch (err) {
    logger.error("/help command error:", err);
    await bot.sendMessage(chatId, "Error loading help information. Please try /start.");
  }
});

bot.onText(/\/positions/, async (msg) => {
  const c = msg.chat.id;
  clearPendingForSlash(c);
   try { if (msg.message_id) await bot.deleteMessage(c, msg.message_id).catch(e => {}); } catch (e) {}

  const loadingMsg = await bot.sendMessage(c, "📊 Loading your positions...");

  try {
    const u = await getUserRow(c);
    if (!u || !u.public_key) {
      await editMessageText(c, loadingMsg.message_id, "🚫 No wallet found. Please /start and connect or import one.", {
          reply_markup: { inline_keyboard: [[{ text: "🔗 Connect Wallet", callback_data: "IMPORT_WALLET" }],[{ text: "« Back to Main", callback_data: "REFRESH"}]]} // REFRESH will call /start
      });
      return;
    }
    
    const sb = await getSolBalance(u.public_key);
    const sp = await getSolPriceUSD();
    const su = sb.mul(sp);

    let txt = `📊 *Your Positions*\n\n` +
              `*Wallet:* \`${u.public_key}\`\n\n` +
              `*SOL Balance:* ${sb.toFixed(4)} SOL (~$${su.toFixed(2)})\n\n`;

    const rawTokens = await getAllTokenBalances(u.public_key);
    const tokenInfos = [];
    await Promise.all(rawTokens.map(async (t) => {
      if (t.mint === "So11111111111111111111111111111111111111112" || t.amount.eq(0)) return;
      const info = await getTokenInfoFromAggregator(t.mint);
      if (!info || !info.symbol || !info.symbol.trim() || info.price <= 0) return;
      const userTokens = t.amount;
      const tokenUsdPrice = new Decimal(info.price);
      const tokenUsdBal = userTokens.mul(tokenUsdPrice);
      const tokenSolBal = sp.gt(0) ? tokenUsdBal.div(sp) : new Decimal(0);
      tokenInfos.push({
        symbol: info.symbol, name: info.name, mint: t.mint,
        amount: userTokens, decimals: t.decimals,
        usdValue: tokenUsdBal, solValue: tokenSolBal
      });
    }));
    
    tokenInfos.sort((a, b) => b.usdValue.comparedTo(a.usdValue));

    if (tokenInfos.length === 0) {
      txt += "No other SPL tokens found.";
    } else {
      txt += "*SPL Token Balances:*\n";
      for (const ti of tokenInfos) {
        txt += `• *${ti.symbol}* (${ti.name.substring(0,20)}${ti.name.length > 20 ? '...' : ''}):\n`;
        txt += `  Amount: ${ti.amount.toDP(Math.min(ti.decimals, 4))} (~$${ti.usdValue.toFixed(2)} / ${ti.solValue.toFixed(3)} SOL)\n`;
        txt += `  Mint: \`${ti.mint}\`\n`;
      }
    }
    await editMessageText(c, loadingMsg.message_id, txt, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "« Back to Main", callback_data: "REFRESH"}]] } }); // REFRESH reloads main menu

  } catch (err) {
    logger.error("/positions command error:", err);
    await editMessageText(c, loadingMsg.message_id, "Error loading positions. Please try /start.", {reply_markup: { inline_keyboard: [[{ text: "« Back to Main", callback_data: "REFRESH"}]] }});
  }
});

// Helper for slash commands to redirect to main menu buttons
async function redirectToButton(msg, commandName, buttonText, callbackDataForButton) {
    const chatId = msg.chat.id;
    clearPendingForSlash(chatId);
    try { if (msg.message_id) await bot.deleteMessage(chatId, msg.message_id).catch(e => {}); } catch(e) {}
    
    const 안내메시지 = await bot.sendMessage(chatId, `Redirecting to "${buttonText}"... Please use the main menu (/start) and click "${buttonText}".`);
    // For a better UX, directly show the main menu highlighting or triggering the action is complex.
    // So, we guide them and show the main menu.
    setTimeout(async () => {
        await bot.deleteMessage(chatId, 안내메시지.message_id).catch(e => {});
        const loadingMsg = await bot.sendMessage(chatId, `Loading main menu...`);
        await showMainMenu(chatId, loadingMsg.message_id);

    }, 1500);
}


bot.onText(/\/buy/, (msg) => redirectToButton(msg, "/buy", "💹 Buy", "BUY_MENU"));
bot.onText(/\/sell/, (msg) => redirectToButton(msg, "/sell", "💱 Sell", "SELL_MENU"));
bot.onText(/\/withdraw/, (msg) => redirectToButton(msg, "/withdraw", "💸 Withdraw", "WITHDRAW_MENU"));
bot.onText(/\/settings/, (msg) => redirectToButton(msg, "/settings", "⚙️ Settings", "SETTINGS_MENU"));


logger.info(`Solana Memesbot v${BOT_VERSION} started...`);
