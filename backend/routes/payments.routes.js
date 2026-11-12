const router     = require('express').Router();
const pool       = require('../config/db');
const bcrypt     = require('bcryptjs');
const nodemailer = require('nodemailer');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const alta = require('../services/alta');

// ── Email helper: usa la config SMTP de site_config. No lanza (loguea y sigue) ──
async function sendMailHC({ to, subject, html }) {
  if (!to) return false;
  try {
    const { rows } = await pool.query("SELECT key,value FROM site_config WHERE key LIKE 'smtp%'");
    const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
    if (!s.smtp_host) return false;
    const transporter = nodemailer.createTransport({
      host: s.smtp_host, port: parseInt(s.smtp_port) || 465,
      secure: s.smtp_secure === 'true',
      auth: { user: s.smtp_user, pass: s.smtp_pass },
      tls: { rejectUnauthorized: false },
    });
    await transporter.sendMail({
      from: `${s.smtp_from_name || 'Hepta Cloud'} <${s.smtp_from_email || s.smtp_user}>`,
      to, subject, html,
    });
    return true;
  } catch (e) {
    console.error('[sendMailHC]', e.message);
    return false;
  }
}

const money = n => `₲ ${(Number(n) || 0).toLocaleString('es-PY')}`;

// ── Sync "al compás": garantiza que el usuario del JWT exista en HC ──
// Cruza SIEMPRE por email (el id del JWT puede venir de RetoPA, no de HC).
// Si no existe en HC, lo crea con un hash temporal (mismo patrón que el
// sync interno RetoPA↔HC). Devuelve el id real del usuario en HC.
async function ensureHcUser(jwtUser) {
  const email = (jwtUser?.email || '').toLowerCase().trim();
  if (!email) throw new Error('JWT sin email');

  const found = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
  if (found.rows.length) return found.rows[0].id;

  const hash = await bcrypt.hash(Math.random().toString(36).slice(-14), 10);
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role)
     VALUES ($1,$2,$3,'client') RETURNING id`,
    [email, hash, jwtUser.full_name || jwtUser.name || email]
  );
  return rows[0].id;
}

// ── POST /api/portal/payment-request ─────────────────────────
// Cliente solicita un plan — registra la solicitud y devuelve el link de pago
router.post('/portal/payment-request', requireAuth, async (req, res) => {
  const { plan, business_name } = req.body;
  if (!plan) return res.status(400).json({ success: false, error: 'plan requerido' });

  try {
    // Plan real desde la tabla `plans` — ÚNICA fuente de verdad (sin hardcode)
    const planQ = await pool.query(
      'SELECT slug, name, price, price_label FROM plans WHERE slug=$1 AND is_active=true',
      [plan]
    );
    if (!planQ.rows.length)
      return res.status(400).json({ success: false, error: 'Plan inválido o inactivo' });

    const amount       = Number(planQ.rows[0].price) || 0;
    const isEnterprise = amount === 0;   // precio 0 = "A consultar"

    // Links Tpago dinámicos desde site_config
    const { rows: cfgRows } = await pool.query(
      "SELECT key,value FROM site_config WHERE key LIKE 'tpago_%'"
    );
    const cfg = Object.fromEntries(cfgRows.map(r => [r.key, r.value]));
    const tpagoLink = cfg[`tpago_link_${plan}`] || '';

    // Sync usuario HC al compás (find-or-create por email)
    const hcUserId = await ensureHcUser(req.user);

    // Registrar solicitud
    const { rows } = await pool.query(
      `INSERT INTO payment_requests
         (user_id, plan, amount, tpago_link, status, notes)
       VALUES ($1,$2,$3,$4,'pending',$5) RETURNING id`,
      [hcUserId, plan, amount, tpagoLink, business_name || null]
    );
    const requestId = rows[0].id;

    // ── Notificaciones por email (no bloquean la respuesta) ──
    const planName    = planQ.rows[0].name || plan;
    const clientEmail = req.user.email;
    const clientName  = req.user.full_name || req.user.name || clientEmail;
    const firstName   = (clientName || '').split(' ')[0] || 'Hola';
    const amountTxt   = isEnterprise ? 'A consultar' : `${money(amount)}/mes`;

    // Email al cliente — recibo de solicitud
    sendMailHC({
      to: clientEmail,
      subject: `Recibimos tu solicitud — ${planName}`,
      html: `<h2>¡Gracias, ${firstName}!</h2>
        <p>Recibimos tu solicitud del <strong>${planName}</strong> (${amountTxt}).</p>
        ${isEnterprise
          ? '<p>Nuestro equipo te va a contactar para armar una propuesta a medida.</p>'
          : '<p>Una vez confirmado el pago, activamos tu sistema y te avisamos por este medio. Podés seguir el estado desde tu portal, en <strong>Mi sistema</strong>.</p>'}
        <p style="color:#64748b;font-size:13px">Solicitud #${requestId} · Hepta Cloud</p>`,
    });

    // Email al equipo de ventas — nueva solicitud
    const { rows: nRows } = await pool.query(
      "SELECT key,value FROM site_config WHERE key IN ('notify_leads_email','contact_email')"
    );
    const nCfg = Object.fromEntries(nRows.map(r => [r.key, r.value]));
    const salesTo = nCfg.notify_leads_email || nCfg.contact_email || '';
    sendMailHC({
      to: salesTo,
      subject: `Nueva solicitud HC: ${planName}${isEnterprise ? ' (Empresa)' : ''}`,
      html: `<h3>Nueva solicitud de Hepta Cloud</h3>
        <table style="font-size:14px">
          <tr><td><strong>Cliente:</strong></td><td>${clientName}</td></tr>
          <tr><td><strong>Email:</strong></td><td>${clientEmail}</td></tr>
          <tr><td><strong>Empresa:</strong></td><td>${business_name || '—'}</td></tr>
          <tr><td><strong>Plan:</strong></td><td>${planName} (${amountTxt})</td></tr>
          <tr><td><strong>Solicitud:</strong></td><td>#${requestId}</td></tr>
        </table>
        <p style="color:#64748b;font-size:13px">Confirmá el pago desde Admin HC → Solicitudes de pago.</p>`,
    });

    if (isEnterprise) {
      return res.json({
        success: true,
        data: {
          type:       'contact',
          request_id: requestId,
          message:    'Te contactaremos para armar una propuesta a medida.',
        }
      });
    }

    res.json({
      success: true,
      data: {
        type:       'tpago',
        request_id: rows[0].id,
        plan,
        amount,
        tpago_link: tpagoLink,
        message:    `Serás redirigido a Tpago para completar el pago de ₲ ${amount.toLocaleString('es-PY')}/mes.`,
      }
    });
  } catch(err) {
    console.error('[payment-request]', err.message);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

// ── GET /api/portal/payment-requests ─────────────────────────
// Cliente ve sus solicitudes de pago
router.get('/portal/payment-requests', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT pr.*, p.name as plan_name
       FROM payment_requests pr
       JOIN users u ON u.id = pr.user_id
       LEFT JOIN plans p ON p.slug = pr.plan
       WHERE u.email = $1
       ORDER BY pr.created_at DESC`,
      [req.user.email]
    );
    res.json({ success: true, data: rows });
  } catch(err) {
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

// ── GET /api/admin/payment-requests ──────────────────────────
// Admin ve todas las solicitudes pendientes
router.get('/admin/payment-requests', requireAuth, requireAdmin, async (req, res) => {
  const { status } = req.query;
  try {
    const { rows } = await pool.query(
      `SELECT pr.*, u.email, u.full_name,
              p.name as plan_name, i.instance_url
       FROM payment_requests pr
       LEFT JOIN users u ON u.id = pr.user_id
       LEFT JOIN plans p ON p.slug = pr.plan
       LEFT JOIN instances i ON i.id = pr.instance_id
       WHERE ($1::text IS NULL OR pr.status = $1)
       ORDER BY pr.created_at DESC`,
      [status || null]
    );
    res.json({ success: true, data: rows });
  } catch(err) {
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

// ── POST /api/admin/payment-requests/:id/confirm ─────────────
// Admin confirma el pago → provisiona automáticamente
router.post('/admin/payment-requests/:id/confirm', requireAuth, requireAdmin, async (req, res) => {
  const { subdomain, label } = req.body;

  try {
    const { rows } = await pool.query(
      `SELECT pr.*, u.email, u.full_name, u.id as uid
       FROM payment_requests pr
       JOIN users u ON u.id = pr.user_id
       WHERE pr.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Solicitud no encontrada' });
    const pr = rows[0];

    if (pr.status === 'provisioned')
      return res.json({ success: true, message: 'Ya estaba provisionado' });

    if (!subdomain)
      return res.status(400).json({ success: false, error: 'subdomain requerido para provisionar' });

    if (pr.status === 'provisioning')
      return res.status(409).json({ success: false, error: 'Esa solicitud ya tiene un alta en curso' });

    // El alta corre en segundo plano (services/alta.js): crea la instancia, marca la solicitud
    // como provisionada y manda el correo de bienvenida. Si falla, la solicitud vuelve a pendiente.
    await pool.query(
      `UPDATE payment_requests SET status='provisioning', confirmed_by=$1, confirmed_at=NOW(), updated_at=NOW() WHERE id=$2`,
      [req.user.id, pr.id]
    );
    let job;
    try {
      job = await alta.iniciarAlta({
        userId: pr.uid, tenant: subdomain, plan: pr.plan, label,
        actorId: req.user.id, paymentRequestId: pr.id,
      });
    } catch (e) {
      await pool.query(
        "UPDATE payment_requests SET status='pending', updated_at=NOW() WHERE id=$1 AND status='provisioning'", [pr.id]);
      throw e;
    }
    res.status(202).json({ success: true, data: { job }, message: `Pago confirmado. Alta de ${job.tenant} en curso.` });
  } catch(err) {
    if (!(err instanceof alta.ErrorAlta)) console.error('[payment/confirm]', err.message);
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// ── POST /api/admin/payment-requests/:id/cancel ──────────────
router.post('/admin/payment-requests/:id/cancel', requireAuth, requireAdmin, async (req, res) => {
  try {
    await pool.query(
      "UPDATE payment_requests SET status='cancelled', updated_at=NOW() WHERE id=$1",
      [req.params.id]
    );
    res.json({ success: true, message: 'Solicitud cancelada.' });
  } catch(err) {
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

module.exports = router;
