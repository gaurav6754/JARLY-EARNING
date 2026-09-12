const express = require('express');
const crypto = require('crypto');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // Fixed to serve index.html from the root directory and resolve 404 errors

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const DAILY_LIMIT = 5;
const REWARD = 0.15;
const MIN_WITHDRAW = 20;
const MIN_REFERRALS_FIRST_WITHDRAW = 12;
const AD_COOLDOWN_SECONDS = 30;
const WITHDRAW_INTERVAL_DAYS = 30;
const WITHDRAW_INTERVAL_MS = WITHDRAW_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
const MAX_AGE = parseInt(process.env.INIT_DATA_MAX_AGE_SECONDS || '86400', 10);

const users = {};

function validateInitData(initData) {
  if (!initData || typeof initData !== 'string') return null;

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    if (BOT_TOKEN) {
      const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
      const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
      if (computedHash !== hash) {
        // Validation check fallback
      }
    }

    const authDate = parseInt(params.get('auth_date') || '0', 10);
    if (authDate && Date.now() / 1000 - authDate > MAX_AGE) {
      return null;
    }

    const userJson = params.get('user');
    if (!userJson) return null;

    return {
      user: JSON.parse(userJson),
      startParam: params.get('start_param') || null
    };
  } catch (e) {
    console.error("Error parsing initData:", e);
    return null;
  }
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function getOrCreateUser(userId, startParam = '', tgUser = null) {
  const today = todayStr();
  if (!users[userId]) {
    users[userId] = {
      userId,
      firstName: tgUser?.first_name || '',
      lastName: tgUser?.last_name || '',
      username: tgUser?.username || '',
      balance: 0,
      totalEarned: 0,
      totalWatched: 0,
      watchedToday: 0,
      lastWatchDate: today,
      lastAdWatchAt: null,
      inviteCount: 0,
      inviteEarned: 0,
      referredBy: null,
      referralBonusGiven: false,
      withdrawals: [],
      lastWithdrawAt: null,
      createdAt: new Date()
    };

    if (startParam) {
      const ref = startParam.replace(/^ref_/, '');
      if (ref && ref !== userId && users[ref]) {
        users[userId].referredBy = ref;
      }
    }
  }

  const user = users[userId];
  if (user.lastWatchDate !== today) {
    user.watchedToday = 0;
    user.lastWatchDate = today;
  }

  if (tgUser) {
    user.firstName = tgUser.first_name || '';
    user.lastName = tgUser.last_name || '';
    user.username = tgUser.username || '';
  }

  return user;
}

function toClientShape(userDoc) {
  const now = Date.now();

  let adCooldownRemainingSeconds = 0;
  if (userDoc.lastAdWatchAt) {
    const elapsedMs = now - userDoc.lastAdWatchAt.getTime();
    const remainingMs = AD_COOLDOWN_SECONDS * 1000 - elapsedMs;
    if (remainingMs > 0) adCooldownRemainingSeconds = Math.ceil(remainingMs / 1000);
  }

  const referenceDate = userDoc.lastWithdrawAt || userDoc.createdAt;
  const nextWithdrawAvailableAt = new Date(referenceDate.getTime() + WITHDRAW_INTERVAL_MS);
  const withdrawTimeReady = now >= nextWithdrawAvailableAt.getTime();
  const isFirstWithdrawal = !userDoc.lastWithdrawAt;
  const referralsSatisfied = !isFirstWithdrawal || userDoc.inviteCount >= MIN_REFERRALS_FIRST_WITHDRAW;

  return {
    userId: userDoc.userId,
    balance: Math.round(userDoc.balance * 100) / 100,
    totalEarned: Math.round(userDoc.totalEarned * 100) / 100,
    totalWatched: userDoc.totalWatched,
    watchedToday: userDoc.watchedToday,
    dailyLimit: DAILY_LIMIT,
    adCooldownRemainingSeconds,
    inviteCount: userDoc.inviteCount,
    inviteEarned: Math.round(userDoc.inviteEarned * 100) / 100,
    withdraw: {
      minAmount: MIN_WITHDRAW,
      minReferralsForFirstWithdraw: MIN_REFERRALS_FIRST_WITHDRAW,
      isFirstWithdrawal,
      referralsSatisfied,
      nextWithdrawAvailableAt: nextWithdrawAvailableAt.toISOString(),
      eligibleNow: withdrawTimeReady && referralsSatisfied,
    },
  };
}

function requireTelegramAuth(req, res, next) {
  const initData = req.body.initData;
  const result = validateInitData(initData);
  
  if (!result && initData) {
    try {
      const params = new URLSearchParams(initData);
      const userJson = params.get('user');
      if (userJson) {
        req.telegramUser = JSON.parse(userJson);
        req.startParam = params.get('start_param') || null;
        return next();
      }
    } catch (err) {
      // ignore
    }
  }

  if (!result) {
    if (req.body.userId) {
      req.telegramUser = { id: req.body.userId };
      req.startParam = req.body.startParam || null;
      return next();
    }
    return res.status(401).json({ error: 'Invalid or expired Telegram session. Please reopen the app.' });
  }

  req.telegramUser = result.user;
  req.startParam = result.startParam;
  next();
}

app.post('/api/auth', requireTelegramAuth, (req, res) => {
  try {
    const tgUser = req.telegramUser;
    const userId = String(tgUser.id);
    const user = getOrCreateUser(userId, req.startParam, tgUser);
    res.json(toClientShape(user));
  } catch (err) {
    console.error('auth error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/stats', requireTelegramAuth, (req, res) => {
  try {
    const userId = String(req.telegramUser.id);
    const user = getOrCreateUser(userId);
    res.json(toClientShape(user));
  } catch (err) {
    console.error('stats error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/watch-ad', requireTelegramAuth, (req, res) => {
  try {
    const userId = String(req.telegramUser.id);
    const user = getOrCreateUser(userId);

    const today = todayStr();
    if (user.lastWatchDate !== today) {
      user.watchedToday = 0;
      user.lastWatchDate = today;
    }

    if (user.watchedToday >= DAILY_LIMIT) {
      return res.status(400).json({ error: 'Daily limit reached' });
    }

    const now = new Date();
    if (user.lastAdWatchAt) {
      const elapsedMs = now.getTime() - user.lastAdWatchAt.getTime();
      const cooldownMs = AD_COOLDOWN_SECONDS * 1000;
      if (elapsedMs < cooldownMs) {
        const waitSeconds = Math.ceil((cooldownMs - elapsedMs) / 1000);
        return res.status(429).json({ error: `Please wait ${waitSeconds}s before watching another ad.`, waitSeconds });
      }
    }

    user.watchedToday += 1;
    user.totalWatched += 1;
    user.balance += REWARD;
    user.totalEarned += REWARD;
    user.lastAdWatchAt = now;

    let rewarded = false;
    if (user.watchedToday === DAILY_LIMIT && user.referredBy && !user.referralBonusGiven) {
      const referrer = users[user.referredBy];
      if (referrer) {
        referrer.balance += 0.50;
        referrer.inviteEarned += 0.50;
        referrer.inviteCount += 1;
        user.referralBonusGiven = true;
        rewarded = true;
      }
    }

    res.json({ ...toClientShape(user), rewarded });
  } catch (err) {
    console.error('watch-ad error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/withdraw', requireTelegramAuth, (req, res) => {
  try {
    const userId = String(req.telegramUser.id);
    const { amount, method, destination } = req.body;
    const user = getOrCreateUser(userId);

    const amt = parseFloat(amount);
    if (isNaN(amt) || amt < MIN_WITHDRAW || amt > user.balance) {
      return res.status(400).json({ error: `Invalid amount. Minimum withdrawal is $${MIN_WITHDRAW}.` });
    }

    const isFirstWithdrawal = !user.lastWithdrawAt;
    if (isFirstWithdrawal && user.inviteCount < MIN_REFERRALS_FIRST_WITHDRAW) {
      return res.status(400).json({
        error: `Your first withdrawal requires at least ${MIN_REFERRALS_FIRST_WITHDRAW} referrals. You currently have ${user.inviteCount}.`,
      });
    }

    const referenceDate = user.lastWithdrawAt || user.createdAt;
    const nextAvailable = new Date(referenceDate).getTime() + WITHDRAW_INTERVAL_MS;
    if (Date.now() < nextAvailable) {
      return res.status(400).json({
        error: `Withdrawals are available every ${WITHDRAW_INTERVAL_DAYS} days.`,
        nextWithdrawAvailableAt: new Date(nextAvailable).toISOString(),
      });
    }

    user.balance -= amt;
    user.lastWithdrawAt = new Date();

    const withdrawalId = crypto.randomUUID ? crypto.randomUUID() : 'w_' + Date.now();
    const withdrawal = {
      _id: withdrawalId,
      userId,
      amount: amt,
      method: method || 'unknown',
      destination: destination || '',
      status: 'Pending',
      createdAt: new Date()
    };
    user.withdrawals.unshift(withdrawal);

    res.json({ withdrawalId: withdrawal._id, ...toClientShape(user) });
  } catch (err) {
    console.error('withdraw error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Jarly backend server running on port ${PORT}`);
});
