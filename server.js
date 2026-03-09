const express = require('express');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Pastebin API key from env (replace with your own)
const PASTEBIN_API_KEY = process.env.PASTEBIN_API_KEY || 'YOUR_PASTEBIN_API_KEY_HERE';

async function uploadToPastebin(content, title = 'Untitled', format = 'json', privacy = '1') {
  try {
    const privacyMap = { '0': 0, '1': 1, '2': 2 };
    const body = new URLSearchParams({
      api_dev_key: PASTEBIN_API_KEY,
      api_option: 'paste',
      api_paste_code: content,
      api_paste_name: title,
      api_paste_format: format,
      api_paste_private: String(privacyMap[privacy] || 1),
      api_paste_expire_date: 'N',
    });

    const res = await axios.post('https://pastebin.com/api/api_post.php', body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const text = res.data;
    if (!text.startsWith('https://')) throw new Error(`Pastebin error: ${text}`);
    const pasteId = text.split('/').pop();
    return `GlobalTechInfo/MEGA-MD_${pasteId}`;
  } catch (e) {
    console.error('Pastebin upload failed:', e);
    throw e;
  }
}

// Serve the pairing page
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
      <title>Sierra MD Pairing</title>
      <style>
        body { font-family: Arial; text-align: center; padding: 50px; }
        input { padding: 10px; font-size: 16px; width: 300px; }
        button { padding: 10px 20px; font-size: 16px; }
        #result { margin-top: 20px; font-size: 18px; word-break: break-all; }
      </style>
    </head>
    <body>
      <h1>Sierra MD Pairing Code Generator</h1>
      <p>Enter phone number (e.g., 254712345678)</p>
      <input type="text" id="phone" placeholder="Phone number">
      <button onclick="generateCode()">Get Pairing Code</button>
      <div id="code"></div>
      <div id="result"></div>

      <script>
        async function generateCode() {
          const phone = document.getElementById('phone').value.trim();
          const codeDiv = document.getElementById('code');
          const resultDiv = document.getElementById('result');
          codeDiv.innerHTML = 'Generating...';
          resultDiv.innerHTML = '';

          try {
            const res = await fetch('/api/pair', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ phone })
            });
            const data = await res.json();

            if (data.error) {
              codeDiv.innerHTML = `Error: ${data.error}`;
              return;
            }

            codeDiv.innerHTML = `Pairing Code: ${data.code}<br>Enter in WhatsApp > Linked Devices > Link with phone number`;
            resultDiv.innerHTML = 'Waiting for pairing to complete...';

            // Poll for completion
            const interval = setInterval(async () => {
              const checkRes = await fetch('/api/check?session=' + data.sessionId);
              const checkData = await checkRes.json();

              if (checkData.status === 'complete') {
                clearInterval(interval);
                resultDiv.innerHTML = `Success! Output: ${checkData.output}`;
              } else if (checkData.status === 'error') {
                clearInterval(interval);
                resultDiv.innerHTML = `Error: ${checkData.error}`;
              }
            }, 5000);
          } catch (err) {
            codeDiv.innerHTML = 'Failed to generate code';
          }
        }
      </script>
    </body>
    </html>
  `);
});

// Start pairing
app.post('/api/pair', async (req, res) => {
  const { phone } = req.body;
  if (!phone || !/^\d{10,15}$/.test(phone)) {
    return res.status(400).json({ error: 'Invalid phone number' });
  }

  const sessionId = Date.now().toString();
  const sessionPath = path.join(__dirname, 'temp', sessionId);

  try {
    await fs.mkdir(sessionPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    const sock = makeWASocket({
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['Sierra MD', 'Chrome', '1.0.0'],
      auth: state
    });

    sock.ev.on('creds.update', saveCreds);

    const code = await sock.requestPairingCode(phone);

    sock.ev.on('connection.update', (update) => {
      const { connection } = update;
      if (connection === 'open') {
        sock.end();
      }
    });

    res.json({ code, sessionId });
  } catch (err) {
    await fs.rm(sessionPath, { recursive: true, force: true }).catch(() => {});
    res.status(500).json({ error: 'Failed to start pairing' });
  }
});

// Check and get output
app.get('/api/check', async (req, res) => {
  const { session } = req.query;
  if (!session) return res.status(400).json({ error: 'Missing session' });

  const sessionPath = path.join(__dirname, 'temp', session, 'creds.json');

  try {
    if (await fs.access(sessionPath).then(() => true).catch(() => false)) {
      const credsJson = await fs.readFile(sessionPath, 'utf-8');
      const pasteOutput = await uploadToPastebin(credsJson);

      await fs.rm(path.dirname(sessionPath), { recursive: true, force: true }).catch(() => {});

      res.json({ status: 'complete', output: pasteOutput });
    } else {
      res.json({ status: 'waiting' });
    }
  } catch (err) {
    res.json({ status: 'error', error: err.message });
  }
});

app.listen(port, () => console.log(`Server running on port ${port}`));
