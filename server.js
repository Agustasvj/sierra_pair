const express = require('express');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve the pairing page
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sierra MD Pairing</title>
  <style>
    body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #111; color: #eee; }
    input { padding: 12px; font-size: 18px; width: 300px; margin: 10px 0; border-radius: 8px; border: 1px solid #444; background: #222; color: white; }
    button { padding: 12px 24px; font-size: 18px; background: #25D366; color: white; border: none; border-radius: 8px; cursor: pointer; }
    #result { margin-top: 30px; font-size: 18px; word-break: break-all; background: #1e1e1e; padding: 20px; border-radius: 12px; max-width: 600px; margin-left: auto; margin-right: auto; }
  </style>
</head>
<body>
  <h1>Sierra MD Pairing Code</h1>
  <p>Enter your phone number (e.g. 254712345678)</p>
  <input type="text" id="phone" placeholder="254712345678">
  <br>
  <button onclick="generateCode()">Generate Code</button>
  <div id="result">Waiting...</div>

  <script>
    async function generateCode() {
      const phone = document.getElementById('phone').value.trim();
      const result = document.getElementById('result');
      result.innerHTML = 'Generating pairing code...';

      if (!phone.match(/^[0-9]{9,15}$/)) {
        result.innerHTML = 'Invalid phone number';
        return;
      }

      try {
        const res = await fetch('/api/pair', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone })
        });
        const data = await res.json();

        if (data.error) {
          result.innerHTML = 'Error: ' + data.error;
        } else {
          result.innerHTML = 'Pairing Code: <strong>' + data.code + '</strong><br><br>' +
            'Open WhatsApp → Settings → Linked Devices → Link with phone number<br>' +
            'Enter the code above immediately (it expires quickly)';
        }
      } catch (err) {
        result.innerHTML = 'Failed to connect. Try again.';
      }
    }
  </script>
</body>
</html>
  `);
});

// API to generate pairing code
app.post('/api/pair', async (req, res) => {
  const { phone } = req.body;
  if (!phone || !/^\d{9,15}$/.test(phone)) {
    return res.status(400).json({ error: 'Invalid phone number (9–15 digits, no +)' });
  }

  const sessionId = Date.now().toString();
  const sessionPath = path.join(__dirname, 'temp_pair_auth');

  try {
    await fs.mkdir(sessionPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    const sock = makeWASocket({
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['Sierra MD Pairing', 'Chrome', '120.0'],
      auth: state
    });

    sock.ev.on('creds.update', saveCreds);

    const code = await sock.requestPairingCode(phone);

    sock.ev.on('connection.update', async (update) => {
      if (update.connection === 'open') {
        console.log('Pairing successful for', phone);
        sock.end();
        // Optional: keep session or clean up
      }
      if (update.connection === 'close') {
        if (update.lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
          sock.end();
        }
      }
    });

    res.json({ code });
  } catch (err) {
    console.error('Pairing error:', err.message);
    res.status(500).json({ error: 'Failed to generate code. Try again.' });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Pairing server running on port ${port}`);
});
