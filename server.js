require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const PORT = process.env.PORT || 3000;
const MAX_AGE = parseInt(process.env.INIT_DATA_MAX_AGE_SECONDS || '86400', 10);

if (!BOT_TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN in .env — copy .env.example to .env and fill it in.');
  process.exit(1);
}

if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI in .env — copy .env.example to .env and fill it in.');
  process.exit(1);
}

const REWARD = 0.15;
const DAILY_LIMIT = 3;
const REFERRAL_BONUS = 0.50;
const MIN_WITHDRAW = 15;

// ---------------------------------------------------------------------
// Database (MongoDB via Mongoose — persists across restarts/redeploys,
// unlike the old sqlite file which lived on Heroku's ephemeral disk)
// ---------------------------------------------------------------------
mongoose.connect(MONGODB_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });

const userSchema = new mongoose.Schema({
  _id: { type: String }, // Telegram user id, used directly as the document id
  firstName: { type: String, default: '' },
  lastName: { type: String, default: '' },
  username: { type: String, default: '' },
  balance: { type: Number, default: 0 },
  totalEarned: { type: Number, default: 0 },
  totalWatched: { type: Number, default: 0 },
  watchedToday: { type: Number, default: 0 },
  lastWatchDate: { type: String, default: '' },
  referredBy: { type: String, default: null },
  referralBonusGiven: { type: Boolean, default: false },
  inviteCount: { type: Number, default: 0 },
  inviteEarned: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});

const withdrawalSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  amount: { type: Number, required: true },
  method: { type: String, default: 'unknown' },
  destination: { type: String, default: '' },
  status: { type: String, default: 'Pending' },
  createdAt: { type: Date, default: Date.now },
});

const User = mongoose.model('User', userSchema);
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);

// ---------------------------------------------------------------------
// Telegram initData validation (unchanged from the sqlite version)
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// ---------------------------------------------------------------------
function validateInitData(initData) {
  if (!initData || typeof initData !== 'string') {
    console.log('[auth debug] initData missing or not a string:', initData);
    return null;
  }

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) {
    console.log('[auth debug] no hash field in initData');
    return null;
  }
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (computedHash !== hash) {
    console.log('[auth debug] hash mismatch — BOT_TOKEN likely wrong. computed:', computedHash, 'received:', hash);
    return null; // forged / tampered
  }

  const authDate = parseInt(params.get('auth_date') || '0', 10);
  if (!authDate || Date.now() / 1000 - authDate > MAX_AGE) {
    console.log('[auth debug] auth_date too old or missing:', authDate);
    return null; // stale/replayed
  }

  const userJson = params.get('user');
  if (!userJson) {
    console.log('[auth debug] no user field in initData');
    return null;
  }

  try {
    const user = JSON.parse(userJson);
    return { user, startParam: params.get('start_param') || null };
  } catch {
    console.log('[auth debug] failed to parse user JSON:', userJson);
    return null;
  }
}

function todayStr() {
  return new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
}

async function resetDailyIfNeeded(userDoc) {
  if (userDoc.lastWatchDate !== todayStr()) {
    userDoc.watchedToday = 0;
    userDoc.lastWatchDate = todayStr();
    await userDoc.save();
  }
  return userDoc;
}

function toClientShape(userDoc) {
  return {
    userId: userDoc._id,
    balance: round2(userDoc.balance),
    totalEarned: round2(userDoc.totalEarned),
    totalWatched: userDoc.totalWatched,
    watchedToday: userDoc.watchedToday,
    inviteCount: userDoc.inviteCount,
    inviteEarned: round2(userDoc.inviteEarned),
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
app.use(express.static(__dirname)); // serves index.html (and any other file) from the repo root

// 1) Auto-bind: called once when the mini app opens.
//    Creates the user if new, updates their profile info,
//    and — if they arrived via a referral link — permanently
//    records who referred them (only on first ever visit).
app.post('/api/auth', requireTelegramAuth, async (req, res) => {
  try {
    const tgUser = req.telegramUser;
    const id = String(tgUser.id);
    let userDoc = await User.findById(id);

    if (!userDoc) {
      userDoc = new User({
        _id: id,
        firstName: tgUser.first_name || '',
        lastName: tgUser.last_name || '',
        username: tgUser.username || '',
        lastWatchDate: todayStr(),
      });

      const ref = req.startParam ? req.startParam.replace(/^ref_/, '') : null;
      if (ref && ref !== id) {
        const referrer = await User.findById(ref);
        if (referrer) {
          userDoc.referredBy = ref;
        }
      }

      await userDoc.save();
    } else {
      userDoc.firstName = tgUser.first_name || '';
      userDoc.lastName = tgUser.last_name || '';
      userDoc.username = tgUser.username || '';
      await userDoc.save();
      userDoc = await resetDailyIfNeeded(userDoc);
    }

    res.json(toClientShape(userDoc));
  } catch (err) {
    console.error('auth error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// 2) Watch an ad — server decides the reward, enforces the daily cap,
//    and credits the referrer the FIRST time a referred user hits 3/day.
app.post('/api/watch-ad', requireTelegramAuth, async (req, res) => {
  try {
    const id = String(req.telegramUser.id);
    let userDoc = await User.findById(id);
    if (!userDoc) return res.status(404).json({ error: 'User not found. Call /api/auth first.' });

    userDoc = await resetDailyIfNeeded(userDoc);

    if (userDoc.watchedToday >= DAILY_LIMIT) {
      return res.status(400).json({ error: 'Daily limit reached' });
    }

    userDoc.balance += REWARD;
    userDoc.totalEarned += REWARD;
    userDoc.totalWatched += 1;
    userDoc.watchedToday += 1;
    userDoc.lastWatchDate = todayStr();
    await userDoc.save();

    let rewarded = false;

    // Credit the referrer once, the moment their referee completes today's 3rd ad
    // (and only ever once per referee, via referralBonusGiven).
    if (userDoc.watchedToday === DAILY_LIMIT && userDoc.referredBy && !userDoc.referralBonusGiven) {
      const referrer = await User.findById(userDoc.referredBy);
      if (referrer) {
        referrer.balance += REFERRAL_BONUS;
        referrer.inviteEarned += REFERRAL_BONUS;
        referrer.inviteCount += 1;
        await referrer.save();

        userDoc.referralBonusGiven = true;
        await userDoc.save();
        rewarded = true;
      }
    }

    res.json({ ...toClientShape(userDoc), rewarded });
  } catch (err) {
    console.error('watch-ad error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// 3) Poll for current stats (balance may have grown from a referral
//    bonus credited by someone else's activity).
app.post('/api/stats', requireTelegramAuth, async (req, res) => {
  try {
    const id = String(req.telegramUser.id);
    let userDoc = await User.findById(id);
    if (!userDoc) return res.status(404).json({ error: 'User not found' });
    userDoc = await resetDailyIfNeeded(userDoc);
    res.json(toClientShape(userDoc));
  } catch (err) {
    console.error('stats error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// 4) Withdraw
app.post('/api/withdraw', requireTelegramAuth, async (req, res) => {
  try {
    const id = String(req.telegramUser.id);
    const { amount, method, destination } = req.body;
    const userDoc = await User.findById(id);
    if (!userDoc) return res.status(404).json({ error: 'User not found' });

    const amt = parseFloat(amount);
    if (isNaN(amt) || amt < MIN_WITHDRAW || amt > userDoc.balance) {
      return res.status(400).json({ error: 'Invalid withdrawal amount' });
    }

    userDoc.balance -= amt;
    await userDoc.save();

    const withdrawal = await Withdrawal.create({
      userId: id,
      amount: amt,
      method: method || 'unknown',
      destination: destination || '',
    });

    res.json({ withdrawalId: withdrawal._id, ...toClientShape(userDoc) });
  } catch (err) {
    console.error('withdraw error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.listen(PORT, () => console.log(`Jarly backend listening on :${PORT}`));
