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
      `SELECT i.id, i.label, i.instance_url, i.plan, i.status, i.odoo_version, i.activated_at, i.db_name
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
    const msg = type === 'own'
      ? `Dominio propio: ${domain} para ${inst.label} (${inst.db_name}). Notas: ${notes||'—'}`
      : `Solicitud compra dominio para ${inst.label}. Deseado: ${domain||'a definir'}. Notas: ${notes||'—'}`;
    await pool.query(
      `INSERT INTO leads (full_name, email, company_name, message, source, status)
       VALUES ($1,$2,$3,$4,'domain_request','new')`,
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
