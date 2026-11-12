require('dotenv').config();
const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const path       = require('path');
const rateLimit  = require('express-rate-limit');
const pool       = require('./config/db');

const authRoutes   = require('./routes/auth.routes');
const portalRoutes = require('./routes/portal.routes');
const leadsRoutes  = require('./routes/leads.routes');
const adminRoutes      = require('./routes/admin.routes');
const paymentsRoutes  = require('./routes/payments.routes');
const provisionRoutes  = require('./routes/provision.routes');
const publicRoutes = require('./routes/public.routes');

const app  = express();
const PORT = process.env.PORT || 3100;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? ['https://cloud.hepta.com.py', 'https://cloud1.hepta.com.py', 'https://retopa.com.py']
    : '*',
  credentials: true,
}));

// ── Servicio de Correo (mailcow) ─────────────────────────────
app.use('/api/public/mail-branding', require('./routes/public_mail.routes'));  // publico: branding del webmail

app.use('/api/admin/mail',  require('./routes/admin_mail.routes'));
app.use('/api/portal/mail', require('./routes/portal_mail.routes'));

app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000, max: 200,
  standardHeaders: true, legacyHeaders: false,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.set('trust proxy', 1);

// ── API ──────────────────────────────────────────────────────
app.use('/api/auth',   authRoutes);
app.use('/api/portal', portalRoutes);
app.use('/api/leads',  leadsRoutes);
app.use('/api/admin',     adminRoutes);
app.use('/api/admin/provision', provisionRoutes);
app.use('/api', paymentsRoutes);
app.use('/api',        publicRoutes);

// ── Site config público ──────────────────────────────────────
app.get('/api/site-config', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT key, value FROM site_config ORDER BY key');
    const data = Object.fromEntries(rows.map(r => [r.key, r.value]));
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

// ── Health ───────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ success: true, status: 'ok', ts: new Date().toISOString() });
  } catch {
    res.status(503).json({ success: false, status: 'db_error' });
  }
});

// ── Frontend estático ────────────────────────────────────────
const FRONTEND = process.env.FRONTEND_PATH || path.join(__dirname, '..', 'frontend');
app.use(express.static(path.join(FRONTEND, 'assets')));
app.use('/assets', express.static(path.join(FRONTEND, 'assets')));
app.use('/portal', express.static(path.join(FRONTEND, 'public', 'portal')));
app.use('/admin',  express.static(path.join(FRONTEND, 'public', 'admin')));

app.get('/terminos', (req, res) =>
  res.sendFile(path.join(FRONTEND, 'public', 'terminos', 'index.html'),
    err => { if (err) res.status(404).send('Not found'); }));
app.get('/privacidad', (req, res) =>
  res.sendFile(path.join(FRONTEND, 'public', 'privacidad', 'index.html'),
    err => { if (err) res.status(404).send('Not found'); }));

app.get('/portal/*', (req, res) =>
  res.sendFile(path.join(FRONTEND, 'public', 'portal', 'index.html'),
    err => { if (err) res.status(404).send('Portal próximamente'); }));
app.get('/admin/*', (req, res) =>
  res.sendFile(path.join(FRONTEND, 'public', 'admin', 'index.html'),
    err => { if (err) res.status(404).send('Admin próximamente'); }));
app.get('*', (req, res) =>
  res.sendFile(path.join(FRONTEND, 'public', 'index.html'),
    err => { if (err) res.status(404).send('Not found'); }));

app.listen(PORT, () => {
  console.log(`[Hepta Cloud] Servidor corriendo en puerto ${PORT}`);
  console.log(`[Hepta Cloud] Ambiente: ${process.env.NODE_ENV}`);
});
