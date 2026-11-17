const router     = require('express').Router();
const rateLimit  = require('express-rate-limit');
const { isIP }   = require('net');
const crypto     = require('crypto');
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

// ── Botón de pago con aviso ──
// El botón "Pagar con tPago" (del sitio y del correo) no va directo a tPago: pasa por /api/leads/:id/pagar, que anota
// el clic, avisa a ventas para que valide el pago en Bancard Comercios y recién ahí redirige. El enlace lleva una firma
// para que nadie pueda disparar avisos de pedidos ajenos cambiando el número.
const firmaPago = id => crypto.createHmac('sha256', process.env.JWT_SECRET || 'sin-clave').update(`pago:${id}`).digest('base64url').slice(0, 24);
async function urlSitio() {
  const { rows } = await pool.query("SELECT value FROM site_config WHERE key = 'site_url'");
  return ((rows[0] && rows[0].value) || 'https://cloud.hepta.com.py').replace(/\/+$/, '');
}
const rutaPago = id => `/api/leads/${id}/pagar?t=${firmaPago(id)}`;

async function avisarClicPago(lead) {
  const { rows } = await pool.query("SELECT value FROM site_config WHERE key = 'notify_leads_email'");
  const destino = rows[0] && rows[0].value;
  const cuando = new Date().toLocaleString('es-PY', { timeZone: 'America/Asuncion', dateStyle: 'short', timeStyle: 'short' });
  if (destino) {
    await enviarCorreo({
      to: destino,
      subject: `Fue a pagar con tPago: ${lead.full_name}${lead.plan_name ? ' (' + lead.plan_name + ')' : ''}`.replace(/[\r\n]+/g, ' '),
      html: marco('Un cliente fue a pagar con tPago', `
        <p><strong>${escapeHtml(lead.full_name)}</strong>${lead.company_name ? ' — ' + escapeHtml(lead.company_name) : ''} tocó "Pagar con tPago" el ${escapeHtml(cuando)}.</p>
        <table style="font-size:14px;border-collapse:collapse;margin:8px 0">
          ${lead.plan_name ? `<tr><td style="padding:4px 12px 4px 0;color:#6B7280">Plan</td><td style="padding:4px 0;font-weight:700">${escapeHtml(lead.plan_name)}${lead.plan_price_label ? ' · ' + escapeHtml(lead.plan_price_label) : ''}</td></tr>` : ''}
          ${lead.email ? `<tr><td style="padding:4px 12px 4px 0;color:#6B7280">Correo</td><td style="padding:4px 0">${escapeHtml(lead.email)}</td></tr>` : ''}
          ${lead.phone ? `<tr><td style="padding:4px 12px 4px 0;color:#6B7280">Teléfono</td><td style="padding:4px 0">${escapeHtml(lead.phone)}</td></tr>` : ''}
          <tr><td style="padding:4px 12px 4px 0;color:#6B7280">Pedido</td><td style="padding:4px 0">#${lead.id}</td></tr>
        </table>
        <p><strong>Siguiente paso:</strong> validá en Bancard Comercios que el pago entró. Si entró, hacé el alta desde el Admin (Usuarios → Nuevo, después Instancias → Nueva instancia).</p>
        <p style="font-size:12px;color:#6B7280">Tocar el botón no garantiza que haya pagado: puede haber cerrado tPago sin terminar.</p>`),
    });
  }
  // Nota en la oportunidad del ERP, si ya existe
  if (lead.odoo_lead_id) {
    const odoo = require('../config/odoo');
    await odoo.erp.ejecutar('crm.lead', 'message_post', [[lead.odoo_lead_id]], {
      body: `Tocó "Pagar con tPago" en cloud.hepta.com.py (${cuando}). Validar el pago en Bancard Comercios.`,
      message_type: 'comment', subtype_xmlid: 'mail.mt_note',
    }).catch(err => console.error('[leads/pago erp]', lead.id, err.message));
  }
}

// GET /api/leads/:id/pagar?t=<firma> → anota el primer clic, avisa y redirige al link de pago del plan
router.get('/:id(\\d+)/pagar', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const t = String(req.query.t || '');
  const ok = t.length === 24 && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(firmaPago(id)));
  const volver = async () => res.redirect(302, (await urlSitio()) + '/#planes');
  try {
    if (!ok) return volver();
    const { rows: [lead] } = await pool.query(
      `SELECT l.*, p.name AS plan_name, p.price_label AS plan_price_label
         FROM leads l LEFT JOIN plans p ON p.slug = l.plan_slug WHERE l.id = $1`, [id]);
    const link = lead && await linkDePago(lead.plan_slug);
    if (!link) return volver();
    // Solo el primer clic avisa: si vuelve a tocar el botón, va directo a tPago.
    const { rowCount } = await pool.query('UPDATE leads SET pago_clic_at = NOW() WHERE id = $1 AND pago_clic_at IS NULL', [id]);
    if (rowCount) avisarClicPago(lead).catch(err => console.error('[leads/pago aviso]', id, err.message));
    res.redirect(302, link);
  } catch (err) {
    console.error('[leads/pagar]', err.message);
    volver().catch(() => res.status(500).end());
  }
});

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
      const hayLink = !!(await linkDePago(plan.slug));
      data.pago = { plan: plan.name, precio: plan.price_label || '', link: hayLink ? rutaPago(lead.id) : '' };
      const linkCorreo = hayLink ? (await urlSitio()) + rutaPago(lead.id) : '';
      confirmarPedido(lead, plan, linkCorreo).catch(err => console.error('[leads/confirmar]', err.message));
    }
    res.json({ success: true, data });
  } catch (err) {
    console.error('[leads POST]', err.message);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

module.exports = router;
