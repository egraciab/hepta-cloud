const router = require('express').Router();
const retopa = (() => { try { return require('./retopa'); } catch(e) { return null; } })();
const pool   = require('../config/db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

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
router.post('/', async (req, res) => {
  const { user_id, tenant, plan, label } = req.body;
  if (!user_id || !tenant)
    return res.status(400).json({ success: false, error: 'user_id y tenant son requeridos' });
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(tenant))
    return res.status(400).json({ success: false, error: 'Tenant inválido' });

  try {
    const cfg = await getConfig();
    const { rows: existing } = await pool.query(
      "SELECT id FROM instances WHERE db_name=$1", [`${tenant}.erp.hepta.com.py`]
    );
    if (existing.length)
      return res.status(409).json({ success: false, error: `El tenant '${tenant}' ya existe` });

    const { rows: userRows } = await pool.query(
      'SELECT id, email, full_name FROM users WHERE id=$1', [user_id]
    );
    if (!userRows.length)
      return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
    const user = userRows[0];

    console.log(`[provision] Iniciando: tenant=${tenant} plan=${plan} user=${user.email}`);

    const apiRes = await fetch(`${cfg.provision_api_url}/provision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': cfg.provision_api_key },
      body: JSON.stringify({
        tenant, plan: plan||'starter',
        client_name: user.full_name||'', client_email: user.email||''
      }),
      signal: AbortSignal.timeout(660000),
    });
    const apiData = await apiRes.json();
    if (!apiRes.ok || !apiData.success)
      return res.status(500).json({ success: false, error: apiData.detail||apiData.error||'Error en provisioning' });

    const { rows: instRows } = await pool.query(
      `INSERT INTO instances (user_id,label,instance_url,db_name,plan,odoo_version,status,activated_at)
       VALUES ($1,$2,$3,$4,$5,'19.0','active',NOW()) RETURNING *`,
      [user_id, label||`${tenant} — Odoo CE`, apiData.url, apiData.db, plan||'starter']
    );

    await logAction(req, 'provision_instance', `instance:${instRows[0].id}`,
      { tenant, plan, url: apiData.url });

    // Email de bienvenida en background
    sendWelcomeEmail({
      to:            user.email,
      nombre:        user.full_name || user.email,
      instancia_url: apiData.url,
      plan:          plan || 'starter',
    });

    console.log(`[provision] OK: tenant=${tenant} url=${apiData.url}`);
    res.json({ success: true, data: { instance: instRows[0], url: apiData.url, tenant } });

  } catch (err) {
    if (err.name === 'TimeoutError')
      return res.status(504).json({ success: false, error: 'Timeout: provisioning tardó más de 11 minutos' });
    console.error('[provision]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
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

// ── Helpers ───────────────────────────────────────────────────
async function getConfig() {
  const { rows } = await pool.query(
    "SELECT key,value FROM site_config WHERE key IN ('provision_api_url','provision_api_key','perimetral_api_url','perimetral_api_key')"
  );
  const cfg = Object.fromEntries(rows.map(r => [r.key, r.value]));
  if (!cfg.provision_api_url) throw new Error('API de provisioning no configurada');
  return cfg;
}

async function callApi(url, key, method, path, body) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-API-Key': key||'' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
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

async function sendWelcomeEmail({ to, nombre, instancia_url, plan }) {
  const nodemailer = require('nodemailer');
  try {
    const { rows: smtpRows } = await pool.query(
      "SELECT key,value FROM site_config WHERE key LIKE 'smtp%' OR key='logo_url'"
    );
    const smtp = Object.fromEntries(smtpRows.map(r => [r.key, r.value]));
    const logoUrl = smtp.logo_url || '';
    if (!smtp.smtp_host) { console.log('[welcome_email] SMTP no configurado'); return; }

    const { rows: tplRows } = await pool.query(
      "SELECT subject, body_html FROM email_templates WHERE slug='welcome_client'"
    );
    if (!tplRows[0]) { console.log('[welcome_email] Plantilla no encontrada'); return; }

    const logoHtml = logoUrl
      ? `<img src="${logoUrl}" alt="Hepta Cloud" style="max-height:40px;max-width:180px;object-fit:contain"/>`
      : `<div style="display:inline-block;background:#1254A4;border-radius:6px;padding:8px 14px"><span style="color:#ffffff;font-size:14px;font-weight:600;letter-spacing:.5px">HEPTA CLOUD</span></div>`;

    const replace = (str) => str
      .replace(/\{\{nombre\}\}/g, nombre)
      .replace(/\{\{instancia_url\}\}/g, instancia_url)
      .replace(/\{\{plan\}\}/g, plan)
      .replace(/\{\{logo_html\}\}/g, logoHtml);

    // Cargar textos editables de email
    const { rows: wcRows } = await pool.query(
      "SELECT key,value FROM site_config WHERE key LIKE 'email_wc_%' OR key='site_url'"
    );
    const wc = Object.fromEntries(wcRows.map(r=>[r.key,r.value]));
    const portalUrl = wc.email_wc_portal_url || wc.site_url + '/portal' || 'https://cloud.hepta.com.py/portal';

    const replaceWc = (str) => replace(str)
      .replace(/\{\{email_titulo\}\}/g,       wc.email_wc_titulo       || '¡Tu sistema está listo!')
      .replace(/\{\{email_subtitulo\}\}/g,    wc.email_wc_subtitulo    || 'Ya podés acceder a tu sistema')
      .replace(/\{\{email_cuerpo\}\}/g,       wc.email_wc_cuerpo       || 'tu instancia fue provisionada y está activa.')
      .replace(/\{\{email_paso1_titulo\}\}/g, wc.email_wc_paso1_titulo || 'Ingresá con las credenciales de administrador')
      .replace(/\{\{email_paso1_desc\}\}/g,   wc.email_wc_paso1_desc   || 'Usuario: admin · Contraseña: admin')
      .replace(/\{\{email_paso2_titulo\}\}/g, wc.email_wc_paso2_titulo || 'Configurá tu empresa')
      .replace(/\{\{email_paso2_desc\}\}/g,   wc.email_wc_paso2_desc   || 'Nombre, RUC, logo y datos de facturación')
      .replace(/\{\{email_paso3_titulo\}\}/g, wc.email_wc_paso3_titulo || 'Explorá tu portal de cliente')
      .replace(/\{\{email_paso3_desc\}\}/g,   wc.email_wc_paso3_desc   || 'Gestioná tu suscripción, facturas y soporte')
      .replace(/\{\{email_cierre\}\}/g,       wc.email_wc_cierre       || '¿Necesitás ayuda? Respondé este email.')
      .replace(/\{\{email_version\}\}/g,      wc.email_wc_version      || 'Hepta Cloud v19')
      .replace(/\{\{portal_url\}\}/g,         portalUrl);

    const transporter = nodemailer.createTransport({
      host: smtp.smtp_host,
      port: parseInt(smtp.smtp_port) || 465,
      secure: smtp.smtp_secure === 'true',
      auth: { user: smtp.smtp_user, pass: smtp.smtp_pass },
      tls: { rejectUnauthorized: false },
    });

    await transporter.sendMail({
      from:    `${smtp.smtp_from_name} <${smtp.smtp_from_email}>`,
      to,
      subject: replaceWc(tplRows[0].subject),
      html:    replaceWc(tplRows[0].body_html),
    });

    console.log(`[welcome_email] Enviado a ${to}`);
  } catch (err) {
    console.error('[welcome_email] Error:', err.message);
  }
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

// ── POST /api/admin/provision/custom-domain/:id ───────────────
// Activa dominio propio para una instancia
router.post('/custom-domain/:id', async (req, res) => {
  const { domain } = req.body;
  if (!domain) return res.status(400).json({ success: false, error: 'domain es requerido' });

  // Validar formato de dominio
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9\-\.]*[a-zA-Z0-9])?$/.test(domain)) {
    return res.status(400).json({ success: false, error: 'Formato de dominio inválido' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT db_name, label, status FROM instances WHERE id=$1', [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Instancia no encontrada' });
    if (rows[0].status === 'cancelled')
      return res.status(400).json({ success: false, error: 'Instancia cancelada' });

    const cfg = await getConfig();
    const { rows: cfgRows } = await pool.query(
      "SELECT key,value FROM site_config WHERE key IN ('perimetral_certbot_email','certbot_email','cloudflare_api_token')"
    );
    const cfgMap = Object.fromEntries(cfgRows.map(r=>[r.key,r.value]));
    const certbotEmail = cfgMap.certbot_email || cfgMap.perimetral_certbot_email || 'admin@hepta.com.py';
    const cfToken = cfgMap.cloudflare_api_token || '';

    console.log(`[custom-domain] Activando: ${domain} → ${rows[0].db_name}`);

    // Llamar API Perimetral
    const apiRes = await fetch(`${cfg.perimetral_api_url}/vhost`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': cfg.perimetral_api_key },
      body: JSON.stringify({
        domain,
        db:                rows[0].db_name,
        certbot_email:     certbotEmail,
        cf_token:          cfToken,
        disable_subdomain: true,
      }),
      signal: AbortSignal.timeout(150000), // 2.5 min para certbot
    });

    const apiData = await apiRes.json();
    if (!apiRes.ok || !apiData.success)
      return res.status(500).json({ success: false, error: apiData.detail || apiData.error });

    // Actualizar instancia en HC
    await pool.query(
      `UPDATE instances SET
         custom_domain=$1,
         custom_domain_status='active',
         instance_url=$2,
         updated_at=NOW()
       WHERE id=$3`,
      [domain, `https://${domain}`, req.params.id]
    );

    await logAction(req, 'activate_custom_domain', `instance:${req.params.id}`,
      { domain, db: rows[0].db_name, ssl: apiData.ssl });

    res.json({
      success: true,
      data: {
        domain,
        ssl:     apiData.ssl,
        url:     `https://${domain}`,
        message: apiData.message,
      }
    });

  } catch (err) {
    if (err.name === 'TimeoutError')
      return res.status(504).json({ success: false, error: 'Timeout en activación SSL' });
    console.error('[custom-domain]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/portal/domain-request ──────────────────────────
// Cliente solicita dominio propio desde el portal
// Se registra como lead interno con tipo domain_request
