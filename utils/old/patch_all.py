#!/usr/bin/env python3
"""HC S28b - Fixes: mismatch usuario, links Tpago editables"""
import os

# ── 1. Fix payments.routes.js: buscar por email ───────────────
PROV = '/opt/heptacloud/backend/routes/payments.routes.js'
with open(PROV, 'r') as f:
    content = f.read()

old = "      [req.user.id, plan, amount, tpagoLink, business_name || null]"
new = """      // Buscar user_id por email (token puede venir de RetoPA con ID diferente)
      const hcUserRows = await pool.query('SELECT id FROM users WHERE email=$1', [req.user.email]);
      const hcUserId = hcUserRows.rows[0]?.id || req.user.id;"""

# Reemplazar también el INSERT
old2 = "      [req.user.id, plan, amount, tpagoLink, business_name || null]"
new2 = "      [hcUserId, plan, amount, tpagoLink, business_name || null]"

if old in content:
    # Insertar búsqueda de userId antes del INSERT
    content = content.replace(
        "    // Registrar solicitud\n    const { rows } = await pool.query(",
        "    // Buscar user HC por email (SSO cross-platform)\n    const hcUserQ = await pool.query('SELECT id FROM users WHERE email=$1', [req.user.email]);\n    const hcUserId = hcUserQ.rows[0]?.id || req.user.id;\n\n    // Registrar solicitud\n    const { rows } = await pool.query("
    )
    content = content.replace(
        "      [req.user.id, plan, amount, tpagoLink, business_name || null]",
        "      [hcUserId, plan, amount, tpagoLink, business_name || null]"
    )
    with open(PROV, 'w') as f:
        f.write(content)
    print("OK payments fix usuario")
else:
    print("WARN payments patrón no encontrado")

# ── 2. Admin: agregar links Tpago en Configuración general ────
ADMIN = '/opt/heptacloud/frontend/public/admin/index.html'
with open(ADMIN, 'r') as f:
    html = f.read()

# Agregar a cfgKeys
if 'tpago_link_starter' not in html:
    html = html.replace(
        "'dns_proxy_host','certbot_email'",
        "'dns_proxy_host','certbot_email','tpago_link_starter','tpago_link_professional','tpago_link_enterprise'"
    )
    print("OK cfgKeys tpago")

# Agregar campos antes del footer card
old_footer = "        <!-- Footer -->"
new_tpago = """        <!-- Tpago -->
        <div class="card">
          <div class="card-header"><div class="card-title">Links de pago Tpago</div></div>
          <div class="card-body">
            <div class="form-group"><label class="form-label">Link Plan Despegue</label><input class="form-input" id="cfg-tpago_link_starter" placeholder="https://www.tpago.com.py/links?alias=..."/></div>
            <div class="form-group"><label class="form-label">Link Plan Crecimiento</label><input class="form-input" id="cfg-tpago_link_professional" placeholder="https://www.tpago.com.py/links?alias=..."/></div>
            <div class="form-group"><label class="form-label">Link Plan Empresa</label><input class="form-input" id="cfg-tpago_link_enterprise" placeholder="Vacío = formulario de contacto"/><div class="form-hint">Dejá vacío para mostrar formulario de contacto en lugar de link de pago.</div></div>
          </div>
        </div>

        <!-- Footer -->"""

if old_footer in html and 'tpago_link_starter' not in html:
    html = html.replace(old_footer, new_tpago, 1)
    print("OK campos Tpago en admin")

with open(ADMIN, 'w') as f:
    f.write(html)
print("OK admin actualizado")

# ── 3. RetoPA hepta.js: planes dinámicos desde API HC ────────
HEPTA = '/opt/retopa/frontend/cliente/js/hepta.js'
with open(HEPTA, 'r') as f:
    hjs = f.read()

old_plans_const = """// ── PLANES HC con Tpago ──────────────────────────────────────
const HC_PLANS = [
    {
        slug: 'starter',
        name: 'Plan Despegue',
        price: '₲ 169.000/mes',
        color: '#4F46E5',
        features: ['CRM de ventas', 'Facturación básica', 'Hasta 3 usuarios', 'Soporte por email'],
        badge: null,
    },
    {
        slug: 'professional',
        name: 'Plan Crecimiento',
        price: '₲ 319.000/mes',
        color: '#7C3AED',
        features: ['Todo lo de Despegue', 'Usuarios ilimitados', 'Módulos avanzados', 'Soporte prioritario'],
        badge: 'Más popular',
    },
    {
        slug: 'enterprise',
        name: 'Plan Empresa',
        price: 'A consultar',
        color: '#0F172A',
        features: ['Todo lo de Crecimiento', 'Implementación dedicada', 'SLA garantizado', 'Soporte 24/7'],
        badge: null,
    },
];"""

new_plans_const = """// ── PLANES HC dinámicos desde API ────────────────────────────
let HC_PLANS = [];
const PLAN_COLORS = { starter:'#4F46E5', professional:'#7C3AED', enterprise:'#0F172A' };

async function loadHCPlans() {
    if (HC_PLANS.length) return HC_PLANS;
    try {
        const res = await fetch('https://cloud.hepta.com.py/api/plans');
        const data = await res.json();
        if (data.success) {
            HC_PLANS = data.data.map(p => ({
                slug:     p.slug,
                name:     p.name,
                price:    p.price_label || 'A consultar',
                color:    PLAN_COLORS[p.slug] || '#4F46E5',
                features: Array.isArray(p.features) ? p.features : JSON.parse(p.features || '[]'),
                badge:    p.badge_text || null,
                featured: p.is_featured,
            }));
        }
    } catch(e) {
        // Fallback hardcodeado
        HC_PLANS = [
            { slug:'starter',      name:'Plan Despegue',   price:'₲ 169.000/mes', color:'#4F46E5', features:['CRM de ventas','Facturación básica','Hasta 3 usuarios','Soporte por email'], badge:null },
            { slug:'professional', name:'Plan Crecimiento', price:'₲ 319.000/mes', color:'#7C3AED', features:['Todo lo de Despegue','Usuarios ilimitados','Módulos avanzados','Soporte prioritario'], badge:'Más popular', featured:true },
            { slug:'enterprise',   name:'Plan Empresa',     price:'A consultar',   color:'#0F172A', features:['Todo lo de Crecimiento','Implementación dedicada','SLA garantizado','Soporte 24/7'], badge:null },
        ];
    }
    return HC_PLANS;
}"""

if old_plans_const in hjs:
    hjs = hjs.replace(old_plans_const, new_plans_const)
    print("OK planes dinámicos en hepta.js")

# Hacer openHeptaRequest async para cargar planes
hjs = hjs.replace(
    "// Modal de solicitud de instancia HC\nfunction openHeptaRequest() {",
    "// Modal de solicitud de instancia HC\nasync function openHeptaRequest() {\n    await loadHCPlans();"
)

with open(HEPTA, 'w') as f:
    f.write(hjs)
print("OK hepta.js con planes dinámicos")

print("\nDone! Rebuild ambas VMs")
