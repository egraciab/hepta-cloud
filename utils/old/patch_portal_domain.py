#!/usr/bin/env python3
"""
HC S19 - Patch portal: agregar modal de dominio propio
Correr en HC VM: python3 patch_portal_domain.py
"""
import os, sys

PORTAL = '/opt/heptacloud/frontend/public/portal/index.html'
PORTAL_ROUTES = '/opt/heptacloud/backend/routes/portal.routes.js'

if not os.path.exists(PORTAL):
    print(f"ERROR: {PORTAL} no encontrado")
    sys.exit(1)

with open(PORTAL, 'r') as f:
    content = f.read()

# ── 1. Agregar botón dominio propio en cada instancia ──────────
old_btn = """            ${i.instance_url&&i.status==='active'?`<a href="${i.instance_url}" target="_blank" class="instance-url" style="margin-top:12px;display:inline-flex">
              <svg viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
              Acceder a ${i.label||'mi sistema'}
            </a>`:i.status==='suspended'?'<div style="color:var(--red);font-size:12px;margin-top:6px">⚠️ Instancia suspendida</div>':''}"""

if old_btn not in content:
    # Buscar variante
    import re
    match = re.search(r'\$\{i\.instance_url&&i\.status===.active..?\`<a href=.*?Instancia suspendida.*?\}', content, re.DOTALL)
    if match:
        print("Patrón encontrado (variante):", repr(match.group()[:80]))
    else:
        print("WARN: botón acceso no encontrado, buscando manualmente...")
        idx = content.find('Acceder a ${i.label')
        print("Contexto:", repr(content[max(0,idx-100):idx+200]))
    print("Continuando con el resto...")

new_btn = """            ${i.instance_url&&i.status==='active'?`
              <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px">
                <a href="${i.instance_url}" target="_blank" class="instance-url" style="margin-top:0">
                  <svg viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                  Acceder a ${i.label||'mi sistema'}
                </a>
                <button onclick="openDomainModal(${i.id},'${(i.label||'').replace(/'/g,\\'\\')}')"
                  style="display:inline-flex;align-items:center;gap:6px;background:var(--gray-100);color:var(--gray-800);border:1px solid var(--gray-200);padding:10px 16px;border-radius:var(--radius);font-size:13px;font-weight:500;cursor:pointer;font-family:inherit">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>
                  ${i.custom_domain_status==='active'?i.custom_domain+' ✓':'Dominio propio'}
                </button>
              </div>`:
            i.status==='suspended'?'<div style="color:var(--red);font-size:12px;margin-top:6px">⚠️ Instancia suspendida</div>':''}"""

if old_btn in content:
    content = content.replace(old_btn, new_btn)
    print("✓ Botón dominio agregado")

# ── 2. Agregar modal y JS antes de </body> ─────────────────────
modal = """
<!-- MODAL DOMINIO PROPIO -->
<div class="modal-overlay" id="domain-modal" onclick="if(event.target===this)closeDomainModal()">
  <div class="modal" style="max-width:520px">
    <div style="font-size:16px;font-weight:700;color:var(--navy);margin-bottom:6px">Dominio propio</div>
    <div style="font-size:13px;color:var(--gray-600);margin-bottom:20px">Asociá tu dominio a este sistema</div>
    <input type="hidden" id="domain-instance-id"/>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px">
      <div id="type-own-card" onclick="selectDomainType('own')"
        style="border:2px solid var(--blue);border-radius:var(--radius);padding:16px;cursor:pointer;background:var(--blue-pale)">
        <div style="font-size:13px;font-weight:600;color:var(--navy);margin-bottom:4px">Ya tengo un dominio</div>
        <div style="font-size:12px;color:var(--gray-600)">Configurar mi dominio existente</div>
      </div>
      <div id="type-buy-card" onclick="selectDomainType('buy')"
        style="border:2px solid var(--gray-200);border-radius:var(--radius);padding:16px;cursor:pointer">
        <div style="font-size:13px;font-weight:600;color:var(--navy);margin-bottom:4px">Quiero un dominio nuevo</div>
        <div style="font-size:12px;color:var(--gray-600)">Hepta lo gestiona por vos</div>
      </div>
    </div>
    <div id="flow-own">
      <div class="form-group"><label class="form-label">Tu dominio</label>
        <input class="form-input" id="domain-own-input" placeholder="miempresa.com.py"/>
        <div class="form-hint">Sin www ni https.</div>
      </div>
      <div style="background:#FEF3C7;border:1px solid #FCD34D;border-radius:var(--radius);padding:14px;font-size:12px;color:#92400E;margin-bottom:16px">
        <strong>Antes de continuar</strong> — agregá este registro DNS en tu proveedor:<br/>
        <div style="margin-top:8px;font-family:monospace;background:rgba(0,0,0,.05);padding:8px;border-radius:4px">
          Tipo: A &nbsp;·&nbsp; Nombre: @ &nbsp;·&nbsp; Valor: <strong>200.108.133.244</strong> &nbsp;·&nbsp; TTL: 3600
        </div>
        <div style="margin-top:6px">Una vez configurado el DNS, enviá la solicitud. Nuestro equipo verificará y activará.</div>
      </div>
      <div class="form-group"><label class="form-label">Notas (opcional)</label>
        <textarea class="form-textarea" id="domain-own-notes" rows="2" style="font-family:inherit" placeholder="Ej: ya configuré el DNS en NIC.py"></textarea>
      </div>
    </div>
    <div id="flow-buy" style="display:none">
      <div style="background:var(--blue-pale);border:1px solid #BFDBFE;border-radius:var(--radius);padding:14px;font-size:13px;color:var(--navy);margin-bottom:16px">
        Te ayudamos a registrar y configurar tu dominio. Te contactaremos para coordinar.
      </div>
      <div class="form-group"><label class="form-label">Dominio deseado (opcional)</label>
        <input class="form-input" id="domain-buy-input" placeholder="miempresa.com.py"/>
      </div>
      <div class="form-group"><label class="form-label">Extensión preferida</label>
        <select class="form-input" id="domain-buy-ext">
          <option>.com.py — recomendado para empresas paraguayas</option>
          <option>.com — internacional</option>
          <option>.py</option>
          <option>Cualquiera — me asesorás</option>
        </select>
      </div>
      <div class="form-group"><label class="form-label">Notas (opcional)</label>
        <textarea class="form-textarea" id="domain-buy-notes" rows="2" style="font-family:inherit"></textarea>
      </div>
    </div>
    <div class="alert alert-success" id="domain-ok"></div>
    <div class="alert alert-error"   id="domain-err"></div>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:20px">
      <button class="btn btn-secondary" onclick="closeDomainModal()">Cancelar</button>
      <button class="btn btn-primary" onclick="submitDomainRequest()" id="domain-submit-btn">Solicitar activación</button>
    </div>
  </div>
</div>

<script>
let _domainType='own';
function openDomainModal(id,label){
  document.getElementById('domain-instance-id').value=id;
  ['own-input','own-notes','buy-input','buy-notes'].forEach(k=>{const el=document.getElementById('domain-'+k);if(el)el.value='';});
  document.getElementById('domain-ok').className='alert alert-success';
  document.getElementById('domain-err').className='alert alert-error';
  selectDomainType('own');
  document.getElementById('domain-modal').classList.add('open');
}
function closeDomainModal(){document.getElementById('domain-modal').classList.remove('open');}
function selectDomainType(type){
  _domainType=type;
  const sel=type==='own';
  document.getElementById('type-own-card').style.borderColor=sel?'var(--blue)':'var(--gray-200)';
  document.getElementById('type-own-card').style.background=sel?'var(--blue-pale)':'';
  document.getElementById('type-buy-card').style.borderColor=sel?'var(--gray-200)':'var(--blue)';
  document.getElementById('type-buy-card').style.background=sel?'':'var(--blue-pale)';
  document.getElementById('flow-own').style.display=sel?'block':'none';
  document.getElementById('flow-buy').style.display=sel?'none':'block';
  document.getElementById('domain-submit-btn').textContent=sel?'Solicitar activación':'Enviar solicitud';
}
async function submitDomainRequest(){
  const instanceId=document.getElementById('domain-instance-id').value;
  const btn=document.getElementById('domain-submit-btn');
  btn.disabled=true;
  const body={instance_id:parseInt(instanceId),type:_domainType};
  if(_domainType==='own'){
    body.domain=(document.getElementById('domain-own-input').value.trim().toLowerCase()).replace(/^https?:\\/\\//,'').replace(/^www\\./,'');
    body.notes=document.getElementById('domain-own-notes').value.trim();
    if(!body.domain){showDomainErr('Ingresá tu dominio');btn.disabled=false;return;}
  } else {
    body.domain=document.getElementById('domain-buy-input').value.trim();
    body.notes=document.getElementById('domain-buy-notes').value.trim();
  }
  try{
    const data=await apiCall('POST','/portal/domain-request',body);
    if(data.success){
      const ok=document.getElementById('domain-ok');
      ok.textContent=data.message; ok.className='alert alert-success show';
      setTimeout(()=>{closeDomainModal();loadInstance();},3000);
    } else showDomainErr(data.error||'Error al enviar solicitud');
  }catch(e){showDomainErr('Error de conexión');}
  btn.disabled=false;
}
function showDomainErr(msg){const el=document.getElementById('domain-err');el.textContent=msg;el.className='alert alert-error show';}
</script>
"""

if '</body>' in content:
    content = content.replace('</body>', modal + '\n</body>')
    print("✓ Modal dominio agregado")

with open(PORTAL, 'w') as f:
    f.write(content)
print("✓ Portal actualizado")

# ── 3. Agregar endpoint domain-request a portal.routes.js ──────
with open(PORTAL_ROUTES, 'r') as f:
    routes = f.read()

domain_endpoint = """
// ── POST /api/portal/domain-request ──────────────────────────
router.post('/domain-request', async (req, res) => {
  const { instance_id, type, domain, notes } = req.body;
  if (!instance_id || !type)
    return res.status(400).json({ success: false, error: 'instance_id y type son requeridos' });
  try {
    const { rows } = await pool.query(
      'SELECT id, label, db_name FROM instances WHERE id=$1 AND user_id=$2',
      [instance_id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Instancia no encontrada' });
    const inst = rows[0];
    const msg = type === 'own'
      ? `Dominio propio: ${domain} para ${inst.label} (${inst.db_name}). Notas: ${notes||'—'}`
      : `Solicitud compra dominio para ${inst.label}. Deseado: ${domain||'a definir'}. Notas: ${notes||'—'}`;
    await pool.query(
      `INSERT INTO leads (full_name, email, company_name, message, source, status)
       VALUES ($1,$2,$3,$4,'domain_request','new')`,
      [req.user.full_name, req.user.email, inst.label, msg]
    );
    await pool.query(
      `UPDATE instances SET custom_domain=$1, custom_domain_status=$2, updated_at=NOW() WHERE id=$3`,
      [domain||null, type==='own'?'pending_dns':'pending_purchase', instance_id]
    );
    res.json({ success: true, message: type==='own'
      ? 'Solicitud recibida. Verificaremos el DNS y activaremos tu dominio en breve.'
      : 'Solicitud recibida. Te contactaremos para gestionar tu dominio.' });
  } catch(err) {
    console.error('[portal/domain-request]', err.message);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});
"""

if '/domain-request' not in routes:
    routes = routes.replace('module.exports = router;', domain_endpoint + '\nmodule.exports = router;')
    with open(PORTAL_ROUTES, 'w') as f:
        f.write(routes)
    print("✓ Endpoint domain-request agregado")
else:
    print("- Endpoint domain-request ya existía")

print("\n✓ Patch S19 completado")
