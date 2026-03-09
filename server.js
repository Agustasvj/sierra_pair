const express = require('express');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const pn = require('awesome-phonenumber');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Pastebin API key from env
const PASTEBIN_API_KEY = process.env.PASTEBIN_API_KEY || '';

const MESSAGE = `
*SESSION GENERATED SUCCESSFULLY* ✅

*Gɪᴠᴇ ᴀ ꜱᴛᴀʀ ᴛᴏ ʀᴇᴘᴏ ꜰᴏʀ ᴄᴏᴜʀᴀɢᴇ* 🌟
https://github.com/GlobalTechInfo/MEGA-MD

*Sᴜᴘᴘᴏʀᴛ Gʀᴏᴜᴘ ꜰᴏʀ ϙᴜᴇʀʏ* 💭
https://t.me/Global_TechInfo
https://whatsapp.com/channel/0029VagJIAr3bbVBCpEkAM07

*Yᴏᴜ-ᴛᴜʙᴇ ᴛᴜᴛᴏʀɪᴀʟꜱ* 🪄 
https://youtube.com/@GlobalTechInfo

*MEGA-MD--WHATSAPP* 🥀
`;

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
  } catch (error) {
    console.error('Pastebin upload failed:', error);
    throw error;
  }
}

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Sierra MD Pairing</title>
      <style>
        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
        input { padding: 10px; font-size: 16px; width: 300px; margin: 10px 0; }
        button { padding: 10px 20px; font-size: 16px; }
        #result { margin-top: 20px; font-size: 18px; word-break: break-all; }
      </style>
    </head>
    <body>
      <h1>Sierra MD Pairing Code</h1>
      <p>Enter your phone number (e.g. 254712345678)</p>
      <input type="text" id="phone" placeholder="254712345678">
      <button onclick="generateCode()">Generate Code</button>
      <div id="result"></div>

      <script>
        async function generateCode() {
          const phone = document.getElementById('phone').value.trim();
          const result = document.getElementById('result');
          result.innerHTML = 'Generating...';

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
              'Waiting for pairing...';

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

// Start pairing
app.post('/api/pair', async (req, res) => {
  const { phone } = req.body;
  const phoneNum = pn('+' + phone);
  if (!phoneNum.isValid()) {
    return res.status(400).json({ error: 'Invalid phone number' });
  }

  const cleanPhone = phoneNum.getNumber('e164').replace('+', '');

  const sessionId = Date.now().toString() + Math.random().toString(36).substring(2, 9);
  const sessionPath = path.join(__dirname, 'temp', `session_${sessionId}`);

  try {
    await fs.mkdir(sessionPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    const sock = makeWASocket({
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['Sierra MD', 'Chrome', '120.0'],
      auth: state
    });

    sock.ev.on('creds.update', saveCreds);

    const code = await sock.requestPairingCode(cleanPhone);

    res.json({ code: code.match(/.{1,4}/g)?.join('-') || code, sessionId });

    // Wait for pairing completion
    sock.ev.on('connection.update', async (update) => {
      const { connection } = update;
      if (connection === 'open') {
        try {
          const credsJson = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf-8');
          const pasteUrl = await uploadToPastebin(credsJson);

          const userJid = sock.user.id;
          await sock.sendMessage(userJid, { text: MESSAGE + pasteUrl });

          console.log('SESSION_ID sent to DM:', pasteUrl);
        } catch (e) {
          console.error('Error sending SESSION_ID:', e);
        } finally {
          sock.end();
          await fs.rm(sessionPath, { recursive: true, force: true });
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

// Check if pairing complete (for polling, if needed)
app.get('/api/check', async (req, res) => {
  const { session } = req.query;
  if (!session) return res.status(400).json({ error: 'Missing session' });

  const sessionPath = path.join(__dirname, 'temp', `session_${session}`);
  const credsPath = path.join(sessionPath, 'creds.json');

  if (await fs.access(credsPath).then(() => true).catch(() => false)) {
    res.json({ status: 'complete' });
  } else {
    res.json({ status: 'waiting' });
  }
});

app.listen(port, () => console.log(`Server on port ${port}`));
