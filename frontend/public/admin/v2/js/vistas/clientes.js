// Clientes: lista (entidades fiscales) y la ficha de cada uno con todo lo suyo en un lugar.
import { html, raw, api, fecha, hace, fechaHora, chipEstado, paginar, normal, icono, wa, toast, confirmar, PLANES } from '../core.js';
import { menuInstancia } from '../acciones.js';
import { describir } from './actividad.js';

export async function render(v, rt, salio) {
  if (rt.partes[1]) return ficha(v, rt.partes[1], salio);
  let q = rt.q.get('q') || '', pagina = 1, todos = [];
  v.innerHTML = html`<div class="cab"><div><h1>Clientes</h1><p>Las entidades fiscales: a quién se le factura. Cada una con sus usuarios y sus servicios.</p></div>
      <a class="btn" href="/admin/#clients">+ Nuevo cliente ↗</a></div>
    <div class="filtros"><label class="buscar"><span class="sr">Buscar clientes</span>${icono('buscar')}<input class="inp" id="q" placeholder="Nombre, razón social, RUC, ciudad" value="${q}"></label></div>
    <section class="card"><div class="tabla-caja"><table><thead><tr><th scope="col">Cliente</th><th scope="col">RUC</th><th scope="col" class="solo-escritorio">Ciudad</th><th scope="col">Usuarios</th><th scope="col">Servicios</th><th scope="col">ERP</th><th scope="col" class="solo-escritorio">Desde</th></tr></thead><tbody id="tb"><tr><td colspan="7" class="cargando">Cargando…</td></tr></tbody></table></div>
    <div class="pie-tabla"><span id="info"></span><div class="btns"><button class="btn sm" type="button" id="ant">Anterior</button><button class="btn sm" type="button" id="sig">Siguiente</button></div></div></section>`.s;

  const pintar = () => {
    const nq = normal(q);
    const lista = todos.filter(c => !nq || normal(`${c.razon_social} ${c.nombre_comercial} ${c.numero_doc} ${c.ciudad} ${c.email}`).includes(nq));
    const p = paginar(lista, pagina);
    v.querySelector('#tb').innerHTML = p.filas.length ? p.filas.map(c => html`<tr class="clic" data-id="${c.id}" tabindex="0">
        <td><b>${c.nombre_comercial || c.razon_social}</b>${c.nombre_comercial && c.nombre_comercial !== c.razon_social ? html`<div class="muted chico">${c.razon_social}</div>` : ''}</td>
        <td class="nw">${c.numero_doc}${c.dv ? '-' + c.dv : ''}</td><td class="solo-escritorio">${c.ciudad || '—'}</td>
        <td>${c.usuarios}</td>
        <td class="nw">${c.instancias + c.otros_servicios}${c.suspendidas ? html` <span class="chip bad">${c.suspendidas} suspendida</span>` : ''}</td>
        <td>${c.erp_partner_id ? html`<span class="chip ok">Vinculado</span>` : c.erp_sync_state === 'error' ? html`<span class="chip bad">Error</span>` : html`<span class="chip mute">Sin vincular</span>`}</td>
        <td class="nw muted solo-escritorio">${fecha(c.created_at)}</td></tr>`).join('')
      : html`<tr><td colspan="7" class="vacio">${todos.length ? 'Sin resultados.' : 'Todavía no hay clientes.'}</td></tr>`.s;
    v.querySelector('#info').textContent = p.total ? `${p.desde}–${p.hasta} de ${p.total}` : '';
    v.querySelector('#ant').disabled = p.pagina <= 1; v.querySelector('#sig').disabled = p.pagina >= p.paginas;
    v.querySelectorAll('tr.clic').forEach(tr => {
      const abrir = () => { location.hash = `#/clientes/${tr.dataset.id}`; };
      tr.addEventListener('click', abrir); tr.addEventListener('keydown', e => { if (e.key === 'Enter') abrir(); });
    });
  };
  v.querySelector('#q').addEventListener('input', e => { q = e.target.value; pagina = 1; pintar(); });
  v.querySelector('#ant').addEventListener('click', () => { pagina--; pintar(); });
  v.querySelector('#sig').addEventListener('click', () => { pagina++; pintar(); });
  const r = await api('GET', '/admin/v2/clientes');
  if (salio()) return;
  if (!r.success) { v.querySelector('#tb').innerHTML = html`<tr><td colspan="7"><div class="aviso bad">${r.error}</div></td></tr>`.s; return; }
  todos = r.data; pintar();
}

async function ficha(v, id, salio) {
  v.innerHTML = '<div class="cargando">Cargando…</div>';
  const r = await api('GET', `/admin/v2/clientes/${encodeURIComponent(id)}`);
  if (salio()) return;
  if (!r.success) { v.innerHTML = html`<div class="card pad"><h1>Cliente</h1><div class="aviso bad">${r.error}</div><a href="#/clientes">Volver a clientes</a></div>`.s; return; }
  const { cliente: c, usuarios, instancias, servicios, correo, leads, actividad, errores } = r.data;
  const nombre = c.nombre_comercial || c.razon_social;
  const suspendidas = instancias.filter(i => i.status === 'suspended').length;
  const recargar = () => ficha(v, id, salio);
  const iniciales = nombre.split(/\s+/).map(p => p[0]).slice(0, 3).join('').toUpperCase();

  v.innerHTML = html`<nav aria-label="Ruta" class="chico muted" style="margin-bottom:10px"><a href="#/clientes">Clientes</a> / ${nombre}</nav>
    <section class="card pad" style="display:flex;flex-wrap:wrap;align-items:center;gap:18px;margin-bottom:16px">
      <div class="av" style="width:56px;height:56px;border-radius:12px;background:var(--navy);color:#fff;font-size:17px">${iniciales}</div>
      <div style="flex:1 1 320px;min-width:0">
        <div class="btns"><h1>${nombre}</h1>${suspendidas ? html`<span class="chip bad">${suspendidas} suspendida${suspendidas > 1 ? 's' : ''}</span>` : instancias.length ? html`<span class="chip ok">Activo</span>` : html`<span class="chip mute">Sin servicios</span>`}</div>
        <p class="muted chico" style="margin:4px 0 0">${c.razon_social} · RUC ${c.numero_doc}${c.dv ? '-' + c.dv : ''}${c.ciudad ? ' · ' + c.ciudad : ''} · cliente desde ${fecha(c.created_at)}</p>
      </div>
      <div class="btns"><a class="btn" href="/admin/#clients">Editar datos ↗</a><a class="btn pri" href="#/pedido?cliente=${c.id}">+ Sumar servicio</a></div>
    </section>
    ${errores.length ? html`<div class="aviso warn">No se pudo leer: ${errores.join(', ')}.</div>` : ''}
    <div class="grid g-2">
      <div class="col">
        <section class="card" aria-labelledby="svc"><div class="card-cab"><h2 id="svc">Servicios</h2></div>
          ${instancias.map(i => html`<div class="row" style="align-items:flex-start">${chipEstado(i.status)}
            <div class="flex"><b>HEPTA ERP · ${PLANES[i.plan] || i.plan || '—'}</b> <span class="muted">${i.label ? '· ' + i.label : ''}</span>
              <div class="muted chico"><a href="${i.custom_domain ? 'https://' + i.custom_domain : (i.instance_url || 'https://' + i.db_name)}" target="_blank" rel="noopener">${i.custom_domain || i.db_name}</a>${i.custom_domain ? ` (antes ${i.db_name})` : ''} · alta ${fecha(i.created_at)}</div></div>
            <button class="btn sm" type="button" data-inst="${i.id}" aria-haspopup="menu" aria-label="Acciones de ${i.label || i.db_name}">${icono('puntos')}</button></div>`)}
          ${correo.map(d => html`<div class="row" style="align-items:flex-start">${chipEstado(d.status)}
            <div class="flex"><b>HEPTA Mail · ${d.domain}</b><div class="muted chico">dueño ${d.owner_email}${d.max_mailboxes ? ` · hasta ${d.max_mailboxes} casillas` : ''}</div></div>
            <a class="btn sm" href="#/servicios/mail?q=${encodeURIComponent(d.domain)}">Ver</a></div>`)}
          ${servicios.map(s => html`<div class="row" style="align-items:flex-start">${chipEstado(s.status)}
            <div class="flex"><b>HEPTA ${s.service === 'drive' ? 'Drive' : s.service} · ${s.slug}</b><div class="muted chico">${s.fqdn || ''}</div></div>
            <a class="btn sm" href="#/servicios/drive?q=${encodeURIComponent(s.slug)}">Ver</a></div>`)}
          ${!instancias.length && !correo.length && !servicios.length ? html`<div class="vacio">Sin servicios todavía. <a href="#/pedido?cliente=${c.id}">Armar un pedido</a></div>` : ''}
        </section>
        <section class="card" aria-labelledby="fac"><div class="card-cab"><h2 id="fac">Facturación</h2><span class="chip mute">pronto</span></div>
          <div class="row"><div class="flex">${c.erp_partner_id ? html`Vinculado al ERP del grupo (contacto #${c.erp_partner_id}). Las facturas y la suscripción se van a ver acá cuando se conecte la lectura del ERP.` : html`Todavía no está vinculado al ERP del grupo.`}</div>
            ${c.erp_partner_id ? '' : html`<button class="btn sm pri" type="button" id="erp">Vincular al ERP</button>`}</div>
          ${c.erp_sync_state === 'error' ? html`<div class="aviso bad" style="margin:0 16px 12px">${c.erp_last_error || 'Error al vincular'}</div>` : ''}
        </section>
        ${leads.length ? html`<section class="card" aria-labelledby="lds"><div class="card-cab"><h2 id="lds">Pedidos y consultas</h2></div>
          ${leads.map(l => html`<div class="row"><span class="muted chico" style="width:84px">${fecha(l.created_at)}</span><div class="flex">${l.company_name || l.full_name}${l.plan_slug ? ' · ' + (PLANES[l.plan_slug] || l.plan_slug) : ''}</div><span class="chip mute">${l.status}</span></div>`)}</section>` : ''}
      </div>
      <div class="col">
        <section class="card pad" aria-labelledby="dat"><h2 id="dat" style="margin-bottom:14px">Datos</h2>
          <dl class="kv"><dt>Razón social</dt><dd>${c.razon_social}</dd><dt>Correo</dt><dd>${c.email || '—'}</dd>
            <dt>Teléfono</dt><dd>${c.telefono ? html`${c.telefono} · <a href="${wa(c.telefono)}" target="_blank" rel="noopener">WhatsApp</a>` : '—'}</dd>
            <dt>Dirección</dt><dd>${[c.direccion, c.ciudad, c.departamento].filter(Boolean).join(', ') || '—'}</dd><dt>Origen</dt><dd>${c.origen || '—'}</dd></dl></section>
        <section class="card" aria-labelledby="usr"><div class="card-cab"><h2 id="usr">Usuarios del portal</h2><a class="chico" href="/admin/#users">Administrar ↗</a></div>
          ${usuarios.length ? usuarios.map(u => html`<div class="row"><div class="flex"><b>${u.full_name || u.email}</b> ${u.is_active === false ? html`<span class="chip mute">sin acceso</span>` : ''}<div class="muted chico">${u.email}${u.rol ? ' · ' + u.rol : ''}</div></div><span class="muted chico">${u.last_login_at ? 'entró ' + hace(u.last_login_at) : 'nunca entró'}</span></div>`)
            : html`<div class="vacio">Sin usuarios vinculados.</div>`}</section>
        <section class="card" aria-labelledby="hist"><div class="card-cab"><h2 id="hist">Actividad</h2></div>
          ${actividad.length ? actividad.map(l => html`<div class="row"><span class="muted chico" style="width:108px;flex-shrink:0;white-space:nowrap">${fechaHora(l.created_at)}</span><div class="flex">${(l.usuario || 'Sistema').split(' ')[0]} ${describir(l)}</div></div>`)
            : html`<div class="vacio">Sin actividad registrada.</div>`}</section>
      </div>
    </div>`.s;

  v.querySelectorAll('[data-inst]').forEach(b => b.addEventListener('click', () => menuInstancia(b, instancias.find(i => String(i.id) === b.dataset.inst), recargar)));
  const erp = v.querySelector('#erp');
  if (erp) erp.addEventListener('click', async () => {
    if (!(await confirmar({ titulo: 'Vincular al ERP', boton: 'Vincular', texto: `Se busca ${c.razon_social} por RUC en el ERP del grupo; si no está, se crea el contacto. Es lo que permite facturarle desde ahí.` }))) return;
    const res = await api('POST', `/admin/clients/${c.id}/erp`, {});
    if (res.success) { toast('Vinculado al ERP', 'ok'); recargar(); }
  });
}
export { raw };
