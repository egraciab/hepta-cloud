// ============================================================
//  HEPTA CLOUD — Datos para el Admin nuevo (/admin/v2/)
//
//  Solo lectura y solo agregados: las acciones (suspender, alta, dominio, módulos…) siguen yendo a las
//  rutas de siempre, que ya validan y dejan rastro en admin_logs. Montada bajo /api/admin, así que hereda
//  requireAuth + requireAdmin del router de admin.
//
//    GET /api/admin/v2/inicio          → números del día, lo que requiere atención y la actividad reciente
//    GET /api/admin/v2/actividad       → admin_logs paginado (?limit, ?offset, ?q)
//    GET /api/admin/v2/clientes        → clientes (entidades fiscales) con cuántos servicios tiene cada uno
//    GET /api/admin/v2/clientes/:id    → la ficha: datos, usuarios, instancias, drive, correo, leads, actividad
//    GET /api/admin/v2/buscar?q=       → búsqueda global (Ctrl K)
//
//  Cada bloque se consulta por separado: si una tabla falla, el resto llega igual y el error va en
//  `errores` (el Admin muestra "no disponible" en ese bloque en lugar de romperse entero).
// ============================================================
const router = require('express').Router();
const pool   = require('../config/db');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Corre una consulta y, si falla, anota el error con su nombre y devuelve `porDefecto`
async function bloque(errores, nombre, fn, porDefecto) {
  try { return await fn(); }
  catch (err) {
    console.error(`[admin/v2 ${nombre}]`, err.message);
    errores.push(nombre);
    return porDefecto;
  }
}
const filas = async (sql, params) => (await pool.query(sql, params)).rows;
const uno   = async (sql, params) => (await pool.query(sql, params)).rows[0] || null;

// ── Inicio ───────────────────────────────────────────────────
router.get('/v2/inicio', async (req, res) => {
  const errores = [];
  const [clientes, instancias, drive, correo, leads, pagos, fundadores] = await Promise.all([
    bloque(errores, 'clientes', () => uno('SELECT count(*)::int AS total FROM billing_customers'), null),
    bloque(errores, 'instancias', () => filas('SELECT status, count(*)::int AS n FROM instances GROUP BY status'), []),
    bloque(errores, 'drive', () => uno("SELECT count(*)::int AS n FROM client_services WHERE service = 'drive' AND status <> 'cancelled'"), null),
    bloque(errores, 'correo', () => uno('SELECT count(*)::int AS n FROM mail_domains'), null),
    bloque(errores, 'leads', () => uno(
      `SELECT count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS semana,
              count(*) FILTER (WHERE status = 'new' AND created_at < now() - interval '24 hours')::int AS sin_responder,
              count(*) FILTER (WHERE status = 'new')::int AS nuevos
         FROM leads`), null),
    bloque(errores, 'pagos', () => uno("SELECT count(*)::int AS pendientes FROM payment_requests WHERE status = 'pending'"), null),
    bloque(errores, 'fundadores', () => uno("SELECT value FROM site_config WHERE key = 'fundadores_restantes'"), null),
  ]);

  // Lo que requiere atención: cada tipo con su consulta, de lo más urgente a lo menos
  const atencion = [];
  const pagosPend = await bloque(errores, 'atencion_pagos', () => filas(
    `SELECT id, full_name, email, plan, amount, created_at FROM payment_requests
      WHERE status = 'pending' ORDER BY created_at LIMIT 10`), []);
  for (const p of pagosPend) atencion.push({ tipo: 'pago', id: p.id, titulo: p.full_name || p.email || `Pago #${p.id}`,
    detalle: { plan: p.plan, monto: Number(p.amount) || 0 }, desde: p.created_at });

  const mora = await bloque(errores, 'atencion_suspendidas', () => filas(
    `SELECT id, label, db_name, suspended_at FROM instances WHERE status = 'suspended' ORDER BY suspended_at NULLS LAST LIMIT 10`), []);
  for (const i of mora) atencion.push({ tipo: 'suspendida', id: i.id, titulo: i.label || i.db_name,
    detalle: { db: i.db_name }, desde: i.suspended_at });

  const leadsViejos = await bloque(errores, 'atencion_leads', () => filas(
    `SELECT id, full_name, company_name, phone, email, created_at FROM leads
      WHERE status = 'new' AND created_at < now() - interval '24 hours' ORDER BY created_at LIMIT 10`), []);
  for (const l of leadsViejos) atencion.push({ tipo: 'lead', id: l.id, titulo: l.company_name || l.full_name,
    detalle: { nombre: l.full_name, telefono: l.phone, correo: l.email }, desde: l.created_at });

  const credenciales = await bloque(errores, 'atencion_credenciales', () => filas(
    `SELECT id, servicio, etiqueta, expira_el FROM integration_credentials
      WHERE activo AND expira_el IS NOT NULL AND expira_el <= CURRENT_DATE + 15 ORDER BY expira_el`), []);
  for (const c of credenciales) atencion.push({ tipo: 'credencial', id: c.id, titulo: c.etiqueta || c.servicio,
    detalle: { servicio: c.servicio, vence: c.expira_el }, desde: null });

  const fallidos = await bloque(errores, 'atencion_trabajos', () => filas(
    `SELECT j.id, j.step, j.error, j.started_at, cs.service, cs.slug FROM provisioning_jobs j
       JOIN client_services cs ON cs.id = j.client_service_id
      WHERE j.status = 'failed' AND j.started_at > now() - interval '3 days'
        AND NOT EXISTS (SELECT 1 FROM provisioning_jobs k WHERE k.client_service_id = j.client_service_id AND k.id > j.id)
      ORDER BY j.started_at DESC LIMIT 10`), []);
  for (const j of fallidos) atencion.push({ tipo: 'trabajo', id: j.id, titulo: `${j.service} ${j.slug}`,
    detalle: { paso: j.step, error: (j.error || '').slice(0, 200) }, desde: j.started_at });

  const actividad = await bloque(errores, 'actividad', () => leerActividad({ limit: 8 }), []);

  const porEstado = Object.fromEntries((instancias || []).map(r => [r.status, r.n]));
  const n = parseInt(fundadores && fundadores.value, 10);
  res.json({ success: true, data: {
    kpis: {
      clientes: clientes ? clientes.total : null,
      instancias: { activas: porEstado.active || 0, suspendidas: porEstado.suspended || 0,
                    total: Object.values(porEstado).reduce((a, b) => a + b, 0) },
      drive: drive ? drive.n : null,
      correo: correo ? correo.n : null,
      leads,
      pagos_pendientes: pagos ? pagos.pendientes : null,
      fundadores_restantes: Number.isFinite(n) ? n : null,
    },
    atencion, actividad, errores,
  } });
});

// ── Actividad (admin_logs) ───────────────────────────────────
async function leerActividad({ limit = 50, offset = 0, q = '', target = null } = {}) {
  const params = [], where = [];
  if (q) { params.push(`%${q}%`); where.push(`(l.action ILIKE $${params.length} OR l.target ILIKE $${params.length} OR l.detail::text ILIKE $${params.length} OR u.email ILIKE $${params.length})`); }
  if (target && target.length) { params.push(target); where.push(`l.target = ANY($${params.length})`); }
  params.push(Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200), Math.max(parseInt(offset, 10) || 0, 0));
  return filas(
    `SELECT l.*, u.full_name AS usuario, u.email AS usuario_email
       FROM admin_logs l LEFT JOIN users u ON u.id = l.user_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY l.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
}

router.get('/v2/actividad', async (req, res) => {
  try {
    const q = String(req.query.q || '').slice(0, 100);
    res.json({ success: true, data: await leerActividad({ limit: req.query.limit, offset: req.query.offset, q }) });
  } catch (err) {
    console.error('[admin/v2 actividad]', err.message);
    res.status(500).json({ success: false, error: 'No se pudo leer el registro de actividad' });
  }
});

// ── Clientes ─────────────────────────────────────────────────
router.get('/v2/clientes', async (req, res) => {
  try {
    const rows = await filas(
      `SELECT c.id, c.razon_social, c.nombre_comercial, c.numero_doc, c.dv, c.email, c.telefono, c.ciudad,
              c.erp_partner_id, c.erp_sync_state, c.origen, c.created_at,
              (SELECT count(*)::int FROM account_billing_customers abc WHERE abc.billing_customer_id = c.id) AS usuarios,
              (SELECT count(*)::int FROM instances i JOIN account_billing_customers abc ON abc.user_id = i.user_id
                WHERE abc.billing_customer_id = c.id AND i.status <> 'cancelled') AS instancias,
              (SELECT count(*)::int FROM instances i JOIN account_billing_customers abc ON abc.user_id = i.user_id
                WHERE abc.billing_customer_id = c.id AND i.status = 'suspended') AS suspendidas,
              (SELECT count(*)::int FROM client_services cs WHERE cs.billing_customer_id = c.id AND cs.status <> 'cancelled') AS otros_servicios
         FROM billing_customers c ORDER BY c.created_at DESC`);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[admin/v2 clientes]', err.message);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

router.get('/v2/clientes/:id', async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(400).json({ success: false, error: 'Cliente inválido' });
  const id = req.params.id, errores = [];
  const cliente = await bloque(errores, 'cliente', () => uno('SELECT * FROM billing_customers WHERE id = $1', [id]), null);
  if (!cliente && !errores.length) return res.status(404).json({ success: false, error: 'Cliente no encontrado' });

  const usuarios = await bloque(errores, 'usuarios', () => filas(
    `SELECT u.id, u.email, u.full_name, u.role, u.is_active, u.last_login_at, abc.rol
       FROM account_billing_customers abc JOIN users u ON u.id = abc.user_id
      WHERE abc.billing_customer_id = $1 ORDER BY u.created_at`, [id]), []);
  const ids = usuarios.map(u => u.id), correos = usuarios.map(u => String(u.email || '').toLowerCase());

  const [instancias, otros, correo, leads] = await Promise.all([
    bloque(errores, 'instancias', () => ids.length ? filas(
      `SELECT i.*, u.email FROM instances i LEFT JOIN users u ON u.id = i.user_id
        WHERE i.user_id = ANY($1) ORDER BY i.created_at`, [ids]) : [], []),
    bloque(errores, 'servicios', () => filas(
      `SELECT id, service, slug, fqdn, status, params, created_at FROM client_services
        WHERE billing_customer_id = $1 AND status <> 'cancelled' ORDER BY created_at`, [id]), []),
    bloque(errores, 'correo', () => correos.length ? filas(
      'SELECT * FROM mail_domains WHERE lower(owner_email) = ANY($1) ORDER BY created_at', [correos]) : [], []),
    bloque(errores, 'leads', () => filas(
      `SELECT id, full_name, company_name, email, phone, status, plan_slug, created_at FROM leads
        WHERE ($1 <> '' AND ruc IS NOT NULL AND regexp_replace(split_part(ruc, '-', 1), '\\D', '', 'g') = $1)
           OR (email IS NOT NULL AND lower(email) = ANY($2))
        ORDER BY created_at DESC LIMIT 20`, [cliente ? cliente.doc_norm || '' : '', correos]), []),
  ]);

  const objetivos = [`client:${id}`, ...instancias.map(i => `instance:${i.id}`)];
  const actividad = await bloque(errores, 'actividad', () => leerActividad({ limit: 20, target: objetivos }), []);
  res.json({ success: true, data: { cliente, usuarios, instancias, servicios: otros, correo, leads, actividad, errores } });
});

// ── Búsqueda global ──────────────────────────────────────────
router.get('/v2/buscar', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (q.length < 2) return res.json({ success: true, data: [] });
  const like = `%${q}%`, digitos = q.replace(/\D/g, ''), errores = [];
  const [clientes, instancias, usuarios, dominios, drives, leads] = await Promise.all([
    bloque(errores, 'clientes', () => filas(
      `SELECT id, razon_social, nombre_comercial, numero_doc FROM billing_customers
        WHERE razon_social ILIKE $1 OR nombre_comercial ILIKE $1 OR ($2 <> '' AND doc_norm LIKE $2 || '%') LIMIT 6`, [like, digitos]), []),
    bloque(errores, 'instancias', () => filas(
      `SELECT id, label, db_name, custom_domain, status FROM instances
        WHERE label ILIKE $1 OR db_name ILIKE $1 OR custom_domain ILIKE $1 LIMIT 6`, [like]), []),
    bloque(errores, 'usuarios', () => filas(
      'SELECT id, email, full_name, role FROM users WHERE email ILIKE $1 OR full_name ILIKE $1 LIMIT 6', [like]), []),
    bloque(errores, 'dominios', () => filas('SELECT domain, owner_email FROM mail_domains WHERE domain ILIKE $1 LIMIT 6', [like]), []),
    bloque(errores, 'drive', () => filas(
      "SELECT id, slug, fqdn, status FROM client_services WHERE service = 'drive' AND (slug ILIKE $1 OR fqdn ILIKE $1) LIMIT 6", [like]), []),
    bloque(errores, 'leads', () => filas(
      'SELECT id, full_name, company_name, email FROM leads WHERE full_name ILIKE $1 OR company_name ILIKE $1 OR email ILIKE $1 ORDER BY created_at DESC LIMIT 6', [like]), []),
  ]);
  const r = [
    ...clientes.map(c => ({ tipo: 'cliente', id: c.id, titulo: c.nombre_comercial || c.razon_social, sub: `RUC ${c.numero_doc}` })),
    ...instancias.map(i => ({ tipo: 'instancia', id: i.id, titulo: i.label || i.db_name, sub: i.custom_domain || i.db_name, estado: i.status })),
    ...dominios.map(d => ({ tipo: 'correo', id: d.domain, titulo: d.domain, sub: `HEPTA Mail · ${d.owner_email}` })),
    ...drives.map(d => ({ tipo: 'drive', id: d.slug, titulo: d.slug, sub: `HEPTA Drive · ${d.fqdn || ''}`, estado: d.status })),
    ...usuarios.map(u => ({ tipo: 'usuario', id: u.id, titulo: u.full_name || u.email, sub: `${u.email} · ${u.role}` })),
    ...leads.map(l => ({ tipo: 'lead', id: l.id, titulo: l.company_name || l.full_name, sub: l.email || '' })),
  ];
  res.json({ success: true, data: r, errores });
});

module.exports = router;
