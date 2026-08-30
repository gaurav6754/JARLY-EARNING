require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const MAX_AGE = parseInt(process.env.INIT_DATA_MAX_AGE_SECONDS || '86400', 10);

if (!BOT_TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN in .env — copy .env.example to .env and fill it in.');
  process.exit(1);
}

const REWARD = 0.15;
const DAILY_LIMIT = 3;
const REFERRAL_BONUS = 0.50;
const MIN_WITHDRAW = 15;

// ---------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------
const db = new Database('jarly.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    first_name TEXT,
    last_name TEXT,
    username TEXT,
    balance REAL NOT NULL DEFAULT 0,
    total_earned REAL NOT NULL DEFAULT 0,
    total_watched INTEGER NOT NULL DEFAULT 0,
    watched_today INTEGER NOT NULL DEFAULT 0,
    last_watch_date TEXT,
    referred_by TEXT,
    referral_bonus_given INTEGER NOT NULL DEFAULT 0,
    invite_count INTEGER NOT NULL DEFAULT 0,
    invite_earned REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS withdrawals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    amount REAL NOT NULL,
    method TEXT NOT NULL,
    destination TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const getUser = db.prepare('SELECT * FROM users WHERE id = ?');
const insertUser = db.prepare(`
  INSERT INTO users (id, first_name, last_name, username, last_watch_date)
  VALUES (?, ?, ?, ?, ?)
`);
const touchProfile = db.prepare(`
  UPDATE users SET first_name = ?, last_name = ?, username = ? WHERE id = ?
`);
const setReferredBy = db.prepare(`UPDATE users SET referred_by = ? WHERE id = ?`);

// ---------------------------------------------------------------------
// Telegram initData validation
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// ---------------------------------------------------------------------
function validateInitData(initData) {
  if (!initData || typeof initData !== 'string') return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (computedHash !== hash) return null; // forged / tampered

  const authDate = parseInt(params.get('auth_date') || '0', 10);
  if (!authDate || Date.now() / 1000 - authDate > MAX_AGE) return null; // stale/replayed

  const userJson = params.get('user');
  if (!userJson) return null;

  try {
    const user = JSON.parse(userJson);
    return { user, startParam: params.get('start_param') || null };
  } catch {
    return null;
  }
}

function todayStr() {
  return new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
}

function resetDailyIfNeeded(row) {
  if (row.last_watch_date !== todayStr()) {
    db.prepare('UPDATE users SET watched_today = 0, last_watch_date = ? WHERE id = ?')
      .run(todayStr(), row.id);
    row.watched_today = 0;
    row.last_watch_date = todayStr();
  }
  return row;
}

function toClientShape(row) {
  return {
    userId: row.id,
    balance: round2(row.balance),
    totalEarned: round2(row.total_earned),
    totalWatched: row.total_watched,
    watchedToday: row.watched_today,
    inviteCount: row.invite_count,
    inviteEarned: round2(row.invite_earned),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Express middleware: validates initData sent in the body on every
// protected route and attaches req.telegramUser / req.startParam.
function requireTelegramAuth(req, res, next) {
  const result = validateInitData(req.body.initData);
  if (!result) {
    return res.status(401).json({ error: 'Invalid or expired Telegram session. Please reopen the app.' });
  }
  req.telegramUser = result.user;
  req.startParam = result.startParam;
  next();
}

// ---------------------------------------------------------------------
// App
// ---------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // serves public/index.html at "/"

// 1) Auto-bind: called once when the mini app opens.
//    Creates the user row if new, updates their profile info,
//    and — if they arrived via a referral link — permanently
//    records who referred them (only on first ever visit).
app.post('/api/auth', requireTelegramAuth, (req, res) => {
  const tgUser = req.telegramUser;
  const id = String(tgUser.id);
  let row = getUser.get(id);

  if (!row) {
    insertUser.run(id, tgUser.first_name || '', tgUser.last_name || '', tgUser.username || '', todayStr());
    row = getUser.get(id);

    const ref = req.startParam ? req.startParam.replace(/^ref_/, '') : null;
    if (ref && ref !== id) {
      const referrer = getUser.get(ref);
      if (referrer) {
        setReferredBy.run(ref, id);
        row.referred_by = ref;
      }
    }
  } else {
    touchProfile.run(tgUser.first_name || '', tgUser.last_name || '', tgUser.username || '', id);
    row = resetDailyIfNeeded(row);
  }

  res.json(toClientShape(row));
});

// 2) Watch an ad — server decides the reward, enforces the daily cap,
//    and credits the referrer the FIRST time a referred user hits 3/day.
app.post('/api/watch-ad', requireTelegramAuth, (req, res) => {
  const id = String(req.telegramUser.id);
  let row = getUser.get(id);
  if (!row) return res.status(404).json({ error: 'User not found. Call /api/auth first.' });

  row = resetDailyIfNeeded(row);

  if (row.watched_today >= DAILY_LIMIT) {
    return res.status(400).json({ error: 'Daily limit reached' });
  }

  const newBalance = row.balance + REWARD;
  const newTotalEarned = row.total_earned + REWARD;
  const newTotalWatched = row.total_watched + 1;
  const newWatchedToday = row.watched_today + 1;

  db.prepare(`
    UPDATE users
    SET balance = ?, total_earned = ?, total_watched = ?, watched_today = ?, last_watch_date = ?
    WHERE id = ?
  `).run(newBalance, newTotalEarned, newTotalWatched, newWatchedToday, todayStr(), id);

  let rewarded = false;

  // Credit the referrer once, the moment their referee completes today's 3rd ad
  // (and only ever once per referee, via referral_bonus_given).
  if (newWatchedToday === DAILY_LIMIT && row.referred_by && !row.referral_bonus_given) {
    const referrer = getUser.get(row.referred_by);
    if (referrer) {
      db.prepare(`
        UPDATE users SET balance = balance + ?, invite_earned = invite_earned + ?, invite_count = invite_count + 1
        WHERE id = ?
      `).run(REFERRAL_BONUS, REFERRAL_BONUS, referrer.id);

      db.prepare('UPDATE users SET referral_bonus_given = 1 WHERE id = ?').run(id);
      rewarded = true;
    }
  }

  const updatedRow = getUser.get(id);
  res.json({ ...toClientShape(updatedRow), rewarded });
});

// 3) Poll for current stats (balance may have grown from a referral
//    bonus credited by someone else's activity).
app.post('/api/stats', requireTelegramAuth, (req, res) => {
  const id = String(req.telegramUser.id);
  let row = getUser.get(id);
  if (!row) return res.status(404).json({ error: 'User not found' });
  row = resetDailyIfNeeded(row);
  res.json(toClientShape(row));
});

// 4) Withdraw
app.post('/api/withdraw', requireTelegramAuth, (req, res) => {
  const id = String(req.telegramUser.id);
  const { amount, method, destination } = req.body;
  const row = getUser.get(id);
  if (!row) return res.status(404).json({ error: 'User not found' });

  const amt = parseFloat(amount);
  if (isNaN(amt) || amt < MIN_WITHDRAW || amt > row.balance) {
    return res.status(400).json({ error: 'Invalid withdrawal amount' });
  }

  db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(amt, id);
  const info = db.prepare(`
    INSERT INTO withdrawals (user_id, amount, method, destination) VALUES (?, ?, ?, ?)
  `).run(id, amt, method || 'unknown', destination || '');

  const updatedRow = getUser.get(id);
  res.json({ withdrawalId: info.lastInsertRowid, ...toClientShape(updatedRow) });
});

app.listen(PORT, () => console.log(`Jarly backend listening on :${PORT}`));
