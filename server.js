
const express = require('express');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestWaWebVersion
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

const sessions = new Map();
const downloads = new Map();

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
    #result {
      margin-top: 20px;
      overflow-wrap: anywhere;
      line-height: 1.6;
    }
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
      <input
        id="phone"
        placeholder="Example: 254712345678"
        inputmode="numeric"
        required
      >
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

    result.innerHTML = \`
      <p>Your pairing code:</p>
      <div class="code"></div>
      <p>Enter this code in WhatsApp Linked Devices.</p>
      <p id="status">Waiting for WhatsApp connection...</p>
    \`;

    result.querySelector('.code').textContent = data.code;

    const status = document.getElementById('status');

    const poll = async () => {
      try {
        const response = await fetch(
          '/api/check?session=' + encodeURIComponent(data.sessionId)
        );

        const state = await response.json();

        if (state.status === 'complete') {
          status.textContent = 'Your complete session is ready.';

          const link = document.createElement('a');
          link.href = state.downloadUrl;
          link.textContent = 'Download complete session';
          link.style.display = 'block';
          link.style.marginTop = '12px';

          result.appendChild(link);
          submit.disabled = false;
          return;
        }

        if (['failed', 'expired'].includes(state.status)) {
          status.textContent = state.message || 'Pairing failed or expired.';
          submit.disabled = false;
          return;
        }

        status.textContent = 'Waiting for WhatsApp connection...';
        setTimeout(poll, 2000);
      } catch (error) {
        status.textContent = 'Unable to check pairing status.';
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

// Export every Baileys auth file without changing filenames.
async function exportAuthFiles(sessionPath) {
  const entries = await fs.readdir(sessionPath, {
    withFileTypes: true
  });

  const files = {};

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }

    const filePath = path.join(sessionPath, entry.name);
    const content = await fs.readFile(filePath, 'utf8');

    files[entry.name] = JSON.parse(content);
  }

  if (!files['creds.json']) {
    throw new Error('creds.json was not found.');
  }

  if (Object.keys(files).length < 2) {
    throw new Error(
      'No additional authentication key files were found.'
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

// Create a new pairing session.
app.post('/api/pair', async (req, res) => {
  const phone = String(req.body.phone || '').replace(/\D/g, '');

  if (!/^[1-9][0-9]{7,14}$/.test(phone)) {
    return res.status(400).json({
      error: 'Enter a valid international phone number.'
    });
  }

  const sessionId = crypto.randomUUID();
  const sessionPath = path.join(TEMP_DIR, sessionId);

  let sock;
  let completed = false;

  try {
    await fs.mkdir(sessionPath, { recursive: true });

    const { state, saveCreds } =
      await useMultiFileAuthState(sessionPath);

    let waVersion;

    try {
      const result = await fetchLatestWaWebVersion();
      waVersion = result.version;
    } catch (error) {
      console.warn(
        'Could not fetch latest WhatsApp version:',
        error.message
      );
    }

    const socketOptions = {
      logger: pino({ level: 'silent' }),
      browser: ['MyApp', 'Ubuntu', 'Chrome'],
      printQRInTerminal: false,
      auth: state,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000
    };

    if (waVersion) {
      socketOptions.version = waVersion;
    }

    sock = makeWASocket(socketOptions);

    sessions.set(sessionId, {
      status: 'waiting',
      createdAt: Date.now()
    });

    // Persist credential updates.
    sock.ev.on('creds.update', () => {
      saveCreds().catch(error => {
        console.error('Could not save credentials:', error.message);
      });
    });

    // Listen for connection events.
    sock.ev.on('connection.update', async (update) => {
      if (update.connection === 'open' && !completed) {
        completed = true;

        try {
          // Allow asynchronous auth-file writes to finish.
          await saveCreds();
          await sleep(1500);

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
            downloadUrl: '/api/session/' + token,
            createdAt: Date.now()
          });

          console.log(
            'Complete authentication bundle created for session:',
            sessionId
          );
          console.log(
            'Authentication files exported:',
            Object.keys(bundle.files).length
          );
        } catch (error) {
          console.error('Session export failed:', error);

          sessions.set(sessionId, {
            status: 'failed',
            message: 'Could not export the complete session.',
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
          'Pairing connection closed. Status:',
          statusCode || 'unknown'
        );

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

    console.log('Pairing code requested for:', phone);

    return res.json({
      code,
      sessionId
    });
  } catch (error) {
    console.error('Pairing error:', error);

    if (sock) {
      try {
        sock.end();
      } catch (_) {}
    }

    await removeSessionDirectory(sessionPath);
    sessions.delete(sessionId);

    return res.status(500).json({
      error: 'Could not generate pairing code. Please try again.'
    });
  }
});

// Check pairing and export status.
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

// Download the complete auth bundle once.
app.get('/api/session/:token', (req, res) => {
  const token = req.params.token;
  const record = downloads.get(token);

  if (!record || Date.now() >= record.expiresAt) {
    downloads.delete(token);

    return res.status(404).send(
      'Download expired or has already been used.'
    );
  }

  // One-time token: consume before sending.
  downloads.delete(token);

  res.setHeader(
    'Content-Disposition',
    'attachment; filename="sierra-session.txt"'
  );
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, private');

  return res.send(record.data);
});

// Clean up expired records.
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
