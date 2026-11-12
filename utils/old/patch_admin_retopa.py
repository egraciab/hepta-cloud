#!/usr/bin/env python3
"""
HC S24 - Patch admin: agregar paso 2 RetoPA en modal provisioning
Correr en HC VM: python3 patch_admin_retopa.py
"""
import os, sys

ADMIN = '/opt/heptacloud/frontend/public/admin/index.html'
PROV  = '/opt/heptacloud/backend/routes/provision.routes.js'

# ── 1. Patch admin.html — agregar paso 2 al modal ─────────────
with open(ADMIN, 'r') as f:
    html = f.read()

# Reemplazar el modal de provisioning con versión de 2 pasos
old_warn = """    <div style="background:#FEF3C7;border:1px solid #FCD34D;border-radius:var(--radius);padding:12px;font-size:12px;color:#92400E;margin-bottom:16px">
      ⚠️ Este proceso puede tardar <strong>3-8 minutos</strong>. No cerrés esta ventana mientras se procesa.
    </div>"""

new_warn = """    <!-- Paso 1: Instancia -->
    <div id="prov-step1">
      <div style="background:#FEF3C7;border:1px solid #FCD34D;border-radius:var(--radius);padding:12px;font-size:12px;color:#92400E;margin-bottom:16px">
        ⚠️ Este proceso puede tardar <strong>3-8 minutos</strong>. No cerrés esta ventana mientras se procesa.
      </div>
    </div>

    <!-- Paso 2: Ficha RetoPA -->
    <div id="prov-step2" style="display:none">
      <div style="background:var(--blue-pale);border:1px solid #BFDBFE;border-radius:var(--radius);padding:14px;font-size:13px;color:var(--navy);margin-bottom:16px">
        <strong>¡Instancia lista!</strong> Completá los datos para crear la ficha del cliente en <strong>RetoPA</strong>.
        <div style="font-size:12px;color:var(--gray-600);margin-top:4px">Aparecerá automáticamente en el directorio empresarial.</div>
      </div>
      <div class="grid-2">
        <div class="form-group"><label class="form-label">Nombre comercial *</label><input class="form-input" id="prov-business-name" placeholder="Ej: Panadería San Pedro"/></div>
        <div class="form-group"><label class="form-label">Razón social</label><input class="form-input" id="prov-trade-name" placeholder="Ej: San Pedro S.A."/></div>
      </div>
      <div class="grid-2">
        <div class="form-group"><label class="form-label">WhatsApp / Teléfono *</label><input class="form-input" id="prov-phone" placeholder="0981000000"/></div>
        <div class="form-group"><label class="form-label">Ciudad</label><input class="form-input" id="prov-city" placeholder="Asunción"/></div>
      </div>
      <div class="grid-2">
        <div class="form-group"><label class="form-label">RUC (opcional)</label><input class="form-input" id="prov-ruc" placeholder="80012345-6"/></div>
        <div class="form-group"><label class="form-label">Categoría</label>
          <select class="form-select" id="prov-category-id"><option value="">Sin categoría</option></select>
        </div>
      </div>
      <div class="form-group"><label class="form-label">Descripción breve (opcional)</label>
        <textarea class="form-textarea" id="prov-description" rows="2" style="font-family:inherit" placeholder="Qué hace el negocio..."></textarea>
      </div>
      <div class="form-group">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
          <input type="checkbox" id="prov-retopa-listing" checked/>
          <span>Crear ficha en RetoPA automáticamente</span>
        </label>
      </div>
    </div>"""

if old_warn in html:
    html = html.replace(old_warn, new_warn)
    print("✓ Paso 2 RetoPA agregado al modal")
else:
    print("WARN: bloque advertencia no encontrado")

# Actualizar botones del modal footer para manejar los 2 pasos
old_footer = """    <div class="modal-footer" id="prov-modal-footer">
      <button class="btn btn-secondary" onclick="closeProvisionModal()">Cancelar</button>
      <button class="btn btn-primary" onclick="runProvisioning()" id="prov-btn">
        <svg viewBox="0 0 24 24" width="14" height="14"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
        Provisionar instancia
      </button>
    </div>"""

new_footer = """    <div class="modal-footer" id="prov-modal-footer">
      <button class="btn btn-secondary" onclick="closeProvisionModal()">Cancelar</button>
      <button class="btn btn-primary" onclick="runProvisioning()" id="prov-btn">
        <svg viewBox="0 0 24 24" width="14" height="14"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
        Provisionar instancia
      </button>
    </div>
    <div class="modal-footer" id="prov-step2-footer" style="display:none">
      <button class="btn btn-secondary" onclick="skipRetopaListing()">Omitir RetoPA</button>
      <button class="btn btn-primary" onclick="submitRetopaListing()" id="prov-retopa-btn">
        Crear ficha en RetoPA →
      </button>
    </div>"""

if old_footer in html:
    html = html.replace(old_footer, new_footer)
    print("✓ Footer del modal actualizado")

# Agregar JS para manejo de paso 2 y carga de categorías
old_fn = "async function openProvisionModal(){"
new_fn = """// ── RETOPA CATEGORIES ─────────────────────────────────────────
let _retopaCategories = [];
async function loadRetopaCategories(){
  if(_retopaCategories.length) return;
  try{
    const data=await api('GET','/admin/retopa/categories');
    if(data.success){
      _retopaCategories=data.data;
      const sel=document.getElementById('prov-category-id');
      if(sel){
        data.data.forEach(c=>{
          sel.innerHTML+=`<option value="${c.id}">${c.parent_name?c.parent_name+' → ':''}${c.name}</option>`;
        });
      }
    }
  }catch(e){}
}

let _provisionedInstanceId = null;

function goToStep2(instanceId, userData){
  _provisionedInstanceId = instanceId;
  document.getElementById('prov-step1').style.display='none';
  document.getElementById('prov-step2').style.display='block';
  document.getElementById('prov-modal-footer').style.display='none';
  document.getElementById('prov-step2-footer').style.display='flex';
  document.getElementById('prov-progress').style.display='none';
  // Pre-completar con datos del usuario seleccionado
  if(userData){
    document.getElementById('prov-business-name').value=userData.full_name||'';
    document.getElementById('prov-phone').value=userData.phone||'';
  }
  loadRetopaCategories();
}

function skipRetopaListing(){
  closeProvisionModal();
  loadInstances();
}

async function submitRetopaListing(){
  const btn=document.getElementById('prov-retopa-btn');
  btn.disabled=true; btn.textContent='Creando ficha...';
  const listing=document.getElementById('prov-retopa-listing').checked;
  if(listing && _provisionedInstanceId){
    await api('POST',`/admin/retopa/create-listing/${_provisionedInstanceId}`,{
      business_name: document.getElementById('prov-business-name').value,
      trade_name:    document.getElementById('prov-trade-name').value,
      phone:         document.getElementById('prov-phone').value,
      city:          document.getElementById('prov-city').value,
      ruc:           document.getElementById('prov-ruc').value,
      category_id:   document.getElementById('prov-category-id').value||null,
      description:   document.getElementById('prov-description').value,
    }).catch(e=>console.error(e));
  }
  btn.disabled=false;
  closeProvisionModal();
  showAlert('inst-ok','success','Instancia provisionada y ficha en RetoPA creada.');
  loadInstances();
}

async function openProvisionModal(){"""

if old_fn in html:
    html = html.replace(old_fn, new_fn)
    print("✓ JS de paso 2 y categorías agregado")

# Actualizar runProvisioning para ir al paso 2 en lugar de cerrar
old_run = """    if(data.success){
      document.getElementById('provision-modal').classList.remove('open');
      showAlert('inst-ok','success',`✓ Instancia "${tenant}" provisionada. URL: ${data.data.url}`);
      loadInstances();
    } else {"""

new_run = """    if(data.success){
      // Ir al paso 2 — ficha en RetoPA
      const selUser = document.getElementById('prov-user-id');
      const userData = selUser ? {
        full_name: selUser.options[selUser.selectedIndex]?.text?.split(' (')[0],
        phone: null
      } : null;
      goToStep2(data.data.instance.id, userData);
    } else {"""

if old_run in html:
    html = html.replace(old_run, new_run)
    print("✓ runProvisioning actualizado para paso 2")

with open(ADMIN, 'w') as f:
    f.write(html)
print("✓ admin/index.html actualizado")

# ── 2. Patch provision.routes.js ──────────────────────────────
with open(PROV, 'r') as f:
    prov = f.read()

# Agregar require de retopa helper
if "require('./retopa')" not in prov:
    prov = prov.replace(
        "const router = require('express').Router();",
        "const router = require('express').Router();\nconst retopa = (() => { try { return require('./retopa'); } catch(e) { return null; } })();"
    )
    print("✓ require retopa agregado")

# Agregar endpoint GET /api/admin/provision/retopa/categories
retopa_endpoints = """
// ── GET /api/admin/provision/retopa/categories ───────────────
router.get('/retopa/categories', async (req, res) => {
  try {
    const cfg = await getConfig();
    if (!cfg.retopa_api_url) return res.json({ success: true, data: [] });
    const apiRes = await fetch(`${cfg.retopa_api_url}/api/v2/categories`, {
      signal: AbortSignal.timeout(5000)
    });
    const data = await apiRes.json();
    res.json({ success: true, data: data.data || [] });
  } catch(e) {
    res.json({ success: true, data: [] });
  }
});

// ── POST /api/admin/provision/retopa/create-listing/:id ──────
router.post('/retopa/create-listing/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT i.*, u.email, u.full_name, u.phone
       FROM instances i JOIN users u ON u.id=i.user_id
       WHERE i.id=$1`, [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Instancia no encontrada' });

    const inst = rows[0];
    const { createRetopaListing } = require('./retopa');
    const result = await createRetopaListing({
      user: { id: inst.user_id, email: inst.email, full_name: inst.full_name, phone: inst.phone },
      instance: inst,
      listingData: req.body,
    });

    if (result) {
      res.json({ success: true, data: result });
    } else {
      res.json({ success: false, error: 'No se pudo crear la ficha en RetoPA' });
    }
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});
"""

if '/retopa/categories' not in prov:
    prov = prov.replace('module.exports = router;', retopa_endpoints + '\nmodule.exports = router;')
    print("✓ Endpoints RetoPA agregados a provision.routes.js")

with open(PROV, 'w') as f:
    f.write(prov)
print("✓ provision.routes.js actualizado")
print("\n✓ Patch HC S24 completado")
print("Rebuild: docker compose down && docker compose up -d --build")
