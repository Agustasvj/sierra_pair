const express = require('express');
const { makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public')); // for static files if you add CSS/JS later

// Serve the pairing page
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
      <title>Sierra MD - Pairing Code</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: #111;
          color: #e0e0e0;
          margin: 0;
          padding: 20px;
          display: flex;
          flex-direction: column;
          align-items: center;
        }
        .container {
          max-width: 480px;
          width: 100%;
          background: #1e1e1e;
          padding: 32px;
          border-radius: 16px;
          box-shadow: 0 4px 30px rgba(0,0,0,0.5);
        }
        h1 {
          color: #25D366;
          text-align: center;
          margin-bottom: 8px;
        }
        p.subtitle {
          text-align: center;
          color: #aaa;
          margin-bottom: 32px;
        }
        label {
          display: block;
          margin: 16px 0 8px;
          font-weight: 500;
        }
        input {
          width: 100%;
          padding: 14px;
          font-size: 18px;
          border: 1px solid #444;
          border-radius: 8px;
          background: #2a2a2a;
          color: white;
          box-sizing: border-box;
        }
        button {
          width: 100%;
          padding: 16px;
          font-size: 18px;
          background: #25D366;
          color: white;
          border: none;
          border-radius: 8px;
          cursor: pointer;
          margin-top: 24px;
          font-weight: bold;
        }
        button:hover {
          background: #128C7E;
        }
        #result {
          margin-top: 32px;
          padding: 20px;
          background: #2a2a2a;
          border-radius: 12px;
          white-space: pre-wrap;
          line-height: 1.5;
        }
        .code {
          font-size: 2.4em;
          font-weight: bold;
          color: #25D366;
          letter-spacing: 8px;
          text-align: center;
          margin: 16px 0;
        }
        .warning {
          color: #ff9800;
          font-size: 0.95em;
          margin-top: 16px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Sierra MD</h1>
        <p class="subtitle">Generate WhatsApp Pairing Code</p>

        <form id="pairForm">
          <label for="phone">Phone Number (international, no +)</label>
          <input
            type="tel"
            id="phone"
            placeholder="254712345678"
            pattern="[0-9]{9,15}"
            required
            title="Enter phone number without + or spaces"
          />
          <button type="submit">Get Pairing Code</button>
        </form>

        <div id="result"></div>
      </div>

      <script>
        const form = document.getElementById('pairForm');
        const result = document.getElementById('result');

        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const phone = document.getElementById('phone').value.trim();

          if (!phone.match(/^[0-9]{9,15}$/)) {
            result.innerHTML = '<p style="color:#f44336;">Invalid number format.</p>';
            return;
          }

          result.innerHTML = '<p>Generating code... please wait.</p>';

          try {
            const response = await fetch('/api/pair', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ phone })
            });

            const data = await response.json();

            if (data.error) {
              result.innerHTML = `<p style="color:#f44336;">Error: ${data.error}</p>`;
            } else {
              result.innerHTML = `
                <p><strong>Pairing Code (8 digits):</strong></p>
                <div class="code">${data.code}</div>
                <p>Open WhatsApp on your phone:</p>
                <ol>
                  <li>Settings → Linked Devices</li>
                  <li>Link with phone number</li>
                  <li>Enter the code above</li>
                </ol>
                <p class="warning">Code expires soon — use it immediately!</p>
              `;
            }
          } catch (err) {
            result.innerHTML = '<p style="color:#f44336;">Connection error. Try again.</p>';
          }
        });
      </script>
    </body>
    </html>
  `);
});

// API to generate pairing code
app.post('/api/pair', async (req, res) => {
  const { phone } = req.body;

  if (!phone || !/^\d{9,15}$/.test(phone)) {
    return res.status(400).json({ error: 'Invalid phone number format (9–15 digits, no +)' });
  }

  try {
    // Temporary folder for pairing attempt
    const sessionPath = path.join(__dirname, 'temp_pair_auth');
    await fs.mkdir(sessionPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    const sock = makeWASocket({
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['Sierra Pairing', 'Chrome', '126.0'],
      auth: state
    });

    sock.ev.on('creds.update', saveCreds);

    // Request pairing code
    const code = await sock.requestPairingCode(phone);

    // Clean up (optional — you can keep if you want to auto-connect later)
    sock.end();
    // await fs.rm(sessionPath, { recursive: true, force: true }).catch(() => {});

    res.json({ code });
  } catch (err) {
    console.error('Pairing error:', err);
    let msg = 'Failed to generate code';
    if (err.message.includes('rate-overlimit')) msg = 'Rate limit reached — try again later';
    if (err.message.includes('already paired')) msg = 'This number is already linked';
    res.status(500).json({ error: msg });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Pairing server running on port ${port}`);
});
