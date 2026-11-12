#!/usr/bin/env python3
"""HC S28 - Agregar sección Solicitudes de Pago al admin HC"""
import os

ADMIN = '/opt/heptacloud/frontend/public/admin/index.html'
SERVER = '/opt/heptacloud/backend/server.js'

with open(ADMIN, 'r') as f:
    html = f.read()

# 1. Agregar menú item Pagos
old_menu = """      <div class="menu-group">CRM</div>
      <div class="menu-item" onclick="showSection('leads',this)">"""
new_menu = """      <div class="menu-group">CRM</div>
      <div class="menu-item" onclick="showSection('payments',this)"><svg viewBox="0 0 24 24"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>Solicitudes de pago <span id="payments-badge" style="background:#EF4444;color:#fff;font-size:10px;font-weight:700;padding:1px 6px;border-radius:8px;margin-left:auto;display:none">0</span></div>
      <div class="menu-item" onclick="showSection('leads',this)">"""

if old_menu in html:
    html = html.replace(old_menu, new_menu)
    print("✓ Menú pagos agregado")

# 2. Agregar sección HTML
old_section = "      <!-- ═══ LEADS ═══ -->"
new_section = """      <!-- ═══ PAYMENTS ═══ -->
      <div class="section" id="section-payments">
        <div class="alert alert-success" id="pay-ok"></div>
        <div class="alert alert-error"   id="pay-err"></div>
        <div class="card">
          <div class="card-header">
            <div class="card-title">Solicitudes de pago</div>
            <select class="form-select" style="width:auto" id="pay-filter" onchange="loadPayments()">
              <option value="">Todas</option>
              <option value="pending">Pendientes</option>
              <option value="provisioned">Provisionadas</option>
              <option value="cancelled">Canceladas</option>
            </select>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>#</th><th>Cliente</th><th>Plan</th><th>Monto</th><th>Estado</th><th>Fecha</th><th>Acciones</th></tr></thead>
              <tbody id="payments-tbody">
                <tr><td colspan="7" class="text-muted" style="text-align:center;padding:24px">Cargando...</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- ═══ LEADS ═══ -->"""

if old_section in html:
    html = html.replace(old_section, new_section)
    print("✓ Sección pagos agregada")

# 3. Agregar modal de confirmación de pago
old_modal = "<!-- MODAL SERVICIO -->"
new_modal = """<!-- MODAL CONFIRMAR PAGO -->
<div class="modal-overlay" id="pay-confirm-modal">
  <div class="modal" style="max-width:440px">
    <div class="modal-title">Confirmar pago y provisionar</div>
    <input type="hidden" id="pay-confirm-id"/>
    <div id="pay-confirm-info" style="background:var(--blue-pale);border-radius:var(--radius);padding:14px;margin-bottom:16px;font-size:13px"></div>
    <div class="form-group">
      <label class="form-label">Subdominio para la instancia *</label>
      <div style="display:flex;align-items:center;gap:8px">
        <input class="form-input" id="pay-subdomain" placeholder="micliente" style="flex:1"/>
        <span style="font-size:13px;color:var(--gray-600);white-space:nowrap">.erp.hepta.com.py</span>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Label (nombre amigable)</label>
      <input class="form-input" id="pay-label" placeholder="Sistema de gestión de MiCliente"/>
    </div>
    <div style="background:#FEF3C7;border:1px solid #FCD34D;border-radius:var(--radius);padding:12px;font-size:12px;color:#92400E;margin-bottom:16px">
      ⚠️ Esto provisionará la instancia automáticamente. Verificá que el pago esté confirmado en Tpago antes de continuar.
    </div>
    <div class="modal-footer">
      <button class="btn btn-secondary" onclick="document.getElementById('pay-confirm-modal').classList.remove('open')">Cancelar</button>
      <button class="btn btn-primary" onclick="confirmPayment()">Confirmar y provisionar</button>
    </div>
  </div>
</div>

<!-- MODAL SERVICIO -->"""

if old_modal in html:
    html = html.replace(old_modal, new_modal)
    print("✓ Modal confirmación pago agregado")

# 4. Agregar JS de pagos
old_js = "// ── INSTANCES ──────────────────────────────────────────────"
new_js = """// ── PAYMENTS ───────────────────────────────────────────────
async function loadPayments() {
  const status = document.getElementById('pay-filter')?.value || '';
  const data = await api('GET', status ? `/admin/payment-requests?status=${status}` : '/admin/payment-requests');
  if (!data.success) return;

  // Actualizar badge de pendientes
  const pending = data.data.filter(p => p.status === 'pending').length;
  const badge = document.getElementById('payments-badge');
  if (badge) { badge.textContent = pending; badge.style.display = pending ? 'inline' : 'none'; }

  const tbody = document.getElementById('payments-tbody');
  if (!data.data.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-muted" style="text-align:center;padding:24px">Sin solicitudes.</td></tr>';
    return;
  }

  const statusLabel = { pending:'Pendiente', provisioned:'Provisionado', cancelled:'Cancelado' };
  const statusColor = { pending:'badge-blue', provisioned:'badge-green', cancelled:'badge-gray' };
  const planLabel   = { starter:'Despegue', professional:'Crecimiento', enterprise:'Empresa' };

  tbody.innerHTML = data.data.map(p => `
    <tr>
      <td>${p.id}</td>
      <td><strong>${p.full_name||'—'}</strong><div class="text-sm text-muted">${p.email||''}</div>
          ${p.notes?`<div class="text-sm text-muted">${p.notes}</div>`:''}</td>
      <td><span class="badge badge-blue">${planLabel[p.plan]||p.plan}</span></td>
      <td style="font-weight:600">₲ ${Number(p.amount).toLocaleString('es-PY')}</td>
      <td><span class="badge ${statusColor[p.status]||'badge-gray'}">${statusLabel[p.status]||p.status}</span></td>
      <td class="text-sm text-muted">${new Date(p.created_at).toLocaleDateString('es-PY')}</td>
      <td style="display:flex;gap:6px;flex-wrap:wrap">
        ${p.status==='pending'?`
          <button class="btn btn-primary btn-sm" onclick="openPayConfirm(${p.id},'${p.full_name?.replace(/'/g,'')}','${p.plan}',${p.amount})">✓ Confirmar</button>
          <button class="btn btn-secondary btn-sm" onclick="cancelPayment(${p.id})">Cancelar</button>
        `:p.instance_url?`<a href="${p.instance_url}" target="_blank" class="btn btn-secondary btn-sm">Ver instancia</a>`:'—'}
      </td>
    </tr>`).join('');
}

function openPayConfirm(id, name, plan, amount) {
  document.getElementById('pay-confirm-id').value = id;
  document.getElementById('pay-subdomain').value = '';
  document.getElementById('pay-label').value = '';
  const planLabel = { starter:'Plan Despegue', professional:'Plan Crecimiento', enterprise:'Plan Empresa' };
  document.getElementById('pay-confirm-info').innerHTML = `
    <strong>${name}</strong> — ${planLabel[plan]||plan}<br/>
    Monto: <strong>₲ ${Number(amount).toLocaleString('es-PY')}/mes</strong>`;
  document.getElementById('pay-confirm-modal').classList.add('open');
}

async function confirmPayment() {
  const id        = document.getElementById('pay-confirm-id').value;
  const subdomain = document.getElementById('pay-subdomain').value.trim().toLowerCase();
  const label     = document.getElementById('pay-label').value.trim();
  if (!subdomain) { alert('Ingresá el subdominio'); return; }

  const data = await api('POST', `/admin/payment-requests/${id}/confirm`, { subdomain, label });
  if (data.success) {
    document.getElementById('pay-confirm-modal').classList.remove('open');
    showAlert('pay-ok', 'success', `✓ ${data.message}`);
    loadPayments();
  } else {
    showAlert('pay-err', 'error', data.error);
  }
}

async function cancelPayment(id) {
  if (!confirm('¿Cancelar esta solicitud?')) return;
  const data = await api('POST', `/admin/payment-requests/${id}/cancel`);
  if (data.success) loadPayments();
}

// ── INSTANCES ──────────────────────────────────────────────"""

if old_js in html:
    html = html.replace(old_js, new_js)
    print("✓ JS pagos agregado")

# 5. Agregar payments en sectionTitles y sectionLoaders
html = html.replace(
    "dashboard:'Dashboard',general:",
    "dashboard:'Dashboard',payments:'Solicitudes de pago',general:"
).replace(
    "dashboard:loadDashboard,general:",
    "dashboard:loadDashboard,payments:loadPayments,general:"
)

with open(ADMIN, 'w') as f:
    f.write(html)
print("✓ Admin actualizado")

# 6. Registrar payments.routes.js en server.js
with open(SERVER, 'r') as f:
    server = f.read()

if 'payments.routes' not in server:
    server = server.replace(
        "const provisionRoutes",
        "const paymentsRoutes  = require('./routes/payments.routes');\nconst provisionRoutes"
    ).replace(
        "app.use('/api/admin/provision', provisionRoutes);",
        "app.use('/api/admin/provision', provisionRoutes);\napp.use('/api', paymentsRoutes);"
    )
    with open(SERVER, 'w') as f:
        f.write(server)
    print("✓ server.js actualizado con payments routes")

print("\nDone! Rebuild: docker compose down && docker compose up -d --build")
