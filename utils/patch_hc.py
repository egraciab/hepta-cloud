#!/usr/bin/env python3
"""
SANEO ecosistema — Correr en HC VM (10.10.50.101) SOLAMENTE.

Cambios:
  1. payments.routes.js: precio dinámico desde la tabla `plans` (sin PLAN_AMOUNTS)
  2. payments.routes.js: sync "al compás" (ensureHcUser — find-or-create por email)
  3. payments.routes.js: GET payment-requests cruza por email, no por id
  4. Borra archivo staged muerto retopa_internal_routes.js (vive en RetoPA, no acá)

Idempotente: se puede correr varias veces sin romper nada.
"""
import os

PAY = '/opt/heptacloud/backend/routes/payments.routes.js'

with open(PAY, 'r', encoding='utf-8') as f:
    content = f.read()

if 'ensureHcUser' in content:
    print("- payments.routes.js ya saneado")
else:
    # ── 1 + 2. Requires + helper ensureHcUser, fuera PLAN_AMOUNTS ──
    old_head = """const router = require('express').Router();
const pool   = require('../config/db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const PLAN_AMOUNTS = {
  starter:      169000,
  professional: 319000,
  enterprise:   0,
};"""

    new_head = """const router = require('express').Router();
const pool   = require('../config/db');
const bcrypt = require('bcryptjs');
const { requireAuth, requireAdmin } = require('../middleware/auth');

// -- Sync "al compas": garantiza que el usuario del JWT exista en HC --
// Cruza SIEMPRE por email (el id del JWT puede venir de RetoPA, no de HC).
// Si no existe en HC, lo crea con un hash temporal (mismo patron que el
// sync interno RetoPA<->HC). Devuelve el id real del usuario en HC.
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
}"""

    # ── Cuerpo de payment-request: precio desde `plans` + ensureHcUser ──
    old_body = """  const { plan, business_name } = req.body;
  if (!plan) return res.status(400).json({ success: false, error: 'plan requerido' });
  if (!PLAN_AMOUNTS[plan] && plan !== 'enterprise')
    return res.status(400).json({ success: false, error: 'Plan inválido' });

  try {
    const { rows: cfgRows } = await pool.query(
      "SELECT key,value FROM site_config WHERE key LIKE 'tpago_%'"
    );
    const cfg = Object.fromEntries(cfgRows.map(r => [r.key, r.value]));

    const tpagoLink = cfg[`tpago_link_${plan}`] || '';
    const amount    = PLAN_AMOUNTS[plan] || 0;

    // Buscar user HC por email (SSO cross-platform)
    const hcUserQ = await pool.query('SELECT id FROM users WHERE email=$1', [req.user.email]);
    const hcUserId = hcUserQ.rows[0]?.id || req.user.id;

    // Registrar solicitud
    const { rows } = await pool.query(
      `INSERT INTO payment_requests
         (user_id, plan, amount, tpago_link, status, notes)
       VALUES ($1,$2,$3,$4,'pending',$5) RETURNING id`,
      [hcUserId, plan, amount, tpagoLink, business_name || null]
    );

    if (plan === 'enterprise') {"""

    new_body = """  const { plan, business_name } = req.body;
  if (!plan) return res.status(400).json({ success: false, error: 'plan requerido' });

  try {
    // Plan real desde la tabla `plans` -- UNICA fuente de verdad (sin hardcode)
    const planQ = await pool.query(
      'SELECT slug, name, price, price_label FROM plans WHERE slug=$1 AND is_active=true',
      [plan]
    );
    if (!planQ.rows.length)
      return res.status(400).json({ success: false, error: 'Plan inválido o inactivo' });

    const amount       = Number(planQ.rows[0].price) || 0;
    const isEnterprise = amount === 0;   // precio 0 = "A consultar"

    // Links Tpago dinamicos desde site_config
    const { rows: cfgRows } = await pool.query(
      "SELECT key,value FROM site_config WHERE key LIKE 'tpago_%'"
    );
    const cfg = Object.fromEntries(cfgRows.map(r => [r.key, r.value]));
    const tpagoLink = cfg[`tpago_link_${plan}`] || '';

    // Sync usuario HC al compas (find-or-create por email)
    const hcUserId = await ensureHcUser(req.user);

    // Registrar solicitud
    const { rows } = await pool.query(
      `INSERT INTO payment_requests
         (user_id, plan, amount, tpago_link, status, notes)
       VALUES ($1,$2,$3,$4,'pending',$5) RETURNING id`,
      [hcUserId, plan, amount, tpagoLink, business_name || null]
    );

    if (isEnterprise) {"""

    # ── 3. GET payment-requests: cruzar por email ──
    old_get = """      `SELECT pr.*, p.name as plan_name
       FROM payment_requests pr
       LEFT JOIN plans p ON p.slug = pr.plan
       WHERE pr.user_id = $1
       ORDER BY pr.created_at DESC`,
      [req.user.id]"""

    new_get = """      `SELECT pr.*, p.name as plan_name
       FROM payment_requests pr
       JOIN users u ON u.id = pr.user_id
       LEFT JOIN plans p ON p.slug = pr.plan
       WHERE u.email = $1
       ORDER BY pr.created_at DESC`,
      [req.user.email]"""

    ok = True
    for label, old, new in [('head', old_head, new_head),
                            ('body', old_body, new_body),
                            ('get',  old_get,  new_get)]:
        if old not in content:
            print(f"WARN: no encontre el bloque '{label}' — revisar manualmente")
            ok = False
        else:
            content = content.replace(old, new, 1)

    if ok:
        with open(PAY, 'w', encoding='utf-8') as f:
            f.write(content)
        print("OK payments.routes.js saneado (precio dinamico + sync al compas)")
    else:
        print("ABORTADO: no se escribio payments.routes.js (bloques no coincidieron)")

# ── 4. Borrar archivo staged muerto ──
DEAD = '/opt/heptacloud/retopa_internal_routes.js'
if os.path.exists(DEAD):
    os.remove(DEAD)
    print(f"OK borrado codigo muerto: {DEAD}")
else:
    print(f"- ya no existe: {DEAD}")

print("Done HC!")
