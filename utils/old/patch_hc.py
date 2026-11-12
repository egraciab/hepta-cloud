#!/usr/bin/env python3
"""HC S28b - Correr en HC VM solamente"""

# ── 1. payments.routes.js: buscar por email ───────────────────
PROV = '/opt/heptacloud/backend/routes/payments.routes.js'
with open(PROV, 'r') as f:
    content = f.read()

if 'hcUserId' not in content:
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
    print("OK payments.routes.js")
else:
    print("- payments.routes.js ya actualizado")

# ── 2. Admin: campos Tpago en Configuración general ──────────
ADMIN = '/opt/heptacloud/frontend/public/admin/index.html'
with open(ADMIN, 'r') as f:
    html = f.read()

if 'tpago_link_starter' not in html:
    html = html.replace(
        "'dns_proxy_host','certbot_email'",
        "'dns_proxy_host','certbot_email','tpago_link_starter','tpago_link_professional','tpago_link_enterprise'"
    )
    html = html.replace(
        "        <!-- Footer -->",
        """        <!-- Tpago -->
        <div class="card">
          <div class="card-header"><div class="card-title">Links de pago Tpago</div></div>
          <div class="card-body">
            <div class="form-group"><label class="form-label">Link Plan Despegue</label><input class="form-input" id="cfg-tpago_link_starter" placeholder="https://www.tpago.com.py/links?alias=..."/></div>
            <div class="form-group"><label class="form-label">Link Plan Crecimiento</label><input class="form-input" id="cfg-tpago_link_professional" placeholder="https://www.tpago.com.py/links?alias=..."/></div>
            <div class="form-group"><label class="form-label">Link Plan Empresa</label><input class="form-input" id="cfg-tpago_link_enterprise" placeholder="Vacío = contacto"/><div class="form-hint">Dejá vacío para mostrar formulario de contacto.</div></div>
          </div>
        </div>

        <!-- Footer -->""",
        1
    )
    with open(ADMIN, 'w') as f:
        f.write(html)
    print("OK admin Tpago campos")
else:
    print("- Admin ya tiene campos Tpago")

print("Done HC!")
