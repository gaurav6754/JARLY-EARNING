const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());

// In-memory storage for balances and referrals
let balances = {};  // { userId: balance }
let referrals = {}; // { refereeId: referrerId }

// --- API ROUTES (Must be before static & wildcard routes) ---

app.post('/api/referral', (req, res) => {
  const { referrerId, refereeId } = req.get ? req.body : req.query;
  if (referrerId && refereeId && refereeId !== referrerId && !referrals[refereeId]) {
    referrals[refereeId] = referrerId;
    return res.json({ success: true, message: "Referral registered" });
  }
  res.json({ success: false, message: "Invalid or already registered" });
});

app.post('/api/complete-ads', (req, res) => {
  const { refereeId } = req.body;
  const referrerId = referrals[refereeId];

  if (referrerId) {
    balances[referrerId] = (balances[referrerId] || 0) + 0.50;
    balances[refereeId] = (balances[refereeId] || 0) + 0.50;
    delete referrals[refereeId]; // Ensure payout happens only once
    return res.json({ success: true, rewarded: true });
  }
  res.json({ success: false, message: "No active referrer found" });
});

app.get('/api/balance/:userId', (req, res) => {
  const userId = req.params.userId;
  res.json({ balance: balances[userId] || 0 });
});

// --- STATIC & FRONTEND ROUTING ---

// Serve static files from current directory
app.use(express.static(path.join(__dirname)));

// Serve index.html on root access (Must be at the very end)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Bind to Heroku's assigned port
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
