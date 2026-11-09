
const express = require('express');
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const TEMP_DIR = path.join(__dirname, 'temp');
const TOKEN_TTL = 5 * 60 * 1000;
const SESSION_TTL = 10 * 60 * 1000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Temporary in-memory session records.
// Download tokens expire and can only be used once.
const sessions = new Map();
const downloads = new Map();

app.get('/', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sierra Pair</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #101820;
      color: white;
      font-family: Arial, sans-serif;
    }
    main {
      width: min(90%, 420px);
      padding: 28px;
      box-sizing: border-box;
      background: #1c2935;
      border-radius: 16px;
    }
    input, button {
      width: 100%;
      box-sizing: border-box;
      padding: 13px;
      margin-top: 12px;
      border: 0;
      border-radius: 8px;
      font-size: 16px;
    }
    button {
      background: #16a085;
      color: white;
      cursor: pointer;
    }
    button:disabled {
      opacity: .5;
      cursor: not-allowed;
    }
    #result {
      margin-top: 20px;
      overflow-wrap: anywhere;
      line-height: 1.6;
    }
    .code {
      font-size: 25px;
      letter-spacing: 4px;
      font-weight: bold;
    }
  </style>
</head>
<body>
  <main>
    <h2>Sierra Pair</h2>
    <p>Enter your WhatsApp number with country code, without the + sign.</p>
    <form id="pairForm">
      <input id="phone" placeholder="Example: 254712345678"
        inputmode="numeric" required>
      <button id="submit" type="submit">Get Pairing Code</button>
    </form>
    <div id="result"></div>
  </main>

  <script>
    const form = document.getElementById('pairForm');
    const result = document.getElementById('result');
    const submit = document.getElementById('submit');

    form.addEventListener('submit', async (event) => {
      event.preventDefault();

      const phone = document.getElementById('phone').value.trim();
      result.textContent = 'Requesting pairing code...';
      submit.disabled = true;

      try {
        const response = await fetch('/api/pair', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone })
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Pairing request failed');
        }

        result.innerHTML =
          '<p>Your pairing code:</p><div class="code"></div>' +
          '<p>Enter this code in WhatsApp linked devices.</p>' +
          '<p id="status">Waiting for WhatsApp connection...</p>';

        result.querySelector('.code').textContent = data.code;

        const status = document.getElementById('status');

        const poll = async () => {
          try {
            const check = await fetch(
              '/api/check?session=' + encodeURIComponent(data.sessionId)
            );
            const state = await check.json();

            if (state.status === 'complete') {
              status.textContent = 'Your session is ready.';

              const link = document.createElement('a');
              link.href = state.downloadUrl;
              link.textContent = 'Download complete session';
              link.style.color = '#5eead4';
              link.style.display = 'block';
              link.style.marginTop = '12px';
              result.appendChild(link);
              return;
            }

            if (state.status === 'failed' || state.status === 'expired') {
              status.textContent = state.message || 'Pairing failed or expired.';
              submit.disabled = false;
              return;
            }

            status.textContent = 'Waiting for WhatsApp connection...';
            setTimeout(poll, 2000);
          } catch (error) {
            status.textContent = 'Could not check session status. Please retry.';
            submit.disabled = false;
          }
        };

        poll();
      } catch (error) {
        result.textContent = error.message;
        submit.disabled = false;
      }
    });
  </script>
</body>
</html>`);
});

// Read every JSON auth file and preserve its original filename.
async function exportAuthFiles(sessionPath) {
  const entries = await fs.readdir(sessionPath, {
    withFileTypes: true
  });

  const files = {};

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;

    const filePath = path.join(sessionPath, entry.name);
    const contents = await fs.readFile(filePath, 'utf8');

    // Validate JSON before including it in the export.
    files[entry.name] = JSON.parse(contents);
  }

  if (!files['creds.json']) {
    throw new Error('Authentication credentials were not found.');
  }

  if (Object.keys(files).length < 2) {
    throw new Error(
      'The session contains credentials but no additional auth key files.'
    );
  }

  return {
    version: 1,
    format: 'sierra-baileys-multifile-auth',
    files
  };
}

async function removeSessionDirectory(sessionPath) {
  await fs.rm(sessionPath, {
    recursive: true,
    force: true
  }).catch(() => {});
}

function expireDownload(token) {
  const record = downloads.get(token);
  if (!record) return;

  if (Date.now() >= record.expiresAt) {
    downloads.delete(token);
  }
}

// Create a pairing session.
app.post('/api/pair', async (req, res) => {
  const phone = String(req.body.phone || '').replace(/\D/g, '');

  if (!/^[1-9][0-9]{7,14}$/.test(phone)) {
    return res.status(400).json({
      error: 'Enter a valid phone number with country code.'
    });
  }

  const sessionId = crypto.randomUUID();
  const sessionPath = path.join(TEMP_DIR, sessionId);

  let sock;

  try {
    await fs.mkdir(sessionPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    sock = makeWASocket({
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['Sierra MD', 'Chrome', '1.0.0'],
      auth: state
    });

    let saveQueue = Promise.resolve();
    let completed = false;

    // Serialize credential writes so exports don't race pending saves.
    sock.ev.on('creds.update', () => {
      saveQueue = saveQueue.then(() => saveCreds());
      saveQueue.catch((error) => {
        console.error('Credential save failed:', error.message);
      });
    });

    sessions.set(sessionId, {
      status: 'waiting',
      createdAt: Date.now()
    });

    sock.ev.on('connection.update', async (update) => {
      if (update.connection === 'open' && !completed) {
        completed = true;

        try {
          // Wait for pending credential writes before reading the files.
          await saveQueue;
          await saveCreds();

          const bundle = await exportAuthFiles(sessionPath);
          const encodedBundle = Buffer
            .from(JSON.stringify(bundle))
            .toString('base64');

          const token = crypto.randomBytes(32).toString('hex');

          downloads.set(token, {
            data: encodedBundle,
            expiresAt: Date.now() + TOKEN_TTL
          });

          sessions.set(sessionId, {
            status: 'complete',
            downloadUrl: `/api/session/${token}`,
            createdAt: Date.now()
          });

          console.log(`Session export ready: ${sessionId}`);
        } catch (error) {
          console.error('Session export failed:', error.message);

          sessions.set(sessionId, {
            status: 'failed',
            message: 'Session export failed. Please generate a new session.',
            createdAt: Date.now()
          });
        } finally {
          try {
            sock.end();
          } catch (_) {}

          await removeSessionDirectory(sessionPath);
        }
      }

      if (update.connection === 'close' && !completed) {
        const statusCode =
          update.lastDisconnect?.error?.output?.statusCode;

        if (statusCode === DisconnectReason.loggedOut) {
          sessions.set(sessionId, {
            status: 'failed',
            message: 'WhatsApp logged out before pairing completed.',
            createdAt: Date.now()
          });
        }
      }
    });

    const code = await sock.requestPairingCode(phone);

    return res.json({
      code,
      sessionId
    });
  } catch (error) {
    console.error('Pairing error:', error.message);

    if (sock) {
      try {
        sock.end();
      } catch (_) {}
    }

    await removeSessionDirectory(sessionPath);
    sessions.delete(sessionId);

    return res.status(500).json({
      error: 'Could not create pairing code. Please try again.'
    });
  }
});

// Check whether the complete session export is ready.
app.get('/api/check', (req, res) => {
  const sessionId = String(req.query.session || '');
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({
      status: 'expired',
      message: 'Session not found or expired.'
    });
  }

  if (Date.now() - session.createdAt > SESSION_TTL) {
    sessions.delete(sessionId);

    return res.status(410).json({
      status: 'expired',
      message: 'Session expired. Please pair again.'
    });
  }

  return res.json({
    status: session.status,
    downloadUrl: session.downloadUrl,
    message: session.message
  });
});

// One-time download of the complete authentication bundle.
app.get('/api/session/:token', (req, res) => {
  const token = req.params.token;
  expireDownload(token);

  const record = downloads.get(token);

  if (!record) {
    return res.status(404).send('Download expired or already used.');
  }

  // Consume token before sending the response.
  downloads.delete(token);

  res.setHeader(
    'Content-Disposition',
    'attachment; filename="sierra-session.txt"'
  );
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, private');

  return res.send(record.data);
});

// Remove expired session records and download tokens.
setInterval(() => {
  const now = Date.now();

  for (const [id, session] of sessions.entries()) {
    if (now - session.createdAt > SESSION_TTL) {
      sessions.delete(id);
    }
  }

  for (const [token, record] of downloads.entries()) {
    if (now >= record.expiresAt) {
      downloads.delete(token);
    }
  }
}, 60 * 1000).unref();

app.listen(PORT, '0.0.0.0', async () => {
  await fs.mkdir(TEMP_DIR, { recursive: true });
  console.log(`Sierra Pair running on port ${PORT}`);
});
