#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Aviso por email de credenciales próximas a vencer.
//
// Pensado para el cron diario del SO (el mismo que después va a mover la
// outbox). No hace nada si no hay novedades, así que correrlo todos los días
// no molesta a nadie.
//
//   0 8 * * *  docker compose -f /opt/heptacloud/docker-compose.yml exec -T backend \
//              node scripts/avisar_credenciales.js >> /var/log/heptacloud_avisos.log 2>&1
//
// Reglas:
// - Avisa desde 15 días antes del vencimiento, y también las ya vencidas.
// - No repite el aviso de la misma credencial dentro de los 3 días.
// - El SMTP sale de site_config, igual que el resto del sistema.
// ---------------------------------------------------------------------------
require('dotenv').config();
const nodemailer = require('nodemailer');
const pool = require('../config/db');

const DIAS_AVISO = 15;
const DIAS_ENTRE_AVISOS = 3;

async function destinatarios() {
  if (process.env.HEPTA_AVISOS_EMAIL) {
    return process.env.HEPTA_AVISOS_EMAIL.split(',').map(s => s.trim()).filter(Boolean);
  }
  const { rows } = await pool.query(
    "SELECT email FROM users WHERE role = 'godmode' AND is_active ORDER BY id"
  );
  return rows.map(r => r.email);
}

async function transporte() {
  const { rows } = await pool.query("SELECT key, value FROM site_config WHERE key LIKE 'smtp_%'");
  const cfg = Object.fromEntries(rows.map(r => [r.key, r.value]));
  if (!cfg.smtp_host) throw new Error('SMTP sin configurar en site_config.');
  return {
    transporter: nodemailer.createTransport({
      host: cfg.smtp_host,
      port: parseInt(cfg.smtp_port) || 465,
      secure: cfg.smtp_secure === 'true',
      auth: { user: cfg.smtp_user, pass: cfg.smtp_pass },
    }),
    from: `${cfg.smtp_from_name || 'HEPTA Cloud'} <${cfg.smtp_from_email || cfg.smtp_user}>`,
  };
}

function lineaDe(c) {
  const dias = Math.round((new Date(c.expira_el) - new Date().setHours(0, 0, 0, 0)) / 86400000);
  const estado = dias < 0 ? `VENCIDA hace ${Math.abs(dias)} día(s)` : `vence en ${dias} día(s)`;
  return `• ${c.servicio} / ${c.entorno}${c.etiqueta ? ` (${c.etiqueta})` : ''} — ${estado}, el ${c.expira_el.toISOString().slice(0, 10)}`;
}

(async () => {
  try {
    const { rows } = await pool.query(
      `SELECT id, servicio, entorno, etiqueta, expira_el
         FROM integration_credentials
        WHERE activo
          AND expira_el IS NOT NULL
          AND expira_el <= CURRENT_DATE + $1::int
          AND (aviso_enviado_el IS NULL OR aviso_enviado_el <= CURRENT_DATE - $2::int)
        ORDER BY expira_el`,
      [DIAS_AVISO, DIAS_ENTRE_AVISOS]
    );

    if (!rows.length) {
      console.log('[avisos] Sin credenciales por vencer.');
      return;
    }

    const para = await destinatarios();
    if (!para.length) throw new Error('No hay a quién avisar (ni HEPTA_AVISOS_EMAIL ni usuarios godmode).');

    const { transporter, from } = await transporte();
    const cuerpo = [
      'Credenciales de integración que necesitan atención:',
      '',
      ...rows.map(lineaDe),
      '',
      'Para renovar: generar la clave nueva en el sistema correspondiente y cargarla',
      'en HEPTA Cloud → Admin → Credenciales. La anterior queda inactiva sola.',
      '',
      'Este aviso se repite cada 3 días mientras el vencimiento siga pendiente.',
    ].join('\n');

    await transporter.sendMail({
      from, to: para.join(', '),
      subject: `[HEPTA Cloud] ${rows.length} credencial(es) por vencer`,
      text: cuerpo,
    });

    await pool.query(
      'UPDATE integration_credentials SET aviso_enviado_el = CURRENT_DATE WHERE id = ANY($1::int[])',
      [rows.map(r => r.id)]
    );
    console.log('[avisos] Enviado a %s sobre %s credencial(es).', para.join(', '), rows.length);
  } catch (err) {
    console.error('[avisos] ERROR:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
