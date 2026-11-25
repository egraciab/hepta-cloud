// Servicios: HEPTA ERP (con acciones), HEPTA Mail, HEPTA Drive y Dominios propios.
// Mail y Drive se listan acá; sus acciones (casillas, DNS, usuarios, secretos, baja) siguen en el Admin actual.
import { html, raw, api, fecha, hace, chipEstado, paginar, normal, icono, PLANES } from '../core.js';
import { menuInstancia } from '../acciones.js';

const PESTANAS = [['erp', 'HEPTA ERP'], ['mail', 'HEPTA Mail'], ['drive', 'HEPTA Drive'], ['dominios', 'Dominios propios']];

export async function render(v, rt, salio) {
  const tab = PESTANAS.some(p => p[0] === rt.partes[1]) ? rt.partes[1] : 'erp';
  v.innerHTML = html`<div class="cab"><div><h1>Servicios</h1><p>Todo lo que HEPTA Cloud opera para sus clientes.</p></div>
      <div class="seg" role="tablist" aria-label="Tipo de servicio">${PESTANAS.map(([id, t]) => html`<a role="tab" href="#/servicios/${id}" class="${id === tab ? 'on' : ''}" ${raw(id === tab ? 'aria-selected="true"' : 'aria-selected="false"')}>${t}</a>`)}</div></div>
    <div id="cont"></div>`.s;
  const cont = v.querySelector('#cont');
  if (tab === 'erp') return erp(cont, rt, salio);
  if (tab === 'mail') return mail(cont, rt, salio);
  if (tab === 'drive') return drive(cont, rt, salio);
  return dominios(cont, salio);
}

// ── HEPTA ERP ────────────────────────────────────────────────
async function erp(cont, rt, salio) {
  let q = rt.q.get('q') || '', estado = rt.q.get('estado') || '', plan = '', pagina = 1, todas = [], altas = [];
  cont.innerHTML = html`<div class="filtros">
      <label class="buscar"><span class="sr">Buscar instancias</span>${icono('buscar')}<input class="inp" id="q" placeholder="Instancia, cliente, dominio o correo" value="${q}"></label>
      <span id="chips" class="btns"></span>
      <label class="btns chico muted">Plan <select class="inp" id="plan" style="width:auto;height:30px"><option value="">Todos</option><option value="starter">Despegue</option><option value="professional">Crecimiento</option><option value="enterprise">Empresa</option></select></label>
      <button class="btn sm" type="button" id="csv" style="margin-left:auto">Exportar CSV</button>
    </div>
    <div id="altas"></div>
    <section class="card"><div class="tabla-caja"><table><thead><tr><th scope="col">Instancia</th><th scope="col">Cliente</th><th scope="col">Plan</th><th scope="col">Dirección</th><th scope="col" class="solo-escritorio">Alta</th><th scope="col">Estado</th><th scope="col"><span class="sr">Acciones</span></th></tr></thead><tbody id="tb"><tr><td colspan="7" class="cargando">Cargando…</td></tr></tbody></table></div>
    <div class="pie-tabla"><span id="info"></span><div class="btns"><button class="btn sm" type="button" id="ant">Anterior</button><button class="btn sm" type="button" id="sig">Siguiente</button></div></div></section>
    <p class="muted chico">La baja de una instancia sigue en el Admin actual, con su confirmación reforzada.</p>`.s;

  const filtradas = () => {
    const nq = normal(q);
    return todas.filter(i => (!estado || i.status === estado) && (!plan || i.plan === plan)
      && (!nq || normal(`${i.label} ${i.db_name} ${i.custom_domain} ${i.email} ${i.full_name}`).includes(nq)));
  };
  const pintar = () => {
    const cuenta = (st) => todas.filter(i => !st || i.status === st).length;
    cont.querySelector('#chips').innerHTML = [['', 'Todas'], ['active', 'Activas'], ['suspended', 'Suspendidas']].map(([st, t]) =>
      html`<button type="button" class="btn sm ${estado === st ? 'sel' : ''}" data-st="${st}" aria-pressed="${estado === st}">${t} · ${cuenta(st)}</button>`).join('');
    cont.querySelectorAll('[data-st]').forEach(b => b.addEventListener('click', () => { estado = b.dataset.st; pagina = 1; pintar(); }));
    const p = paginar(filtradas(), pagina);
    cont.querySelector('#tb').innerHTML = p.filas.length ? p.filas.map(i => html`<tr>
        <td><b>${(i.db_name || '').split('.')[0]}</b>${i.label ? html`<div class="muted chico">${i.label}</div>` : ''}</td>
        <td>${i.full_name || i.email || '—'}${i.full_name && i.email ? html`<div class="muted chico">${i.email}</div>` : ''}</td>
        <td class="nw">${PLANES[i.plan] || i.plan || '—'}</td>
        <td><a href="${i.custom_domain ? 'https://' + i.custom_domain : (i.instance_url || 'https://' + i.db_name)}" target="_blank" rel="noopener">${i.custom_domain || i.db_name}</a>${i.custom_domain ? html` <span class="chip info">propio</span>` : ''}</td>
        <td class="nw muted solo-escritorio">${fecha(i.created_at)}</td>
        <td class="nw">${chipEstado(i.status)}${i.status === 'suspended' && i.suspended_at ? html`<div class="muted chico">${hace(i.suspended_at)}</div>` : ''}</td>
        <td><button class="btn sm" type="button" data-inst="${i.id}" aria-haspopup="menu" aria-expanded="false" aria-label="Acciones de ${i.db_name}">${icono('puntos')}</button></td></tr>`).join('')
      : html`<tr><td colspan="7" class="vacio">${todas.length ? 'Sin resultados con estos filtros.' : 'Todavía no hay instancias.'}</td></tr>`.s;
    cont.querySelector('#info').textContent = p.total ? `${p.desde}–${p.hasta} de ${p.total}` : '';
    cont.querySelector('#ant').disabled = p.pagina <= 1; cont.querySelector('#sig').disabled = p.pagina >= p.paginas;
    cont.querySelectorAll('[data-inst]').forEach(b => b.addEventListener('click', () => menuInstancia(b, todas.find(i => String(i.id) === b.dataset.inst), cargar)));
    const enCurso = altas.filter(a => a.estado === 'en_curso');
    cont.querySelector('#altas').innerHTML = enCurso.length ? html`<div class="aviso info">${enCurso.map(a => html`<div>Alta en curso: <b>${a.tenant}</b> · ${a.plan_nombre} · ${a.paso}</div>`)}</div>`.s : '';
  };
  const cargar = async () => {
    const [r, a] = await Promise.all([api('GET', '/admin/instances'), api('GET', '/admin/provision/jobs', undefined, { silencioso: true })]);
    if (salio()) return;
    if (!r.success) { cont.querySelector('#tb').innerHTML = html`<tr><td colspan="7"><div class="aviso bad">${r.error}</div></td></tr>`.s; return; }
    todas = r.data.filter(i => i.status !== 'cancelled'); altas = a.success ? a.data : []; pintar();
  };
  cont.querySelector('#q').addEventListener('input', e => { q = e.target.value; pagina = 1; pintar(); });
  cont.querySelector('#plan').addEventListener('change', e => { plan = e.target.value; pagina = 1; pintar(); });
  cont.querySelector('#ant').addEventListener('click', () => { pagina--; pintar(); });
  cont.querySelector('#sig').addEventListener('click', () => { pagina++; pintar(); });
  cont.querySelector('#csv').addEventListener('click', () => {
    const cel = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`;
    const filas = [['instancia', 'nombre', 'cliente', 'correo', 'plan', 'direccion', 'estado', 'alta'],
      ...filtradas().map(i => [(i.db_name || '').split('.')[0], i.label, i.full_name, i.email, PLANES[i.plan] || i.plan, i.custom_domain || i.db_name, i.status, (i.created_at || '').slice(0, 10)])];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + filas.map(f => f.map(cel).join(';')).join('\n')], { type: 'text/csv;charset=utf-8' }));
    a.download = `instancias-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(a.href);
  });
  await cargar();
}

// ── HEPTA Mail ───────────────────────────────────────────────
async function mail(cont, rt, salio) {
  let q = rt.q.get('q') || '';
  cont.innerHTML = html`<div class="filtros"><label class="buscar"><span class="sr">Buscar dominios</span>${icono('buscar')}<input class="inp" id="q" placeholder="Dominio o dueño" value="${q}"></label>
      <span id="salud" class="chico"></span><a class="btn sm" href="/admin/#mail" style="margin-left:auto">Alta y casillas ↗</a></div>
    <section class="card"><div class="tabla-caja"><table><thead><tr><th scope="col">Dominio</th><th scope="col">Dueño</th><th scope="col">Casillas</th><th scope="col">Cuota</th><th scope="col">DNS</th><th scope="col">Estado</th></tr></thead><tbody id="tb"><tr><td colspan="6" class="cargando">Cargando…</td></tr></tbody></table></div></section>`.s;
  api('GET', '/admin/mail/health', undefined, { silencioso: true }).then(h => { if (!salio()) cont.querySelector('#salud').innerHTML = html`<span class="punto ${h.success ? 'ok' : 'bad'}" style="display:inline-block"></span> mailcow ${h.success ? 'responde' : 'no responde'}`.s; });
  const r = await api('GET', '/admin/mail/domains');
  if (salio()) return;
  if (!r.success) { cont.querySelector('#tb').innerHTML = html`<tr><td colspan="6"><div class="aviso bad">${r.error}</div></td></tr>`.s; return; }
  const pintar = () => {
    const nq = normal(q), lista = r.data.filter(d => !nq || normal(`${d.domain} ${d.owner_email}`).includes(nq));
    cont.querySelector('#tb').innerHTML = lista.length ? lista.map(d => html`<tr>
        <td><b>${d.domain}</b></td><td>${d.owner_email}${d.owner_tiene_usuario === false ? html` <span class="chip warn" title="El dueño no tiene usuario en el portal: no va a ver su correo">sin usuario</span>` : ''}</td>
        <td>hasta ${d.max_mailboxes ?? '—'}</td><td class="nw">${d.def_quota_mb ? Math.round(d.def_quota_mb / 1024) + ' GB c/u' : '—'}</td>
        <td>${d.dns_verified_at ? html`<span class="chip ok">verificado</span>` : html`<span class="chip warn">sin verificar</span>`}</td><td>${chipEstado(d.status)}</td></tr>`).join('')
      : html`<tr><td colspan="6" class="vacio">${r.data.length ? 'Sin resultados.' : 'Todavía no hay dominios de correo.'}</td></tr>`.s;
  };
  cont.querySelector('#q').addEventListener('input', e => { q = e.target.value; pintar(); });
  pintar();
}

// ── HEPTA Drive ──────────────────────────────────────────────
async function drive(cont, rt, salio) {
  let q = rt.q.get('q') || '';
  cont.innerHTML = html`<div class="filtros"><label class="buscar"><span class="sr">Buscar instancias de Drive</span>${icono('buscar')}<input class="inp" id="q" placeholder="Cliente o dirección" value="${q}"></label>
      <a class="btn sm" href="/admin/#drive" style="margin-left:auto">Alta, usuarios y secretos ↗</a></div>
    <div id="aviso"></div>
    <section class="card"><div class="tabla-caja"><table><thead><tr><th scope="col">Instancia</th><th scope="col">Cliente</th><th scope="col">Usuarios</th><th scope="col">Última copia</th><th scope="col">Secretos</th><th scope="col">Estado</th></tr></thead><tbody id="tb"><tr><td colspan="6" class="cargando">Preguntando al agente de la VM (puede tardar unos segundos)…</td></tr></tbody></table></div></section>`.s;
  const r = await api('GET', '/admin/drive');
  if (salio()) return;
  if (!r.success) { cont.querySelector('#tb').innerHTML = html`<tr><td colspan="6"><div class="aviso bad">${r.error}</div></td></tr>`.s; return; }
  if (r.data.agente_error) cont.querySelector('#aviso').innerHTML = html`<div class="aviso warn">El agente de HEPTA Drive no respondió (${r.data.agente_error}): se muestra solo lo registrado en HEPTA Cloud.</div>`.s;
  const pintar = () => {
    const nq = normal(q), lista = r.data.instancias.filter(i => !nq || normal(`${i.slug} ${i.fqdn} ${i.dominio} ${i.registro && i.registro.cliente}`).includes(nq));
    cont.querySelector('#tb').innerHTML = lista.length ? lista.map(i => {
      const st = i.solo_registro ? (i.registro && i.registro.status) : (i.suspendida ? 'suspended' : (i.registro && i.registro.status) || 'active');
      return html`<tr><td><b>${i.slug}</b><div class="muted chico">${i.dominio || i.fqdn || ''}</div></td>
        <td>${i.registro && i.registro.cliente || '—'}</td><td>${i.usuarios ?? '—'}</td>
        <td class="nw">${i.ultima_copia || '—'}</td>
        <td>${i.secretos_pendientes ? html`<span class="chip warn">sin bajar</span>` : i.solo_registro ? '—' : html`<span class="chip ok">en KeePass</span>`}</td>
        <td>${chipEstado(st)}${i.solo_registro ? html`<div class="muted chico">no está en la VM</div>` : ''}</td></tr>`;
    }).join('') : html`<tr><td colspan="6" class="vacio">${r.data.instancias.length ? 'Sin resultados.' : 'Todavía no hay instancias de HEPTA Drive.'}</td></tr>`.s;
  };
  cont.querySelector('#q').addEventListener('input', e => { q = e.target.value; pintar(); });
  pintar();
}

// ── Dominios propios (de los tenants) ────────────────────────
async function dominios(cont, salio) {
  const r = await api('GET', '/admin/instances');
  if (salio()) return;
  const lista = r.success ? r.data.filter(i => i.custom_domain && i.status !== 'cancelled') : [];
  cont.innerHTML = html`<section class="card"><div class="tabla-caja"><table><thead><tr><th scope="col">Dominio</th><th scope="col">Instancia</th><th scope="col">Cliente</th><th scope="col">Estado</th></tr></thead><tbody>
    ${lista.length ? lista.map(i => html`<tr><td><a href="https://${i.custom_domain}" target="_blank" rel="noopener"><b>${i.custom_domain}</b></a></td><td>${i.db_name}</td><td>${i.full_name || i.email || '—'}</td><td>${chipEstado(i.status)}</td></tr>`)
      : html`<tr><td colspan="4" class="vacio">${r.success ? 'Ninguna instancia tiene dominio propio todavía. Se activa desde HEPTA ERP → ⋯ → Dominio propio.' : r.error}</td></tr>`}
    </tbody></table></div></section>
    <p class="muted chico">El vencimiento en NIC.PY de cada dominio gestionado se va a cargar acá (próxima entrega).</p>`.s;
}
