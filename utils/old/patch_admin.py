#!/usr/bin/env python3
"""
Patch admin.routes.js: agregar DELETE /instances/:id
Patch admin/index.html: agregar campos version/portal_url + botón eliminar
"""
import re

# ── admin.routes.js ───────────────────────────────────────────
with open('/opt/heptacloud/backend/routes/admin.routes.js', 'r') as f:
    routes = f.read()

delete_route = """
// ── DELETE /admin/instances/:id ───────────────────────────────
router.delete('/instances/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT label, db_name FROM instances WHERE id=$1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Instancia no encontrada' });
    await pool.query('DELETE FROM instances WHERE id=$1', [req.params.id]);
    console.log(`[admin] Instancia eliminada: ${rows[0].db_name}`);
    res.json({ success: true, message: `Instancia "${rows[0].label}" eliminada de HC (DB de Odoo no fue tocada).` });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});
"""

if 'DELETE /admin/instances' not in routes:
    # Insertar antes del module.exports
    routes = routes.replace('module.exports = router;', delete_route + '\nmodule.exports = router;')
    with open('/opt/heptacloud/backend/routes/admin.routes.js', 'w') as f:
        f.write(routes)
    print("admin.routes.js OK")
else:
    print("admin.routes.js ya tenía el DELETE")

# ── admin/index.html ──────────────────────────────────────────
with open('/opt/heptacloud/frontend/public/admin/index.html', 'r') as f:
    html = f.read()

# 1. Agregar botón Eliminar en tabla de instancias
old_btn = "async function suspendInstance(id){"
new_btn = """async function deleteInstance(id,label){
  if(!confirm(`¿Eliminar "${label}" de Hepta Cloud?\\n\\nNOTA: Solo se elimina el registro. La DB en Odoo CE NO se borra.`)) return;
  const data=await api('DELETE',`/admin/instances/${id}`);
  if(data.success){showAlert('inst-ok','success',data.message);loadInstances();}
  else showAlert('inst-err','error',data.error);
}

async function suspendInstance(id){"""

html = html.replace(old_btn, new_btn)

# 2. Agregar botón Eliminar en la última columna de la tabla
old_td = """        ${i.status==='active'
          ? `<button class="btn btn-sm" style="background:#FEF3C7;color:#92400E;border:1px solid #FCD34D" onclick="suspendInstance(${i.id})">Suspender</button>`
          : i.status==='suspended'
          ? `<button class="btn btn-sm" style="background:var(--teal-pale);color:var(--teal);border:1px solid var(--teal)" onclick="reactivateInstance(${i.id})">Reactivar</button>`
          : ''
        }
      </td>"""

new_td = """        ${i.status==='active'
          ? `<button class="btn btn-sm" style="background:#FEF3C7;color:#92400E;border:1px solid #FCD34D" onclick="suspendInstance(${i.id})">Suspender</button>`
          : i.status==='suspended'
          ? `<button class="btn btn-sm" style="background:var(--teal-pale);color:var(--teal);border:1px solid var(--teal)" onclick="reactivateInstance(${i.id})">Reactivar</button>`
          : ''
        }
        <button class="btn btn-sm" style="background:var(--red-pale);color:var(--red);border:1px solid var(--red)" onclick="deleteInstance(${i.id},'${(i.label||'').replace(/'/g,'')}')">Eliminar</button>
      </td>"""

html = html.replace(old_td, new_td)

# 3. Agregar campos version y portal_url al modal de plantillas
old_fields = """      <div class="section-divider">Cierre</div>
      <div class="form-group"><label class="form-label">Texto de cierre</label><textarea class="form-textarea" id="tpl-email_cierre" rows="2" style="font-family:inherit"></textarea></div>
      <div class="form-hint">El diseño y estructura del email no cambian — solo los textos.</div>"""

new_fields = """      <div class="section-divider">Versión y portal</div>
      <div class="grid-2">
        <div class="form-group"><label class="form-label">Texto de versión</label><input class="form-input" id="tpl-email_version" placeholder="Hepta Cloud v19"/></div>
        <div class="form-group"><label class="form-label">URL del portal</label><input class="form-input" id="tpl-email_portal_url" placeholder="https://cloud.hepta.com.py/portal"/></div>
      </div>
      <div class="section-divider">Cierre</div>
      <div class="form-group"><label class="form-label">Texto de cierre</label><textarea class="form-textarea" id="tpl-email_cierre" rows="2" style="font-family:inherit"></textarea></div>
      <div class="form-hint">El diseño y estructura del email no cambian — solo los textos.</div>"""

html = html.replace(old_fields, new_fields)

# 4. Actualizar la lista de campos en openTemplateModal y saveTemplate
old_keys = "['titulo','subtitulo','cuerpo','paso1_titulo','paso1_desc','paso2_titulo','paso2_desc','paso3_titulo','paso3_desc','cierre']"
new_keys = "['titulo','subtitulo','cuerpo','paso1_titulo','paso1_desc','paso2_titulo','paso2_desc','paso3_titulo','paso3_desc','version','portal_url','cierre']"
html = html.replace(old_keys, new_keys, 2)  # reemplaza ambas ocurrencias (open y save)

with open('/opt/heptacloud/frontend/public/admin/index.html', 'w') as f:
    f.write(html)
print("admin/index.html OK")
