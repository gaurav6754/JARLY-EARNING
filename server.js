const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());

// In-memory storage
let balances = {};        // { userId: balance }
let referrals = {};       // { refereeId: referrerId }
let inviteCounts = {};    // { referrerId: count }
let inviteEarnings = {};  // { referrerId: earnings }

// --- API ROUTES ---

app.post('/api/referral', (req, res) => {
  const { referrerId, refereeId } = req.body;
  // Ensure user cannot refer themselves and referral isn't already logged
  if (referrerId && refereeId && referrerId !== refereeId && !referrals[refereeId]) {
    referrals[refereeId] = referrerId;
    return res.json({ success: true, message: "Referral registered" });
  }
  res.json({ success: false, message: "Invalid or already registered" });
});

app.post('/api/earn', (req, res) => {
  const { userId, amount } = req.body;
  if (userId && amount) {
    balances[userId] = (balances[userId] || 0) + parseFloat(amount);
    return res.json({ success: true, balance: balances[userId] });
  }
  res.json({ success: false, message: "Invalid request" });
});

app.post('/api/complete-ads', (req, res) => {
  const { refereeId } = req.body;
  const referrerId = referrals[refereeId];

  if (referrerId) {
    balances[referrerId] = (balances[referrerId] || 0) + 0.50;
    balances[refereeId] = (balances[refereeId] || 0) + 0.50;
    
    inviteCounts[referrerId] = (inviteCounts[referrerId] || 0) + 1;
    inviteEarnings[referrerId] = (inviteEarnings[referrerId] || 0) + 0.50;

    delete referrals[refereeId]; // Payout only once per referral
    return res.json({ success: true, rewarded: true });
  }
  res.json({ success: false, message: "No active referrer found" });
});

app.get('/api/stats/:userId', (req, res) => {
  const userId = req.params.userId;
  res.json({
    balance: balances[userId] !== undefined ? balances[userId] : null,
    inviteCount: inviteCounts[userId] || 0,
    inviteEarned: inviteEarnings[userId] || 0
  });
});

// --- STATIC FILES ---
app.use(express.static(path.join(__dirname)));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
