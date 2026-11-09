
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
const SESSION_TTL = 10 * 60 * 1000;
const DOWNLOAD_TTL = 5 * 60 * 1000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sessions = new Map();
const downloads = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

app.get('/', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sierra Pair</title>
<style>
* { box-sizing: border-box; }
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
  background: #1c2935;
  border-radius: 16px;
}
input, button {
  width: 100%;
  padding: 14px;
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
button:disabled { opacity: .5; }
#result { margin-top: 20px; overflow-wrap: anywhere; }
.code {
  font-size: 26px;
  font-weight: bold;
  letter-spacing: 4px;
}
a { color: #5eead4; }
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

  const phone = document.getElementById('phone').value
    .replace(/\\D/g, '');

  result.textContent = 'Starting pairing...';
  submit.disabled = true;

  try {
    // This request returns immediately with a session ID.
    const response = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Could not start pairing.');
    }

    result.innerHTML = \`
      <p id="status">Connecting to WhatsApp...</p>
      <div class="code" id="code"></div>
      <p id="instructions"></p>
      <div id="download"></div>
    \`;

    const status = document.getElementById('status');
    const codeBox = document.getElementById('code');
    const instructions = document.getElementById('instructions');
    const download = document.getElementById('download');

    let shownCode = false;
    let finished = false;

    const poll = async () => {
      if (finished) return;

      try {
        const check = await fetch(
          '/api/check?session=' + encodeURIComponent(data.sessionId)
        );

        const state = await check.json();

        if (state.code && !shownCode) {
          shownCode = true;
          codeBox.textContent = state.code;
          instructions.textContent =
            'On WhatsApp, open Linked Devices and choose Link with phone number instead.';
        }

        if (state.status === 'complete') {
          finished = true;
          status.textContent = 'Session export is ready.';

          const link = document.createElement('a');
          link.href = state.downloadUrl;
          link.textContent = 'Download complete session';
          download.appendChild(link);

          submit.disabled = false;
          return;
        }

        if (state.status === 'failed' || state.status === 'expired') {
          finished = true;
          status.textContent = state.message || 'Pairing failed.';
          submit.disabled = false;
          return;
        }

        if (state.status === 'pairing') {
          status.textContent = 'Pairing code generated. Link your device.';
        } else if (state.status === 'connected') {
          status.textContent = 'WhatsApp connected. Preparing session...';
        } else {
          status.textContent = 'Waiting for pairing code...';
        }

        setTimeout(poll, 2000);
      } catch (error) {
        status.textContent = 'Checking pairing status...';
        setTimeout(poll, 3000);
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

async function removeSessionDirectory(directory) {
  await fs.rm(directory, {
    recursive: true,
    force: true
  }).catch(() => {});
}

async function exportAuthFiles(sessionPath) {
  const entries = await fs.readdir(sessionPath, {
    withFileTypes: true
  });

  const files = {};

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }

    const content = await fs.readFile(
      path.join(sessionPath, entry.name),
      'utf8'
    );

    files[entry.name] = JSON.parse(content);
  }

  if (!files['creds.json']) {
    throw new Error('Authentication credentials are missing.');
  }

  if (Object.keys(files).length < 2) {
    throw new Error('Additional authentication key files are missing.');
  }

  return {
    version: 1,
    format: 'sierra-baileys-multifile-auth',
    files
  };
}

// Runs independently of the browser's HTTP request.
async function startPairing(sessionId, phone) {
  const sessionPath = path.join(TEMP_DIR, sessionId);
  let sock;
  let completed = false;
  let saveQueue = Promise.resolve();

  try {
    await fs.mkdir(sessionPath, { recursive: true });

    const { state, saveCreds } =
      await useMultiFileAuthState(sessionPath);

    sock = makeWASocket({
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['MyApp', 'Ubuntu', 'Chrome'],
      auth: state,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000
    });

    sock.ev.on('creds.update', () => {
      saveQueue = saveQueue
        .then(() => saveCreds())
        .catch(error => {
          console.error('Credential save error:', error.message);
        });
    });

    sock.ev.on('connection.update', async update => {
      if (update.connection === 'open' && !completed) {
        completed = true;

        sessions.set(sessionId, {
          ...sessions.get(sessionId),
          status: 'connected'
        });

        try {
          await saveQueue;
          await saveCreds();
          await sleep(1500);

          const bundle = await exportAuthFiles(sessionPath);
          const token = crypto.randomBytes(32).toString('hex');

          downloads.set(token, {
            data: Buffer.from(JSON.stringify(bundle)).toString('base64'),
            expiresAt: Date.now() + DOWNLOAD_TTL
          });

          sessions.set(sessionId, {
            status: 'complete',
            code: sessions.get(sessionId)?.code,
            downloadUrl: '/api/session/' + token,
            createdAt: Date.now()
          });

          console.log(
            'Session exported:',
            sessionId,
            'Files:',
            Object.keys(bundle.files).length
          );
        } catch (error) {
          console.error('Export failed:', error);

          sessions.set(sessionId, {
            status: 'failed',
            message: 'Could not export complete authentication files.',
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

        console.error(
          'WhatsApp connection closed:',
          statusCode || 'unknown'
        );

        if (statusCode === DisconnectReason.loggedOut) {
          sessions.set(sessionId, {
            status: 'failed',
            message: 'WhatsApp logged out during pairing.',
            createdAt: Date.now()
          });
        }
      }
    });

    // Generate the pairing code in the background.
    const code = await sock.requestPairingCode(phone);

    sessions.set(sessionId, {
      status: 'pairing',
      code,
      createdAt: Date.now()
    });

    console.log('Pairing code generated for session:', sessionId);
  } catch (error) {
    console.error('Pairing startup failed:', error);

    sessions.set(sessionId, {
      status: 'failed',
      message: 'Pairing could not be started. Check Heroku logs.',
      createdAt: Date.now()
    });

    if (sock) {
      try {
        sock.end();
      } catch (_) {}
    }

    await removeSessionDirectory(sessionPath);
  }
}

// Start pairing and respond immediately.
app.post('/api/pair', (req, res) => {
  const phone = String(req.body.phone || '').replace(/\D/g, '');

  if (!/^[1-9][0-9]{7,14}$/.test(phone)) {
    return res.status(400).json({
      error: 'Enter a valid international phone number.'
    });
  }

  const sessionId = crypto.randomUUID();

  sessions.set(sessionId, {
    status: 'waiting',
    createdAt: Date.now()
  });

  // Do not await this operation.
  startPairing(sessionId, phone).catch(error => {
    console.error('Background pairing error:', error);
  });

  return res.status(202).json({ sessionId });
});

// Browser polls this endpoint for the pairing code and export.
app.get('/api/check', (req, res) => {
  const sessionId = String(req.query.session || '');
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({
      status: 'expired',
      message: 'Session not found.'
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
    code: session.code,
    downloadUrl: session.downloadUrl,
    message: session.message
  });
});

// One-time session download.
app.get('/api/session/:token', (req, res) => {
  const token = req.params.token;
  const record = downloads.get(token);

  if (!record || Date.now() >= record.expiresAt) {
    downloads.delete(token);
    return res.status(404).send('Download expired or already used.');
  }

  downloads.delete(token);

  res.setHeader(
    'Content-Disposition',
    'attachment; filename="sierra-session.txt"'
  );
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, private');

  return res.send(record.data);
});

// Expire temporary records.
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
  console.log('Sierra Pair running on port ' + PORT);
});
