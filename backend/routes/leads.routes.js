const router     = require('express').Router();
const rateLimit  = require('express-rate-limit');
const nodemailer = require('nodemailer');
const pool       = require('../config/db');

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { success: false, error: 'Demasiadas solicitudes, intentá más tarde.' }
});

async function notifyNewLead(lead) {
  try {
    const { rows } = await pool.query(
      "SELECT key, value FROM site_config WHERE key LIKE 'smtp_%' OR key = 'notify_leads_email'"
    );
    const cfg = Object.fromEntries(rows.map(r => [r.key, r.value]));
    if (!cfg.notify_leads_email || !cfg.smtp_host) return;

    const transporter = nodemailer.createTransport({
      host: cfg.smtp_host, port: parseInt(cfg.smtp_port) || 465,
      secure: cfg.smtp_secure === 'true',
      auth: { user: cfg.smtp_user, pass: cfg.smtp_pass },
      tls: { rejectUnauthorized: false },
    });

    await transporter.sendMail({
      from: `${cfg.smtp_from_name} <${cfg.smtp_from_email}>`,
      to: cfg.notify_leads_email,
      subject: `Nuevo lead: ${lead.full_name}${lead.company_name ? ' — ' + lead.company_name : ''}`,
      html: `
        <h2 style="color:#0D1F5C">Nuevo lead desde el sitio</h2>
        <table style="font-family:sans-serif;font-size:14px;border-collapse:collapse;width:100%">
          <tr><td style="padding:8px;color:#6B7280;width:140px">Nombre</td><td style="padding:8px;font-weight:600">${lead.full_name}</td></tr>
          ${lead.company_name ? `<tr><td style="padding:8px;color:#6B7280">Empresa</td><td style="padding:8px">${lead.company_name}</td></tr>` : ''}
          ${lead.email ? `<tr><td style="padding:8px;color:#6B7280">Email</td><td style="padding:8px"><a href="mailto:${lead.email}">${lead.email}</a></td></tr>` : ''}
          ${lead.phone ? `<tr><td style="padding:8px;color:#6B7280">Teléfono</td><td style="padding:8px"><a href="tel:${lead.phone}">${lead.phone}</a></td></tr>` : ''}
          ${lead.message ? `<tr><td style="padding:8px;color:#6B7280;vertical-align:top">Mensaje</td><td style="padding:8px">${lead.message}</td></tr>` : ''}
          <tr><td style="padding:8px;color:#6B7280">Fuente</td><td style="padding:8px">${lead.source}</td></tr>
        </table>
        <p style="margin-top:20px"><a href="https://cloud1.hepta.com.py/admin/" style="background:#1254A4;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-family:sans-serif;font-size:14px">Ver en el panel admin →</a></p>
      `,
    });
  } catch (err) {
    console.error('[leads/notify]', err.message);
    // No fallar el request por esto
  }
}

// POST /api/leads
router.post('/', limiter, async (req, res) => {
  const { full_name, email, phone, company_name, message, source } = req.body;

  if (!full_name || (!email && !phone)) {
    return res.status(400).json({
      success: false,
      error: 'Nombre y al menos un medio de contacto son requeridos'
    });
  }

  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
    const { rows } = await pool.query(
      `INSERT INTO leads (full_name, email, phone, company_name, message, source, ip_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        full_name.trim(),
        email?.trim().toLowerCase() || null,
        phone?.trim() || null,
        company_name?.trim() || null,
        message?.trim() || null,
        source || 'website',
        ip
      ]
    );

    // Notificar por email en background (no bloquea la respuesta)
    notifyNewLead(rows[0]);

    res.json({ success: true, data: { id: rows[0].id } });
  } catch (err) {
    console.error('[leads POST]', err.message);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

module.exports = router;
