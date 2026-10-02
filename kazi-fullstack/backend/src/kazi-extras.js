// kazi-extras.js  -  put this file in backend/src/ next to server.js
// Adds: wallet, withdrawals, address/phone/ID verification, PayPal link, admin till + admin review routes.
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const PP_BASE = process.env.PAYPAL_ENV === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
const PP_WWW  = process.env.PAYPAL_ENV === 'sandbox' ? 'https://www.sandbox.paypal.com' : 'https://www.paypal.com';

async function init() {
  await pool.query(`
  CREATE TABLE IF NOT EXISTS kazi_flags(user_id TEXT PRIMARY KEY, phone TEXT, phone_verified BOOLEAN DEFAULT false,
    id_status TEXT DEFAULT 'none', id_doc_type TEXT, id_front TEXT, id_selfie TEXT, id_submitted_at TIMESTAMPTZ, id_reason TEXT,
    paypal_email TEXT);
  CREATE TABLE IF NOT EXISTS kazi_codes(user_id TEXT PRIMARY KEY, phone TEXT, code TEXT, expires_at TIMESTAMPTZ, attempts INT DEFAULT 0);
  CREATE TABLE IF NOT EXISTS kazi_ledger(id SERIAL PRIMARY KEY, user_id TEXT, amount NUMERIC, note TEXT, created_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS kazi_withdrawals(id SERIAL PRIMARY KEY, user_id TEXT, amount NUMERIC, method TEXT,
    status TEXT DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS kazi_address(id SERIAL PRIMARY KEY, user_id TEXT, county TEXT, area TEXT, street TEXT, doc_type TEXT,
    file_name TEXT, file_type TEXT, file_data TEXT, status TEXT DEFAULT 'pending', reason TEXT,
    submitted_at TIMESTAMPTZ DEFAULT now(), verified_at TIMESTAMPTZ);
  CREATE TABLE IF NOT EXISTS kazi_settings(key TEXT PRIMARY KEY, value TEXT);`);
}
const ready = init().catch(e => console.error('kazi-extras init failed:', e.message));

function auth(req, res, next) {
  try {
    const tok = (req.headers.authorization || '').replace('Bearer ', '');
    const p = jwt.verify(tok, process.env.JWT_SECRET);
    req.uid = String(p.id || p.userId || p.sub);
    if (!req.uid || req.uid === 'undefined') throw new Error('no id');
    next();
  } catch (e) { res.status(401).json({ error: 'Please log in again.' }); }
}
async function admin(req, res, next) {
  try {
    const r = await pool.query('SELECT * FROM users WHERE id::text=$1', [req.uid]);
    const u = r.rows[0] || {};
    const emails = (process.env.ADMIN_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
    if (u.role === 'admin' || u.is_admin === true || (u.email && emails.includes(String(u.email).toLowerCase()))) return next();
  } catch (e) {}
  res.status(403).json({ error: 'Admins only.' });
}
const wrap = fn => (req, res) => ready.then(() => fn(req, res)).catch(e => { console.error(e); res.status(500).json({ message: 'Server error.' }); });
const setFlag = (uid, col, val) => pool.query(
  `INSERT INTO kazi_flags(user_id,${col}) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET ${col}=$2`, [uid, val]);
const normPhone = p => { p = String(p || '').replace(/[^\d+]/g, ''); if (p.startsWith('0')) p = '+254' + p.slice(1); else if (p.startsWith('254')) p = '+' + p; return /^\+254\d{9}$/.test(p) ? p : null; };

module.exports = function (app) {
  // ---------- Wallet ----------
  async function balance(uid) {
    const a = await pool.query('SELECT COALESCE(SUM(amount),0) s FROM kazi_ledger WHERE user_id=$1', [uid]);
    const b = await pool.query("SELECT COALESCE(SUM(amount),0) s FROM kazi_withdrawals WHERE user_id=$1 AND status<>'rejected'", [uid]);
    return Number(a.rows[0].s) - Number(b.rows[0].s);
  }
  app.get('/api/wallet', auth, wrap(async (req, res) => {
    const w = await pool.query('SELECT id,amount,method,status,created_at AS "createdAt" FROM kazi_withdrawals WHERE user_id=$1 ORDER BY id DESC LIMIT 50', [req.uid]);
    res.json({ balance: await balance(req.uid), withdrawals: w.rows.map(r => ({ ...r, amount: Number(r.amount) })) });
  }));
  app.post('/api/withdrawals', auth, wrap(async (req, res) => {
    const amount = Number(req.body.amount), method = String(req.body.method || '');
    if (!['mpesa', 'bank', 'paypal', 'googlepay'].includes(method)) return res.status(400).json({ message: 'Choose a payout method.' });
    if (!amount || amount < 100) return res.status(400).json({ message: 'Minimum withdrawal is KSh 100.' });
    const c = await pool.connect();
    try {
      await c.query('BEGIN'); await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [req.uid]);
      const bal = await balance(req.uid);
      if (amount > bal) { await c.query('ROLLBACK'); return res.status(400).json({ message: 'That is more than your available balance.' }); }
      await c.query('INSERT INTO kazi_withdrawals(user_id,amount,method) VALUES($1,$2,$3)', [req.uid, amount, method]);
      await c.query('COMMIT'); res.json({ ok: true });
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }));

  // ---------- Verification status ----------
  app.get('/api/verification/status', auth, wrap(async (req, res) => {
    const f = (await pool.query('SELECT * FROM kazi_flags WHERE user_id=$1', [req.uid])).rows[0] || {};
    res.json({ phoneVerified: !!f.phone_verified, idStatus: f.id_status || 'none' });
  }));

  // ---------- Address ----------
  app.get('/api/verification/address', auth, wrap(async (req, res) => {
    const r = (await pool.query('SELECT * FROM kazi_address WHERE user_id=$1 ORDER BY id DESC LIMIT 1', [req.uid])).rows[0];
    if (!r) return res.json({ status: 'none' });
    res.json({ status: r.status, county: r.county, area: r.area, reason: r.reason, submittedAt: r.submitted_at, verifiedAt: r.verified_at });
  }));
  app.post('/api/verification/address', auth, wrap(async (req, res) => {
    const b = req.body || {};
    if (!b.county || !b.area || !b.docType || !b.fileData) return res.status(400).json({ message: 'Missing details.' });
    if (String(b.fileData).length > 3.5e6) return res.status(413).json({ message: 'File too large.' });
    await pool.query("UPDATE kazi_address SET status='superseded' WHERE user_id=$1 AND status IN ('pending','rejected')", [req.uid]);
    await pool.query('INSERT INTO kazi_address(user_id,county,area,street,doc_type,file_name,file_type,file_data) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [req.uid, b.county, b.area, b.street || '', b.docType, b.fileName, b.fileType, b.fileData]);
    res.json({ ok: true });
  }));

  // ---------- Phone code (Africa's Talking) ----------
  app.post('/api/verification/phone/send', auth, wrap(async (req, res) => {
    const phone = normPhone(req.body.phone);
    if (!phone) return res.status(400).json({ message: 'Enter a valid Kenyan phone number.' });
    if (!process.env.AT_API_KEY || !process.env.AT_USERNAME) return res.status(503).json({ message: 'SMS is not configured yet.' });
    const prev = (await pool.query('SELECT expires_at FROM kazi_codes WHERE user_id=$1', [req.uid])).rows[0];
    if (prev && new Date(prev.expires_at).getTime() - 9 * 60 * 1000 > Date.now()) return res.status(429).json({ message: 'Wait a minute before requesting another code.' });
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const r = await fetch('https://api.africastalking.com/version1/messaging', {
      method: 'POST', headers: { apiKey: process.env.AT_API_KEY, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: process.env.AT_USERNAME, to: phone, message: `Your Kazi code is ${code}. It expires in 10 minutes.` })
    });
    if (!r.ok) return res.status(502).json({ message: 'Could not send SMS.' });
    await pool.query(`INSERT INTO kazi_codes(user_id,phone,code,expires_at,attempts) VALUES($1,$2,$3,now()+interval '10 minutes',0)
      ON CONFLICT(user_id) DO UPDATE SET phone=$2,code=$3,expires_at=now()+interval '10 minutes',attempts=0`, [req.uid, phone, code]);
    res.json({ ok: true });
  }));
  app.post('/api/verification/phone/confirm', auth, wrap(async (req, res) => {
    const c = (await pool.query('SELECT * FROM kazi_codes WHERE user_id=$1', [req.uid])).rows[0];
    if (!c || new Date(c.expires_at) < new Date()) return res.status(400).json({ message: 'Code expired. Request a new one.' });
    if (c.attempts >= 5) return res.status(429).json({ message: 'Too many attempts. Request a new code.' });
    if (String(req.body.code).trim() !== c.code) {
      await pool.query('UPDATE kazi_codes SET attempts=attempts+1 WHERE user_id=$1', [req.uid]);
      return res.status(400).json({ message: 'Wrong code.' });
    }
    await pool.query('INSERT INTO kazi_flags(user_id,phone,phone_verified) VALUES($1,$2,true) ON CONFLICT(user_id) DO UPDATE SET phone=$2,phone_verified=true', [req.uid, c.phone]);
    await pool.query('DELETE FROM kazi_codes WHERE user_id=$1', [req.uid]);
    res.json({ ok: true });
  }));

  // ---------- ID check ----------
  app.post('/api/verification/identity', auth, wrap(async (req, res) => {
    const { docType, front, selfie } = req.body || {};
    if (!docType || !front || !selfie) return res.status(400).json({ message: 'Add the document and a selfie.' });
    if (String(front).length > 3.5e6 || String(selfie).length > 3.5e6) return res.status(413).json({ message: 'Image too large.' });
    await pool.query(`INSERT INTO kazi_flags(user_id,id_status,id_doc_type,id_front,id_selfie,id_submitted_at) VALUES($1,'pending',$2,$3,$4,now())
      ON CONFLICT(user_id) DO UPDATE SET id_status='pending',id_doc_type=$2,id_front=$3,id_selfie=$4,id_submitted_at=now()`, [req.uid, docType, front, selfie]);
    res.json({ ok: true });
  }));

  // ---------- PayPal (Log in with PayPal) ----------
  app.get('/api/paypal/link-url', auth, wrap(async (req, res) => {
    if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_REDIRECT) return res.status(404).json({ message: 'PayPal not configured.' });
    const q = new URLSearchParams({ flowEntry: 'static', client_id: process.env.PAYPAL_CLIENT_ID, response_type: 'code', scope: 'openid email', redirect_uri: process.env.PAYPAL_REDIRECT });
    res.json({ url: `${PP_WWW}/signin/authorize?${q}` });
  }));
  app.post('/api/paypal/link', auth, wrap(async (req, res) => {
    const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`).toString('base64');
    const t = await (await fetch(`${PP_BASE}/v1/oauth2/token`, { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: String(req.body.code || '') }) })).json();
    if (!t.access_token) return res.status(400).json({ message: 'PayPal did not approve the link.' });
    const u = await (await fetch(`${PP_BASE}/v1/identity/oauth2/userinfo?schema=paypalv1.1`, { headers: { Authorization: `Bearer ${t.access_token}` } })).json();
    const email = ((u.emails || []).find(e => e.primary) || (u.emails || [])[0] || {}).value;
    if (!email) return res.status(400).json({ message: 'No email returned by PayPal.' });
    await setFlag(req.uid, 'paypal_email', email); res.json({ ok: true, email });
  }));
  app.post('/api/paypal/unlink', auth, wrap(async (req, res) => { await setFlag(req.uid, 'paypal_email', null); res.json({ ok: true }); }));

  // ---------- Admin: till + review ----------
  app.get('/api/admin/settings', auth, admin, wrap(async (req, res) => {
    const r = await pool.query("SELECT key,value FROM kazi_settings WHERE key IN ('tillNumber','tillName')");
    res.json(Object.fromEntries(r.rows.map(x => [x.key, x.value])));
  }));
  app.patch('/api/admin/settings', auth, admin, wrap(async (req, res) => {
    const till = String(req.body.tillNumber || '').trim();
    if (!/^\d{5,8}$/.test(till)) return res.status(400).json({ message: 'Invalid till number.' });
    for (const [k, v] of [['tillNumber', till], ['tillName', String(req.body.tillName || '')]])
      await pool.query('INSERT INTO kazi_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2', [k, v]);
    res.json({ tillNumber: till, tillName: req.body.tillName || '' });
  }));
  app.get('/api/admin/queue', auth, admin, wrap(async (req, res) => {
    const q = async s => (await pool.query(s)).rows;
    res.json({
      withdrawals: await q("SELECT * FROM kazi_withdrawals WHERE status='pending' ORDER BY id"),
      addresses: await q("SELECT id,user_id,county,area,street,doc_type,file_name FROM kazi_address WHERE status='pending' ORDER BY id"),
      ids: await q("SELECT user_id,id_doc_type,id_submitted_at FROM kazi_flags WHERE id_status='pending'")
    });
  }));
  app.post('/api/admin/withdrawals/:id/:action', auth, admin, wrap(async (req, res) => {
    const s = req.params.action === 'paid' ? 'paid' : 'rejected';
    await pool.query("UPDATE kazi_withdrawals SET status=$1 WHERE id=$2 AND status='pending'", [s, req.params.id]); res.json({ ok: true });
  }));
  app.post('/api/admin/address/:id/:action', auth, admin, wrap(async (req, res) => {
    const ok = req.params.action === 'approve';
    await pool.query('UPDATE kazi_address SET status=$1,reason=$2,verified_at=CASE WHEN $3 THEN now() END WHERE id=$4', [ok ? 'verified' : 'rejected', req.body.reason || null, ok, req.params.id]); res.json({ ok: true });
  }));
  app.post('/api/admin/id/:userId/:action', auth, admin, wrap(async (req, res) => {
    await pool.query('UPDATE kazi_flags SET id_status=$1,id_reason=$2 WHERE user_id=$3', [req.params.action === 'approve' ? 'verified' : 'rejected', req.body.reason || null, req.params.userId]); res.json({ ok: true });
  }));
  app.post('/api/admin/wallet/credit', auth, admin, wrap(async (req, res) => {
    await pool.query('INSERT INTO kazi_ledger(user_id,amount,note) VALUES($1,$2,$3)', [String(req.body.userId), Number(req.body.amount), req.body.note || 'Credit']); res.json({ ok: true });
  }));
  module.exports.getTill = async () => (await pool.query("SELECT value FROM kazi_settings WHERE key='tillNumber'")).rows[0]?.value || process.env.MPESA_SHORTCODE;
};
