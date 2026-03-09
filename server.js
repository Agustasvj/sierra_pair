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
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
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

          try {
            const res = await fetch('/api/pair', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ phone })
            });
            const data = await res.json();

            if (data.error) {
              result.innerHTML = 'Error: ' + data.error;
              return;
            }

            result.innerHTML = 'Pairing Code: <strong>' + data.code + '</strong><br><br>' +
              'Enter in WhatsApp > Linked Devices > Link with phone number<br>' +
              'Waiting for pairing to complete...';

            // Poll for completion
            const interval = setInterval(async () => {
              const check = await fetch('/api/check?session=' + data.sessionId);
              const checkData = await check.json();

              if (checkData.status === 'complete') {
                clearInterval(interval);
                result.innerHTML += '<br>Success! SESSION_ID sent to your DM.';
              } else if (checkData.status === 'error') {
                clearInterval(interval);
                result.innerHTML += '<br>Error: ' + checkData.error;
              }
            }, 3000);
          } catch (err) {
            result.innerHTML = 'Failed to generate code';
          }
        }
      </script>
    </body>
    </html>
  `);
});

// API to start pairing
app.post('/api/pair', async (req, res) => {
  const { phone } = req.body;
  if (!phone || !/^\d{9,15}$/.test(phone)) {
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

    res.json({ code, sessionId });

    // Wait for pairing completion
    sock.ev.on('connection.update', async (update) => {
      const { connection } = update;
      if (connection === 'open') {
        try {
          const credsJson = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf-8');
          const credsBase64 = Buffer.from(credsJson).toString('base64');

          const userJid = sock.user.id;
          await sock.sendMessage(userJid, { text: `Your SESSION_ID:\n\n${credsBase64}\n\nCopy and set in your bot env vars.` });

          console.log('SESSION_ID sent to DM for', phone);
        } catch (e) {
          console.error('Error sending SESSION_ID:', e);
        } finally {
          sock.end();
          await fs.rm(path.dirname(sessionPath), { recursive: true, force: true });
        }
      }
      if (connection === 'close' && update.lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
        // Reconnect if not logged out
      }
    });

  } catch (err) {
    await fs.rm(sessionPath, { recursive: true, force: true });
    res.status(500).json({ error: err.message });
  }
});

// Check if pairing complete
app.get('/api/check', async (req, res) => {
  const { session } = req.query;
  if (!session) return res.status(400).json({ error: 'Missing session' });

  const sessionPath = path.join(__dirname, 'temp', session);
  const credsPath = path.join(sessionPath, 'creds.json');

  if (await fs.access(credsPath).then(() => true).catch(() => false)) {
    res.json({ status: 'complete' });
  } else {
    res.json({ status: 'waiting' });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Server running on port ${port}`);
});
