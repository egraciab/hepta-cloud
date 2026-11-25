// Registro de actividad (admin_logs): quién hizo qué y cuándo, con búsqueda y paginado.
import { html, api, fechaHora } from '../core.js';

// Texto legible de cada acción. Lo que no está en la lista se muestra con su nombre técnico.
const ACCIONES = {
  suspend_instance: 'suspendió', reactivate_instance: 'reactivó', cancel_instance: 'dio de baja',
  admin_password_tenant: 'pidió la clave admin de', activate_custom_domain: 'activó el dominio propio de',
  addon_install: 'instaló un módulo en', provision_instance: 'dio de alta',
  drive_create: 'dio de alta HEPTA Drive', drive_delete: 'dio de baja HEPTA Drive', drive_publish: 'publicó HEPTA Drive',
  drive_custom_domain: 'agregó un dominio a HEPTA Drive', drive_add_users: 'sumó usuarios a HEPTA Drive',
  drive_user_delete: 'borró un usuario de HEPTA Drive', drive_secrets_download: 'bajó los secretos de HEPTA Drive',
  drive_secrets_saved: 'confirmó en KeePass los secretos de HEPTA Drive', update_user_access: 'cambió el acceso del usuario',
};
function detalle(l) {
  let d = l.detail;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = {}; } }
  d = d || {};
  return d.dominio || d.tenant || d.db || d.slug || d.email || d.addon || '';
}
export function describir(l) {
  const que = ACCIONES[l.action] || l.action.replace(/_/g, ' ');
  const sobre = detalle(l) || l.target || '';
  let estado = '';
  try { const d = typeof l.detail === 'string' ? JSON.parse(l.detail) : l.detail; if (d && d.estado && d.estado !== 'ok') estado = ` (${d.estado}${d.error ? ': ' + d.error : ''})`; } catch (e) { /* sin detalle */ }
  return html`${que} <b>${sobre}</b>${estado}`;
}

export async function render(v, rt, salio) {
  const POR = 50;
  let pagina = 0, q = rt.q.get('q') || '';
  v.innerHTML = html`<div class="cab"><div><h1>Registro de actividad</h1><p>Todo lo que se hizo desde el Admin: altas, suspensiones, claves, dominios, módulos.</p></div></div>
    <div class="filtros"><label class="buscar"><span class="sr">Buscar en el registro</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg><input class="inp" id="q" placeholder="Acción, instancia, dominio, persona" value="${q}"></label></div>
    <section class="card"><div class="tabla-caja"><table><thead><tr><th scope="col">Cuándo</th><th scope="col">Quién</th><th scope="col">Qué</th><th scope="col">Objeto</th></tr></thead><tbody id="tb"></tbody></table></div>
    <div class="pie-tabla"><span id="info"></span><div class="btns"><button class="btn sm" type="button" id="ant">Anterior</button><button class="btn sm" type="button" id="sig">Siguiente</button></div></div></section>`.s;
  const cargar = async () => {
    const r = await api('GET', `/admin/v2/actividad?limit=${POR}&offset=${pagina * POR}&q=${encodeURIComponent(q)}`);
    if (salio()) return;
    const tb = v.querySelector('#tb');
    if (!r.success) { tb.innerHTML = html`<tr><td colspan="4"><div class="aviso bad">${r.error}</div></td></tr>`.s; return; }
    tb.innerHTML = r.data.length ? r.data.map(l => html`<tr><td class="nw muted">${fechaHora(l.created_at)}</td><td class="nw">${l.usuario || l.usuario_email || 'Sistema'}</td><td>${describir(l)}</td><td class="muted chico">${l.target || ''}</td></tr>`).join('')
      : html`<tr><td colspan="4" class="vacio">Sin resultados.</td></tr>`.s;
    v.querySelector('#info').textContent = r.data.length ? `${pagina * POR + 1}–${pagina * POR + r.data.length}` : '';
    v.querySelector('#ant').disabled = pagina === 0;
    v.querySelector('#sig').disabled = r.data.length < POR;
  };
  let t;
  v.querySelector('#q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { q = e.target.value.trim(); pagina = 0; cargar(); }, 300); });
  v.querySelector('#ant').addEventListener('click', () => { pagina = Math.max(0, pagina - 1); cargar(); });
  v.querySelector('#sig').addEventListener('click', () => { pagina++; cargar(); });
  cargar();
}
