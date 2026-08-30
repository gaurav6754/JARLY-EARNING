const express = require('express');
const path = require('path');
const app = express();

// Serve static files from current directory
app.use(express.static(path.join(__dirname)));

// Serve index.html on root access
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Bind to Heroku's assigned port
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
