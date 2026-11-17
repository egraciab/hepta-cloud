const router     = require('express').Router();
const rateLimit  = require('express-rate-limit');
const { isIP }   = require('net');
const nodemailer = require('nodemailer');
const pool       = require('../config/db');
const erpLeads   = require('../services/erp_leads');
const { enviarCorreo, marco, escapeHtml } = require('../services/correo');

// El correo de aviso es HTML: todo lo que escribió la persona se escapa.
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// IP de quien escribe. El sitio está detrás de Cloudflare: req.ip es la IP del nodo de Cloudflare, que comparten
// muchos visitantes, y contar por ella bloquearía a personas distintas. Cloudflare informa la real en CF-Connecting-IP.
const ipCliente = req => String(req.headers['cf-connecting-ip'] || req.ip || '').trim();

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: ipCliente,
  message: { success: false, error: 'Recibimos varios pedidos seguidos desde tu conexión. Probá de nuevo en un rato o escribinos por WhatsApp.' }
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
      subject: `${lead.intent === 'contratar' ? 'Pedido de contratación' : 'Nuevo lead'}${lead.plan_name ? ' (' + lead.plan_name + ')' : ''}: ${lead.full_name}${lead.company_name ? ' — ' + lead.company_name : ''}`.replace(/[\r\n]+/g, ' '),
      html: `
        <h2 style="color:#0D1F5C">${lead.intent === 'contratar' ? 'Pedido de contratación desde el sitio' : 'Nuevo lead desde el sitio'}</h2>
        <table style="font-family:sans-serif;font-size:14px;border-collapse:collapse;width:100%">
          <tr><td style="padding:8px;color:#6B7280;width:140px">Nombre</td><td style="padding:8px;font-weight:600">${esc(lead.full_name)}</td></tr>
          ${lead.plan_name ? `<tr><td style="padding:8px;color:#6B7280">Plan</td><td style="padding:8px;font-weight:600">${esc(lead.plan_name)}</td></tr>` : ''}
          ${lead.ruc ? `<tr><td style="padding:8px;color:#6B7280">RUC</td><td style="padding:8px">${esc(lead.ruc)}</td></tr>` : ''}
          ${lead.company_name ? `<tr><td style="padding:8px;color:#6B7280">Empresa</td><td style="padding:8px">${esc(lead.company_name)}</td></tr>` : ''}
          ${lead.email ? `<tr><td style="padding:8px;color:#6B7280">Email</td><td style="padding:8px"><a href="mailto:${esc(lead.email)}">${esc(lead.email)}</a></td></tr>` : ''}
          ${lead.phone ? `<tr><td style="padding:8px;color:#6B7280">Teléfono</td><td style="padding:8px"><a href="tel:${esc(lead.phone)}">${esc(lead.phone)}</a></td></tr>` : ''}
          ${lead.message ? `<tr><td style="padding:8px;color:#6B7280;vertical-align:top">Mensaje</td><td style="padding:8px">${esc(lead.message).replace(/\n/g, '<br/>')}</td></tr>` : ''}
          <tr><td style="padding:8px;color:#6B7280">Fuente</td><td style="padding:8px">${esc(lead.source)}</td></tr>
        </table>
        <p style="margin-top:20px"><a href="https://cloud.hepta.com.py/admin/" style="background:#1254A4;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-family:sans-serif;font-size:14px">Ver en el panel admin →</a></p>
      `,
    });
  } catch (err) {
    console.error('[leads/notify]', err.message);
    // No fallar el request por esto
  }
}

// ── Link de pago del plan ──
// Vive en site_config como tpago_link_<slug> (se edita en Admin → Planes). Solo se acepta un enlace https.
async function linkDePago(slug) {
  if (!slug) return '';
  const { rows } = await pool.query('SELECT value FROM site_config WHERE key = $1', [`tpago_link_${slug}`]);
  const v = (rows[0]?.value || '').trim();
  return /^https:\/\/[^\s"'<>]+$/i.test(v) ? v : '';
}

// Confirmación al cliente cuando pide contratar: qué pidió, cuánto es y, si hay, el botón de pago.
// Así no pierde el link si cierra la ventana del sitio antes de pagar.
async function confirmarPedido(lead, plan, link) {
  const nombre = escapeHtml(lead.full_name.split(' ')[0]);
  const boton = link
    ? `<p style="margin:20px 0"><a href="${escapeHtml(link)}" style="background:#1254A4;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:700">Pagar el primer mes con tPago</a></p>
       <p style="font-size:13px;color:#6B7280">Si preferís pagar por transferencia o QR, respondé este correo y te pasamos los datos.</p>`
    : '<p>En menos de 24 horas hábiles te escribimos con los datos para pagar el primer mes (transferencia, tPago o QR).</p>';
  await enviarCorreo({
    to: lead.email,
    subject: `Recibimos tu pedido: ${plan.name}`.replace(/[\r\n]+/g, ' '),
    html: marco('Recibimos tu pedido', `
      <p>Hola, ${nombre}. Gracias por elegir Hepta Cloud.</p>
      <table style="font-size:14px;border-collapse:collapse;margin:8px 0 4px">
        <tr><td style="padding:4px 12px 4px 0;color:#6B7280">Plan</td><td style="padding:4px 0;font-weight:700">${escapeHtml(plan.name)}</td></tr>
        ${plan.price_label ? `<tr><td style="padding:4px 12px 4px 0;color:#6B7280">Precio</td><td style="padding:4px 0">${escapeHtml(plan.price_label)} (IVA incluido)</td></tr>` : ''}
        <tr><td style="padding:4px 12px 4px 0;color:#6B7280">Pedido</td><td style="padding:4px 0">#${lead.id}</td></tr>
      </table>
      ${boton}
      <p>Cuando confirmamos el pago damos de alta tu sistema y te llega otro correo con tu usuario y contraseña.</p>
      <p style="font-size:12px;color:#6B7280;margin-top:20px">Contrataste según los <a href="https://cloud.hepta.com.py/terminos" style="color:#1254A4">términos del servicio</a>. ¿Dudas? soporte@hepta.com.py · WhatsApp +595 985 605737.</p>`),
  });
}

const limpio = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// POST /api/leads
// Dos usos: consulta o demo (intent "consulta") y pedido de contratación de un plan (intent "contratar").
// Al contratar, la respuesta trae el link de pago del plan si está cargado.
router.post('/', limiter, async (req, res) => {
  const b = req.body || {};
  // Campo trampa: las personas no lo ven; si viene con algo, es un robot. Se responde "ok" y no se guarda nada.
  if (limpio(b.website, 200)) return res.json({ success: true, data: { id: 0 } });

  const full_name    = limpio(b.full_name, 255);
  const email        = limpio(b.email, 255).toLowerCase();
  const phone        = limpio(b.phone, 50);
  const company_name = limpio(b.company_name, 255);
  const message      = limpio(b.message, 4000);
  const ruc          = limpio(b.ruc, 30);
  const plan_slug    = limpio(b.plan_slug, 100);
  const intent       = b.intent === 'contratar' ? 'contratar' : 'consulta';
  const FUENTES      = ['website', 'whatsapp', 'retopa', 'referral', 'other'];
  const source       = FUENTES.includes(b.source) ? b.source : 'website';
  const error = (msg) => res.status(400).json({ success: false, error: msg });

  if (!full_name || (!email && !phone)) return error('Nombre y al menos un medio de contacto son requeridos');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return error('Revisá el correo: no parece válido.');
  if (phone && phone.replace(/\D/g, '').length < 6) return error('Revisá el teléfono: faltan números.');
  if (ruc && !/^[0-9]{3,10}(-[0-9])?$/.test(ruc)) return error('Revisá el RUC: va con números y, si tiene, guion y dígito verificador.');

  try {
    let plan = null;
    if (plan_slug) {
      const { rows } = await pool.query('SELECT slug, name, price, price_label FROM plans WHERE slug = $1 AND is_active = true', [plan_slug]);
      plan = rows[0] || null;
      if (!plan) return error('Ese plan ya no está disponible. Recargá la página y elegí de nuevo.');
    }
    if (intent === 'contratar') {
      if (!plan) return error('Elegí el plan que querés contratar.');
      if (!email || !phone) return error('Para contratar necesitamos tu correo y tu teléfono.');
      if (b.acepta_terminos !== true) return error('Para contratar tenés que aceptar los términos del servicio y la política de privacidad.');
    }

    const ip = isIP(ipCliente(req)) ? ipCliente(req) : null;   // solo informativa: si no es una IP válida, no se guarda
    const { rows } = await pool.query(
      `INSERT INTO leads (full_name, email, phone, company_name, message, source, ip_address, plan_slug, intent, ruc, acepta_terminos_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CASE WHEN $11 THEN NOW() END) RETURNING *`,
      [full_name, email || null, phone || null, company_name || null, message || null, source, ip,
       plan ? plan.slug : null, intent, ruc || null, intent === 'contratar']
    );
    const lead = rows[0];

    // En segundo plano, sin frenar la respuesta: aviso por correo y envío al ERP.
    notifyNewLead({ ...lead, plan_name: plan?.name });
    erpLeads.enviarLead(lead.id).catch(err => console.error('[leads/erp]', err.message));

    const data = { id: lead.id };
    if (intent === 'contratar') {
      data.pago = { plan: plan.name, precio: plan.price_label || '', link: await linkDePago(plan.slug) };
      confirmarPedido(lead, plan, data.pago.link).catch(err => console.error('[leads/confirmar]', err.message));
    }
    res.json({ success: true, data });
  } catch (err) {
    console.error('[leads POST]', err.message);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

module.exports = router;
