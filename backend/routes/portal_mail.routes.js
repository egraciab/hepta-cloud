const router = require('express').Router();
const mail = require('../services/mailcow');
const { requireAuth } = require('../middleware/auth');

// Parser propio: estas rutas se montan ANTES de /api/portal para ganar
// precedencia, así que no pueden depender de dónde esté el express.json()
// global. Aplicarlo dos veces es inocuo (body-parser saltea si ya parseó).
router.use(require('express').json({ limit: '1mb' }));

router.use(requireAuth);
router.use((req, res, next) => { res.set("Cache-Control", "no-store, no-cache, must-revalidate"); res.set("Pragma", "no-cache"); next(); });

function fail(res, err, tag) {
  console.error(`[${tag}]`, err.message);
  res.status(err.status || 500).json({ success: false, error: err.message });
}

// El email es la clave compartida entre RetoPA y HEPTA Cloud.
function userEmail(req) {
  const u = req.user || {};
  return u.email || u.correo || u.user_email || null;
}

/**
 * Resuelve y valida la propiedad del dominio. TODA ruta de este archivo
 * tiene que empezar con esto — la API key de mailcow es global y este es
 * el único punto que impide que un cliente toque el correo de otro.
 */
async function owned(req) {
  const email = userEmail(req);
  if (!email) {
    const err = new Error('Sesión sin email asociado');
    err.status = 401;
    throw err;
  }
  await mail.assertOwnership(req.params.domain, email);
  return mail.normalizeDomain(req.params.domain);
}

// ── Diagnóstico: qué trae el JWT (sacalo cuando verifiques) ──
router.get('/whoami', (req, res) => {
  res.json({
    success: true,
    data: { campos: Object.keys(req.user || {}), email_detectado: userEmail(req) },
  });
});

// ── Dominios del cliente ─────────────────────────────────────
router.get('/domains', async (req, res) => {
  try {
    const email = userEmail(req);
    if (!email) return res.status(401).json({ success: false, error: 'Sesión sin email asociado' });
    res.json({ success: true, data: await mail.listDomainsByOwner(email) });
  } catch (err) { fail(res, err, 'portal/mail/domains'); }
});

// ── Casillas ─────────────────────────────────────────────────
router.get('/domains/:domain/mailboxes', async (req, res) => {
  try {
    const domain = await owned(req);
    res.json({ success: true, data: await mail.listMailboxes(domain) });
  } catch (err) { fail(res, err, 'portal/mail/mailboxes GET'); }
});

router.post('/domains/:domain/mailboxes', async (req, res) => {
  try {
    const domain = await owned(req);
    const { local_part: localPart, name, quota_mb: quotaMb, password } = req.body || {};
    const created = await mail.createMailbox(domain, { localPart, name, quotaMb, password });
    res.status(201).json({ success: true, data: created });
  } catch (err) { fail(res, err, 'portal/mail/mailboxes POST'); }
});

router.patch('/domains/:domain/mailboxes/:address', async (req, res) => {
  try {
    const domain = await owned(req);
    const { quota_mb: quotaMb, name, active, password } = req.body || {};
    const updated = await mail.updateMailbox(domain, req.params.address, { quotaMb, name, active, password });
    res.json({ success: true, data: updated });
  } catch (err) { fail(res, err, 'portal/mail/mailboxes PATCH'); }
});

router.post('/domains/:domain/mailboxes/:address/reset-password', async (req, res) => {
  try {
    const domain = await owned(req);
    res.json({ success: true, data: await mail.resetPassword(domain, req.params.address) });
  } catch (err) { fail(res, err, 'portal/mail/reset-password'); }
});

router.delete('/domains/:domain/mailboxes/:address', async (req, res) => {
  try {
    const domain = await owned(req);
    res.json({ success: true, data: await mail.deleteMailbox(domain, req.params.address) });
  } catch (err) { fail(res, err, 'portal/mail/mailboxes DELETE'); }
});

// ── Alias internos ───────────────────────────────────────────
router.get('/domains/:domain/aliases', async (req, res) => {
  try {
    const domain = await owned(req);
    res.json({ success: true, data: await mail.listAliases(domain) });
  } catch (err) { fail(res, err, 'portal/mail/aliases GET'); }
});

router.post('/domains/:domain/aliases', async (req, res) => {
  try {
    const domain = await owned(req);
    const { local_part: localPart, goto } = req.body || {};
    const created = await mail.createAlias(domain, { localPart, goto });
    res.status(201).json({ success: true, data: created });
  } catch (err) { fail(res, err, 'portal/mail/aliases POST'); }
});

router.delete('/domains/:domain/aliases/:id', async (req, res) => {
  try {
    const domain = await owned(req);
    res.json({ success: true, data: await mail.deleteAlias(domain, req.params.id) });
  } catch (err) { fail(res, err, 'portal/mail/aliases DELETE'); }
});

// ── DNS y datos de configuración del cliente de correo ───────
router.get('/domains/:domain/dns', async (req, res) => {
  try {
    const domain = await owned(req);
    res.json({ success: true, data: await mail.getDnsPlan(domain) });
  } catch (err) { fail(res, err, 'portal/mail/dns'); }
});

router.get('/domains/:domain/settings', async (req, res) => {
  try {
    const domain = await owned(req);
    const host = process.env.MAIL_HOSTNAME || 'mail.hepta.com.py';
    // Si el cliente tiene webmail con su propia marca, mostramos ese.
    const row = await mail.findDomain(domain);
    const webmailHost = (row && row.webmail_host) || host;
    res.json({
      success: true,
      data: {
        domain,
        webmail: `https://${webmailHost}/SOGo/`,
        webmail_propio: Boolean(row && row.webmail_host),
        imap: { host, port: 993, security: 'SSL/TLS' },
        smtp: { host, port: 465, security: 'SSL/TLS', auth: 'requerida' },
        smtp_alt: { host, port: 587, security: 'STARTTLS' },
        usuario: 'la dirección de correo completa',
      },
    });
  } catch (err) { fail(res, err, 'portal/mail/settings'); }
});

module.exports = router;
