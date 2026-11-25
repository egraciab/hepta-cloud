// ============================================================
//  HEPTA CLOUD — Admin nuevo: acciones sobre una instancia de HEPTA ERP
//  Todas usan las rutas de siempre (/api/admin/provision/*, /api/admin/instances/*), que validan y dejan
//  rastro en admin_logs. La baja sigue en el Admin actual hasta pasarla con su confirmación reforzada.
// ============================================================
import { html, raw, api, sesion, modal, confirmar, toast, menu, seguir, esc, PLANES } from './core.js';

export function menuInstancia(boton, inst, recargar) {
  const activa = inst.status === 'active', suspendida = inst.status === 'suspended';
  const url = inst.custom_domain ? `https://${inst.custom_domain}` : (inst.instance_url || `https://${inst.db_name}`);
  menu(boton, [
    { texto: 'Abrir el sistema ↗', accion: () => window.open(url, '_blank', 'noopener') },
    { texto: 'Editar nombre y notas', accion: () => editar(inst, recargar) },
    { texto: 'Módulos adicionales', accion: () => modulos(inst, recargar), deshabilitado: !activa },
    { texto: 'Dominio propio', accion: () => dominio(inst, recargar), deshabilitado: !activa },
    { texto: sesion.godmode ? 'Clave admin' : 'Clave admin (solo godmode)', accion: () => claveAdmin(inst), deshabilitado: !activa || !sesion.godmode },
    { sep: true },
    activa ? { texto: 'Suspender', clase: 'warn-t', accion: () => suspender(inst, recargar) }
           : { texto: 'Reactivar', accion: () => reactivar(inst, recargar), deshabilitado: !suspendida },
    { texto: 'Dar de baja (en el Admin actual) ↗', clase: 'bad-t', accion: () => { location.href = '/admin/#instances'; } },
  ]);
}

const nombre = (i) => i.label || (i.db_name || '').split('.')[0];

async function editar(inst, recargar) {
  modal({
    titulo: `Editar ${nombre(inst)}`,
    contenido: html`<div class="col" style="gap:12px">
      <label class="fld">Nombre<input id="e-label" value="${inst.label || ''}" maxlength="120"></label>
      <label class="fld">Notas internas<textarea id="e-notas" maxlength="2000">${inst.notes || ''}</textarea></label>
      <p class="muted chico" style="margin:0">El plan y el estado no se editan acá: el plan se cambia con un upsell y el estado con Suspender o Reactivar, que sí cortan o devuelven el acceso.</p></div>`,
    botones: [{ texto: 'Cancelar' }, { texto: 'Guardar', clase: 'pri', accion: async (c, r) => {
      const res = await api('PUT', `/admin/instances/${inst.id}`, { label: r.querySelector('#e-label').value.trim(), notes: r.querySelector('#e-notas').value });
      if (!res.success) return true;
      toast('Guardado', 'ok'); recargar();
    } }],
  });
}

async function suspender(inst, recargar) {
  const ok = await confirmar({ titulo: `Suspender ${nombre(inst)}`, boton: 'Suspender', peligro: true,
    texto: 'Nadie va a poder entrar al sistema y el sitio muestra la página de servicio en pausa. Los datos quedan intactos y se puede reactivar cuando quieras.' });
  if (!ok) return;
  const r = await api('POST', `/admin/provision/suspend/${inst.id}`, {});
  if (r.success) { toast(r.message || 'Suspendida', 'ok'); recargar(); }
}

async function reactivar(inst, recargar) {
  const ok = await confirmar({ titulo: `Reactivar ${nombre(inst)}`, boton: 'Reactivar', texto: 'Vuelve el acceso al sistema y al sitio.' });
  if (!ok) return;
  const r = await api('POST', `/admin/provision/reactivate/${inst.id}`, {});
  if (r.success) { toast(r.message || 'Reactivada', 'ok'); recargar(); }
}

// La clave se muestra UNA vez y no queda en ningún lado (ni en esta página después de cerrar)
async function claveAdmin(inst) {
  const ok = await confirmar({ titulo: `Clave admin de ${nombre(inst)}`, boton: 'Generar clave nueva',
    texto: 'Se genera una contraseña nueva al azar para la cuenta admin (la de HEPTA) y la anterior deja de servir. Se muestra una sola vez: copiala a KeePass.' });
  if (!ok) return;
  toast('Generando… (Odoo tarda unos segundos)', '', 4000);
  const r = await api('POST', `/admin/provision/admin-password/${inst.id}`, {});
  if (!r.success) return;
  const { raiz } = modal({
    titulo: 'Clave admin: copiala ahora',
    contenido: html`<dl class="kv" style="margin-bottom:10px"><dt>Sistema</dt><dd>${r.data.url}</dd><dt>Usuario</dt><dd>${r.data.login}</dd></dl>
      <div class="secreto" id="sec">${r.data.password}</div>
      <div class="aviso warn">No se guarda en ningún lado. Al cerrar esta ventana no se puede volver a ver.</div>`,
    botones: [{ texto: 'Copiar', accion: async () => { try { await navigator.clipboard.writeText(r.data.password); toast('Copiada', 'ok', 2500); } catch (e) { toast('No se pudo copiar: seleccionala y copiala a mano', 'bad'); } return true; } },
              { texto: 'Ya la guardé', clase: 'pri' }],
    alCerrar: () => { const s = raiz.querySelector('#sec'); if (s) s.textContent = ''; },
  });
}

async function modulos(inst, recargar) {
  const r = await api('GET', `/admin/provision/addons/${inst.id}`);
  if (!r.success) return;
  const lista = r.data;
  const estado = (a) => a.status === 'installed' ? html`<span class="chip ok">Instalado</span>`
    : a.status === 'installing' ? html`<span class="chip info">Instalando</span>`
    : a.status === 'failed' ? html`<span class="chip bad" title="${a.error || ''}">Falló</span>` : '';
  const { raiz, cerrar } = modal({
    titulo: `Módulos adicionales · ${nombre(inst)}`, ancho: true,
    contenido: lista.length ? html`<p class="muted" style="margin:0 0 8px">Se instalan en segundo plano (1 a 4 minutos). Solo plan Crecimiento o superior.</p>
      ${lista.map(a => html`<div class="row" style="padding:12px 0"><div class="flex"><b>${a.name}</b> ${estado(a)}<div class="muted chico">${a.description || ''}</div></div>
        <span class="muted chico nw">${a.price_label || ''}</span>
        ${a.status === 'installed' ? '' : html`<button class="btn sm pri" type="button" data-addon="${a.id}" ${raw(a.status === 'installing' ? 'disabled' : '')}>Instalar</button>`}</div>`)}`
      : html`<div class="vacio">No hay módulos adicionales activos.</div>`,
  });
  raiz.querySelectorAll("[data-addon]").forEach(b => b.addEventListener("click", async () => {
    const a = lista.find(x => String(x.id) === b.dataset.addon);
    if (!(await confirmar({ titulo: `Instalar ${a.name}`, boton: 'Instalar', texto: `Se instala en ${nombre(inst)}. El cliente no tiene que hacer nada; tarda de 1 a 4 minutos.` }))) return;
    const ini = await api('POST', `/admin/provision/addons/${inst.id}`, { addon_id: a.id });
    if (!ini.success) return;
    cerrar();
    toast(`Instalando ${a.name}… te aviso acá cuando termine.`, '', 8000);
    const fin = await seguir(`/admin/provision/addon-jobs/${ini.data.job.id}`);
    if (fin.estado === 'ok') toast(`${a.name} instalado en ${nombre(inst)}.`, 'ok', 0);
    else toast(`${a.name} no se pudo instalar: ${fin.error || 'sin detalle'}`, 'bad', 0);
    recargar();
  }));
}

// Dominio propio: revisión (no cambia nada) → confirmación con lo que cambia → trabajo en segundo plano
async function dominio(inst, recargar) {
  const { raiz } = modal({
    titulo: `Dominio propio · ${nombre(inst)}`,
    contenido: html`<label class="fld">Dominio del cliente<input id="d-dom" placeholder="cliente.com.py" value="${inst.custom_domain || ''}" autocomplete="off"><span class="ayuda">Sin www ni https. Primero se revisa el DNS: no se cambia nada hasta que confirmes.</span></label><div id="d-rev"></div>`,
    botones: [{ texto: 'Cancelar' }, { texto: 'Revisar', clase: 'pri', accion: async (cerrar, r) => {
      const d = r.querySelector('#d-dom').value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
      if (!d) { toast('Escribí el dominio', 'bad'); return true; }
      const rev = await api('GET', `/admin/provision/custom-domain/${inst.id}?domain=${encodeURIComponent(d)}`);
      if (!rev.success) { toast(rev.error, 'bad'); return true; }
      cerrar(); revisionDominio(inst, rev.data, recargar);
    } }],
  });
  raiz.querySelector('#d-dom').focus();
}

function revisionDominio(inst, r, recargar) {
  const bloqueos = r.modo === 'hepta' ? r.bloqueos : (r.listo ? [] : [`Todavía no apunta. ${r.instrucciones}`]);
  const filas = r.modo === 'hepta'
    ? html`<p style="margin:0 0 8px">La zona <b>${r.zona}</b> está en la cuenta de Cloudflare de HEPTA. Va a quedar:</p>
      ${r.registros.map(g => html`<div class="row" style="padding:8px 0"><div class="flex"><b>${g.nombre}</b> → CNAME ${r.destino} (con proxy)
        ${g.accion === 'reemplazar' ? html`<div class="chico" style="color:var(--warn)">Reemplaza: ${g.actuales.map(a => `${a.tipo} ${a.valor}${a.proxy ? ' (proxy)' : ''}`).join(', ')}</div>` : ''}</div>
        <span class="chip ${g.accion === 'nada' ? 'ok' : g.accion === 'crear' ? 'info' : 'warn'}">${g.accion === 'nada' ? 'ya está' : g.accion}</span></div>`)}
      ${r.ssl_cambia ? html`<div class="row" style="padding:8px 0"><div class="flex">SSL de la zona: ${r.ssl || '?'} → Full (strict)</div></div>` : ''}
      <div class="row" style="padding:8px 0"><div class="flex">Correo (MX): ${r.correo.length ? r.correo.join(', ') : 'la zona no tiene MX'}</div><span class="chip ${r.correo.length ? 'mute' : 'warn'}">${r.correo.length ? 'no se toca' : 'ojo'}</span></div>`
    : html`<p style="margin:0 0 8px">El DNS lo maneja el cliente.</p>${r.registros.map(g => html`<div class="row" style="padding:8px 0"><div class="flex">${g.nombre}</div><span class="chip ${g.apunta ? 'ok' : 'warn'}">${g.apunta ? 'apunta bien' : 'no apunta todavía'}</span></div>`)}`;
  modal({
    titulo: `Activar ${r.dominio}`, ancho: true,
    contenido: html`${filas}${bloqueos.length ? html`<div class="aviso bad">${bloqueos.map(b => html`<div>${b}</div>`)}</div>`
      : html`<div class="aviso info">Después: certificado, prueba de https://${r.dominio} y recién ahí ${r.db} manda al dominio propio. Si la prueba falla, el DNS vuelve a como estaba.</div>`}`,
    botones: bloqueos.length ? [{ texto: 'Cerrar' }] : [{ texto: 'Cancelar' }, { texto: 'Activar', clase: 'pri', accion: async () => {
      const ini = await api('POST', `/admin/provision/custom-domain/${inst.id}`, { domain: r.dominio, reemplazar: r.hay_que_reemplazar === true });
      if (!ini.success) return true;
      toast(`Activando ${r.dominio}: certificado, DNS y prueba (1 a 5 minutos). Te aviso acá.`, '', 10000);
      seguir(`/admin/provision/custom-domain-jobs/${ini.data.job.id}`).then(fin => {
        const av = fin.avisos && fin.avisos.length ? ` · ${fin.avisos.join(' · ')}` : '';
        if (fin.estado === 'ok') toast(`✓ ${r.dominio} activo${av}`, 'ok', 0);
        else toast(`No se pudo activar ${r.dominio}: ${fin.error || 'sin detalle'}${av}`, 'bad', 0);
        recargar();
      });
    } }],
  });
}

export const nombrePlan = (p) => PLANES[p] || p || '—';
export { esc };
