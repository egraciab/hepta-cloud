// Envío de correo con el SMTP cargado en site_config. No lanza: devuelve true/false y deja el motivo en el log.
const nodemailer = require('nodemailer');
const pool = require('../config/db');

const escapeHtml = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function enviarCorreo({ to, subject, html, replyTo }) {
  if (!to) return false;
  try {
    const { rows } = await pool.query("SELECT key,value FROM site_config WHERE key LIKE 'smtp%'");
    const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
    if (!s.smtp_host) { console.error('[correo] SMTP sin configurar'); return false; }
    const transporter = nodemailer.createTransport({
      host: s.smtp_host, port: parseInt(s.smtp_port) || 465,
      secure: s.smtp_secure === 'true',
      auth: { user: s.smtp_user, pass: s.smtp_pass },
      tls: { rejectUnauthorized: false },
    });
    await transporter.sendMail({
      from: `${s.smtp_from_name || 'Hepta Cloud'} <${s.smtp_from_email || s.smtp_user}>`,
      to, subject, html, ...(replyTo ? { replyTo } : {}),
    });
    return true;
  } catch (e) {
    console.error('[correo]', e.message);
    return false;
  }
}

// Marco común de los correos cortos (recuperar contraseña, consultas)
function marco(titulo, cuerpoHtml) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1F2937">
  <div style="background:#0D1F5C;color:#fff;padding:18px 24px;border-radius:10px 10px 0 0;font-weight:700;letter-spacing:.5px">HEPTA <span style="font-weight:400;opacity:.8">CLOUD</span></div>
  <div style="border:1px solid #E5E7EB;border-top:0;border-radius:0 0 10px 10px;padding:24px">
    <h2 style="margin:0 0 12px;font-size:18px;color:#0D1F5C">${escapeHtml(titulo)}</h2>
    ${cuerpoHtml}
  </div></div>`;
}

module.exports = { enviarCorreo, marco, escapeHtml };
