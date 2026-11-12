const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns/promises');
const tls = require('node:tls');
const { URL } = require('node:url');
const { initDatabase, db, calculateDistanceKm } = require('./db.js');

// Load .env variables if present
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const match = trimmed.match(/^([\w.-]+)\s*=\s*(.*)?$/);
        if (match) {
          const key = match[1].trim();
          let val = (match[2] || '').trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          process.env[key] = val;
        }
      }
    } catch(e){}
  }
}
loadEnv();

// Ensure DB is initialized
initDatabase();

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// MIME types for static assets
const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// In-memory session cache backed by persistent SQLite sessions table
const sessions = new Map();

function saveSession(token, userId) {
  sessions.set(token, userId);
  try {
    db.prepare('INSERT OR REPLACE INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
  } catch(e){}
}

function getUserIdFromSession(token) {
  if (!token) return null;
  if (sessions.has(token)) return sessions.get(token);
  try {
    const row = db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token);
    if (row) {
      sessions.set(token, row.user_id);
      return row.user_id;
    }
  } catch(e){}
  return null;
}

// ---------------- OTP & EMAIL VERIFICATION SYSTEM ----------------
// In-memory OTP storage with 10-minute expiry
const pendingRegistrations = new Map(); // email -> { otp, expiresAt, data }
const passwordResetOtps = new Map();   // email -> { otp, expiresAt, userId }

// Disposable / dummy email domains blacklist
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  'dummy.com', 'fake.com', 'test.com', 'example.com', 'tempmail.com', '10minutemail.com',
  'mailinator.com', 'throwawaymail.com', 'guerrillamail.com', 'sharklasers.com',
  'yopmail.com', 'trashmail.com', 'dispostable.com', 'getairmail.com', 'mytempemail.com',
  'generator.email', 'dropmail.me', 'fakeinbox.com', 'trashmail.net', 'temp-mail.org'
]);

async function validateEmailDomain(email) {
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!regex.test(email)) {
    return { valid: false, reason: 'Please enter a valid email address format (e.g. name@gmail.com).' };
  }

  const parts = email.split('@');
  const domain = parts[1].toLowerCase().trim();

  // 1. Check blacklist of disposable/dummy domains
  if (DISPOSABLE_EMAIL_DOMAINS.has(domain)) {
    return { valid: false, reason: `Domain @${domain} is a temporary/dummy domain. Please provide a real email address.` };
  }

  // 2. Perform live DNS MX record lookup to verify real mail exchange servers exist
  try {
    const mxRecords = await dns.resolveMx(domain);
    if (!mxRecords || mxRecords.length === 0) {
      return { valid: false, reason: `Email domain @${domain} does not have valid mail exchange (MX) servers and cannot receive emails.` };
    }
  } catch (err) {
    if (err.code === 'ENOTFOUND' || err.code === 'ENODATA' || err.code === 'SERVFAIL') {
      return { valid: false, reason: `Email domain @${domain} does not exist or cannot receive mail. Please use a valid email.` };
    }
    // If local network or offline, allow standard domains (gmail.com, yahoo.com, outlook.com, hotmail.com, icloud.com, etc.)
    const wellKnownDomains = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'aol.com', 'zoho.com', 'proton.me', 'protonmail.com'];
    if (!wellKnownDomains.includes(domain) && !domain.endsWith('.edu') && !domain.endsWith('.ac.in') && !domain.endsWith('.org')) {
      return { valid: false, reason: `Could not verify mail server for @${domain}. Please check for typos.` };
    }
  }

  return { valid: true };
}

// Google Apps Script HTTPS Relay (Port 443 - uses native Gmail from your Gmail account, zero domain/IP blocks)
async function sendGoogleScriptEmail({ to, subject, html }) {
  const webhookUrl = process.env.GMAIL_WEBHOOK_URL;
  if (!webhookUrl) return { sent: false, error: 'GMAIL_WEBHOOK_URL not configured' };

  try {
    const res = await fetch(webhookUrl.trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, subject, html }),
      redirect: 'follow'
    });
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch (e) {}
    if (res.ok && (data.sent || text.includes('sent'))) {
      console.log(`[EMAIL DISPATCH] Delivered natively via Google Apps Script HTTPS Webhook`);
      return { sent: true };
    }
    return { sent: false, error: data?.error || text.slice(0, 100) };
  } catch (e) {
    return { sent: false, error: e.message };
  }
}

// Brevo HTTPS API Dispatcher (Port 443 - works on Render Free Tier to deliver real emails to ANY address)
async function sendBrevoEmail({ to, subject, html }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) return { sent: false, error: 'BREVO_API_KEY environment variable is missing on Render' };

  try {
    const senderEmail = process.env.BREVO_SENDER || process.env.SMTP_USER || 'devkate.avdhut2003@gmail.com';
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': apiKey.trim(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sender: { name: 'Fixit Platform', email: senderEmail.trim() },
        to: [{ email: to }],
        subject,
        htmlContent: html
      })
    });
    const data = await res.json();
    if (res.ok && data && (data.messageId || data.id)) {
      console.log(`[EMAIL DISPATCH] Delivered via Brevo HTTPS API (Message ID: ${data.messageId || data.id})`);
      return { sent: true };
    }
    console.warn(`[EMAIL WARNING] Brevo API error:`, data);
    return { sent: false, error: data?.message || data?.code || JSON.stringify(data) };
  } catch (e) {
    console.warn(`[EMAIL WARNING] Brevo fetch failed:`, e.message);
    return { sent: false, error: e.message };
  }
}

// HTTPS Email Dispatcher (Port 443 - works on Render Free Tier & cloud hosts where SMTP is blocked)
async function sendHttpsApiEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { sent: false };

  try {
    const fromAddr = process.env.RESEND_FROM || 'Fixit Platform <onboarding@resend.dev>';
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey.trim()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: fromAddr,
        to: [to],
        subject,
        html
      })
    });
    const data = await res.json();
    if (res.ok && data && data.id) {
      console.log(`[EMAIL DISPATCH] Delivered via Resend HTTPS API (Message ID: ${data.id})`);
      return { sent: true };
    }
    console.warn(`[EMAIL WARNING] Resend API error:`, data);
    return { sent: false, error: data?.message || 'Resend API rejected' };
  } catch (e) {
    console.warn(`[EMAIL WARNING] Resend fetch failed:`, e.message);
    return { sent: false, error: e.message };
  }
}

// Lightweight SMTP email dispatch (supports TLS 465)
async function sendSmtpEmail({ to, subject, html, text }) {
  loadEnv();
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = parseInt(process.env.SMTP_PORT || '465', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!user || !pass) {
    return {
      sent: false,
      error: 'SMTP credentials not configured. Please add your SMTP_USER and SMTP_PASS (Gmail address and 16-character Google App Password) in the .env file to deliver verification emails.'
    };
  }

  const cleanPass = pass.replace(/\s+/g, '');

  return new Promise((resolve) => {
    try {
      const socket = tls.connect(port, host, () => {
        let step = 0;
        socket.on('data', (data) => {
          const res = data.toString();
          if (step === 0 && res.startsWith('220')) {
            socket.write(`EHLO localhost\r\n`);
            step = 1;
          } else if (step === 1 && res.includes('250')) {
            socket.write('AUTH LOGIN\r\n');
            step = 2;
          } else if (step === 2 && res.startsWith('334')) {
            socket.write(Buffer.from(user).toString('base64') + '\r\n');
            step = 3;
          } else if (step === 3 && res.startsWith('334')) {
            socket.write(Buffer.from(cleanPass).toString('base64') + '\r\n');
            step = 4;
          } else if (step === 4 && res.startsWith('235')) {
            socket.write(`MAIL FROM:<${user}>\r\n`);
            step = 5;
          } else if (step === 5 && res.startsWith('250')) {
            socket.write(`RCPT TO:<${to}>\r\n`);
            step = 6;
          } else if (step === 6 && res.startsWith('250')) {
            socket.write('DATA\r\n');
            step = 7;
          } else if (step === 7 && res.startsWith('354')) {
            const dateStr = new Date().toUTCString();
            const msgId = `<${Date.now()}.${Math.random().toString(36).substring(2)}@fixit.com>`;
            const message = [
              `From: "Fixit Platform" <${user}>`,
              `To: <${to}>`,
              `Subject: ${subject}`,
              `Date: ${dateStr}`,
              `Message-ID: ${msgId}`,
              'MIME-Version: 1.0',
              'Content-Type: text/html; charset=UTF-8',
              '',
              html || text,
              '.\r\n'
            ].join('\r\n');
            socket.write(message);
            step = 8;
          } else if (step === 8 && res.startsWith('250')) {
            socket.write('QUIT\r\n');
            socket.end();
            resolve({ sent: true });
          } else if (res.startsWith('4') || res.startsWith('5')) {
            socket.end();
            resolve({ sent: false, error: res.trim() });
          }
        });
      });
      socket.setTimeout(3500, () => {
        socket.destroy();
        resolve({ sent: false, error: 'SMTP Timeout connecting to ' + host });
      });
      socket.on('error', (err) => resolve({ sent: false, error: err.message }));
    } catch (e) {
      resolve({ sent: false, error: e.message });
    }
  });
}

async function sendOtpEmail(toEmail, otp, type = 'register') {
  const isRegister = type === 'register';
  const subject = isRegister
    ? `Fixit Verification Code: ${otp}`
    : `Fixit Password Reset Code: ${otp}`;
  
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 16px; background-color: #ffffff;">
      <div style="text-align: center; margin-bottom: 20px;">
        <h2 style="color: #0f766e; margin: 0; font-size: 24px; font-weight: 800;">Fixit Platform</h2>
        <p style="color: #64748b; font-size: 13px; margin-top: 4px;">Verified Home Repair & Services</p>
      </div>
      <div style="background-color: #f0fdfa; border: 1px solid #99f6e4; border-radius: 12px; padding: 20px; text-align: center;">
        <p style="color: #0f766e; font-size: 14px; font-weight: 600; margin: 0 0 10px;">
          ${isRegister ? 'Your Email Verification Code' : 'Your Password Reset Code'}
        </p>
        <div style="font-size: 32px; font-weight: 900; letter-spacing: 6px; color: #134e4a; font-family: monospace; padding: 8px 16px; background: #ffffff; border-radius: 8px; display: inline-block; border: 1px dashed #0d9488;">
          ${otp}
        </div>
        <p style="color: #64748b; font-size: 12px; margin: 12px 0 0;">
          This code is valid for <strong>10 minutes</strong>. Do not share it with anyone.
        </p>
      </div>
      <p style="color: #94a3b8; font-size: 11px; margin-top: 20px; text-align: center;">
        If you did not request this verification code, please ignore this email.
      </p>
    </div>
  `;

  console.log(`\n==================================================`);
  console.log(`[OTP DISPATCH] Type: ${type.toUpperCase()}`);
  console.log(`To: ${toEmail}`);
  console.log(`OTP Code: >>> ${otp} <<<`);
  console.log(`Expires in: 10 minutes`);
  console.log(`==================================================\n`);

  let lastError = null;

  // 1. Try Google Apps Script HTTPS Webhook (Port 443 - uses native GmailApp from your Gmail account, zero domain/IP blocks)
  if (process.env.GMAIL_WEBHOOK_URL) {
    const googleResult = await sendGoogleScriptEmail({ to: toEmail, subject, html });
    if (googleResult.sent) return { ...googleResult, otp };
    lastError = `Google Webhook: ${googleResult.error}`;
  }

  // 2. Try Brevo HTTPS API (Port 443)
  if (process.env.BREVO_API_KEY) {
    const brevoResult = await sendBrevoEmail({ to: toEmail, subject, html });
    if (brevoResult.sent) return { ...brevoResult, otp };
    lastError = `Brevo: ${brevoResult.error}`;
  }

  // 2. Try Resend HTTPS API (Port 443)
  if (process.env.RESEND_API_KEY) {
    const httpsResult = await sendHttpsApiEmail({ to: toEmail, subject, html });
    if (httpsResult.sent) return { ...httpsResult, otp };
    lastError = `Resend: ${httpsResult.error}`;
  }

  // 3. Try SMTP TLS (Port 465 - works on localhost:3000)
  const smtpResult = await sendSmtpEmail({ to: toEmail, subject, html });
  if (smtpResult.sent) return { ...smtpResult, otp };

  return {
    sent: false,
    error: lastError || smtpResult.error || 'Outbound SMTP port blocked on host',
    otp
  };
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(c => {
    const [k, v] = c.trim().split('=');
    if (k && v) cookies[k] = decodeURIComponent(v);
  });
  return cookies;
}

function getAuthenticatedUser(req) {
  const authHeader = req.headers['authorization'];
  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else {
    const cookies = parseCookies(req.headers['cookie']);
    token = cookies['fixit_token'];
  }
  if (!token) return null;
  const userId = getUserIdFromSession(token);
  if (!userId) return null;
  const user = db.prepare('SELECT id, name, email, role, phone, address, avatar, status FROM users WHERE id = ?').get(userId);
  return user || null;
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=UTF-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
  });
  res.end(JSON.stringify(data));
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      // 10MB limit for image uploads/base64
      if (body.length > 10 * 1024 * 1024) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

// Robust static file resolver: checks ./public subfolder and repository root
function resolveStaticFile(relPath) {
  const cleanPath = relPath.replace(/^[\/\\]+/, '');
  const candidates = [
    path.join(__dirname, 'public', cleanPath),
    path.join(__dirname, 'Public', cleanPath),
    path.join(__dirname, cleanPath)
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) {
        return c;
      }
    } catch (e) {}
  }
  return null;
}

function serveStatic(req, res, pathname) {
  let safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
  if (safePath === '/' || safePath === '\\') {
    safePath = 'index.html';
  } else if (safePath.startsWith('/') || safePath.startsWith('\\')) {
    safePath = safePath.slice(1);
  }

  // 1. Try to find the requested file in ./public or root
  let targetFile = resolveStaticFile(safePath);

  // 2. If no extension, try .html
  if (!targetFile && !path.extname(safePath)) {
    targetFile = resolveStaticFile(safePath + '.html');
  }

  // 3. Fallback to index.html for Single Page App client-side routing
  if (!targetFile) {
    targetFile = resolveStaticFile('index.html');
  }

  if (!targetFile) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  const ext = path.extname(targetFile).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache'
  });
  fs.createReadStream(targetFile).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  // Handle preflight CORS
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
    });
    res.end();
    return;
  }

  // API Routes
  if (pathname.startsWith('/api/')) {
    try {
      // ---------------- AUTH ROUTES ----------------
      if (pathname === '/api/auth/login' && method === 'POST') {
        const { email, password } = await readBody(req);
        if (!email || !password) return sendError(res, 400, 'Email and password required');
        const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)').get(email);
        if (!user || user.password !== password) {
          return sendError(res, 401, 'Invalid email or password');
        }
        if (user.status === 'suspended') {
          return sendError(res, 403, 'Account is suspended. Please contact administrator.');
        }

        let existingSession = db.prepare('SELECT token FROM sessions WHERE user_id = ? ORDER BY rowid DESC LIMIT 1').get(user.id);
        let token = existingSession ? existingSession.token : null;
        if (!token) {
          token = 'tok_sync_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
          saveSession(token, user.id);
        }

        let providerData = null;
        if (user.role === 'provider') {
          providerData = db.prepare('SELECT * FROM providers WHERE user_id = ?').get(user.id);
        }

        const { password: _, ...safeUser } = user;
        return sendJson(res, 200, {
          user: safeUser,
          provider: providerData,
          token
        });
      }

      // ---------------- REGISTRATION WITH REAL EMAIL OTP VERIFICATION ----------------
      // Step 1: Initiate registration, validate domain MX records (filter out dummy emails), and send 6-digit OTP
      if (pathname === '/api/auth/register-request' && method === 'POST') {
        const body = await readBody(req);
        const { name, email, password, role, phone, address, district, state, category_id, custom_trade, skills, hourly_rate, bio } = body;
        
        if (!name || !name.trim()) return sendError(res, 400, 'Full name is required');
        if (!email || !email.trim()) return sendError(res, 400, 'Email address is required');
        if (!password || password.length < 6) return sendError(res, 400, 'Password must be at least 6 characters long');

        const cleanEmail = email.toLowerCase().trim();

        // 1. Check if user is already registered in fixit.db
        const existing = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').get(cleanEmail);
        if (existing) {
          return sendError(res, 409, 'An account with this email address already exists. Please sign in instead.');
        }

        // 2. Validate email domain (Check format, blacklist disposable domains, and verify live DNS MX records)
        const domainCheck = await validateEmailDomain(cleanEmail);
        if (!domainCheck.valid) {
          return sendError(res, 400, domainCheck.reason);
        }

        // 3. Generate 6-digit OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

        // 4. Save to pending registrations map
        pendingRegistrations.set(cleanEmail, {
          otp,
          expiresAt,
          data: {
            name: name.trim(),
            email: cleanEmail,
            password,
            role: ['customer', 'provider'].includes(role) ? role : 'customer',
            phone: phone || '',
            address: address || district || 'Pune, Maharashtra',
            district: (district || address || 'Pune, Maharashtra').trim(),
            state: state || ((district || '').includes(',') ? district.split(',').pop().trim() : 'Maharashtra'),
            category_id: category_id ? Number(category_id) : 8,
            custom_trade: custom_trade || '',
            skills: skills || '',
            hourly_rate: Number(hourly_rate) || 499.0,
            bio: bio || ''
          }
        });

        // 5. Send OTP via email
        const emailResult = await sendOtpEmail(cleanEmail, otp, 'register');
        if (!emailResult.sent) {
          console.warn(`[OTP WARNING] Email delivery unavailable on host (${emailResult.error}). Registration kept active in memory.`);
        }

        return sendJson(res, 200, {
          success: true,
          emailDeliveryFailed: !emailResult.sent,
          emailError: !emailResult.sent ? (emailResult.error || 'Email dispatch failed') : null,
          message: emailResult.sent
            ? `A 6-digit verification code has been dispatched to ${cleanEmail}. Please check your email inbox and spam folder.`
            : `Email delivery issue: ${emailResult.error || 'Cloud email unavailable'}.`,
          email: cleanEmail
        });
      }

      // Step 2: Verify Registration OTP and create user in fixit.db
      if (pathname === '/api/auth/verify-register' && method === 'POST') {
        const { email, otp } = await readBody(req);
        if (!email || !otp) return sendError(res, 400, 'Email and 6-digit OTP are required');

        const cleanEmail = email.toLowerCase().trim();
        const pending = pendingRegistrations.get(cleanEmail);

        if (!pending) {
          return sendError(res, 400, 'No pending registration found for this email. Please register again.');
        }

        if (Date.now() > pending.expiresAt) {
          pendingRegistrations.delete(cleanEmail);
          return sendError(res, 400, 'Verification code has expired. Please register again to request a new code.');
        }

        if (pending.otp !== String(otp).trim()) {
          return sendError(res, 400, 'Invalid verification code. Please check your email and try again.');
        }

        // OTP is correct! Create user in fixit.db
        const reg = pending.data;
        const defaultAvatar = `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(reg.name)}`;

        const userInsert = db.prepare(`
          INSERT INTO users (name, email, password, role, phone, address, avatar, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
        `).run(reg.name, reg.email, reg.password, reg.role, reg.phone, reg.address, defaultAvatar);

        const newUserId = Number(userInsert.lastInsertRowid);
        let providerData = null;

        if (reg.role === 'provider') {
          let skillsArray = Array.isArray(reg.skills)
            ? reg.skills
            : (reg.skills ? reg.skills.split(',').map(s => s.trim()).filter(Boolean) : []);

          if (reg.custom_trade && reg.custom_trade.trim()) {
            const cleanTrade = reg.custom_trade.trim();
            if (!skillsArray.includes(cleanTrade)) skillsArray.unshift(cleanTrade);
          }
          if (skillsArray.length === 0) skillsArray = ['General Repairs'];

          const skillsJson = JSON.stringify(skillsArray);
          const initialBio = reg.bio || (reg.custom_trade ? `Specialist in ${reg.custom_trade.trim()} services and general repairs.` : `${reg.name} is a verified home repair specialist.`);

          const pInsert = db.prepare(`
            INSERT INTO providers (user_id, category_id, skills, hourly_rate, bio, verification_status, is_available, district, state)
            VALUES (?, ?, ?, ?, ?, 'approved', 1, ?, ?)
          `).run(newUserId, reg.category_id, skillsJson, reg.hourly_rate, initialBio, reg.district, reg.state);

          providerData = db.prepare('SELECT * FROM providers WHERE id = ?').get(pInsert.lastInsertRowid);

          // Admin notification
          db.prepare(`
            INSERT INTO notifications (user_id, title, message, type)
            VALUES (1, 'New Verified Provider', ?, 'warning')
          `).run(`New provider ${reg.name} verified email and registered for ${reg.district}.`);
        }

        // Clean up pending registration
        pendingRegistrations.delete(cleanEmail);

        // Generate session token
        const token = 'tok_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
        saveSession(token, newUserId);

        const safeUser = db.prepare('SELECT id, name, email, role, phone, address, avatar, status FROM users WHERE id = ?').get(newUserId);
        return sendJson(res, 201, {
          success: true,
          message: 'Email verified successfully! Your account is now active.',
          user: safeUser,
          provider: providerData,
          token
        });
      }

      // Resend Registration OTP
      if (pathname === '/api/auth/resend-register-otp' && method === 'POST') {
        const { email } = await readBody(req);
        if (!email) return sendError(res, 400, 'Email address is required');

        const cleanEmail = email.toLowerCase().trim();
        const pending = pendingRegistrations.get(cleanEmail);

        if (!pending) {
          return sendError(res, 400, 'No pending registration found for this email.');
        }

        const freshOtp = Math.floor(100000 + Math.random() * 900000).toString();
        pending.otp = freshOtp;
        pending.expiresAt = Date.now() + 10 * 60 * 1000;

        const emailResult = await sendOtpEmail(cleanEmail, freshOtp, 'register');
        if (!emailResult.sent) {
          console.warn(`[OTP WARNING] Resend email delivery unavailable (${emailResult.error}).`);
        }

        return sendJson(res, 200, {
          success: true,
          emailDeliveryFailed: !emailResult.sent,
          emailError: !emailResult.sent ? (emailResult.error || 'Email dispatch failed') : null,
          message: emailResult.sent
            ? `A fresh 6-digit verification code has been dispatched to ${cleanEmail}. Please check your inbox and spam folder.`
            : `Email delivery issue: ${emailResult.error || 'Cloud email unavailable'}.`,
          email: cleanEmail
        });
      }

      // ---------------- PASSWORD RESET WITH MANDATORY OTP VERIFICATION ----------------
      // Step 1: User requests password reset -> check user exists in fixit.db & send 6-digit OTP
      if (pathname === '/api/auth/forgot-password-request' && method === 'POST') {
        const { email } = await readBody(req);
        if (!email || !email.trim()) return sendError(res, 400, 'Email address is required');

        const cleanEmail = email.toLowerCase().trim();
        const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)').get(cleanEmail);
        if (!user) {
          return sendError(res, 404, 'No account found with this email address. Please check your spelling or register.');
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = Date.now() + 10 * 60 * 1000;

        passwordResetOtps.set(cleanEmail, {
          otp,
          expiresAt,
          userId: user.id
        });

        const emailResult = await sendOtpEmail(cleanEmail, otp, 'reset_password');
        if (!emailResult.sent) {
          console.warn(`[OTP WARNING] Password reset email delivery unavailable (${emailResult.error}).`);
        }

        return sendJson(res, 200, {
          success: true,
          emailDeliveryFailed: !emailResult.sent,
          emailError: !emailResult.sent ? (emailResult.error || 'Email dispatch failed') : null,
          message: emailResult.sent
            ? `A 6-digit password reset code has been dispatched to ${cleanEmail}. Please check your inbox and spam folder.`
            : `Email delivery issue: ${emailResult.error || 'Cloud email unavailable'}.`,
          email: cleanEmail
        });
      }

      // Step 2: User enters OTP and new password -> verify OTP and update password in fixit.db
      if (pathname === '/api/auth/reset-password-verify' && method === 'POST') {
        const { email, otp, new_password } = await readBody(req);
        if (!email || !otp || !new_password) {
          return sendError(res, 400, 'Email, OTP, and new password are required');
        }

        const cleanEmail = email.toLowerCase().trim();
        const resetInfo = passwordResetOtps.get(cleanEmail);

        if (!resetInfo) {
          return sendError(res, 400, 'No active password reset request for this email. Please request a new code.');
        }

        if (Date.now() > resetInfo.expiresAt) {
          passwordResetOtps.delete(cleanEmail);
          return sendError(res, 400, 'Password reset code has expired. Please request a new code.');
        }

        if (resetInfo.otp !== String(otp).trim()) {
          return sendError(res, 400, 'Invalid verification code. Please check your email and try again.');
        }

        if (new_password.length < 6) {
          return sendError(res, 400, 'New password must be at least 6 characters long.');
        }

        // Update password in fixit.db
        db.prepare('UPDATE users SET password = ? WHERE id = ?').run(new_password, resetInfo.userId);
        passwordResetOtps.delete(cleanEmail);

        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(resetInfo.userId);
        let existingSession = db.prepare('SELECT token FROM sessions WHERE user_id = ? ORDER BY rowid DESC LIMIT 1').get(user.id);
        let token = existingSession ? existingSession.token : null;
        if (!token) {
          token = 'tok_reset_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
          saveSession(token, user.id);
        }

        let providerData = null;
        if (user.role === 'provider') {
          providerData = db.prepare('SELECT * FROM providers WHERE user_id = ?').get(user.id);
        }

        const { password: _, ...safeUser } = user;
        return sendJson(res, 200, {
          success: true,
          message: 'Password reset successfully! You are now logged in with your new password.',
          user: safeUser,
          provider: providerData,
          token
        });
      }

      // ---------------- DATABASE INSPECTION ENDPOINT ----------------
      if (pathname === '/api/db/inspect' && method === 'GET') {
        const users = db.prepare('SELECT id, name, email, role, phone, address, status, created_at FROM users ORDER BY id ASC').all();
        const providers = db.prepare(`
          SELECT p.id as provider_id, p.user_id, u.name, u.email, c.name as category_name,
                 p.hourly_rate, p.experience_years, p.verification_status, p.district, p.state, p.skills
          FROM providers p
          JOIN users u ON p.user_id = u.id
          LEFT JOIN categories c ON p.category_id = c.id
          ORDER BY p.id ASC
        `).all();
        const categories = db.prepare('SELECT id, name, slug, description FROM categories ORDER BY id ASC').all();
        const totalRequests = db.prepare('SELECT count(*) as count FROM requests').get().count;

        return sendJson(res, 200, {
          success: true,
          totalUsers: users.length,
          totalProviders: providers.length,
          totalCategories: categories.length,
          totalRequests,
          users,
          providers,
          categories
        });
      }

      if (pathname === '/api/auth/me' && method === 'GET') {
        const user = getAuthenticatedUser(req);
        if (!user) return sendError(res, 401, 'Not authenticated');
        let providerData = null;
        if (user.role === 'provider') {
          providerData = db.prepare('SELECT * FROM providers WHERE user_id = ?').get(user.id);
        }
        return sendJson(res, 200, { user, provider: providerData });
      }


      // ---------------- CATEGORIES ROUTES ----------------
      if (pathname === '/api/categories' && method === 'GET') {
        const categories = db.prepare(`
          SELECT c.*, 
            (SELECT count(*) FROM providers p WHERE p.category_id = c.id AND p.verification_status = 'approved') as providers_count,
            (SELECT count(*) FROM requests r WHERE r.category_id = c.id) as requests_count
          FROM categories c
          WHERE c.is_active = 1
          ORDER BY c.id ASC
        `).all();
        return sendJson(res, 200, { categories });
      }

      if (pathname === '/api/categories' && method === 'POST') {
        const user = getAuthenticatedUser(req);
        if (!user || user.role !== 'admin') return sendError(res, 403, 'Admin privilege required');
        const { name, icon, base_price, description } = await readBody(req);
        if (!name) return sendError(res, 400, 'Name is required');
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        const resCat = db.prepare(`
          INSERT INTO categories (name, slug, icon, base_price, description)
          VALUES (?, ?, ?, ?, ?)
        `).run(name, slug, icon || 'fa-tools', Number(base_price) || 40.0, description || '');
        const newCat = db.prepare('SELECT * FROM categories WHERE id = ?').get(resCat.lastInsertRowid);
        return sendJson(res, 201, { category: newCat });
      }

      // ---------------- PROVIDERS ROUTES ----------------
      if (pathname === '/api/providers' && method === 'GET') {
        const categoryId = parsedUrl.searchParams.get('category_id');
        const search = parsedUrl.searchParams.get('search');
        const status = parsedUrl.searchParams.get('status') || 'approved';
        const excludeUserId = parsedUrl.searchParams.get('exclude_user_id');

        let query = `
          SELECT p.*, u.name, u.email, u.phone, u.avatar, u.address, c.name as category_name, c.icon as category_icon
          FROM providers p
          JOIN users u ON p.user_id = u.id
          LEFT JOIN categories c ON p.category_id = c.id
          WHERE 1=1
        `;
        const params = [];

        if (status !== 'all') {
          query += ` AND p.verification_status = ?`;
          params.push(status);
        }
        if (categoryId) {
          query += ` AND p.category_id = ?`;
          params.push(Number(categoryId));
        }
        if (excludeUserId) {
          query += ` AND p.user_id != ?`;
          params.push(Number(excludeUserId));
        }
        if (search) {
          query += ` AND (u.name LIKE ? OR p.bio LIKE ? OR p.skills LIKE ?)`;
          const term = `%${search}%`;
          params.push(term, term, term);
        }

        query += ` ORDER BY p.rating DESC, p.reviews_count DESC`;
        const providers = db.prepare(query).all(...params);
        return sendJson(res, 200, { providers });
      }

      if (pathname.match(/^\/api\/providers\/\d+$/) && method === 'GET') {
        const providerId = Number(pathname.split('/')[3]);
        const provider = db.prepare(`
          SELECT p.*, u.name, u.email, u.phone, u.avatar, u.address, c.name as category_name
          FROM providers p
          JOIN users u ON p.user_id = u.id
          LEFT JOIN categories c ON p.category_id = c.id
          WHERE p.id = ?
        `).get(providerId);
        if (!provider) return sendError(res, 404, 'Provider not found');

        const reviews = db.prepare(`
          SELECT r.*, u.name as reviewer_name, u.avatar as reviewer_avatar
          FROM reviews r
          JOIN users u ON r.user_id = u.id
          WHERE r.provider_id = ?
          ORDER BY r.created_at DESC
        `).all(providerId);

        return sendJson(res, 200, { provider, reviews });
      }

      // Update provider profile
      if (pathname === '/api/providers/profile' && method === 'PUT') {
        const user = getAuthenticatedUser(req);
        if (!user || user.role !== 'provider') return sendError(res, 403, 'Provider access required');
        const body = await readBody(req);
        const { hourly_rate, experience_years, bio, skills, is_available, service_radius_km, latitude, longitude, phone, address, district, state } = body;

        // Update provider table
        db.prepare(`
          UPDATE providers SET
            hourly_rate = COALESCE(?, hourly_rate),
            experience_years = COALESCE(?, experience_years),
            bio = COALESCE(?, bio),
            skills = COALESCE(?, skills),
            is_available = COALESCE(?, is_available),
            service_radius_km = COALESCE(?, service_radius_km),
            latitude = COALESCE(?, latitude),
            longitude = COALESCE(?, longitude),
            district = COALESCE(?, district),
            state = COALESCE(?, state)
          WHERE user_id = ?
        `).run(
          hourly_rate ? Number(hourly_rate) : null,
          experience_years ? Number(experience_years) : null,
          bio !== undefined ? bio : null,
          skills ? JSON.stringify(Array.isArray(skills) ? skills : skills.split(',').map(s=>s.trim())) : null,
          is_available !== undefined ? (is_available ? 1 : 0) : null,
          service_radius_km ? Number(service_radius_km) : null,
          latitude ? Number(latitude) : null,
          longitude ? Number(longitude) : null,
          district || null,
          state || (district && district.includes(',') ? district.split(',').pop().trim() : null),
          user.id
        );

        // Update user table
        if (phone || address) {
          db.prepare(`
            UPDATE users SET
              phone = COALESCE(?, phone),
              address = COALESCE(?, address)
            WHERE id = ?
          `).run(phone || null, address || null, user.id);
        }

        const updatedProvider = db.prepare('SELECT * FROM providers WHERE user_id = ?').get(user.id);
        return sendJson(res, 200, { success: true, provider: updatedProvider });
      }

      // Admin verify/reject provider
      if (pathname.match(/^\/api\/providers\/\d+\/verify$/) && method === 'PUT') {
        const user = getAuthenticatedUser(req);
        if (!user || user.role !== 'admin') return sendError(res, 403, 'Admin access required');
        const providerId = Number(pathname.split('/')[3]);
        const { status } = await readBody(req);
        if (!['approved', 'rejected', 'pending'].includes(status)) {
          return sendError(res, 400, 'Invalid status');
        }

        db.prepare('UPDATE providers SET verification_status = ? WHERE id = ?').run(status, providerId);
        const provider = db.prepare('SELECT p.*, u.id as user_id, u.name FROM providers p JOIN users u ON p.user_id = u.id WHERE p.id = ?').get(providerId);

        if (provider) {
          db.prepare(`
            INSERT INTO notifications (user_id, title, message, type)
            VALUES (?, 'Account Verification Status', ?, ?)
          `).run(
            provider.user_id,
            status === 'approved' ? 'Congratulations! Your service provider account has been verified and approved.' : 'Your provider application was marked as ' + status,
            status === 'approved' ? 'success' : 'warning'
          );
        }

        return sendJson(res, 200, { success: true, provider });
      }

      // ---------------- REPAIR REQUESTS ROUTES ----------------
      if (pathname === '/api/requests' && method === 'GET') {
        const user = getAuthenticatedUser(req);
        if (!user) return sendError(res, 401, 'Authentication required');

        const statusFilter = parsedUrl.searchParams.get('status');
        const categoryFilter = parsedUrl.searchParams.get('category_id');

        let query = `
          SELECT r.*, 
            c.name as category_name, c.icon as category_icon,
            u.name as customer_name, u.phone as customer_phone, u.avatar as customer_avatar,
            pu.name as provider_name, pu.phone as provider_phone, pu.avatar as provider_avatar,
            (SELECT rating FROM reviews rv WHERE rv.request_id = r.id) as user_review_rating,
            (SELECT comment FROM reviews rv WHERE rv.request_id = r.id) as user_review_comment
          FROM requests r
          JOIN categories c ON r.category_id = c.id
          JOIN users u ON r.user_id = u.id
          LEFT JOIN providers p ON r.provider_id = p.id
          LEFT JOIN users pu ON p.user_id = pu.id
          WHERE 1=1
        `;
        const params = [];

        const scope = parsedUrl.searchParams.get('scope');
        const viewAll = parsedUrl.searchParams.get('all') === 'true';

        if (!viewAll) {
          if (scope === 'customer' || user.role === 'customer') {
            query += ` AND r.user_id = ?`;
            params.push(user.id);
          } else if (user.role === 'provider') {
            // Provider sees jobs assigned to them, OR pending jobs in their registered category!
            const provider = db.prepare('SELECT id, category_id FROM providers WHERE user_id = ?').get(user.id);
            if (provider) {
              query += ` AND (r.provider_id = ? OR (r.category_id = ? AND r.status = 'Pending'))`;
              params.push(provider.id, provider.category_id);
            } else {
              query += ` AND 1=0`;
            }
          }
        }
        // Admin sees all

        if (statusFilter && statusFilter !== 'all') {
          query += ` AND r.status = ?`;
          params.push(statusFilter);
        }
        if (categoryFilter && categoryFilter !== 'all') {
          query += ` AND r.category_id = ?`;
          params.push(Number(categoryFilter));
        }

        query += ` ORDER BY r.id DESC`;
        const requests = db.prepare(query).all(...params);

        // If provider, calculate distance to each job and flag if within their radius
        if (user.role === 'provider') {
          const prov = db.prepare('SELECT latitude, longitude, service_radius_km FROM providers WHERE user_id = ?').get(user.id);
          const pLat = prov ? (prov.latitude || 18.5204) : 18.5204;
          const pLng = prov ? (prov.longitude || 73.8567) : 73.8567;
          const pRadius = prov ? (prov.service_radius_km || 5.0) : 5.0;

          const withDist = requests.map(reqItem => {
            const dist = (reqItem.latitude && reqItem.longitude) ? calculateDistanceKm(pLat, pLng, reqItem.latitude, reqItem.longitude) : null;
            return {
              ...reqItem,
              distance_km: dist,
              within_radius: dist !== null ? dist <= pRadius : true
            };
          });
          return sendJson(res, 200, { requests: withDist });
        }

        return sendJson(res, 200, { requests });
      }

      // Create new repair request (Customer)
      if (pathname === '/api/requests' && method === 'POST') {
        const user = getAuthenticatedUser(req);
        if (!user) return sendError(res, 401, 'Please sign in to submit a request');
        const body = await readBody(req);
        const { title, description, category_id, photos, preferred_date, preferred_time, address, latitude, longitude, urgency, provider_id } = body;

        if (!title || !description || !category_id || !preferred_date) {
          return sendError(res, 400, 'Title, description, category, and preferred date are required');
        }

        const ticketNumber = 'FIX-' + Math.floor(1000 + Math.random() * 9000);
        const photosJson = JSON.stringify(Array.isArray(photos) ? photos : (photos ? [photos] : []));
        
        // Compute estimated cost based on category base price
        const cat = db.prepare('SELECT base_price FROM categories WHERE id = ?').get(category_id);
        const estCost = cat ? cat.base_price : 45.0;

        const assignedProviderId = provider_id ? Number(provider_id) : null;
        const initialStatus = 'Pending';

        const reqInsert = db.prepare(`
          INSERT INTO requests (
            ticket_number, user_id, provider_id, category_id,
            title, description, photos, preferred_date, preferred_time,
            address, latitude, longitude, urgency, status, estimated_cost
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          ticketNumber,
          user.id,
          assignedProviderId,
          Number(category_id),
          title,
          description,
          photosJson,
          preferred_date,
          preferred_time || 'Morning (9 AM - 12 PM)',
          address || user.address || 'Address provided upon confirmation',
          latitude ? Number(latitude) : null,
          longitude ? Number(longitude) : null,
          urgency || 'normal',
          initialStatus,
          estCost
        );

        const newRequestId = reqInsert.lastInsertRowid;

        // Notification to user
        db.prepare(`
          INSERT INTO notifications (user_id, title, message, type)
          VALUES (?, 'Repair Request Submitted', ?, 'info')
        `).run(user.id, `Your request "${title}" (${ticketNumber}) was submitted successfully. Waiting for provider acceptance.`);

        // Notify chosen provider or category providers within 5km radius
        if (assignedProviderId) {
          const prov = db.prepare('SELECT user_id FROM providers WHERE id = ?').get(assignedProviderId);
          if (prov) {
            db.prepare(`
              INSERT INTO notifications (user_id, title, message, type)
              VALUES (?, 'New Direct Booking Request', ?, 'info')
            `).run(prov.user_id, `You received a new repair request "${title}" from ${user.name}.`);
          }
        } else {
          // Broadcast to providers in this category whose service radius covers this request
          const categoryProviders = db.prepare(`
            SELECT p.id, p.user_id, p.latitude, p.longitude, p.service_radius_km
            FROM providers p
            WHERE p.category_id = ? AND p.verification_status = 'approved' AND p.is_available = 1
          `).all(Number(category_id));

          for (const p of categoryProviders) {
            let inRadius = true;
            let dist = null;
            if (latitude && longitude && p.latitude && p.longitude) {
              dist = calculateDistanceKm(latitude, longitude, p.latitude, p.longitude);
              const provRadius = p.service_radius_km || 5.0;
              if (dist !== null && dist > provRadius) {
                inRadius = false;
              }
            }

            if (inRadius) {
              const distNote = dist !== null ? ` (📍 ${dist} km away • within 5km radius)` : '';
              db.prepare(`
                INSERT INTO notifications (user_id, title, message, type)
                VALUES (?, 'Nearby Job Alert', ?, 'info')
              `).run(p.user_id, `New complaint in your category${distNote}: "${title}" at ${address}.`);
            }
          }
        }

        const createdRequest = db.prepare(`
          SELECT r.*, c.name as category_name
          FROM requests r
          JOIN categories c ON r.category_id = c.id
          WHERE r.id = ?
        `).get(newRequestId);

        return sendJson(res, 201, { request: createdRequest });
      }

      // Update Request Status (Accept, Reject, In Progress, Complete)
      if (pathname.match(/^\/api\/requests\/\d+\/status$/) && method === 'PUT') {
        const user = getAuthenticatedUser(req);
        if (!user) return sendError(res, 401, 'Authentication required');
        const requestId = Number(pathname.split('/')[3]);
        const body = await readBody(req);
        const { status, rejection_reason, completion_notes, final_cost } = body;

        const existing = db.prepare('SELECT * FROM requests WHERE id = ?').get(requestId);
        if (!existing) return sendError(res, 404, 'Request not found');

        let provider = null;
        if (user.role === 'provider') {
          provider = db.prepare('SELECT id FROM providers WHERE user_id = ?').get(user.id);
          if (!provider) return sendError(res, 403, 'Provider profile missing');
        }

        let assignedProviderId = existing.provider_id;
        // If provider is accepting a pending job, assign it to them
        if (user.role === 'provider' && status === 'Accepted') {
          assignedProviderId = provider.id;
        }

        db.prepare(`
          UPDATE requests SET
            status = ?,
            provider_id = COALESCE(?, provider_id),
            rejection_reason = COALESCE(?, rejection_reason),
            completion_notes = COALESCE(?, completion_notes),
            final_cost = COALESCE(?, final_cost),
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(
          status,
          assignedProviderId,
          rejection_reason || null,
          completion_notes || null,
          final_cost ? Number(final_cost) : (status === 'Completed' ? existing.estimated_cost : null),
          requestId
        );

        // Notify customer of status change
        const statusMsgs = {
          'Accepted': `Your repair request ${existing.ticket_number} has been ACCEPTED by the technician.`,
          'In Progress': `Technician has arrived and started repair work on ${existing.ticket_number}.`,
          'Completed': `Repair ${existing.ticket_number} marked as COMPLETED! Please rate your experience.`,
          'Rejected': `Your request ${existing.ticket_number} was declined. Reason: ${rejection_reason || 'Provider unavailable.'}`
        };

        if (statusMsgs[status]) {
          db.prepare(`
            INSERT INTO notifications (user_id, title, message, type)
            VALUES (?, 'Request Status Updated', ?, 'status_change')
          `).run(existing.user_id, statusMsgs[status]);
        }

        const updated = db.prepare('SELECT * FROM requests WHERE id = ?').get(requestId);
        return sendJson(res, 200, { success: true, request: updated });
      }

      // Customer Rate & Review after Completion
      if (pathname.match(/^\/api\/requests\/\d+\/rate$/) && method === 'POST') {
        const user = getAuthenticatedUser(req);
        if (!user) return sendError(res, 401, 'Authentication required');
        const requestId = Number(pathname.split('/')[3]);
        const { rating, comment } = await readBody(req);

        if (!rating || rating < 1 || rating > 5) {
          return sendError(res, 400, 'Valid rating between 1 and 5 required');
        }

        const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(requestId);
        if (!request) return sendError(res, 404, 'Request not found');
        if (request.user_id !== user.id && user.role !== 'admin') {
          return sendError(res, 403, 'You can only review your own completed service');
        }
        if (!request.provider_id) {
          return sendError(res, 400, 'No provider was assigned to this request');
        }

        // Insert or replace review
        db.prepare('DELETE FROM reviews WHERE request_id = ?').run(requestId);
        db.prepare(`
          INSERT INTO reviews (request_id, user_id, provider_id, rating, comment)
          VALUES (?, ?, ?, ?, ?)
        `).run(requestId, user.id, request.provider_id, Number(rating), comment || '');

        // Recalculate provider average rating and review count
        const stats = db.prepare(`
          SELECT AVG(rating) as avg_rating, count(*) as total_reviews
          FROM reviews
          WHERE provider_id = ?
        `).get(request.provider_id);

        if (stats && stats.total_reviews > 0) {
          db.prepare(`
            UPDATE providers SET
              rating = ROUND(?, 1),
              reviews_count = ?
            WHERE id = ?
          `).run(stats.avg_rating, stats.total_reviews, request.provider_id);
        }

        // Notify provider
        const providerUser = db.prepare('SELECT user_id FROM providers WHERE id = ?').get(request.provider_id);
        if (providerUser) {
          db.prepare(`
            INSERT INTO notifications (user_id, title, message, type)
            VALUES (?, 'New Customer Review', ?, 'info')
          `).run(providerUser.user_id, `${user.name} gave you a ${rating}-star review for request ${request.ticket_number}!`);
        }

        return sendJson(res, 201, { success: true, message: 'Review recorded' });
      }

      // ---------------- CHAT & NEGOTIATION ROUTES ----------------
      if (pathname.match(/^\/api\/requests\/\d+\/messages$/) && method === 'GET') {
        const user = getAuthenticatedUser(req);
        if (!user) return sendError(res, 401, 'Authentication required');
        const requestId = Number(pathname.split('/')[3]);

        const request = db.prepare(`
          SELECT r.*, 
            u.id as customer_id, u.name as customer_name, u.avatar as customer_avatar,
            pu.id as provider_user_id, pu.name as provider_name, pu.avatar as provider_avatar
          FROM requests r
          JOIN users u ON r.user_id = u.id
          LEFT JOIN providers p ON r.provider_id = p.id
          LEFT JOIN users pu ON p.user_id = pu.id
          WHERE r.id = ?
        `).get(requestId);

        if (!request) return sendError(res, 404, 'Request not found');

        const messages = db.prepare(`
          SELECT m.*, u.name as sender_name, u.avatar as sender_avatar, u.role as sender_role
          FROM messages m
          JOIN users u ON m.sender_id = u.id
          WHERE m.request_id = ?
          ORDER BY m.id ASC
        `).all(requestId);

        return sendJson(res, 200, {
          request: {
            id: request.id,
            ticket_number: request.ticket_number,
            title: request.title,
            status: request.status,
            estimated_cost: request.estimated_cost,
            agreed_price: request.agreed_price,
            offline_payment_agreed: request.offline_payment_agreed,
            customer_name: request.customer_name,
            customer_avatar: request.customer_avatar,
            provider_name: request.provider_name,
            provider_avatar: request.provider_avatar
          },
          messages
        });
      }

      if (pathname.match(/^\/api\/requests\/\d+\/messages$/) && method === 'POST') {
        const user = getAuthenticatedUser(req);
        if (!user) return sendError(res, 401, 'Authentication required');
        const requestId = Number(pathname.split('/')[3]);
        const { message, message_type, proposed_price } = await readBody(req);

        if (!message && !proposed_price) {
          return sendError(res, 400, 'Message or price offer required');
        }

        const request = db.prepare(`
          SELECT r.*, p.user_id as provider_user_id
          FROM requests r
          LEFT JOIN providers p ON r.provider_id = p.id
          WHERE r.id = ?
        `).get(requestId);
        if (!request) return sendError(res, 404, 'Request not found');

        const msgText = message || (message_type === 'price_offer' ? `Proposed offline service price: ₹${proposed_price}` : 'Payment agreed');
        const type = message_type || 'text';

        const insert = db.prepare(`
          INSERT INTO messages (request_id, sender_id, message, message_type, proposed_price)
          VALUES (?, ?, ?, ?, ?)
        `).run(requestId, user.id, msgText, type, proposed_price ? Number(proposed_price) : null);

        if (type === 'payment_agreed' && proposed_price) {
          db.prepare(`
            UPDATE requests SET
              offline_payment_agreed = 1,
              agreed_price = ?,
              final_cost = ?
            WHERE id = ?
          `).run(Number(proposed_price), Number(proposed_price), requestId);
        }

        const recipientUserId = (user.id === request.user_id) ? request.provider_user_id : request.user_id;
        if (recipientUserId) {
          db.prepare(`
            INSERT INTO notifications (user_id, title, message, type)
            VALUES (?, 'New Chat Message', ?, 'info')
          `).run(recipientUserId, `${user.name} on ${request.ticket_number}: "${msgText.slice(0, 45)}..."`);
        }

        const createdMessage = db.prepare(`
          SELECT m.*, u.name as sender_name, u.avatar as sender_avatar, u.role as sender_role
          FROM messages m
          JOIN users u ON m.sender_id = u.id
          WHERE m.id = ?
        `).get(insert.lastInsertRowid);

        return sendJson(res, 201, { message: createdMessage });
      }

      if (pathname.match(/^\/api\/requests\/\d+\/negotiate-price$/) && method === 'POST') {
        const user = getAuthenticatedUser(req);
        if (!user) return sendError(res, 401, 'Authentication required');
        const requestId = Number(pathname.split('/')[3]);
        const { price } = await readBody(req);

        if (!price || Number(price) <= 0) return sendError(res, 400, 'Valid price required');

        const request = db.prepare(`
          SELECT r.*, p.user_id as provider_user_id
          FROM requests r
          LEFT JOIN providers p ON r.provider_id = p.id
          WHERE r.id = ?
        `).get(requestId);
        if (!request) return sendError(res, 404, 'Request not found');

        const agreedAmount = Number(price);
        db.prepare(`
          UPDATE requests SET
            offline_payment_agreed = 1,
            agreed_price = ?,
            final_cost = ?
          WHERE id = ?
        `).run(agreedAmount, agreedAmount, requestId);

        const agreementMsg = `🤝 Offline payment confirmed! Rate agreed at ₹${agreedAmount.toFixed(2)} (Cash in person upon completion).`;
        db.prepare(`
          INSERT INTO messages (request_id, sender_id, message, message_type, proposed_price)
          VALUES (?, ?, ?, 'payment_agreed', ?)
        `).run(requestId, user.id, agreementMsg, agreedAmount);

        const otherUserId = (user.id === request.user_id) ? request.provider_user_id : request.user_id;
        if (otherUserId) {
          db.prepare(`
            INSERT INTO notifications (user_id, title, message, type)
            VALUES (?, 'Offline Price Agreed', ?, 'success')
          `).run(otherUserId, `Offline cash payment price agreed at ₹${agreedAmount} for ${request.ticket_number}!`);
        }

        return sendJson(res, 200, { success: true, agreed_price: agreedAmount });
      }

      // ---------------- NOTIFICATIONS ROUTES ----------------
      if (pathname === '/api/notifications' && method === 'GET') {
        const user = getAuthenticatedUser(req);
        if (!user) return sendError(res, 401, 'Authentication required');
        const notifications = db.prepare(`
          SELECT * FROM notifications
          WHERE user_id = ?
          ORDER BY id DESC
          LIMIT 30
        `).all(user.id);
        const unreadCount = db.prepare('SELECT count(*) as c FROM notifications WHERE user_id = ? AND is_read = 0').get(user.id).c;
        return sendJson(res, 200, { notifications, unreadCount });
      }

      if (pathname === '/api/notifications/read' && method === 'POST') {
        const user = getAuthenticatedUser(req);
        if (!user) return sendError(res, 401, 'Authentication required');
        db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(user.id);
        return sendJson(res, 200, { success: true });
      }

      // ---------------- REVIEWS FEED (Public / Admin) ----------------
      if (pathname === '/api/reviews' && method === 'GET') {
        const reviews = db.prepare(`
          SELECT r.*, 
            u.name as customer_name, u.avatar as customer_avatar,
            pu.name as provider_name,
            c.name as category_name,
            req.title as request_title, req.ticket_number
          FROM reviews r
          JOIN users u ON r.user_id = u.id
          JOIN providers p ON r.provider_id = p.id
          JOIN users pu ON p.user_id = pu.id
          JOIN requests req ON r.request_id = req.id
          JOIN categories c ON req.category_id = c.id
          ORDER BY r.id DESC
          LIMIT 50
        `).all();
        return sendJson(res, 200, { reviews });
      }

      // ---------------- ADMIN ROUTES ----------------
      if (pathname === '/api/admin/stats' && method === 'GET') {
        const user = getAuthenticatedUser(req);
        if (!user || user.role !== 'admin') return sendError(res, 403, 'Admin access required');

        const totalRequests = db.prepare('SELECT count(*) as c FROM requests').get().c;
        const pendingRequests = db.prepare("SELECT count(*) as c FROM requests WHERE status = 'Pending'").get().c;
        const inProgressRequests = db.prepare("SELECT count(*) as c FROM requests WHERE status = 'In Progress'").get().c;
        const completedRequests = db.prepare("SELECT count(*) as c FROM requests WHERE status = 'Completed'").get().c;
        const rejectedRequests = db.prepare("SELECT count(*) as c FROM requests WHERE status = 'Rejected'").get().c;

        const totalUsers = db.prepare("SELECT count(*) as c FROM users WHERE role = 'customer'").get().c;
        const totalProviders = db.prepare("SELECT count(*) as c FROM providers WHERE verification_status = 'approved'").get().c;
        const pendingProviders = db.prepare("SELECT count(*) as c FROM providers WHERE verification_status = 'pending'").get().c;

        const totalRevenue = db.prepare("SELECT SUM(final_cost) as s FROM requests WHERE status = 'Completed'").get().s || 0;

        const categoryStats = db.prepare(`
          SELECT c.name, count(r.id) as request_count
          FROM categories c
          LEFT JOIN requests r ON r.category_id = c.id
          GROUP BY c.id
        `).all();

        const recentRequests = db.prepare(`
          SELECT r.id, r.ticket_number, r.title, r.status, r.created_at, u.name as customer_name, c.name as category_name
          FROM requests r
          JOIN users u ON r.user_id = u.id
          JOIN categories c ON r.category_id = c.id
          ORDER BY r.id DESC
          LIMIT 5
        `).all();

        return sendJson(res, 200, {
          stats: {
            totalRequests,
            pendingRequests,
            inProgressRequests,
            completedRequests,
            rejectedRequests,
            totalUsers,
            totalProviders,
            pendingProviders,
            totalRevenue: Math.round(totalRevenue * 100) / 100,
            completionRate: totalRequests > 0 ? Math.round((completedRequests / totalRequests) * 100) : 0
          },
          categoryStats,
          recentRequests
        });
      }

      if (pathname === '/api/admin/users' && method === 'GET') {
        const user = getAuthenticatedUser(req);
        if (!user || user.role !== 'admin') return sendError(res, 403, 'Admin access required');
        const users = db.prepare(`
          SELECT u.id, u.name, u.email, u.role, u.phone, u.status, u.created_at,
            (SELECT count(*) FROM requests r WHERE r.user_id = u.id) as orders_count
          FROM users u
          ORDER BY u.id DESC
        `).all();
        return sendJson(res, 200, { users });
      }

      if (pathname.match(/^\/api\/admin\/users\/\d+\/status$/) && method === 'PUT') {
        const user = getAuthenticatedUser(req);
        if (!user || user.role !== 'admin') return sendError(res, 403, 'Admin access required');
        const targetUserId = Number(pathname.split('/')[4]);
        const { status } = await readBody(req);
        if (!['active', 'suspended'].includes(status)) {
          return sendError(res, 400, 'Invalid status');
        }
        db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, targetUserId);
        return sendJson(res, 200, { success: true });
      }

      if (pathname.match(/^\/api\/admin\/users\/\d+$/) && method === 'DELETE') {
        const user = getAuthenticatedUser(req);
        if (!user || user.role !== 'admin') return sendError(res, 403, 'Admin access required');
        const targetUserId = Number(pathname.split('/')[4]);
        if (targetUserId === 1) return sendError(res, 400, 'Cannot delete the Super Admin account');

        const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(targetUserId);
        if (!targetUser) return sendError(res, 404, 'User not found');

        const prov = db.prepare('SELECT id FROM providers WHERE user_id = ?').get(targetUserId);
        const provId = prov ? prov.id : null;

        // Cascade cleanup
        if (provId) {
          db.prepare('DELETE FROM messages WHERE request_id IN (SELECT id FROM requests WHERE provider_id = ? OR user_id = ?)').run(provId, targetUserId);
          db.prepare('DELETE FROM reviews WHERE provider_id = ? OR user_id = ?').run(provId, targetUserId);
          db.prepare('DELETE FROM requests WHERE provider_id = ? OR user_id = ?').run(provId, targetUserId);
          db.prepare('DELETE FROM providers WHERE id = ?').run(provId);
        } else {
          db.prepare('DELETE FROM messages WHERE request_id IN (SELECT id FROM requests WHERE user_id = ?)').run(targetUserId);
          db.prepare('DELETE FROM reviews WHERE user_id = ?').run(targetUserId);
          db.prepare('DELETE FROM requests WHERE user_id = ?').run(targetUserId);
        }

        db.prepare('DELETE FROM notifications WHERE user_id = ?').run(targetUserId);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetUserId);
        db.prepare('DELETE FROM users WHERE id = ?').run(targetUserId);

        return sendJson(res, 200, { success: true, message: `User ${targetUser.name} (#${targetUserId}) removed successfully` });
      }

      // ---------------- AUTO-SYNC ENDPOINTS ----------------
      if (pathname === '/api/sync/user' && method === 'POST') {
        const { name, email, role, phone, address, category_id, custom_trade, skills, hourly_rate, bio } = await readBody(req);
        if (!name || !email) return sendError(res, 400, 'Name and email required');

        let user = db.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)').get(email);
        const assignedRole = ['customer', 'provider'].includes(role) ? role : 'customer';

        if (!user) {
          const avatar = `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(name)}`;
          const insert = db.prepare(`
            INSERT INTO users (name, email, password, role, phone, address, avatar, status)
            VALUES (?, ?, 'password123', ?, ?, ?, ?, 'active')
          `).run(name, email, assignedRole, phone || '', address || '', avatar);
          user = db.prepare('SELECT * FROM users WHERE id = ?').get(insert.lastInsertRowid);
        }

        let provider = null;
        if (assignedRole === 'provider') {
          provider = db.prepare('SELECT * FROM providers WHERE user_id = ?').get(user.id);
          if (!provider) {
            const catId = category_id ? Number(category_id) : 1;
            let skillsArr = Array.isArray(skills) ? skills : (skills ? skills.split(',').map(s=>s.trim()).filter(Boolean) : []);
            if (custom_trade && !skillsArr.includes(custom_trade.trim())) skillsArr.unshift(custom_trade.trim());
            if (skillsArr.length === 0) skillsArr = ['General Repairs'];

            const initialBio = bio || (custom_trade ? `Specialist in ${custom_trade.trim()} services.` : 'Skilled technician ready to help.');
            const pInsert = db.prepare(`
              INSERT INTO providers (user_id, category_id, skills, hourly_rate, bio, verification_status, is_available)
              VALUES (?, ?, ?, ?, ?, 'approved', 1)
            `).run(user.id, catId, JSON.stringify(skillsArr), Number(hourly_rate) || 45.0, initialBio);
            provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(pInsert.lastInsertRowid);
          }
        }

        const token = 'tok_sync_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
        saveSession(token, user.id);

        const { password: _, ...safeUser } = user;
        return sendJson(res, 200, { success: true, user: safeUser, provider, token });
      }

      if (pathname === '/api/sync/request' && method === 'POST') {
        const body = await readBody(req);
        const { ticket_number, customer_email, customer_name, title, description, category_id, preferred_date, preferred_time, address, status, estimated_cost } = body;
        if (!title) return sendError(res, 400, 'Title required');

        // Check if ticket number exists
        const existing = ticket_number ? db.prepare('SELECT * FROM requests WHERE ticket_number = ?').get(ticket_number) : null;
        if (existing) {
          return sendJson(res, 200, { success: true, request: existing });
        }

        // Find or create customer
        let custUser = customer_email ? db.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)').get(customer_email) : null;
        if (!custUser) {
          const uName = customer_name || 'Customer';
          const uEmail = customer_email || ('customer_' + Date.now() + '@fixit.local');
          const ins = db.prepare(`
            INSERT INTO users (name, email, password, role, phone, address, avatar, status)
            VALUES (?, ?, 'password123', 'customer', '', ?, ?, 'active')
          `).run(uName, uEmail, address || '', `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(uName)}`);
          custUser = db.prepare('SELECT * FROM users WHERE id = ?').get(ins.lastInsertRowid);
        }

        const tNum = ticket_number || ('FIX-' + Math.floor(1000 + Math.random() * 9000));
        const catId = category_id ? Number(category_id) : 1;
        const cat = db.prepare('SELECT base_price FROM categories WHERE id = ?').get(catId);

        const rIns = db.prepare(`
          INSERT INTO requests (
            ticket_number, user_id, category_id, title, description,
            preferred_date, preferred_time, address, status, estimated_cost
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          tNum,
          custUser.id,
          catId,
          title,
          description || 'Service request submitted.',
          preferred_date || new Date().toISOString().split('T')[0],
          preferred_time || 'Morning',
          address || 'Customer Address',
          status || 'Pending',
          estimated_cost || (cat ? cat.base_price : 45.0)
        );

        const createdReq = db.prepare('SELECT * FROM requests WHERE id = ?').get(rIns.lastInsertRowid);
        return sendJson(res, 201, { success: true, request: createdReq });
      }

      // If no API endpoint matched
      return sendError(res, 404, 'API endpoint not found');
    } catch (apiErr) {
      console.error('API Error:', apiErr);
      return sendError(res, 500, 'Internal server error: ' + apiErr.message);
    }
  }

  // Static Assets and SPA routing
  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(`Fixit Web Platform running at http://localhost:${PORT}`);
  console.log(`Press Ctrl+C to terminate`);
  console.log(`===============================================`);
});
