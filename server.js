const express = require('express');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
      <title>Sierra MD Pairing - Full Session</title>
      <style>
        body { font-family: Arial, sans-serif; background:#111; color:#eee; margin:0; padding:20px; text-align:center; }
        .box { max-width:600px; margin:0 auto; background:#1e1e1e; padding:30px; border-radius:12px; }
        h1 { color:#25D366; }
        input { width:100%; padding:14px; font-size:18px; margin:10px 0; border-radius:8px; border:1px solid #444; background:#2a2a2a; color:white; }
        button { background:#25D366; color:white; border:none; padding:16px; font-size:18px; width:100%; border-radius:8px; cursor:pointer; }
        #status { margin:20px 0; padding:15px; background:#2a2a2a; border-radius:8px; min-height:100px; white-space:pre-wrap; word-break:break-all; }
        .code { font-size:2.5em; font-weight:bold; color:#25D366; letter-spacing:6px; margin:20px 0; }
        textarea { width:100%; height:180px; background:#222; color:#0f0; font-family:monospace; padding:12px; border-radius:8px; border:1px solid #444; }
      </style>
    </head>
    <body>
      <div class="box">
        <h1>Sierra MD Pairing</h1>
        <p>Enter your phone number (no +, e.g. 254712345678)</p>
        
        <input type="tel" id="phone" placeholder="254712345678" pattern="[0-9]{9,15}" required />
        <button onclick="startPairing()">Generate Code & Wait for Pairing</button>
        
        <div id="status">Waiting...</div>
        <div id="codeDisplay" style="display:none;">
          <p>Enter this code in WhatsApp → Linked Devices → Link with phone number</p>
          <div class="code" id="pairCode"></div>
        </div>
        <textarea id="credsOutput" placeholder="Full base64 session will appear here after successful pairing" readonly></textarea>
      </div>

      <script>
        let socket = null;

        async function startPairing() {
          const phone = document.getElementById('phone').value.trim();
          const status = document.getElementById('status');
          const codeDiv = document.getElementById('codeDisplay');
          const codeEl = document.getElementById('pairCode');
          const credsArea = document.getElementById('credsOutput');

          if (!phone.match(/^[0-9]{9,15}$/)) {
            status.innerHTML = '<span style="color:#f44336;">Invalid phone number</span>';
            return;
          }

          status.innerHTML = 'Requesting pairing code...';
          credsArea.value = '';

          try {
            const res = await fetch('/api/start-pair', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ phone })
            });

            const data = await res.json();

            if (data.error) {
              status.innerHTML = '<span style="color:#f44336;">Error: ' + data.error + '</span>';
              return;
            }

            codeEl.textContent = data.code;
            codeDiv.style.display = 'block';
            status.innerHTML = '<span style="color:#4caf50;">Code generated! Enter it in WhatsApp now.</span><br>Waiting for pairing to complete...';

            // Poll for completion
            const interval = setInterval(async () => {
              const check = await fetch('/api/check-pair?session=' + data.sessionId);
              const result = await check.json();

              if (result.status === 'success') {
                clearInterval(interval);
                status.innerHTML = '<span style="color:#4caf50;">Pairing successful!</span>';
                credsArea.value = result.credsBase64;
                credsArea.select();
                status.innerHTML += '<br><strong>Copy the above base64 string and set it as SESSION_ID in Render env vars.</strong>';
              } else if (result.status === 'failed') {
                clearInterval(interval);
                status.innerHTML = '<span style="color:#f44336;">Pairing failed: ' + (result.error || 'unknown') + '</span>';
              }
              // else still waiting
            }, 5000);

          } catch (err) {
            status.innerHTML = '<span style="color:#f44336;">Connection failed</span>';
          }
        }
      </script>
    </body>
    </html>
  `);
});

// Start pairing and return code + session ID for polling
app.post('/api/start-pair', async (req, res) => {
  const { phone } = req.body;
  if (!phone || !/^\d{9,15}$/.test(phone)) {
    return res.status(400).json({ error: 'Invalid phone number' });
  }

  const sessionId = Date.now().toString(); // unique per attempt
  const sessionPath = path.join(__dirname, 'temp_pair', sessionId);

  try {
    await fs.mkdir(sessionPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    const sock = makeWASocket({
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['Sierra Pair', 'Chrome', '120.0'],
      auth: state
    });

    sock.ev.on('creds.update', saveCreds);

    const code = await sock.requestPairingCode(phone);

    // Keep socket alive until paired or timeout
    const timeout = setTimeout(() => sock.end(), 5 * 60 * 1000); // 5 min max

    sock.ev.on('connection.update', (update) => {
      if (update.connection === 'open') {
        clearTimeout(timeout);
        sock.end();
        // Session is now saved in sessionPath/creds.json
      }
    });

    res.json({ code, sessionId });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to start pairing' });
  }
});

// Check if pairing completed and return base64 creds
app.get('/api/check-pair', async (req, res) => {
  const { session } = req.query;
  if (!session) return res.status(400).json({ error: 'Missing session' });

  const sessionPath = path.join(__dirname, 'temp_pair', session, 'creds.json');

  try {
    const credsExist = await fs.access(sessionPath).then(() => true).catch(() => false);

    if (credsExist) {
      const credsJson = await fs.readFile(sessionPath, 'utf-8');
      const credsBase64 = Buffer.from(credsJson).toString('base64');

      // Optional: clean up
      // await fs.rm(path.dirname(sessionPath), { recursive: true, force: true });

      res.json({ status: 'success', credsBase64 });
    } else {
      res.json({ status: 'waiting' });
    }
  } catch (err) {
    res.json({ status: 'failed', error: err.message });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Pairing server on port ${port}`);
});
