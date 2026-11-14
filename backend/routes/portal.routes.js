const router = require('express').Router();
const pool   = require('../config/db');
const odoo   = require('../config/odoo');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/portal/dashboard
router.get('/dashboard', async (req, res) => {
  try {
    const partnerId = req.user.odoo_partner_id;

    // Todas las instancias del usuario
    const { rows: instances } = await pool.query(
      `SELECT i.id, i.label, i.instance_url, i.plan, i.status, i.odoo_version, i.activated_at, i.db_name, i.custom_domain, i.custom_domain_status
       FROM instances i
       JOIN users u ON u.id = i.user_id
       WHERE u.email = $1 AND i.status != 'cancelled'
       ORDER BY CASE WHEN i.status='active' THEN 0 ELSE 1 END, i.id DESC`,
      [req.user.email]
    );

    // Primera instancia activa para KPIs
    const instance = instances.find(i => i.status === 'active') || instances[0] || null;

    let partnerInfo = null;
    let invoicesSummary = null;

    if (partnerId) {
      partnerInfo = await odoo.getPartnerInfo(partnerId);
      const invoices = await odoo.getInvoices(partnerId);
      const pending = invoices.filter(i => i.payment_state !== 'paid' && i.state === 'posted');
      invoicesSummary = {
        total:   invoices.length,
        pending: pending.length,
        total_amount_pending: pending.reduce((s, i) => s + i.amount_total, 0),
      };
    }

    res.json({
      success: true,
      data: {
        instance,
        all_instances:  instances,
        partner_info:   partnerInfo,
        invoices_summary: invoicesSummary,
      }
    });
  } catch (err) {
    console.error('[portal/dashboard]', err.message);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

// GET /api/portal/instance
router.get('/instance', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT i.id, i.label, i.instance_url, i.plan, i.status, i.odoo_version, i.activated_at, i.suspended_at, i.db_name, i.custom_domain, i.custom_domain_status
       FROM instances i
       JOIN users u ON u.id = i.user_id
       WHERE u.email = $1 AND i.status != 'cancelled'
       ORDER BY CASE WHEN i.status='active' THEN 0 ELSE 1 END, i.id DESC`,
      [req.user.email]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[portal/instance]', err.message);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

// GET /api/portal/invoices
router.get('/invoices', async (req, res) => {
  const partnerId = req.user.odoo_partner_id;
  if (!partnerId) return res.json({ success: true, data: [] });
  try {
    const data = await odoo.getInvoices(partnerId);
    res.json({ success: true, data });
  } catch (err) {
    console.error('[portal/invoices]', err.message);
    res.status(500).json({ success: false, error: 'Error al obtener facturas' });
  }
});

// GET /api/portal/tickets
router.get('/tickets', async (req, res) => {
  const partnerId = req.user.odoo_partner_id;
  if (!partnerId) return res.json({ success: true, data: [] });
  try {
    const data = await odoo.getTickets(partnerId);
    res.json({ success: true, data });
  } catch (err) {
    console.error('[portal/tickets]', err.message);
    res.status(500).json({ success: false, error: 'Error al obtener tickets' });
  }
});

// POST /api/portal/tickets
router.post('/tickets', async (req, res) => {
  const partnerId = req.user.odoo_partner_id;
  if (!partnerId) return res.status(400).json({ success: false, error: 'Cuenta no vinculada a Odoo' });
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ success: false, error: 'Título requerido' });
  try {
    // Antes esto armaba su propio cliente XML-RPC leyendo process.env. Ahora va
    // por el módulo, que resuelve la credencial desde el panel y cachea el uid.
    const ticketId = await odoo.crearTicket(partnerId, name, description);
    res.json({ success: true, data: { ticket_id: ticketId } });
  } catch (err) {
    console.error('[portal/tickets POST]', err.message);
    res.status(500).json({ success: false, error: 'Error al crear ticket' });
  }
});


// ── GET /api/portal/account ──────────────────────────────────
// Datos de la cuenta y de la o las entidades a las que se factura. Solo lectura.
router.get('/account', async (req, res) => {
  try {
    const { rows: [u] } = await pool.query('SELECT full_name, email, created_at FROM users WHERE id=$1', [req.user.id]);
    const { rows: clientes } = await pool.query(
      `SELECT c.razon_social, c.nombre_comercial, c.tipo_doc, c.numero_doc, c.dv, c.email, c.telefono
         FROM account_billing_customers a JOIN billing_customers c ON c.id = a.billing_customer_id
        WHERE a.user_id = $1 ORDER BY c.razon_social`, [req.user.id]);
    res.json({ success: true, data: { usuario: u, clientes } });
  } catch (err) {
    console.error('[portal/account]', err.message);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

// ── POST /api/portal/support ─────────────────────────────────
// Consulta de soporte para cuentas que todavía no están vinculadas a la mesa de ayuda: llega por correo
// al equipo (con respuesta directa al cliente) y queda registrada en Leads.
const rateLimit = require('express-rate-limit');
const { enviarCorreo, marco, escapeHtml } = require('../services/correo');
const supportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  keyGenerator: req => 'u' + req.user.id,
  message: { success: false, error: 'Enviaste varias consultas seguidas. Probá de nuevo en un rato o escribinos por WhatsApp.' },
});
router.post('/support', supportLimiter, async (req, res) => {
  const asunto  = String(req.body.asunto || '').trim().slice(0, 150);
  const mensaje = String(req.body.mensaje || '').trim().slice(0, 4000);
  if (!asunto || !mensaje) return res.status(400).json({ success: false, error: 'Contanos el asunto y el detalle de tu consulta' });
  try {
    const { rows: [u] } = await pool.query('SELECT full_name, email FROM users WHERE id=$1', [req.user.id]);
    const { rows: inst } = await pool.query("SELECT label, db_name, plan FROM instances WHERE user_id=$1 AND status <> 'cancelled' ORDER BY id", [req.user.id]);
    const sistemas = inst.map(i => `${i.label || i.db_name} (${i.db_name}, ${i.plan})`).join('; ') || 'sin sistema';
    await pool.query(
      `INSERT INTO leads (full_name, email, company_name, message, source, status) VALUES ($1,$2,$3,$4,'other','new')`,
      [u.full_name || u.email, u.email, inst[0]?.label || null, `[Soporte] ${asunto}\n\n${mensaje}\n\nSistemas: ${sistemas}`]);
    const { rows: cfg } = await pool.query("SELECT key,value FROM site_config WHERE key IN ('contact_email','notify_leads_email')");
    const c = Object.fromEntries(cfg.map(r => [r.key, r.value]));
    const enviado = await enviarCorreo({
      to: c.contact_email || c.notify_leads_email, replyTo: u.email,
      subject: `[Soporte] ${asunto} — ${u.full_name || u.email}`,
      html: marco('Consulta desde el portal', `
        <p style="font-size:14px"><strong>${escapeHtml(u.full_name || '')}</strong> &lt;${escapeHtml(u.email)}&gt;</p>
        <p style="font-size:13px;color:#4B5563">Sistemas: ${escapeHtml(sistemas)}</p>
        <p style="font-size:14px"><strong>${escapeHtml(asunto)}</strong></p>
        <p style="font-size:14px;line-height:1.6;white-space:pre-wrap">${escapeHtml(mensaje)}</p>
        <p style="font-size:12px;color:#6B7280">Respondé este correo para contestarle al cliente.</p>`),
    });
    if (!enviado) console.error('[portal/support] consulta guardada en Leads, pero el correo de aviso no salió');
    res.json({ success: true });
  } catch (err) {
    console.error('[portal/support]', err.message);
    res.status(500).json({ success: false, error: 'No pudimos enviar tu consulta. Escribinos por WhatsApp.' });
  }
});

// ── POST /api/portal/domain-request ──────────────────────────
router.post('/domain-request', async (req, res) => {
  const { instance_id, type, domain, notes } = req.body;
  if (!instance_id || !type)
    return res.status(400).json({ success: false, error: 'instance_id y type son requeridos' });
  try {
    const { rows } = await pool.query(
      'SELECT id, label, db_name FROM instances WHERE id=$1 AND user_id=$2',
      [instance_id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Instancia no encontrada' });
    const inst = rows[0];
    // Va como lead con origen 'other': la tabla no acepta otros orígenes y con 'domain_request' el pedido fallaba.
    const msg = type === 'own'
      ? `[Dominio] Dominio propio: ${domain} para ${inst.label} (${inst.db_name}). Notas: ${notes||'—'}`
      : `[Dominio] Solicitud compra dominio para ${inst.label}. Deseado: ${domain||'a definir'}. Notas: ${notes||'—'}`;
    await pool.query(
      `INSERT INTO leads (full_name, email, company_name, message, source, status)
       VALUES ($1,$2,$3,$4,'other','new')`,
      [req.user.full_name, req.user.email, inst.label, msg]
    );
    await pool.query(
      `UPDATE instances SET custom_domain=$1, custom_domain_status=$2, updated_at=NOW() WHERE id=$3`,
      [domain||null, type==='own'?'pending_dns':'pending_purchase', instance_id]
    );
    res.json({ success: true, message: type==='own'
      ? 'Solicitud recibida. Verificaremos el DNS y activaremos tu dominio en breve.'
      : 'Solicitud recibida. Te contactaremos para gestionar tu dominio.' });
  } catch(err) {
    console.error('[portal/domain-request]', err.message);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

module.exports = router;
