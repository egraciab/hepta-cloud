const router = require('express').Router();
const retopa = (() => { try { return require('./retopa'); } catch(e) { return null; } })();
const pool   = require('../config/db');
const { requireAuth, requireAdmin, requireGodmode } = require('../middleware/auth');
const alta   = require('../services/alta');
const adicionales = require('../services/adicionales');

router.use(requireAuth, requireAdmin);

// ── GET /api/admin/provision/health ──────────────────────────
router.get('/health', async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT key,value FROM site_config WHERE key IN ('provision_api_url','perimetral_api_url')"
    );
    const cfg = Object.fromEntries(rows.map(r => [r.key, r.value]));
    const apiRes = await fetch(`${cfg.provision_api_url}/health`, { signal: AbortSignal.timeout(5000) });
    const data   = await apiRes.json();
    res.json({ success: true, status: data.status, script: data.script, api_url: cfg.provision_api_url });
  } catch (err) {
    res.json({ success: false, status: 'unreachable', error: err.message });
  }
});

// ── POST /api/admin/provision ─────────────────────────────────
// Inicia el alta y responde enseguida (202). El alta sigue en segundo plano: el Admin
// consulta el avance en /jobs/:id. Ver services/alta.js.
router.post('/', async (req, res) => {
  const { user_id, tenant, plan, label } = req.body;
  try {
    const job = await alta.iniciarAlta({ userId: user_id, tenant, plan, label, actorId: req.user.id });
    res.status(202).json({ success: true, data: { job } });
  } catch (err) {
    if (!(err instanceof alta.ErrorAlta)) console.error('[provision]', err.message);
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// ── GET /api/admin/provision/jobs ─────────────────────────────
// Altas en curso y las terminadas en las últimas 24 h
router.get('/jobs', (req, res) => {
  res.json({ success: true, data: alta.listarAltas() });
});

router.get('/jobs/:id', (req, res) => {
  const job = alta.verAlta(req.params.id);
  if (!job) return res.status(404).json({ success: false, error: 'No hay registro de esa alta (¿se reinició el servidor?). Mirá la lista de instancias.' });
  res.json({ success: true, data: job });
});

// ── POST /api/admin/provision/suspend/:id ─────────────────────
router.post('/suspend/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT db_name, status FROM instances WHERE id=$1', [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Instancia no encontrada' });
    if (rows[0].status === 'suspended')
      return res.json({ success: true, message: 'Ya estaba suspendida' });

    const db     = rows[0].db_name;
    const tenant = db.split('.')[0];
    const cfg    = await getConfig();

    await callApi(cfg.provision_api_url, cfg.provision_api_key, 'POST', '/suspend', { db });
    if (cfg.perimetral_api_url)
      await callApi(cfg.perimetral_api_url, cfg.perimetral_api_key, 'POST', '/suspend', { tenant });

    await pool.query(
      "UPDATE instances SET status='suspended', suspended_at=NOW(), updated_at=NOW() WHERE id=$1",
      [req.params.id]
    );
    await logAction(req, 'suspend_instance', `instance:${req.params.id}`, { db, tenant });
    res.json({ success: true, message: `Instancia ${tenant} suspendida.` });
  } catch (err) {
    console.error('[suspend]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/admin/provision/reactivate/:id ──────────────────
router.post('/reactivate/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT db_name, status FROM instances WHERE id=$1', [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Instancia no encontrada' });
    if (rows[0].status === 'active')
      return res.json({ success: true, message: 'Ya estaba activa' });

    const db     = rows[0].db_name;
    const tenant = db.split('.')[0];
    const cfg    = await getConfig();

    await callApi(cfg.provision_api_url, cfg.provision_api_key, 'POST', '/reactivate', { db });
    if (cfg.perimetral_api_url)
      await callApi(cfg.perimetral_api_url, cfg.perimetral_api_key, 'POST', '/reactivate', { tenant });

    await pool.query(
      "UPDATE instances SET status='active', suspended_at=NULL, updated_at=NOW() WHERE id=$1",
      [req.params.id]
    );
    await logAction(req, 'reactivate_instance', `instance:${req.params.id}`, { db, tenant });
    res.json({ success: true, message: `Instancia ${tenant} reactivada.` });
  } catch (err) {
    console.error('[reactivate]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/admin/provision/admin-password/:id (solo godmode) ─
// Genera una contraseña nueva al azar para `admin` (la cuenta de HEPTA en el tenant) y la
// devuelve UNA vez para mostrarla en pantalla. No se guarda en la base, ni en admin_logs, ni en
// la consola: quien la pidió la copia a KeePass. La anterior deja de servir.
router.post('/admin-password/:id', requireGodmode, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { rows } = await pool.query(
      'SELECT db_name, status, instance_url FROM instances WHERE id=$1', [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Instancia no encontrada' });
    if (rows[0].status !== 'active')
      return res.status(409).json({ success: false, error: 'Solo en instancias activas: reactivala antes' });

    const db  = rows[0].db_name;
    const cfg = await getConfig();
    // Odoo tarda unos segundos en levantar el shell del tenant
    const data = await callApi(cfg.provision_api_url, cfg.provision_api_key, 'POST', '/admin-password', { db }, 200000);

    await logAction(req, 'admin_password_tenant', `instance:${req.params.id}`, { db });
    res.json({ success: true, data: {
      login: data.login || 'admin',
      password: data.password,
      url: rows[0].instance_url || `https://${db}`,
    } });
  } catch (err) {
    console.error('[admin-password]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Módulos adicionales (rubros) de una instancia ─────────────
// GET  /api/admin/provision/addons/:id   → los adicionales activos y su estado en la instancia
// POST /api/admin/provision/addons/:id   → instala uno (202 con un trabajo; tarda 1 a 4 minutos)
// GET  /api/admin/provision/addon-jobs/:jobId
router.get('/addons/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.slug, a.name, a.description, a.min_plan, a.price, a.price_label,
              ia.status, ia.error, ia.installed_at
         FROM addons a LEFT JOIN instance_addons ia ON ia.addon_id = a.id AND ia.instance_id = $1
        WHERE a.is_active OR ia.id IS NOT NULL
        ORDER BY a.sort_order, a.id`, [req.params.id]);
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, error: 'Error interno' }); }
});

router.post('/addons/:id', async (req, res) => {
  try {
    const job = await adicionales.iniciar({ instanceId: req.params.id, addonId: req.body.addon_id, actorId: req.user.id });
    res.status(202).json({ success: true, data: { job } });
  } catch (err) {
    if (!(err instanceof alta.ErrorAlta)) console.error('[adicional]', err.message);
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

router.get('/addon-jobs/:jobId', (req, res) => {
  const job = adicionales.ver(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: 'No hay registro de esa instalación (¿se reinició el servidor?). Mirá el estado en la instancia.' });
  res.json({ success: true, data: job });
});

// ── Helpers ───────────────────────────────────────────────────
async function getConfig() {
  const { rows } = await pool.query(
    "SELECT key,value FROM site_config WHERE key IN ('provision_api_url','provision_api_key','perimetral_api_url','perimetral_api_key')"
  );
  const cfg = Object.fromEntries(rows.map(r => [r.key, r.value]));
  if (!cfg.provision_api_url) throw new Error('API de provisioning no configurada');
  return cfg;
}

async function callApi(url, key, method, path, body, timeoutMs = 10000) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-API-Key': key||'' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.detail||data.error||`Error en ${path}`);
  return data;
}

async function logAction(req, action, target, detail) {
  try {
    await pool.query(
      'INSERT INTO admin_logs (user_id,action,target,detail) VALUES ($1,$2,$3,$4)',
      [req.user.id, action, target, JSON.stringify(detail)]
    );
  } catch(e) {}
}

// ── GET /api/admin/provision/retopa/categories ───────────────
router.get('/retopa/categories', async (req, res) => {
  try {
    const cfg = await getConfig();
    if (!cfg.retopa_api_url) return res.json({ success: true, data: [] });
    const apiRes = await fetch(`${cfg.retopa_api_url}/api/v2/categories`, {
      signal: AbortSignal.timeout(5000)
    });
    const data = await apiRes.json();
    res.json({ success: true, data: data.data || [] });
  } catch(e) {
    res.json({ success: true, data: [] });
  }
});

// ── POST /api/admin/provision/retopa/create-listing/:id ──────
router.post('/retopa/create-listing/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT i.*, u.email, u.full_name, u.phone
       FROM instances i JOIN users u ON u.id=i.user_id
       WHERE i.id=$1`, [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Instancia no encontrada' });

    const inst = rows[0];
    const { createRetopaListing } = require('./retopa');
    const result = await createRetopaListing({
      user: { id: inst.user_id, email: inst.email, full_name: inst.full_name, phone: inst.phone },
      instance: inst,
      listingData: req.body,
    });

    if (result) {
      res.json({ success: true, data: result });
    } else {
      res.json({ success: false, error: 'No se pudo crear la ficha en RetoPA' });
    }
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;

// ── Dominio propio de una instancia (ver services/dominio_tenant.js) ──
// GET  /api/admin/provision/custom-domain/:id?domain=   → qué hay en el DNS y qué se cambiaría (no cambia nada)
// POST /api/admin/provision/custom-domain/:id           → { domain, reemplazar } → 202 con un trabajo
// GET  /api/admin/provision/custom-domain-jobs/:jobId
// Antes era una sola petición de hasta 2,5 minutos (el proxy la corta al minuto), mandaba el token de Cloudflare a
// la API del NGINX y no tocaba el DNS.
const dominioTenant = require('../services/dominio_tenant');

router.get('/custom-domain/:id', async (req, res) => {
  try {
    res.json({ success: true, data: await dominioTenant.revisar(req.params.id, req.query.domain) });
  } catch (err) {
    if (!(err instanceof alta.ErrorAlta)) console.error('[custom-domain]', err.message);
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

router.post('/custom-domain/:id', async (req, res) => {
  try {
    const job = await dominioTenant.iniciar(req.params.id, req.body.domain,
      { reemplazar: req.body.reemplazar === true, actorId: req.user.id });
    res.status(202).json({ success: true, data: { job } });
  } catch (err) {
    if (!(err instanceof alta.ErrorAlta)) console.error('[custom-domain]', err.message);
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

router.get('/custom-domain-jobs/:jobId', (req, res) => {
  const job = dominioTenant.ver(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: 'No hay registro de ese cambio (¿se reinició el servidor?). Mirá la instancia y admin_logs.' });
  res.json({ success: true, data: job });
});
