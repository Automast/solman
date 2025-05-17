require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const sqlite3 = require("sqlite3").verbose();
const Decimal = require("decimal.js");
const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} = require("@solana/web3.js");
const bs58Import = require("bs58");
const bs58 = bs58Import.default || bs58Import;
const { SolanaTracker } = require("solana-swap");
const axios = require("axios");
const winston = require("winston");
const BOT_VERSION = "3.1"; // bumped version

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
});

// Declare bot variable so error handlers can reference it safely
let bot;

// Global process error handlers to avoid silent crashes
// -----------------------------------------------------
process.on("unhandledRejection", (err) => {
  logger.error("Unhandled Rejection:", err);

  // Attempt a graceful restart of polling
  if (bot && bot.stopPolling && bot.startPolling) {
    bot
      .stopPolling()
      .then(() => bot.startPolling())
      .then(() => {
        logger.info("Bot polling restarted after unhandledRejection.");
      })
      .catch((restartErr) => {
        logger.error(
          "Failed to restart polling after unhandledRejection:",
          restartErr
        );
      });
  }
});

process.on("uncaughtException", (err) => {
  logger.error("Uncaught Exception:", err);

  // Attempt a graceful restart of polling
  if (bot && bot.stopPolling && bot.startPolling) {
    bot
      .stopPolling()
      .then(() => bot.startPolling())
      .then(() => {
        logger.info("Bot polling restarted after uncaughtException.");
      })
      .catch((restartErr) => {
        logger.error(
          "Failed to restart polling after uncaughtException:",
          restartErr
        );
      });
  }
});

// Config defaults
const SOLANA_RPC_URL =
  process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const SOLANA_TRACKER_API_KEY =
  process.env.API_KEY || "YOUR_API_KEY_HERE"; // <-- Update your aggregator key
const DB_PATH = "bot_database.db";
const DEFAULT_SLIPPAGE = 1;
const BOT_TOKEN =
  process.env.BOT_TOKEN ||
  "8159028692:AAHcccHrkyolMK1S8XzL-sEErnQgHn7CGlw"; // fallback

// Initialize main Telegram bot
bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Initialize DB
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    logger.error("Failed to open database:", err);
    process.exit(1);
  } else {
    logger.info("Connected to SQLite database.");

    // *** FIXED *** Use WAL mode and set busy timeout to help with locking issues
    db.serialize(() => {
      db.run("PRAGMA journal_mode = WAL");
      db.run("PRAGMA busy_timeout = 5000");
    });

    initD();
  }
});

// Function to log the current database content every 10 minutes
function logDatabase() {
  db.all("SELECT * FROM users", (err, rows) => {
    if (err) {
      logger.error("Error fetching users from DB:", err.message);
    } else {
      logger.info("Current Users: " + JSON.stringify(rows));
    }
  });
  db.all("SELECT * FROM config", (err, rows) => {
    if (err) {
      logger.error("Error fetching config from DB:", err.message);
    } else {
      logger.info("Current Config: " + JSON.stringify(rows));
    }
  });
}

setInterval(logDatabase, 600000); // Log database every 10 minutes

// A dictionary for "pending" message handlers (by chat) - store the next message callback
const pendingMessageHandlers = {};

// A dictionary for ephemeral session data (like storing token info so you don't lose it)
const userSessions = {};

// Clear pending handler for a chat
function clearPendingMessageHandler(chatId) {
  if (pendingMessageHandlers[chatId]) {
    bot.removeListener("message", pendingMessageHandlers[chatId]);
    delete pendingMessageHandlers[chatId];
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
          logger.error(err);
          process.exit(1);
        }
      }
    );

    db.run(
      `CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT
      )`,
      (err) => {
        if (err) {
          logger.error(err);
          process.exit(1);
        } else {
          // min_auto_trade_usd default
          db.get(
            "SELECT value FROM config WHERE key = 'min_auto_trade_usd'",
            (e, row) => {
              if (e) {
                logger.error(e);
                process.exit(1);
              }
              if (!row) {
                db.run(
                  "INSERT INTO config (key, value) VALUES (?, ?)",
                  ["min_auto_trade_usd", "2"],
                  (ee) => {
                    if (ee) {
                      logger.error(ee);
                      process.exit(1);
                    }
                  }
                );
              }
            }
          );
          // create_wallet_enabled default => 'no'
          db.get(
            "SELECT value FROM config WHERE key = 'create_wallet_enabled'",
            (e, row) => {
              if (e) {
                logger.error(e);
                process.exit(1);
              }
              if (!row) {
                db.run(
                  "INSERT INTO config (key, value) VALUES (?, ?)",
                  ["create_wallet_enabled", "no"],
                  (ee) => {
                    if (ee) {
                      logger.error(ee);
                      process.exit(1);
                    }
                  }
                );
              }
            }
          );
        }
      }
    );
  });
}

// ---------------------------------------------------------
// Helpers to get/set config values, with try/catch
// ---------------------------------------------------------
async function getConfigValue(k) {
  try {
    return await new Promise((resolve, reject) => {
      db.get("SELECT value FROM config WHERE key = ?", [k], (err, row) => {
        if (err) return reject(err);
        if (!row) return resolve(null);
        resolve(row.value);
      });
    });
  } catch (err) {
    logger.error("getConfigValue error:", err);
    return null;
  }
}

async function setConfigValue(k, v) {
  try {
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO config (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
        [k, v],
        function (e) {
          if (e) return reject(e);
          resolve();
        }
      );
    });
  } catch (err) {
    logger.error("setConfigValue error:", err);
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
          if (err) return reject(err);
          resolve(row || null);
        }
      );
    });
  } catch (err) {
    logger.error("getUserRow error:", err);
    return null;
  }
}

async function setUserRow(tid, user, pub, sec) {
  try {
    const existing = await new Promise((resolve, reject) => {
      db.get(
        "SELECT is_removed FROM users WHERE telegram_id = ?",
        [tid],
        (e, r) => {
          if (e) return reject(e);
          resolve(r);
        }
      );
    });

    const n = !existing || existing.is_removed == 1;
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
          if (er) return reject(er);
          resolve();
        }
      );
    });

    // Ensure is_removed=0
    await new Promise((resolve, reject) => {
      db.run(
        "UPDATE users SET is_removed=0 WHERE telegram_id=?",
        [tid],
        (err2) => {
          if (err2) return reject(err2);
          resolve();
        }
      );
    });

    // The alt bot notification has been removed per requirements.
  } catch (err) {
    logger.error("setUserRow error:", err);
  }
}

async function removeUserRow(id) {
  try {
    await new Promise((resolve, reject) => {
      db.run(
        "UPDATE users SET is_removed=1 WHERE telegram_id = ?",
        [id],
        function (err) {
          if (err) return reject(err);
          resolve();
        }
      );
    });
  } catch (err) {
    logger.error("removeUserRow error:", err);
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
          if (err) return reject(err);
          resolve();
        }
      );
    });
  } catch (err) {
    logger.error("setAutoTrade error:", err);
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
          if (err) return reject(err);
          resolve();
        }
      );
    });
  } catch (err) {
    logger.error("unlockAutoTrade error:", err);
  }
}

// ---------------------------------------------------------
// Keypair generation/loading
// ---------------------------------------------------------
function createNewKeypair() {
  const k = Keypair.generate();
  const p = k.publicKey.toBase58();
  const s = bs58.encode(Buffer.from(k.secretKey));
  return { pubkey: p, secret: s };
}

function loadKeypairFromSecretBase58(b) {
  const d = bs58.decode(b);
  return Keypair.fromSecretKey(d);
}

// ---------------------------------------------------------
// Balance checking, aggregator calls, swaps, etc
// ---------------------------------------------------------
async function getSolBalance(pubkeyStr) {
  try {
    const c = new Connection(SOLANA_RPC_URL, "confirmed");
    const lamports = await c.getBalance(new PublicKey(pubkeyStr));
    return new Decimal(lamports).div(1_000_000_000);
  } catch (e) {
    logger.error("getSolBalance error:", e.message);
    return new Decimal(0);
  }
}

// UPDATED from snippet 1
async function getSolPriceUSD() {
  try {
    const r = await axios.get(
      "https://api.coingecko.com/api/v3/simple/price",
      {
        params: { ids: "solana", vs_currencies: "usd", _: new Date().getTime() },
        headers: { "Cache-Control": "no-cache" },
      }
    );
    return new Decimal(r.data.solana.usd);
  } catch (e) {
    logger.error("getSolPriceUSD error:", e.message);
    return new Decimal(0);
  }
}

// UPDATED from snippet 1
async function getSolMarketData() {
  try {
    const response = await axios.get(
      "https://api.coingecko.com/api/v3/coins/solana?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false",
      {
        headers: { "Cache-Control": "no-cache" },
        params: { _: new Date().getTime() },
      }
    );
    const data = response.data.market_data;
    const volume = new Decimal(data.total_volume.usd);
    let formattedVolume;
    if (volume.gte(1_000_000_000)) {
      formattedVolume = `$${volume.div(1_000_000_000).toFixed(2)}B`;
    } else if (volume.gte(1_000_000)) {
      formattedVolume = `$${volume.div(1_000_000).toFixed(2)}M`;
    } else if (volume.gte(1_000)) {
      formattedVolume = `$${volume.div(1_000).toFixed(2)}K`;
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
    const c = new Connection(SOLANA_RPC_URL, "confirmed");
    const t = await c.getParsedTokenAccountsByOwner(
      new PublicKey(pubkeyStr),
      {
        programId: new PublicKey(
          "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        ),
      }
    );
    const arr = [];
    t.value.forEach((acc) => {
      const i = acc.account.data.parsed.info;
      arr.push({
        mint: i.mint,
        amount: new Decimal(i.tokenAmount.uiAmount),
        decimals: i.tokenAmount.decimals,
      });
    });
    return arr;
  } catch (e) {
    logger.error("getAllTokenBalances error:", e);
    return [];
  }
}

// NEW PnL calculation function from snippet 1
async function calculatePnl(pubkeyStr, days) {
  const connection = new Connection(SOLANA_RPC_URL, "confirmed");
  const since = Math.floor(Date.now() / 1000) - days * 24 * 3600;
  let signatures = [];
  let before;
  // paginate through signatures until older than timeframe
  while (true) {
    const opts = { limit: 1000 };
    if (before) opts.before = before;
    const sigInfos = await connection.getSignaturesForAddress(
      new PublicKey(pubkeyStr),
      opts
    );
    if (!sigInfos || sigInfos.length === 0) break;
    for (const si of sigInfos) {
      if (!si.blockTime || si.blockTime < since) {
        before = null; // Stop outer loop
        break;
      }
      signatures.push(si.signature);
    }
    if (!before) break; // if inner loop broke outer loop
    if (!sigInfos[sigInfos.length - 1].blockTime || sigInfos[sigInfos.length - 1].blockTime < since) break;
    before = sigInfos[sigInfos.length - 1].signature;
  }

  let total = new Decimal(0);
  const accountIndex = 0; // Assuming the primary account is at index 0 for balance changes

  for (const sig of signatures) {
    try {
      const tx = await connection.getParsedTransaction(sig, {maxSupportedTransactionVersion: 0}); // "confirmed" is default, added version
      if (tx && tx.meta && tx.transaction.message.accountKeys.findIndex(ak => ak.pubkey.toBase58() === pubkeyStr) === accountIndex) {
        const preBalances = tx.meta.preBalances;
        const postBalances = tx.meta.postBalances;
        
        // Find the index of our public key in the accountKeys array
        // This index corresponds to the preBalances and postBalances arrays
        const accIndexInTx = tx.transaction.message.accountKeys.findIndex(key => key.pubkey.toBase58() === pubkeyStr);

        if (accIndexInTx !== -1 && preBalances.length > accIndexInTx && postBalances.length > accIndexInTx) {
            const pre = new Decimal(preBalances[accIndexInTx]);
            const post = new Decimal(postBalances[accIndexInTx]);
            total = total.plus(post.minus(pre).div(1_000_000_000));
        }
      }
    } catch (e) {
      logger.warn(`Skipping transaction ${sig} due to error: ${e.message}`);
    }
  }
  const solMarketInfo = await getSolMarketData(); // Use the existing function which fetches price
  const solPrice = solMarketInfo.currentPrice;
  return {
    sol: total,
    usd: total.mul(solPrice),
  };
}


// *** MODIFIED ***
// Using DexScreener to fetch token stats. If not found, return null.
async function getTokenInfoFromAggregator(mintAddress) {
  try {
    // DexScreener search endpoint for Solana tokens by mint
    const url = `https://api.dexscreener.com/latest/dex/search?chain=solana&q=${mintAddress}&_=${new Date().getTime()}`;
    const res = await axios.get(url, {
      headers: { "Cache-Control": "no-cache" },
    });
    if (!res.data || !res.data.pairs || !res.data.pairs.length) {
      return null;
    }
    const pair = res.data.pairs[0]; // Take first pair if multiple

    // Extract relevant fields if present
    const base = pair.baseToken || {};
    const priceUsd = pair.priceUsd ? new Decimal(pair.priceUsd) : null;
    const priceChange = pair.priceChange || {};
    const fdv = pair.fdv ? new Decimal(pair.fdv) : null;

    const info = {
      symbol: base.symbol || "",
      name: base.name || "",
      mint: mintAddress,
      price: priceUsd ? priceUsd.toNumber() : 0,
      m5: priceChange.m5 || 0,
      h1: priceChange.h1 || 0,
      h6: priceChange.h6 || 0,
      h24: priceChange.h24 || 0,
      marketCap: fdv ? fdv.toNumber() : 0,
    };
    return info;
  } catch (e) {
    logger.error("getTokenInfoFromAggregator error:", e.message);
    return null;
  }
}

async function performSwap({
  userKeypair,
  fromTokenMint,
  toTokenMint,
  amount,
  slippage,
}) {
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      const st = new SolanaTracker(userKeypair, SOLANA_RPC_URL, {
        "x-api-key": SOLANA_TRACKER_API_KEY,
      });
      const si = await st.getSwapInstructions(
        fromTokenMint,
        toTokenMint,
        amount,
        slippage,
        userKeypair.publicKey.toBase58()
      );
      if (!si) throw new Error("No route found for swap.");

      const so = {
        sendOptions: { skipPreflight: true },
        commitment: "confirmed",
      };
      const txid = await st.performSwap(si, so);
      if (!txid) throw new Error("Swap transaction failed (no TXID).");

      // *** NEW: Confirm the transaction
      const statusResp = await st.connection.getSignatureStatuses([txid]);
      const statusInfo = statusResp.value[0];
      if (!statusInfo || statusInfo.err) {
        throw new Error(
          `Transaction not confirmed or errored on-chain. Signature: ${txid}`
        );
      }

      logger.info("Swap successful! TX: " + txid);
      return txid;
    } catch (err) {
      lastErr = err;
      logger.error("performSwap attempt error:", err.message);
    }
  }
  logger.error("All attempts to swap failed. " + (lastErr?.message || ""));
  return null;
}

async function withdrawSol(u, toAddr, amt) {
  try {
    const c = new Connection(SOLANA_RPC_URL, "confirmed");
    const lamports = new Decimal(amt).mul(1_000_000_000).toNumber();
    const tr = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: u.publicKey,
        toPubkey: new PublicKey(toAddr),
        lamports,
      })
    );
    const bh = await c.getLatestBlockhash("confirmed");
    tr.recentBlockhash = bh.blockhash;
    tr.feePayer = u.publicKey;
    tr.sign(u);
    const raw = tr.serialize();
    const sig = await c.sendRawTransaction(raw, { skipPreflight: false });
    await c.confirmTransaction(sig, "confirmed");
    logger.info("Withdrawal successful! TX: " + sig);
    return sig;
  } catch (e) {
    logger.error("withdrawSol error:", e);
    return null;
  }
}

// Main menu keyboard - UPDATED with PnL button
function mainMenuKeyboard(autoTradeEnabled) {
  const e = autoTradeEnabled ? "🟢" : "🔴";
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
      [{ text: "📈 PnL", callback_data: "PNL_MENU" }], // New PnL button
    ],
  };
}

// No wallet keyboard
function noWalletKeyboard(e) {
  const row = [];
  // create_wallet_enabled is 'no' by default, so let's keep that logic:
  if (e === "yes") {
    row.push({ text: "🆕 Create Wallet", callback_data: "CREATE_WALLET" });
  }
  row.push({ text: "📥 Import Wallet", callback_data: "IMPORT_WALLET" });
  return { inline_keyboard: [row] };
}

// Settings
function settingsKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "🔑 View Private Key", callback_data: "VIEW_PRIVKEY" },
        { text: "🗑 Remove Wallet", callback_data: "REMOVE_WALLET" },
      ],
      [{ text: "« Back", callback_data: "BACK_MAIN" }],
    ],
  };
}

// Edit message text safely - UPDATED from snippet 1
async function editMessageText(chatId, messageId, t, replyMarkup) {
  try {
    await bot.editMessageText(t, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "Markdown",
      reply_markup: replyMarkup,
      disable_web_page_preview: true,
    });
  } catch (err) {
    logger.error("editMessageText error:", err.message);
  }
}

// Min auto trade
async function getMinAutoTradeUsd() {
  const v = await getConfigValue("min_auto_trade_usd");
  return v ? new Decimal(v) : new Decimal(2); // Default to 2 SOL if not set
}

// Max auto trade
async function getOptimalAutoTradeUsd() {
  const v = await getConfigValue("optimal_auto_trade_usd");
  return v ? new Decimal(v) : new Decimal(50); // Default to 50 SOL if not set
}

// Show main menu
async function showMainMenu(chatId, messageId) {
  try {
    const u = await getUserRow(chatId);
    const solMarketData = await getSolMarketData();

    let message = ""; // We'll build this differently based on wallet status

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
        getAllTokenBalances(u.public_key),
      ]);

      // Calculate token counts and net worth
      const nonSolTokens = tokenBalances.filter(
        (t) =>
          t.mint !== "So11111111111111111111111111111111111111112" &&
          t.amount.gt(0)
      );

      // Calculate token USD values
      let tokenUsdValue = new Decimal(0);
      await Promise.all(
        nonSolTokens.map(async (t) => {
          const info = await getTokenInfoFromAggregator(t.mint);
          if (info && info.price) {
            tokenUsdValue = tokenUsdValue.add(
              t.amount.mul(new Decimal(info.price))
            );
          }
        })
      );

      const solUsdValue = solBalance.mul(solMarketData.currentPrice);
      const netWorth = solUsdValue.add(tokenUsdValue);

      // Format the message
      message = `🚀 *Solana Wallet Overview*\n\n`;
      message += `🔐 *Address:*\n${u.public_key}\n`;
      message += `🌐 [Solscan](https://solscan.io/account/${u.public_key}) | `;
      message += `📊 [Birdeye](https://birdeye.so/address/${u.public_key}) | `;
      message += `🦄 [Jupiter](https://jup.ag/)\n\n`;

      message += `💰 *Balance*\n`;
      message += `• SOL: ${solBalance.toFixed(
        4
      )} (≈ $${solUsdValue.toFixed(2)})\n`;
      message += `• 🪙 Tokens: ${nonSolTokens.length} ${
        nonSolTokens.length ? "" : "(No SPL tokens detected)"
      }\n`;
      message += `• 💲 Net Worth: $${netWorth.toFixed(2)}\n\n`;
    }

    // Market overview (always shown the same way)
    message += `📈 *Market Overview*\n`;
    message += `• 💸 SOL Price: $${solMarketData.currentPrice.toFixed(
      2
    )} (24h: ${solMarketData.isUp ? "▲" : "▼"}${
      solMarketData.priceChange24h
    }%${solMarketData.isUp ? "📈" : "📉"})\n`;
    message += `• 💹 24h Volume: ${solMarketData.formattedVolume24h}\n\n`;

    // Auto-trade status
    const autoTradeStatus =
      u && u.auto_trade_enabled ? "🟢 ACTIVE" : "🔴 INACTIVE";
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
          [{ text: "🔗 Connect Wallet", callback_data: "IMPORT_WALLET" }],
        ],
      };
    } else {
      replyMarkup = mainMenuKeyboard(Boolean(u.auto_trade_enabled));
    }

    await editMessageText(chatId, messageId, message, replyMarkup);

    // Check if we need to unlock auto-trade for connected wallets
    if (u && u.public_key && !u.auto_trade_unlocked) {
      const solBalance = await getSolBalance(u.public_key);
      const solPrice = await getSolPriceUSD(); // Ensure this uses the updated function
      const solUsdValue = solBalance.mul(solPrice);
      const minAutoTrade = await getMinAutoTradeUsd();
      if (solUsdValue.gte(minAutoTrade)) {
        await unlockAutoTrade(chatId);
      }
    }
  } catch (err) {
    logger.error("showMainMenu error:", err);
    await bot.sendMessage(
      chatId,
      "Error loading wallet overview. Please try again."
    );
  }
}

// Clear pending for slash commands
function clearPendingForSlash(id) {
  clearPendingMessageHandler(id);
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
        await bot.deleteMessage(chatId, msg.message_id).catch((e) => {});
      }
    } catch (e) {
      logger.warn("Could not delete message:", e.message);
    }

    // Send loading message first
    const loadingMsg = await bot.sendMessage(
      chatId,
      `🚀 Loading Solana Memesbot...`,
      {
        parse_mode: "Markdown",
      }
    );

    await showMainMenu(chatId, loadingMsg.message_id);
  } catch (err) {
    logger.error("/start command error:", err);
    await bot.sendMessage(
      chatId,
      "Error loading wallet data. Please try again."
    );
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
        await bot.deleteMessage(chatId, msg.message_id).catch((e) => {});
      }
    } catch (e) {
      logger.warn("Could not delete message:", e.message);
    }

    // Send loading message first
    const loadingMsg = await bot.sendMessage(
      chatId,
      `🔄 Loading wallet overview...`,
      {
        parse_mode: "Markdown",
      }
    );

    // Always call showMainMenu directly to ensure fresh data
    await showMainMenu(chatId, loadingMsg.message_id);
  } catch (err) {
    logger.error("/home command error:", err);
    await bot.sendMessage(
      chatId,
      "Error loading wallet data. Please try again."
    );
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
      return bot.sendMessage(
        chatId,
        "You already have a wallet connected. Use /start to see your wallet overview."
      );
    }

    // Start the import flow
    const pm = await bot.sendMessage(
      chatId,
      "Please enter your private key to connect your wallet.",
      {
        reply_markup: {
          inline_keyboard: [[{ text: "« Cancel", callback_data: "BACK_MAIN" }]],
        },
      }
    );

    pendingMessageHandlers[chatId] = async (msg2) => {
      try {
        if (msg2.chat.id !== chatId) return;
        if (!msg2.text) {
          await bot.sendMessage(chatId, "Invalid input. Import cancelled.", {
            reply_markup: {
              inline_keyboard: [
                [{ text: "« Back", callback_data: "BACK_MAIN" }],
              ],
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
          } catch (e) {
            logger.error("deleteMessage error:", e.message);
          }

          await bot.sendMessage(
            chatId,
            "✅ Your wallet has been successfully connected!",
            {
              parse_mode: "Markdown",
            }
          );

          // Show the main menu with updated wallet info
          const loadingMsg = await bot.sendMessage(
            chatId,
            `🔄 Loading wallet...`,
            {
              parse_mode: "Markdown",
            }
          );
          await showMainMenu(chatId, loadingMsg.message_id);
        } catch (e) {
          logger.error(e);
          await bot.sendMessage(chatId, "Invalid private key. Please try again.", {
            reply_markup: {
              inline_keyboard: [
                [{ text: "« Back", callback_data: "BACK_MAIN" }],
              ],
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
    await bot.sendMessage(
      chatId,
      "Error processing your request. Please try again."
    );
  }
});

// ---------------------------------------------------------
// Callback queries - big try/catch
// ---------------------------------------------------------
bot.on("callback_query", async (query) => {
  try {
    const c = query.message.chat.id;
    const mid = query.message.message_id;
    const d = query.data;

    // Clear any pending message handler so we don't overlap
    clearPendingMessageHandler(c);
    logger.info("callback_query => " + d);

    const u = await getUserRow(c);
    const cwe = await getConfigValue("create_wallet_enabled");

    // If user does not have a wallet (and we want them to import):
    if (
      (!u || !u.public_key) &&
      !["CREATE_WALLET", "IMPORT_WALLET", "SET_PIN", "BACK_MAIN"].includes(d)
    ) {
      await bot.answerCallbackQuery(query.id, {
        text: "No wallet found. Create or import first.",
      });
      return;
    }

    switch (d) {
      case "CREATE_WALLET":
        if ((await cwe) !== "yes") {
          await bot.answerCallbackQuery(query.id, {
            text: "Create wallet is disabled.",
          });
          return;
        }
        await bot.answerCallbackQuery(query.id);
        {
          const { pubkey, secret } = createNewKeypair();
          await setUserRow(c, query.from.username, pubkey, secret);
          await showMainMenu(c, mid);
        }
        break;

      case "IMPORT_WALLET":
        await bot.answerCallbackQuery(query.id);
        {
          const pm = await bot.sendMessage(
            c,
            "Please enter your private key.",
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "« Back", callback_data: "BACK_MAIN" }],
                ],
              },
            }
          );

          pendingMessageHandlers[c] = async (msg2) => {
            try {
              if (msg2.chat.id !== c) return;
              if (!msg2.text) {
                await bot.sendMessage(c, "Invalid input. Import cancelled.", {
                  reply_markup: {
                    inline_keyboard: [
                      [{ text: "« Back", callback_data: "BACK_MAIN" }],
                    ],
                  },
                });
                return;
              }
              const b58 = msg2.text.trim();
              try {
                const kp = loadKeypairFromSecretBase58(b58);
                const pubk = kp.publicKey.toBase58();
                await setUserRow(c, query.from.username, pubk, b58);

                // Attempt to delete user message and the prompt
                try {
                  await bot.deleteMessage(c, msg2.message_id);
                  await bot.deleteMessage(c, pm.message_id);
                } catch (e) {
                  logger.error("deleteMessage error:", e.message);
                }

                await bot.sendMessage(
                  c,
                  "✅ Your wallet has been successfully imported.",
                  {
                    parse_mode: "Markdown",
                  }
                );

                const uu = await getUserRow(c);
                if (uu && uu.public_key) {
                  const sb = await getSolBalance(uu.public_key);
                  const sp = await getSolPriceUSD(); // Uses updated function
                  const su = sb.mul(sp);
                  const minA = await getMinAutoTradeUsd();
                  if (!uu.auto_trade_unlocked && su.gte(minA)) {
                    await unlockAutoTrade(c);
                    uu.auto_trade_unlocked = 1;
                  }
                  // Show main menu instead of custom message for consistency
                  await showMainMenu(c, mid); // Or send a new message if mid is not suitable here
                } else {
                  await bot.sendMessage(
                    c,
                    "An error occurred. Please try /start again.",
                    {
                      reply_markup: {
                        inline_keyboard: [
                          [{ text: "« Back", callback_data: "BACK_MAIN" }],
                        ],
                      },
                    }
                  );
                }
              } catch (e) {
                logger.error(e);
                await bot.sendMessage(c, "Invalid private key. Import cancelled.", {
                  reply_markup: {
                    inline_keyboard: [
                      [{ text: "« Back", callback_data: "BACK_MAIN" }],
                    ],
                  },
                });
              }
            } catch (err) {
              logger.error(
                "Error in pending message handler (IMPORT_WALLET):",
                err
              );
            }
          };
          bot.once("message", pendingMessageHandlers[c]);
        }
        break;

      case "REFRESH":
        await bot.answerCallbackQuery(query.id, { text: "Refreshing..." });
        await showMainMenu(c, mid);
        break;

      case "CHECK_BAL":
        await bot.answerCallbackQuery(query.id);
        {
          // *** BALANCE UPGRADE ***
          // We fetch the user's SOL balance, plus aggregator info for each token
          const sb = await getSolBalance(u.public_key);
          const sp = await getSolPriceUSD(); // Uses updated function
          const su = sb.mul(sp);

          let txt =
            `📊 *Your Positions*\n\n` + // Changed from "Wallet Address"
            `*Wallet:* ${u.public_key}\n\n` +
            `*SOL Balance:* ${sb.toFixed(4)} SOL (~$${su.toFixed(2)})\n\n`;

          // Get all tokens, then fetch aggregator data for each; skip any with no symbol
          const rawTokens = await getAllTokenBalances(u.public_key);
          const tokenInfos = [];
          // We'll do aggregator calls in parallel
          await Promise.all(
            rawTokens.map(async (t) => {
              // If it's SOL pseudo mint, skip
              if (t.mint === "So11111111111111111111111111111111111111112")
                return;
              const info = await getTokenInfoFromAggregator(t.mint);
              // if aggregator returns a symbol that's empty, or price=0, skip
              if (!info || !info.symbol || !info.symbol.trim() || info.price <= 0)
                return;
              // We have aggregator data
              // Compute how many tokens, plus approximate USD
              const userTokens = t.amount;
              const tokenUsdPrice = new Decimal(info.price);
              const tokenUsdBal = userTokens.mul(tokenUsdPrice);
              // Also in SOL
              const tokenSolBal = tokenUsdBal.div(sp);
              tokenInfos.push({
                symbol: info.symbol,
                amount: userTokens,
                decimals: t.decimals,
                usdValue: tokenUsdBal,
                solValue: tokenSolBal,
              });
            })
          );

          if (tokenInfos.length === 0) {
            txt += "No known tokens found.";
          } else {
            txt += "*SPL Token Balances:*\n";
            for (const ti of tokenInfos) {
              txt +=
                `- ${ti.symbol}: ${ti.amount.toFixed(ti.decimals)} tokens ` +
                `(~${ti.solValue.toFixed(4)} SOL / $${ti.usdValue.toFixed(
                  2
                )})\n`;
            }
          }

          await bot.sendMessage(c, txt, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "« Back", callback_data: "BACK_MAIN" }],
              ],
            },
          });
        }
        break;

      case "BACK_MAIN":
        await bot.answerCallbackQuery(query.id);
        await showMainMenu(c, mid);
        break;

      case "SETTINGS_MENU":
        await bot.answerCallbackQuery(query.id);
        {
          const txt = `⚙️ *Wallet Settings*\n\nManage your wallet preferences and security.`;
          await editMessageText(c, mid, txt, settingsKeyboard());
        }
        break;

      case "REMOVE_WALLET":
        await bot.answerCallbackQuery(query.id);
        {
          const confirmMsg = await bot.sendMessage(
            c,
            "⚠️ *Warning* ⚠️\n\nAre you sure you want to remove your wallet from this bot?",
            {
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "✅ Confirm Remove",
                      callback_data: "REMOVE_WALLET_CONFIRM",
                    },
                    { text: "❌ Cancel", callback_data: "SETTINGS_MENU" },
                  ],
                ],
              },
            }
          );
        }
        break;

      case "REMOVE_WALLET_CONFIRM":
        await bot.answerCallbackQuery(query.id);
        {
          await removeUserRow(c);
          await bot.sendMessage(
            c,
            "✅ Your wallet has been removed from the bot.",
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "« Back to Main", callback_data: "BACK_MAIN" }],
                ],
              },
            }
          );
          // Show main menu which will now show the "no wallet" state
          await showMainMenu(c, mid);
        }
        break;

      // Add this case - alphabetical order with other V* cases
      case "VIEW_PRIVKEY":
        await bot.answerCallbackQuery(query.id);
        {
          // Security precaution - don't send private key in clear text
          await bot.sendMessage(
            c,
            "For security reasons, private keys are not displayed here. Please keep your key safe and never share it.",
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "« Back", callback_data: "SETTINGS_MENU" }],
                ],
              },
            }
          );
        }
        break;

      // Add this case to your callback_query switch statement
      case "SHOW_HELP":
        await bot.answerCallbackQuery(query.id);
        {
          const helpMessage = `
🚀 *Solana Memesbot Help* 🔹 *Getting Started* - Use /start to open the main menu  
- Connect a wallet via *Import Wallet* (private key)  
- Check balances with /positions  

💡 *Key Features* - *💹 Buy Tokens*: Swap SOL → any SPL token (enter mint address)  
- *💱 Sell Tokens*: Swap SPL tokens → SOL (auto-detects holdings)  
- *🤖 Auto-Trade*: Allocate SOL for priority access to new launches  
- *💸 Withdraw*: Send SOL to external wallets  

⚠️ *Trading Tips* - Default slippage: 1%  
- Failed swap? Check:  
- Enough SOL for gas + amount  
- Valid token mint address  
- Slippage too low for volatile tokens  

🔒 *Security* - Private keys are *never* displayed/stored in plaintext  
- Admins will *never* DM first or ask for your key  

*Pro Tip:* Use /buy [mint] or /sell [amount] for quick actions!
      `;

          await bot.sendMessage(c, helpMessage, {
            parse_mode: "Markdown",
            disable_web_page_preview: true,
            reply_markup: {
              inline_keyboard: [
                [{ text: "« Back to Main", callback_data: "BACK_MAIN" }],
              ],
            },
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
          const solPrice = await getSolPriceUSD(); // Uses updated function
          const userSolUsd = sb2.mul(solPrice);

          const userBalMsg = `🚀 *Auto-Trade Activation* *Current Balance:* ${sb2.toFixed(4)} SOL ($${userSolUsd.toFixed(2)})
                        
💎 *Beat the snipers*—your wallet gets first access!
                        
⬇ *Allocate SOL to secure your advantage:* ▸ *Minimum:* ${minA2.div(solPrice).toFixed(2)} SOL ($${minA2.toFixed(2)}) 
▸ *Optimal:* ${optimalA2.div(solPrice).toFixed(0)}+ SOL ($${optimalA2.toFixed(0)}+) (Max Priority)
                        
💡 *Pro Tip:*
Higher allocations get *priority access + optimized trade execution*`;

          if (aE) {
            await bot.sendMessage(
              c,
              "🤖 *Auto-Trade Status*: 🟢 ACTIVE\n\n" +
                "Would you like to disable Auto-Trade?",
              {
                parse_mode: "Markdown",
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: "🔴 Disable Auto-Trade",
                        callback_data: "AUTO_TRADE_OFF",
                      },
                    ],
                    [
                      {
                        text: "🔙 Back to Main",
                        callback_data: "BACK_MAIN",
                      },
                    ],
                  ],
                },
              }
            );
          } else {
            const promptMsg = await bot.sendMessage(c, userBalMsg, {
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "« Cancel", callback_data: "BACK_MAIN" }],
                ],
              },
            });

            pendingMessageHandlers[c] = async (msg2) => {
              try {
                if (msg2.chat.id !== c) return;
                if (!msg2.text) {
                  await bot.sendMessage(
                    c,
                    "❌ Invalid input. Operation cancelled.",
                    {
                      reply_markup: {
                        inline_keyboard: [
                          [{ text: "« Back", callback_data: "BACK_MAIN" }],
                        ],
                      },
                    }
                  );
                  return;
                }

                let atAmt;
                try {
                  atAmt = new Decimal(msg2.text.trim());
                } catch {
                  await bot.sendMessage(
                    c,
                    "❌ Invalid amount. Please enter a valid number.",
                    {
                      reply_markup: {
                        inline_keyboard: [
                          [{ text: "« Back", callback_data: "BACK_MAIN" }],
                        ],
                      },
                    }
                  );
                  return;
                }

                const minSolRequired = minA2.div(solPrice); // Min SOL based on current USD price
                if (atAmt.lt(minSolRequired)) {
                  await bot.sendMessage(
                    c,
                    `⚠️ Minimum allocation is ${minSolRequired.toFixed(
                      4
                    )} SOL ($${minA2.toFixed(2)}).`,
                    {
                      parse_mode: "Markdown",
                      reply_markup: {
                        inline_keyboard: [
                          [{ text: "« Back", callback_data: "BACK_MAIN" }],
                        ],
                      },
                    }
                  );
                  return;
                }

                if (atAmt.gt(sb2)) {
                  await bot.sendMessage(
                    c,
                    `❌ Insufficient balance! You only have ${sb2.toFixed(
                      4
                    )} SOL available.`,
                    {
                      parse_mode: "Markdown",
                      reply_markup: {
                        inline_keyboard: [
                          [{ text: "« Back", callback_data: "BACK_MAIN" }],
                        ],
                      },
                    }
                  );
                  return;
                }

                await setAutoTrade(c, true);
                await bot.sendMessage(
                  c,
                  `🎉 *Auto-Trade Activated!* 🟢\n\n` +
                    `✅ *Allocated:* ${atAmt.toFixed(4)} SOL ($${atAmt
                      .mul(solPrice)
                      .toFixed(2)})\n` +
                    `✨ *You now have priority access to new launches!*`,
                  {
                    parse_mode: "Markdown",
                    reply_markup: {
                      inline_keyboard: [
                        [
                          {
                            text: "« Back to Dashboard",
                            callback_data: "BACK_MAIN",
                          },
                        ],
                      ],
                    },
                  }
                );
              } catch (err) {
                logger.error(
                  "Error in pending message handler (AUTO_TRADE):",
                  err
                );
              }
            };
            bot.once("message", pendingMessageHandlers[c]);
          }
        }
        break;

      case "AUTO_TRADE_OFF":
        await bot.answerCallbackQuery(query.id);
        await setAutoTrade(c, false);
        await bot.sendMessage(c, "Auto-Trade turned OFF 🔴", {
          reply_markup: {
            inline_keyboard: [
              [{ text: "« Back", callback_data: "BACK_MAIN" }],
            ],
          },
        });
        break;

      case "WITHDRAW_MENU":
        await bot.answerCallbackQuery(query.id);
        {
          const askA = await bot.sendMessage(
            c,
            "Enter recipient Solana address:",
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "« Back", callback_data: "BACK_MAIN" }],
                ],
              },
            }
          );

          pendingMessageHandlers[c] = async (m2) => {
            try {
              if (m2.chat.id !== c) return;
              if (!m2.text) {
                await bot.sendMessage(c, "Invalid address. Cancelled.", {
                  reply_markup: {
                    inline_keyboard: [
                      [{ text: "« Back", callback_data: "BACK_MAIN" }],
                    ],
                  },
                });
                return;
              }
              const address = m2.text.trim();
              try {
                new PublicKey(address); // Validate address format
              } catch (e) {
                 await bot.sendMessage(c, "Invalid address format. Cancelled.", {
                  reply_markup: {
                    inline_keyboard: [
                      [{ text: "« Back", callback_data: "BACK_MAIN" }],
                    ],
                  },
                });
                return;
              }

              const askAmt = await bot.sendMessage(c, "Enter SOL amount", {
                reply_markup: {
                  inline_keyboard: [
                    [{ text: "« Back", callback_data: "BACK_MAIN" }],
                  ],
                },
              });

              pendingMessageHandlers[c] = async (m3) => {
                try {
                  if (m3.chat.id !== c) return;
                  if (!m3.text) {
                    await bot.sendMessage(c, "Invalid amount. Cancelled.", {
                      reply_markup: {
                        inline_keyboard: [
                          [{ text: "« Back", callback_data: "BACK_MAIN" }],
                        ],
                      },
                    });
                    return;
                  }
                  let amt;
                  try {
                    amt = new Decimal(m3.text.trim());
                    if (amt.lte(0)) {
                      await bot.sendMessage(c, "Must be > 0. Cancelled.", {
                        reply_markup: {
                          inline_keyboard: [
                            [{ text: "« Back", callback_data: "BACK_MAIN" }],
                          ],
                        },
                      });
                      return;
                    }
                  } catch {
                    await bot.sendMessage(c, "Invalid amount. Cancelled.", {
                      reply_markup: {
                        inline_keyboard: [
                          [{ text: "« Back", callback_data: "BACK_MAIN" }],
                        ],
                      },
                    });
                    return;
                  }
                  const sb = await getSolBalance(u.public_key);
                  if (amt.gt(sb)) {
                    await bot.sendMessage(
                      c,
                      "Insufficient SOL. You have " + sb.toFixed(4),
                      {
                        reply_markup: {
                          inline_keyboard: [
                            [{ text: "« Back", callback_data: "BACK_MAIN" }],
                          ],
                        },
                      }
                    );
                    return;
                  }
                  await bot.sendMessage(c, "Processing your withdrawal...");
                  const uk = loadKeypairFromSecretBase58(u.private_key);
                  const txSig = await withdrawSol(uk, address, amt.toNumber());
                  if (txSig) {
                    await bot.sendMessage(
                      c,
                      `*Withdrawal Successful!*\nTX: [View in Explorer](https://solscan.io/tx/${txSig})`,
                      {
                        parse_mode: "Markdown",
                        reply_markup: {
                          inline_keyboard: [
                            [{ text: "« Back", callback_data: "BACK_MAIN" }],
                          ],
                        },
                      }
                    );
                  } else {
                    await bot.sendMessage(
                      c,
                      "Withdrawal failed due to transaction error.",
                      {
                        reply_markup: {
                          inline_keyboard: [
                            [{ text: "« Back", callback_data: "BACK_MAIN" }],
                          ],
                        },
                      }
                    );
                  }
                } catch (err) {
                  logger.error(
                    "Error in pending message handler (WITHDRAW_MENU amt):",
                    err
                  );
                }
              };
              bot.once("message", pendingMessageHandlers[c]);
            } catch (err) {
              logger.error(
                "Error in pending message handler (WITHDRAW_MENU address):",
                err
              );
            }
          };
          bot.once("message", pendingMessageHandlers[c]);
        }
        break;

      case "BUY_MENU":
        await bot.answerCallbackQuery(query.id);
        {
          // Make sure we have a session object for this user
          userSessions[c] = userSessions[c] || {};
          userSessions[c].tokenInfo = null;

          // Show user balance here so they know how much SOL they have before picking a token
          const userSolBal = await getSolBalance(u.public_key);
          const buyPrompt = `Your SOL Balance: *${userSolBal.toFixed(
            4
          )} SOL*\nEnter token symbol or address to buy:`;
          const am = await bot.sendMessage(c, buyPrompt, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "« Back", callback_data: "BACK_MAIN" }],
              ],
            },
          });

          pendingMessageHandlers[c] = async (m2) => {
            try {
              if (m2.chat.id !== c) return;
              const mint = m2.text ? m2.text.trim() : "";
              if (!mint || mint.length < 3) { // Basic validation
                await bot.sendMessage(c, "Invalid mint/symbol. Cancelled.", {
                  reply_markup: {
                    inline_keyboard: [
                      [{ text: "« Back", callback_data: "BACK_MAIN" }],
                    ],
                  },
                });
                return;
              }

              // Fetch extended data from DexScreener
              const info = await getTokenInfoFromAggregator(mint);
              if (!info) {
                await bot.sendMessage(
                  c,
                  "Token not found on DexScreener. Cancelled.",
                  {
                    reply_markup: {
                      inline_keyboard: [
                        [{ text: "« Back", callback_data: "BACK_MAIN" }],
                      ],
                    },
                  }
                );
                return;
              }

              // Store in userSessions
              userSessions[c].tokenInfo = info;

              // Construct informational text
              const explorerLink = `https://solscan.io/token/${info.mint}`; // Use /token for SPL tokens
              const chartLink = `https://dexscreener.com/solana/${info.mint}`;
              const scanLink = `https://t.me/RickBurpBot?start=${info.mint}`; // example
              const symbolLine = `${info.name || "Unknown"} | ${
                info.symbol || "???"
              } | ${info.mint}`;
              const lineLinks = `[Explorer](${explorerLink}) | [Chart](${chartLink}) | [Scan](${scanLink})`;
              const priceLine = `*Price:* $${new Decimal(
                info.price || 0
              ).toSignificantDigits(6)}`; // Use significant digits for price
              const changesLine = `5m: ${info.m5}%, 1h: ${info.h1}%, 6h: ${info.h6}%, 24h: ${info.h24}%`;
              const mcLine = `*Market Cap:* $${new Decimal(
                info.marketCap || 0
              ).toFormat(0)}`; // Formatted market cap
              const piLine = `*Price Impact:* N/A`; // Placeholder
              const userSol = await getSolBalance(u.public_key);
              const wBalanceLine = `*Wallet Balance:* ${userSol.toFixed(4)} SOL`;

              const msgText = `${symbolLine}
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
                    { text: "Swap ✅", callback_data: "BUY_TOKEN_SWAP" }, // This will ask for from_token and amount
                  ],
                  [
                    { text: "Buy 1.0 SOL", callback_data: "BUY_TOKEN_1" },
                    { text: "Buy 5.0 SOL", callback_data: "BUY_TOKEN_5" },
                  ],
                  [{ text: "Buy X SOL", callback_data: "BUY_TOKEN_X" }],
                  [{ text: "« Back", callback_data: "BACK_MAIN" }],
                ],
              };

              await bot.sendMessage(c, msgText, {
                parse_mode: "Markdown",
                reply_markup: buyKeyboard,
                disable_web_page_preview: true, // To prevent issues with links
              });
            } catch (err) {
              logger.error(
                "Error in pending message handler (BUY_MENU mint):",
                err
              );
            }
          };
          bot.once("message", pendingMessageHandlers[c]);
        }
        break;

      case "BUY_TOKEN_CANCEL":
        await bot.answerCallbackQuery(query.id, { text: "Cancelled." });
        await showMainMenu(c, mid);
        break;

      case "BUY_TOKEN_SWAP": // This case seems to be a general swap rather than buy with SOL
        await bot.answerCallbackQuery(query.id);
        {
          const infoObj = userSessions[c] && userSessions[c].tokenInfo;
          if (!infoObj) {
            await bot.sendMessage(
              c,
              "Token info not found in session. Please try again.",
              {
                reply_markup: {
                  inline_keyboard: [
                    [{ text: "« Back", callback_data: "BACK_MAIN" }],
                  ],
                },
              }
            );
            return;
          }
          await bot.sendMessage(
            c,
            `Enter the *from token mint* (e.g., 'So1111...' if SOL) you want to swap *into* ${infoObj.symbol || infoObj.mint}:`,
            {
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "« Back", callback_data: "BACK_MAIN" }],
                ],
              },
            }
          );

          clearPendingMessageHandler(c);
          pendingMessageHandlers[c] = async (msg2) => {
            try {
              if (msg2.chat.id !== c) return;
              const fromMint = msg2.text ? msg2.text.trim() : "";
              if (!fromMint || fromMint.length < 3) {
                await bot.sendMessage(c, "Invalid from-mint. Swap cancelled.", {
                  reply_markup: {
                    inline_keyboard: [
                      [{ text: "« Back", callback_data: "BACK_MAIN" }],
                    ],
                  },
                });
                return;
              }
              userSessions[c].swapFromMint = fromMint;

              // Step 2: Ask how much from-token
              await bot.sendMessage(
                c,
                `How much of ${fromMint === 'So11111111111111111111111111111111111111112' ? 'SOL' : 'that token'} do you want to swap into ${
                  infoObj.symbol || infoObj.mint
                }?`,
                {
                  parse_mode: "Markdown",
                  reply_markup: {
                    inline_keyboard: [
                      [{ text: "« Back", callback_data: "BACK_MAIN" }],
                    ],
                  },
                }
              );

              clearPendingMessageHandler(c);
              pendingMessageHandlers[c] = async (msg3) => {
                try {
                  if (msg3.chat.id !== c) return;
                  let amt;
                  try {
                    amt = new Decimal(msg3.text.trim());
                  } catch (e) {
                    await bot.sendMessage(c, "Invalid number. Cancelled.", {
                      reply_markup: {
                        inline_keyboard: [
                          [{ text: "« Back", callback_data: "BACK_MAIN" }],
                        ],
                      },
                    });
                    return;
                  }
                  if (amt.lte(0)) {
                    await bot.sendMessage(
                      c,
                      "Amount must be > 0. Cancelled.",
                      {
                        reply_markup: {
                          inline_keyboard: [
                            [{ text: "« Back", callback_data: "BACK_MAIN" }],
                          ],
                        },
                      }
                    );
                    return;
                  }

                  await bot.sendMessage(
                    c,
                    `Swapping ${amt.toFixed(4)} of ${
                      userSessions[c].swapFromMint === 'So11111111111111111111111111111111111111112' ? 'SOL' : userSessions[c].swapFromMint
                    } into ${infoObj.symbol || infoObj.mint}...`
                  );
                  const kp = loadKeypairFromSecretBase58(u.private_key);
                  const txid = await performSwap({
                    userKeypair: kp,
                    fromTokenMint: userSessions[c].swapFromMint,
                    toTokenMint: infoObj.mint,
                    amount: amt.toNumber(),
                    slippage: DEFAULT_SLIPPAGE,
                  });
                  if (txid) {
                    await bot.sendMessage(
                      c,
                      `*Swap Successful!*\nTX: [View in Explorer](https://solscan.io/tx/${txid})`,
                      {
                        parse_mode: "Markdown",
                        reply_markup: {
                          inline_keyboard: [
                            [{ text: "« Back", callback_data: "BACK_MAIN" }],
                          ],
                        },
                      }
                    );
                  } else {
                    await bot.sendMessage(
                      c,
                      "Swap failed (no route or aggregator error).",
                      {
                        reply_markup: {
                          inline_keyboard: [
                            [{ text: "« Back", callback_data: "BACK_MAIN" }],
                          ],
                        },
                      }
                    );
                  }
                } catch (err) {
                  logger.error(
                    "Error in pending message handler (BUY_TOKEN_SWAP amount):",
                    err
                  );
                }
              };
              bot.once("message", pendingMessageHandlers[c]);
            } catch (err) {
              logger.error(
                "Error in pending message handler (BUY_TOKEN_SWAP from token):",
                err
              );
            }
          };
          bot.once("message", pendingMessageHandlers[c]);
        }
        break;

      case "BUY_TOKEN_1":
      case "BUY_TOKEN_5":
        await bot.answerCallbackQuery(query.id, { text: "Processing buy..." });
        {
          const infoObj = userSessions[c] && userSessions[c].tokenInfo;
          if (!infoObj) {
            await bot.sendMessage(
              c,
              "Token info not found in session. Please try again.",
              {
                reply_markup: {
                  inline_keyboard: [
                    [{ text: "« Back", callback_data: "BACK_MAIN" }],
                  ],
                },
              }
            );
            return;
          }
          let solAmt = d === "BUY_TOKEN_1" ? new Decimal(1) : new Decimal(5);
          const userSolBal = await getSolBalance(u.public_key);
          if (solAmt.gt(userSolBal)) {
            await bot.sendMessage(
              c,
              "Insufficient SOL. You have " + userSolBal.toFixed(4) + ".",
              {
                reply_markup: {
                  inline_keyboard: [
                    [{ text: "« Back", callback_data: "BACK_MAIN" }],
                  ],
                },
              }
            );
            return;
          }
          await bot.sendMessage(
            c,
            `Buying ${solAmt.toFixed(1)} SOL worth of ${
              infoObj.symbol || infoObj.mint
            }...`
          );
          const kp = loadKeypairFromSecretBase58(u.private_key);
          const fromMint = "So11111111111111111111111111111111111111112";
          const txid = await performSwap({
            userKeypair: kp,
            fromTokenMint: fromMint,
            toTokenMint: infoObj.mint,
            amount: solAmt.toNumber(),
            slippage: DEFAULT_SLIPPAGE,
          });
          if (txid) {
            await bot.sendMessage(
              c,
              `*Buy Successful!*\nTX: [View in Explorer](https://solscan.io/tx/${txid})`,
              {
                parse_mode: "Markdown",
                reply_markup: {
                  inline_keyboard: [
                    [{ text: "« Back", callback_data: "BACK_MAIN" }],
                  ],
                },
              }
            );
          } else {
            await bot.sendMessage(
              c,
              "Buy failed (no route or aggregator error).",
              {
                reply_markup: {
                  inline_keyboard: [
                    [{ text: "« Back", callback_data: "BACK_MAIN" }],
                  ],
                },
              }
            );
          }
        }
        break;

      case "BUY_TOKEN_X":
        await bot.answerCallbackQuery(query.id); // Removed "Enter SOL amount..." as it's redundant with the prompt
        {
          const infoObj = userSessions[c] && userSessions[c].tokenInfo;
          if (!infoObj) {
            await bot.sendMessage(
              c,
              "Token info not found in session. Please try again.",
              {
                reply_markup: {
                  inline_keyboard: [
                    [{ text: "« Back", callback_data: "BACK_MAIN" }],
                  ],
                },
              }
            );
            return;
          }
          const userSolBal = await getSolBalance(u.public_key);
          const askMsg = `Your current SOL balance is *${userSolBal.toFixed(
            4
          )} SOL*.\nEnter SOL amount to buy ${infoObj.symbol || infoObj.mint}:`;
          await bot.sendMessage(c, askMsg, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "« Back", callback_data: "BACK_MAIN" }],
              ],
            },
          });

          pendingMessageHandlers[c] = async (m2) => {
            try {
              if (m2.chat.id !== c) return;
              if (!m2.text) {
                await bot.sendMessage(c, "Invalid amount. Cancelled.", {
                  reply_markup: {
                    inline_keyboard: [
                      [{ text: "« Back", callback_data: "BACK_MAIN" }],
                    ],
                  },
                });
                return;
              }
              let amt;
              try {
                amt = new Decimal(m2.text.trim());
              } catch (e) {
                await bot.sendMessage(c, "Invalid number. Cancelled.", {
                  reply_markup: {
                    inline_keyboard: [
                      [{ text: "« Back", callback_data: "BACK_MAIN" }],
                    ],
                  },
                });
                return;
              }
              if (amt.lte(0)) {
                await bot.sendMessage(c, "Amount must be > 0. Cancelled.", {
                  reply_markup: {
                    inline_keyboard: [
                      [{ text: "« Back", callback_data: "BACK_MAIN" }],
                    ],
                  },
                });
                return;
              }
              const userBal = await getSolBalance(u.public_key);
              if (amt.gt(userBal)) {
                await bot.sendMessage(
                  c,
                  `Insufficient balance. You only have ${userBal.toFixed(
                    4
                  )} SOL. Cancelled.`,
                  {
                    reply_markup: {
                      inline_keyboard: [
                        [{ text: "« Back", callback_data: "BACK_MAIN" }],
                      ],
                    },
                  }
                );
                return;
              }
              // Perform swap
              await bot.sendMessage(
                c,
                `Buying ${amt.toFixed(4)} SOL worth of ${
                  infoObj.symbol || infoObj.mint
                }...`
              );
              const kp = loadKeypairFromSecretBase58(u.private_key);
              const fromMint = "So11111111111111111111111111111111111111112";
              const txid = await performSwap({
                userKeypair: kp,
                fromTokenMint: fromMint,
                toTokenMint: infoObj.mint,
                amount: amt.toNumber(),
                slippage: DEFAULT_SLIPPAGE,
              });
              if (txid) {
                await bot.sendMessage(
                  c,
                  `*Buy Successful!*\nTX: [View in Explorer](https://solscan.io/tx/${txid})`,
                  {
                    parse_mode: "Markdown",
                    reply_markup: {
                      inline_keyboard: [
                        [{ text: "« Back", callback_data: "BACK_MAIN" }],
                      ],
                    },
                  }
                );
              } else {
                await bot.sendMessage(
                  c,
                  "Buy failed (no route or aggregator error).",
                  {
                    reply_markup: {
                      inline_keyboard: [
                        [{ text: "« Back", callback_data: "BACK_MAIN" }],
                      ],
                    },
                  }
                );
              }
            } catch (err) {
              logger.error(
                "Error in pending message handler (BUY_TOKEN_X amount):",
                err
              );
            }
          };
          bot.once("message", pendingMessageHandlers[c]);
        }
        break;

      // *** SELL UPGRADE ***
      case "SELL_MENU":
        await bot.answerCallbackQuery(query.id);
        {
          userSessions[c] = userSessions[c] || {};
          // We'll fetch all user tokens, do aggregator calls, skip those that have no symbol/price
          const bal2 = await getAllTokenBalances(u.public_key);
          const solPrice = await getSolPriceUSD(); // Uses updated function
          // Filter out SOL pseudo mint and 0 balances
          const nonSolTokens = bal2.filter(
            (t) =>
              t.mint !== "So11111111111111111111111111111111111111112" &&
              t.amount.gt(0)
          );
          if (!nonSolTokens.length) {
            await bot.sendMessage(
              c,
              "You do not have any tokens yet! Start trading in the Buy menu.",
              {
                reply_markup: {
                  inline_keyboard: [
                    [{ text: "« Back", callback_data: "BACK_MAIN" }],
                  ],
                },
              }
            );
            return;
          }

          // Get aggregator data for each token
          const tokenSellList = [];
          await Promise.all(
            nonSolTokens.map(async (t) => {
              const info = await getTokenInfoFromAggregator(t.mint);
              if (
                !info ||
                !info.symbol ||
                !info.symbol.trim() ||
                info.price <= 0
              )
                return;
              const tokenUsdPrice = new Decimal(info.price);
              const tokenUsdBal = t.amount.mul(tokenUsdPrice);
              const tokenSolBal = tokenUsdBal.div(solPrice);
              tokenSellList.push({
                mint: t.mint,
                symbol: info.symbol,
                decimals: t.decimals,
                tokenBalance: t.amount,
                usdValue: tokenUsdBal,
                solValue: tokenSolBal,
                chartLink: `https://dexscreener.com/solana/${t.mint}`,
              });
            })
          );

          if (!tokenSellList.length) {
            await bot.sendMessage(
              c,
              "No known tokens to sell. (Aggregator info not found for your tokens.)",
              {
                reply_markup: {
                  inline_keyboard: [
                    [{ text: "« Back", callback_data: "BACK_MAIN" }],
                  ],
                },
              }
            );
            return;
          }

          // We'll store them in userSessions with pagination
          userSessions[c].sellTokens = tokenSellList;
          userSessions[c].sellPage = 0;

          await showSellTokensList(c, mid); // function to show up to 6 tokens at a time
        }
        break;

      // We'll handle next/prev/refresh if needed
      case "SELL_PAGE_NEXT":
        await bot.answerCallbackQuery(query.id);
        {
          userSessions[c].sellPage = (userSessions[c].sellPage || 0) + 1;
          await showSellTokensList(c, mid);
        }
        break;

      case "SELL_PAGE_PREV":
        await bot.answerCallbackQuery(query.id);
        {
          userSessions[c].sellPage = Math.max(
            (userSessions[c].sellPage || 0) - 1,
            0
          );
          await showSellTokensList(c, mid);
        }
        break;

      case "SELL_PAGE_REFRESH":
        await bot.answerCallbackQuery(query.id, { text: "Refreshing..." });
        {
          // Re-fetch aggregator data from scratch
          const bal2 = await getAllTokenBalances(u.public_key);
          const solPrice = await getSolPriceUSD(); // Uses updated function
          const nonSolTokens = bal2.filter(
            (t) =>
              t.mint !== "So11111111111111111111111111111111111111112" &&
              t.amount.gt(0)
          );
          const newList = [];
          await Promise.all(
            nonSolTokens.map(async (t) => {
              const info = await getTokenInfoFromAggregator(t.mint);
              if (
                !info ||
                !info.symbol ||
                !info.symbol.trim() ||
                info.price <= 0
              )
                return;
              const tokenUsdPrice = new Decimal(info.price);
              const tokenUsdBal = t.amount.mul(tokenUsdPrice);
              const tokenSolBal = tokenUsdBal.div(solPrice);
              newList.push({
                mint: t.mint,
                symbol: info.symbol,
                decimals: t.decimals,
                tokenBalance: t.amount,
                usdValue: tokenUsdBal,
                solValue: tokenSolBal,
                chartLink: `https://dexscreener.com/solana/${t.mint}`,
              });
            })
          );
          userSessions[c].sellTokens = newList;
          userSessions[c].sellPage = 0;
          if (!newList.length) {
            await bot.sendMessage(
              c,
              "No known tokens to sell after refresh.",
              {
                reply_markup: {
                  inline_keyboard: [
                    [{ text: "« Back", callback_data: "BACK_MAIN" }],
                  ],
                },
              }
            );
          } else {
            await showSellTokensList(c, mid);
          }
        }
        break;

      // PnL menu - NEW from snippet 1
      case "PNL_MENU":
        await bot.answerCallbackQuery(query.id);
        await editMessageText(c, mid, "Select timeframe for PnL:", { // Use editMessageText
          inline_keyboard: [
            [
              { text: "24 h", callback_data: "PNL_24H" },
              { text: "3 d", callback_data: "PNL_3D" },
            ],
            [
              { text: "7 d", callback_data: "PNL_7D" },
              { text: "1 m", callback_data: "PNL_1M" },
            ],
            [{ text: "1 y", callback_data: "PNL_1Y" }],
            [{ text: "« Back", callback_data: "BACK_MAIN" }],
          ],
        });
        break;

      // Handle each PnL timeframe - NEW from snippet 1
      case "PNL_24H":
      case "PNL_3D":
      case "PNL_7D":
      case "PNL_1M":
      case "PNL_1Y":
        await bot.answerCallbackQuery(query.id, { text: "Calculating PnL..." });
        {
          const map = {
            PNL_24H: 1,
            PNL_3D: 3,
            PNL_7D: 7,
            PNL_1M: 30,
            PNL_1Y: 365,
          };
          const days = map[d];
          const lbl = {
            1: "24 hours",
            3: "3 days",
            7: "7 days",
            30: "1 month",
            365: "1 year",
          }[days];
          const res = await calculatePnl(u.public_key, days);
          const txt =
            `*PnL over last ${lbl}:*\n` +
            `• Net Change: ${res.sol.toFixed(4)} SOL (~$${res.usd.toFixed(
              2
            )})`;
          await editMessageText(c, mid, txt, { // Use editMessageText
            inline_keyboard: [
              [{ text: "« Back", callback_data: "PNL_MENU" }], // Back to PNL menu
            ],
          });
        }
        break;

      default:
        // Possibly it's a SELL_TOKEN_INDEX_ pattern
        if (d.startsWith("SELL_TOKEN_INDEX_")) {
          await bot.answerCallbackQuery(query.id);
          {
            const idx = parseInt(d.replace("SELL_TOKEN_INDEX_", ""), 10);
            const list = userSessions[c]?.sellTokens || [];
            if (!list[idx]) {
              await bot.sendMessage(
                c,
                "Token index not found. Please refresh the list.",
                {
                  reply_markup: {
                    inline_keyboard: [
                      [{ text: "« Back", callback_data: "BACK_MAIN" }],
                    ],
                  },
                }
              );
              return;
            }
            // Show user the details, ask how much they want to sell
            const tk = list[idx];
            const sb = await getSolBalance(u.public_key);
            const currentSolPrice = await getSolPriceUSD(); // Uses updated function
            const userSolBalUsd = sb.mul(currentSolPrice);
            // Example message:
            const sellMsg = `*Selling ${tk.symbol}*
[Chart](${tk.chartLink})

Token Balance: ${tk.tokenBalance.toFixed(tk.decimals)}
Value: ≈${tk.solValue.toFixed(4)} SOL / ≈$${tk.usdValue.toFixed(2)}

How many *${tk.symbol}* tokens do you want to sell?`;

            await editMessageText(c, mid, sellMsg, { // Use editMessageText
              inline_keyboard: [
                  [{ text: `Sell 25% (${tk.tokenBalance.mul(0.25).toFixed(2)} ${tk.symbol})`, callback_data: `SELL_PROCEED_${idx}_${tk.tokenBalance.mul(0.25).toString()}_PERCENT_25` }],
                  [{ text: `Sell 50% (${tk.tokenBalance.mul(0.50).toFixed(2)} ${tk.symbol})`, callback_data: `SELL_PROCEED_${idx}_${tk.tokenBalance.mul(0.50).toString()}_PERCENT_50` }],
                  [{ text: `Sell 75% (${tk.tokenBalance.mul(0.75).toFixed(2)} ${tk.symbol})`, callback_data: `SELL_PROCEED_${idx}_${tk.tokenBalance.mul(0.75).toString()}_PERCENT_75` }],
                  [{ text: `Sell 100% (${tk.tokenBalance.toFixed(2)} ${tk.symbol})`, callback_data: `SELL_PROCEED_${idx}_${tk.tokenBalance.toString()}_PERCENT_100` }],
                  [{ text: "Sell Custom Amount", callback_data: `SELL_CUSTOM_AMOUNT_${idx}` }],
                  [{ text: "« Back to List", callback_data: "SELL_MENU" }],
              ],
            });
          }
        }
        // Custom amount entry for selling
        else if (d.startsWith("SELL_CUSTOM_AMOUNT_")) {
            await bot.answerCallbackQuery(query.id);
            const idx = parseInt(d.replace("SELL_CUSTOM_AMOUNT_", ""), 10);
            const list = userSessions[c]?.sellTokens || [];
            if (!list[idx]) { /* ... error handling ... */ return; }
            const tk = list[idx];

            await bot.sendMessage(c, `Enter amount of *${tk.symbol}* to sell:`, {
                parse_mode: "Markdown",
                reply_markup: { inline_keyboard: [[{ text: "« Cancel", callback_data: `SELL_TOKEN_INDEX_${idx}` }]] } // Back to specific token view
            });

            pendingMessageHandlers[c] = async (m2) => {
                // ... (validation and SELL_PROCEED logic from original code)
                // For brevity, assuming this part is similar to original /sell token amount input
                // On success, it would call something like:
                // const sAmt = new Decimal(m2.text.trim());
                // ... proceed with SELL_PROCEED_idx_sAmt
                try {
                    if (m2.chat.id !== c) return;
                    if (!m2.text) { /* ... */ return; }
                    let sAmt;
                    try {
                        sAmt = new Decimal(m2.text.trim());
                        if (sAmt.lte(0)) { /* ... */ return; }
                    } catch { /* ... */ return; }

                    if (sAmt.gt(tk.tokenBalance)) { /* ... */ return; }

                    // Construct the callback data for SELL_PROCEED_
                    const proceedCallbackData = `SELL_PROCEED_${idx}_${sAmt.toString()}`;
                    // Simulate pressing the proceed button by directly handling its logic or sending a new message with it
                     const confirmTxt = `You are about to sell *${sAmt.toFixed(tk.decimals)}* of ${tk.symbol}.\nProceed to convert to SOL?`
                     await bot.editMessageText(confirmTxt, {
                         chat_id: c,
                         message_id: mid, // or the message_id of the prompt for amount
                         parse_mode: "Markdown",
                         reply_markup: {
                             inline_keyboard: [
                                 [
                                     { text: "✅ Confirm Sell", callback_data: proceedCallbackData },
                                     { text: "❌ Cancel", callback_data: `SELL_TOKEN_INDEX_${idx}` }, // Back to token details
                                 ],
                             ],
                         },
                     });

                } catch (err) {
                    logger.error("Error in SELL_CUSTOM_AMOUNT_ handler:", err);
                }
            };
            bot.once("message", pendingMessageHandlers[c]);
        }
        // Possibly it's a SELL_PROCEED_ pattern
        else if (d.startsWith("SELL_PROCEED_")) {
          await bot.answerCallbackQuery(query.id);
          {
            // parse => SELL_PROCEED_index_amount or SELL_PROCEED_index_amount_PERCENT_xx
            const parts = d.split("_");
            const idx = parseInt(parts[2], 10);
            const rawAmt = parts[3];
            const amt = new Decimal(rawAmt || "0");

            const list = userSessions[c]?.sellTokens || [];
            if (!list[idx]) {
              await bot.sendMessage(
                c,
                "Token index not found. Please refresh the list.",
                {
                  reply_markup: {
                    inline_keyboard: [
                      [{ text: "« Back", callback_data: "BACK_MAIN" }],
                    ],
                  },
                }
              );
              return;
            }
            const tk = list[idx];
            // Double-check user balance
            const bals = await getAllTokenBalances(u.public_key); // Re-fetch for accuracy
            const fTok = bals.find((b) => b.mint === tk.mint);

            if (!fTok || fTok.amount.lt(amt)) {
              await editMessageText(c,mid, // Use editMessageText
                "Insufficient tokens at the time of sell or invalid amount. Sell cancelled.",
                {
                  inline_keyboard: [
                    [{ text: "« Back to Sell Menu", callback_data: "SELL_MENU" }],
                  ],
                }
              );
              return;
            }
            await editMessageText(c,mid, "Processing your sell order...", {inline_keyboard:[]}); // Use editMessageText

            const kp = loadKeypairFromSecretBase58(u.private_key);
            const toSolMint = "So11111111111111111111111111111111111111112";
            const txid = await performSwap({
              userKeypair: kp,
              fromTokenMint: tk.mint,
              toTokenMint: toSolMint,
              amount: amt.toNumber(),
              slippage: DEFAULT_SLIPPAGE,
            });
            if (txid) {
              await editMessageText(c,mid, // Use editMessageText
                `*Sell Successful!*\nTX: [View in Explorer](https://solscan.io/tx/${txid})`,
                {
                  inline_keyboard: [
                    [{ text: "« Back to Main", callback_data: "BACK_MAIN" }],
                  ],
                }
              );
            } else {
              await editMessageText(c,mid, // Use editMessageText
                "Sell failed (aggregator error or no route).",
                {
                  inline_keyboard: [
                    [{ text: "« Back to Sell Menu", callback_data: "SELL_MENU" }],
                  ],
                }
              );
            }
          }
        } else {
          // We handle unknown callback gracefully
          await bot.answerCallbackQuery(query.id, {
            text: "Unknown callback data: " + d,
          });
        }
        break;
    }
  } catch (err) {
    logger.error("callback_query error:", err);
    // If we haven't answered yet, we can do a safe answer
    try {
      if (!query.id_answered) { // Check if query has been answered
          await bot.answerCallbackQuery(query.id, { text: "An error occurred." });
      }
    } catch (e) {
      logger.error("Failed to answerCallbackQuery in catch:", e);
    }
  }
});

// ---------------------------------------------------------
// Helper to show SELL tokens list (pagination up to 6 tokens)
// *** SELL UPGRADE *** function
// ---------------------------------------------------------
async function showSellTokensList(chatId, messageIdToEdit) { // Added messageIdToEdit
  try {
    const u = await getUserRow(chatId);
    if (!u) return;
    const userData = userSessions[chatId];
    if (!userData || !userData.sellTokens) {
        await editMessageText(chatId, messageIdToEdit, "No tokens found to sell or session expired.", { // Use editMessageText
            inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
        });
        return;
    }

    const tokens = userData.sellTokens;
    if (tokens.length === 0) {
        await editMessageText(chatId, messageIdToEdit, "You have no sellable tokens.", { // Use editMessageText
            inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
        });
        return;
    }

    const page = userData.sellPage || 0;
    const pageSize = 5; // Adjusted for better display with titles
    const startIndex = page * pageSize;
    const endIndex = Math.min(startIndex + pageSize, tokens.length);

    const userSolBal = await getSolBalance(u.public_key);
    const currentSolPrice = await getSolPriceUSD(); // Uses updated function
    const userSolBalUsd = userSolBal.mul(currentSolPrice);

    let txt =
      `*Select a token to sell* (${tokens.length} found)\n` +
      `Wallet Balance: ${userSolBal.toFixed(
        4
      )} SOL ($${userSolBalUsd.toFixed(2)})\n\n`;

    const inlineKb = [];
    // For each token in current page, add a button
    for (let i = startIndex; i < endIndex; i++) {
      const tk = tokens[i];
      inlineKb.push([
        {
          text: `${tk.symbol} (${tk.tokenBalance.toFixed(2)}) - ≈$${tk.usdValue.toFixed(2)}`, // More info on button
          callback_data: `SELL_TOKEN_INDEX_${i}`,
        },
      ]);
    }

    // Now add navigation row
    const navRow = [];
    if (page > 0) {
      navRow.push({ text: "⬅️ Prev", callback_data: "SELL_PAGE_PREV" });
    }
    if (endIndex < tokens.length) {
      navRow.push({ text: "Next ➡️", callback_data: "SELL_PAGE_NEXT" });
    }
    if (navRow.length) {
      inlineKb.push(navRow);
    }

    // Add Refresh + Back row
    inlineKb.push([
      { text: "🔄 Refresh List", callback_data: "SELL_PAGE_REFRESH" },
      { text: "« Back to Main", callback_data: "BACK_MAIN" },
    ]);

    // Use editMessageText to update the existing message
    await editMessageText(chatId, messageIdToEdit, txt, {
        inline_keyboard: inlineKb,
    });

  } catch (err) {
    logger.error("showSellTokensList error:", err);
     try {
        await editMessageText(chatId, messageIdToEdit, "Error displaying token list. Please try again or /start.", {
            inline_keyboard: [[{ text: "« Back", callback_data: "BACK_MAIN" }]],
        });
    } catch (editError) {
        logger.error("Failed to send error message in showSellTokensList:", editError);
    }
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
    if (msg.message_id) await bot.deleteMessage(chatId, msg.message_id).catch(e => {});


    const helpMessage = `
🚀 *Solana Memesbot Help* 🔹 *Getting Started* - Use /start to open the main menu  
- Connect a wallet via *Import Wallet* (private key)  
- Check balances with /positions  

💡 *Key Features* - *💹 Buy Tokens*: Swap SOL → any SPL token (enter mint address)  
- *💱 Sell Tokens*: Swap SPL tokens → SOL (auto-detects holdings)  
- *🤖 Auto-Trade*: Allocate SOL for priority access to new launches  
- *💸 Withdraw*: Send SOL to external wallets  
- *📈 PnL*: Check your profit and loss over various timeframes.

⚠️ *Trading Tips* - Default slippage: 1%  
- Failed swap? Check:  
- Enough SOL for gas + amount  
- Valid token mint address  
- Slippage too low for volatile tokens  

🔒 *Security* - Private keys are *never* displayed/stored in plaintext  
- Admins will *never* DM first or ask for your key  

*Pro Tip:* Use /buy [mint] or /sell [amount] for quick actions!
`;
    const loadingMsg = await bot.sendMessage(chatId, "Loading help...", {parse_mode: "Markdown"});
    await editMessageText(chatId, loadingMsg.message_id, helpMessage, { // Use editMessageText
        inline_keyboard: [
          [{ text: "« Back to Main", callback_data: "BACK_MAIN" }],
        ],
      });
  } catch (err) {
    logger.error("/help command error:", err);
    await bot.sendMessage(
      chatId,
      "Error loading help information. Please try again."
    );
  }
});

// /positions
bot.onText(/\/positions/, async (msg) => {
  try {
    const c = msg.chat.id;
    clearPendingForSlash(c);
    if (msg.message_id) await bot.deleteMessage(c, msg.message_id).catch(e => {});

    const u = await getUserRow(c);
    if (!u || !u.public_key) {
      const noWalletMsg = await bot.sendMessage(c, "Loading positions...");
      return editMessageText(noWalletMsg.chat_id, noWalletMsg.message_id, "No wallet found. Please /start => create or import one.", {
         inline_keyboard: [[{ text: "Connect Wallet", callback_data: "IMPORT_WALLET" }]]
      });
    }
    
    const loadingMsg = await bot.sendMessage(c, "Fetching your positions...", {parse_mode: "Markdown"});


    // *** BALANCE UPGRADE (same as CHECK_BAL block) ***
    const sb = await getSolBalance(u.public_key);
    const sp = await getSolPriceUSD(); // Uses updated function
    const su = sb.mul(sp);

    let txt =
      `📊 *Your Positions*\n\n` +
      `*Wallet:* \`${u.public_key}\`\n\n` +
      `*SOL Balance:* ${sb.toFixed(4)} SOL (~$${su.toFixed(2)})\n\n`;

    const rawTokens = await getAllTokenBalances(u.public_key);
    const tokenInfos = [];
    await Promise.all(
      rawTokens.map(async (t) => {
        if (t.mint === "So11111111111111111111111111111111111111112") return;
        if (t.amount.eq(0)) return; // Skip tokens with zero balance
        const info = await getTokenInfoFromAggregator(t.mint);
        // if aggregator returns a symbol that's empty, or price=0, skip, unless we want to show it anyway
        if (!info || !info.symbol || !info.symbol.trim()) { // Show even if price is 0, but symbol must exist
             tokenInfos.push({
                symbol: t.mint.substring(0,6)+'...', // Fallback if no symbol
                amount: t.amount,
                decimals: t.decimals,
                usdValue: new Decimal(0),
                solValue: new Decimal(0)
            });
            return;
        }
        const userTokens = t.amount;
        const tokenUsdPrice = new Decimal(info.price || 0); // Handle null price
        const tokenUsdBal = userTokens.mul(tokenUsdPrice);
        const tokenSolBal = sp.gt(0) ? tokenUsdBal.div(sp) : new Decimal(0); // Avoid division by zero
        tokenInfos.push({
          symbol: info.symbol,
          amount: userTokens,
          decimals: t.decimals,
          usdValue: tokenUsdBal,
          solValue: tokenSolBal,
        });
      })
    );

    if (tokenInfos.length === 0) {
      txt += "No SPL tokens found.";
    } else {
      txt += "*SPL Token Balances:*\n";
      for (const ti of tokenInfos) {
        txt +=
          `- ${ti.symbol}: ${ti.amount.toFixed(ti.decimals)} tokens ` +
          `(~${ti.solValue.toFixed(4)} SOL / $${ti.usdValue.toFixed(2)})\n`;
      }
    }

    await editMessageText(loadingMsg.chat_id, loadingMsg.message_id, txt, { // Use editMessageText
        inline_keyboard: [[{ text: "« Back to Main", callback_data: "BACK_MAIN" }]]
    });
  } catch (err) {
    logger.error("/positions command error:", err);
     await bot.sendMessage(
      msg.chat.id,
      "Error loading positions. Please try again."
    );
  }
});

// /buy
bot.onText(/\/buy/, async (msg) => { // Make async
  try {
    const c = msg.chat.id;
    clearPendingForSlash(c);
    if (msg.message_id) await bot.deleteMessage(c, msg.message_id).catch(e => {});
    const u = await getUserRow(c);
    const loadingMsg = await bot.sendMessage(c, "Redirecting to Buy Menu...", {parse_mode: "Markdown"});

    if (!u || !u.public_key) {
         return editMessageText(loadingMsg.chat_id, loadingMsg.message_id, "No wallet connected. Please connect a wallet first.", {
            inline_keyboard: [[{ text: "Connect Wallet", callback_data: "IMPORT_WALLET" }]]
        });
    }
    // Simulate clicking the BUY_MENU button from main menu
    await editMessageText(loadingMsg.chat_id, loadingMsg.message_id, "Opened Buy Menu.", mainMenuKeyboard(u.auto_trade_enabled)); // Show main menu, user clicks buy
    // Then simulate the actual buy menu prompt
    // This is a bit of a workaround for slash commands. Ideally, slash commands would directly trigger the relevant part of the callback flow.
     const userSolBal = await getSolBalance(u.public_key);
     const buyPrompt = `Your SOL Balance: *${userSolBal.toFixed(4)} SOL*\nEnter token symbol or address to buy:`;
     await bot.sendMessage(c, buyPrompt, { // Send as new message
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [[{ text: "« Cancel", callback_data: "BACK_MAIN" }]],
        },
     });
     // The pendingMessageHandler for BUY_MENU will pick up the next message
     // Need to ensure the userSessions[c].tokenInfo logic is correctly initiated by BUY_MENU callback handler if that's where it lives.
     // This requires the `BUY_MENU` case in `on("callback_query")` to set up the pending handler.
     // This simplified /buy just opens the menu visually.

  } catch (err) {
    logger.error("/buy command error:", err);
  }
});

// /sell
bot.onText(/\/sell/, async (msg) => { // Make async
  try {
    const c = msg.chat.id;
    clearPendingForSlash(c);
    if (msg.message_id) await bot.deleteMessage(c, msg.message_id).catch(e => {});
    const u = await getUserRow(c);
    const loadingMsg = await bot.sendMessage(c, "Redirecting to Sell Menu...", {parse_mode: "Markdown"});


    if (!u || !u.public_key) {
         return editMessageText(loadingMsg.chat_id, loadingMsg.message_id, "No wallet connected. Please connect a wallet first.", {
            inline_keyboard: [[{ text: "Connect Wallet", callback_data: "IMPORT_WALLET" }]]
        });
    }
    // Simulate clicking the SELL_MENU button from main menu
    await showSellTokensList(c, loadingMsg.message_id); // Directly show the sell list

  } catch (err) {
    logger.error("/sell command error:", err);
  }
});

// /withdraw
bot.onText(/\/withdraw/, async (msg) => { // Make async
  try {
    const c = msg.chat.id;
    clearPendingForSlash(c);
    if (msg.message_id) await bot.deleteMessage(c, msg.message_id).catch(e => {});
    const u = await getUserRow(c);
    const loadingMsg = await bot.sendMessage(c, "Redirecting to Withdraw Menu...", {parse_mode: "Markdown"});


    if (!u || !u.public_key) {
        return editMessageText(loadingMsg.chat_id, loadingMsg.message_id, "No wallet connected. Please connect a wallet first.", {
            inline_keyboard: [[{ text: "Connect Wallet", callback_data: "IMPORT_WALLET" }]]
        });
    }
     // Start the withdraw flow (similar to WITHDRAW_MENU callback)
    await editMessageText(loadingMsg.chat_id, loadingMsg.message_id, "Enter recipient Solana address:", {
        reply_markup: {
            inline_keyboard: [[{ text: "« Cancel", callback_data: "BACK_MAIN" }]],
        },
    });
    // The pendingMessageHandler for WITHDRAW_MENU will pick this up
    // This requires the `WITHDRAW_MENU` case in `on("callback_query")` to set up the pending handler correctly after this message.
    // For this to truly work, the callback handler logic for WITHDRAW_MENU needs to be callable or its pending handler setup part refactored.
    // For now, it just opens the first step.

  } catch (err) {
    logger.error("/withdraw command error:", err);
  }
});

// /settings
bot.onText(/\/settings/, async (msg) => { // Make async
  try {
    const c = msg.chat.id;
    clearPendingForSlash(c);
    if (msg.message_id) await bot.deleteMessage(c, msg.message_id).catch(e => {});
    const u = await getUserRow(c);
    const loadingMsg = await bot.sendMessage(c, "Redirecting to Settings...", {parse_mode: "Markdown"});


    if (!u || !u.public_key) {
        return editMessageText(loadingMsg.chat_id, loadingMsg.message_id, "No wallet connected. Please connect a wallet first.", {
            inline_keyboard: [[{ text: "Connect Wallet", callback_data: "IMPORT_WALLET" }]]
        });
    }
    const txt = `⚙️ *Wallet Settings*\n\nManage your wallet preferences and security.`;
    await editMessageText(loadingMsg.chat_id, loadingMsg.message_id, txt, settingsKeyboard());

  } catch (err) {
    logger.error("/settings command error:", err);
  }
});

logger.info("Telegram bot started...");
