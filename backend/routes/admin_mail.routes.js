const router = require('express').Router();
const mail = require('../services/mailcow');
const mc = require('../services/mailcow/client');
const { applyDnsPlan } = require('../services/mailcow/cloudflare');
const { requireAuth, requireAdmin } = require('../middleware/auth');

// Parser propio: estas rutas se montan ANTES de /api/admin para ganar
// precedencia, así que no pueden depender de dónde esté el express.json()
// global. Aplicarlo dos veces es inocuo (body-parser saltea si ya parseó).
router.use(require('express').json({ limit: '1mb' }));

router.use(requireAuth, requireAdmin);
router.use((req, res, next) => { res.set("Cache-Control", "no-store, no-cache, must-revalidate"); res.set("Pragma", "no-cache"); next(); });

function fail(res, err, tag) {
  console.error(`[${tag}]`, err.message);
  const status = err.status || 500;
  res.status(status).json({ success: false, error: err.message });
}

// ── Health del servicio de correo ────────────────────────────
router.get('/health', async (req, res) => {
  try {
    await mc.ping();
    res.json({ success: true, data: { mailcow: 'ok', url: process.env.MAILCOW_URL || null } });
  } catch (err) {
    console.error('[admin/mail/health]', err.message);
    res.status(502).json({ success: false, error: err.message });
  }
});

// ── Dominios ─────────────────────────────────────────────────
router.get('/domains', async (req, res) => {
  try {
    res.json({ success: true, data: await mail.listAllDomains() });
  } catch (err) { fail(res, err, 'admin/mail/domains GET'); }
});

/**
 * Alta / re-sincronización de un dominio de correo. Idempotente.
 * body: { domain, owner_email, quota_mb?, def_quota_mb?, max_mailboxes?, plan_code?, publish_dns? }
 */
router.post('/domains', async (req, res) => {
  try {
    const {
      domain,
      owner_email: ownerEmail,
      quota_mb: quotaMb,
      def_quota_mb: defQuotaMb,
      max_mailboxes: maxMailboxes,
      plan_code: planCode,
      description,
      publish_dns: publishDns = false,
    } = req.body || {};

    const result = await mail.provisionDomain({
      domain,
      ownerEmail,
      quotaMb: quotaMb ? Number(quotaMb) : undefined,
      defQuotaMb: defQuotaMb ? Number(defQuotaMb) : undefined,
      maxMailboxes: maxMailboxes ? Number(maxMailboxes) : undefined,
      planCode: planCode || null,
      description,
    });

    if (publishDns) {
      try {
        result.cloudflare = await applyDnsPlan(result.dns);
      } catch (err) {
        console.error('[admin/mail/domains POST cloudflare]', err.message);
        result.cloudflare = { error: err.message };
      }
    }

    res.status(result.created ? 201 : 200).json({ success: true, data: result });
  } catch (err) { fail(res, err, 'admin/mail/domains POST'); }
});

// ── DNS ──────────────────────────────────────────────────────
router.get('/domains/:domain/dns', async (req, res) => {
  try {
    await mail.assertOwnership(req.params.domain, null, { isAdmin: true, role: req.user && req.user.role });
    res.json({ success: true, data: await mail.getDnsPlan(req.params.domain) });
  } catch (err) { fail(res, err, 'admin/mail/dns GET'); }
});

router.post('/domains/:domain/dns/publish', async (req, res) => {
  try {
    await mail.assertOwnership(req.params.domain, null, { isAdmin: true, role: req.user && req.user.role });
    const plan = await mail.getDnsPlan(req.params.domain);
    const result = await applyDnsPlan(plan, {
      onlyRequired: Boolean(req.body && req.body.only_required),
      dryRun: Boolean(req.body && req.body.dry_run),
    });
    res.json({ success: true, data: result });
  } catch (err) { fail(res, err, 'admin/mail/dns publish'); }
});

// ── Suspensión / reactivación (mismo patrón que las instancias Odoo) ──
router.post('/domains/:domain/suspend', async (req, res) => {
  try {
    await mail.assertOwnership(req.params.domain, null, { isAdmin: true, role: req.user && req.user.role });
    res.json({ success: true, data: await mail.setDomainStatus(req.params.domain, 'suspended') });
  } catch (err) { fail(res, err, 'admin/mail/suspend'); }
});

router.post('/domains/:domain/activate', async (req, res) => {
  try {
    await mail.assertOwnership(req.params.domain, null, { isAdmin: true, role: req.user && req.user.role });
    res.json({ success: true, data: await mail.setDomainStatus(req.params.domain, 'active') });
  } catch (err) { fail(res, err, 'admin/mail/activate'); }
});

// ── Buzones desde el admin (soporte) ─────────────────────────
router.get('/domains/:domain/mailboxes', async (req, res) => {
  try {
    await mail.assertOwnership(req.params.domain, null, { isAdmin: true, role: req.user && req.user.role });
    res.json({ success: true, data: await mail.listMailboxes(req.params.domain) });
  } catch (err) { fail(res, err, 'admin/mail/mailboxes GET'); }
});

router.post('/domains/:domain/mailboxes', async (req, res) => {
  try {
    await mail.assertOwnership(req.params.domain, null, { isAdmin: true, role: req.user && req.user.role });
    const { local_part: localPart, name, quota_mb: quotaMb, password } = req.body || {};
    const created = await mail.createMailbox(req.params.domain, { localPart, name, quotaMb, password });
    res.status(201).json({ success: true, data: created });
  } catch (err) { fail(res, err, 'admin/mail/mailboxes POST'); }
});

router.post('/domains/:domain/mailboxes/:address/reset-password', async (req, res) => {
  try {
    await mail.assertOwnership(req.params.domain, null, { isAdmin: true, role: req.user && req.user.role });
    res.json({ success: true, data: await mail.resetPassword(req.params.domain, req.params.address) });
  } catch (err) { fail(res, err, 'admin/mail/reset-password'); }
});

router.delete('/domains/:domain/mailboxes/:address', async (req, res) => {
  try {
    await mail.assertOwnership(req.params.domain, null, { isAdmin: true, role: req.user && req.user.role });
    res.json({ success: true, data: await mail.deleteMailbox(req.params.domain, req.params.address) });
  } catch (err) { fail(res, err, 'admin/mail/mailboxes DELETE'); }
});

// ── Alias ────────────────────────────────────────────────────
router.get('/domains/:domain/aliases', async (req, res) => {
  try {
    await mail.assertOwnership(req.params.domain, null, { isAdmin: true, role: req.user && req.user.role });
    res.json({ success: true, data: await mail.listAliases(req.params.domain) });
  } catch (err) { fail(res, err, 'admin/mail/aliases GET'); }
});

/**
 * body: { local_part, goto, allow_external? }
 * local_part '@' o '*' crea un catch-all.
 * allow_external solo lo permite godmode: un alias hacia afuera te convierte
 * en reenviador y es riesgo de blacklist.
 */
router.post('/domains/:domain/aliases', async (req, res) => {
  try {
    await mail.assertOwnership(req.params.domain, null, { isAdmin: true, role: req.user && req.user.role });
    const { local_part: localPart, goto, allow_external: allowExternal } = req.body || {};
    const externo = Boolean(allowExternal) && req.user && req.user.role === 'godmode';
    const created = await mail.createAlias(req.params.domain, { localPart, goto }, { allowExternal: externo });
    res.status(201).json({ success: true, data: created });
  } catch (err) { fail(res, err, 'admin/mail/aliases POST'); }
});

router.delete('/domains/:domain/aliases/:id', async (req, res) => {
  try {
    await mail.assertOwnership(req.params.domain, null, { isAdmin: true, role: req.user && req.user.role });
    res.json({ success: true, data: await mail.deleteAlias(req.params.domain, req.params.id) });
  } catch (err) { fail(res, err, 'admin/mail/aliases DELETE'); }
});

// ── Delegación de la gestión al cliente ──────────────────────
router.get('/domains/:domain/delegation', async (req, res) => {
  try {
    res.json({ success: true, data: await mail.getDelegationOptions(req.params.domain) });
  } catch (err) { fail(res, err, 'admin/mail/delegation GET'); }
});

router.post('/domains/:domain/owner', async (req, res) => {
  try {
    const { owner_email: ownerEmail } = req.body || {};
    res.json({ success: true, data: await mail.setDomainOwner(req.params.domain, ownerEmail) });
  } catch (err) { fail(res, err, 'admin/mail/owner POST'); }
});

// ── Webmail con marca propia ─────────────────────────────────
/** body: { webmail_host } — null o vacío vuelve al webmail genérico. */
router.post('/domains/:domain/webmail', async (req, res) => {
  try {
    await mail.assertOwnership(req.params.domain, null, { isAdmin: true, role: req.user && req.user.role });
    const { webmail_host: webmailHost } = req.body || {};
    res.json({ success: true, data: await mail.setWebmailHost(req.params.domain, webmailHost) });
  } catch (err) { fail(res, err, 'admin/mail/webmail POST'); }
});

// ── Branding del webmail: logo y color ───────────────────────
const multer = require('multer');
const fs = require('fs');
const pathMod = require('path');

const subidaLogo = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      try { fs.mkdirSync(mail.LOGO_DIR, { recursive: true }); } catch (_) {}
      cb(null, mail.LOGO_DIR);
    },
    filename: (req, file, cb) => {
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[file.mimetype] || 'png';
      const slug = String(req.params.domain || 'dominio').toLowerCase().replace(/[^a-z0-9]+/g, '-');
      cb(null, `maillogo_${slug}_${Date.now()}.${ext}`);
    },
  }),
  limits: { fileSize: 512 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    // SVG queda afuera a propósito: es ejecutable en el navegador.
    const ok = ['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('Formato no permitido: subí PNG, JPG o WebP'), ok);
  },
}).single('logo');

router.post('/domains/:domain/logo', async (req, res) => {
  try {
    await mail.assertOwnership(req.params.domain, null, { isAdmin: true, role: req.user && req.user.role });
  } catch (err) { return fail(res, err, 'admin/mail/logo auth'); }

  subidaLogo(req, res, async (errSubida) => {
    if (errSubida) {
      console.error('[admin/mail/logo upload]', errSubida.message);
      const msg = errSubida.code === 'LIMIT_FILE_SIZE' ? 'El logo no puede pesar más de 512 KB' : errSubida.message;
      return res.status(400).json({ success: false, error: msg });
    }
    if (!req.file) return res.status(400).json({ success: false, error: 'No llegó ningún archivo' });

    try {
      const r = await mail.setWebmailBranding(req.params.domain, { logoFile: pathMod.basename(req.file.filename) });
      if (r.anterior && r.anterior !== r.webmail_logo_url) mail.borrarLogo(r.anterior);
      res.json({ success: true, data: r });
    } catch (err) {
      mail.borrarLogo(pathMod.basename(req.file.filename)); // no dejamos huérfanos
      fail(res, err, 'admin/mail/logo POST');
    }
  });
});

/** body: { color?, titulo?, quitar_logo? } */
router.post('/domains/:domain/branding', async (req, res) => {
  try {
    await mail.assertOwnership(req.params.domain, null, { isAdmin: true, role: req.user && req.user.role });
    const { color, titulo, quitar_logo: quitarLogo } = req.body || {};
    const cambios = {};
    if (color !== undefined) cambios.color = color || null;
    if (titulo !== undefined) cambios.titulo = titulo || null;
    if (quitarLogo) cambios.logoFile = null;

    const r = await mail.setWebmailBranding(req.params.domain, cambios);
    if (quitarLogo && r.anterior) mail.borrarLogo(r.anterior);
    res.json({ success: true, data: r });
  } catch (err) { fail(res, err, 'admin/mail/branding POST'); }
});

// ── Log de provisioning ──────────────────────────────────────
router.get('/domains/:domain/log', async (req, res) => {
  try {
    res.json({ success: true, data: await mail.getProvisionLog(req.params.domain) });
  } catch (err) { fail(res, err, 'admin/mail/log'); }
});

module.exports = router;
