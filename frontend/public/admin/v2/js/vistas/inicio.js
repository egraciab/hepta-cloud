// Inicio: los números del día, lo que requiere atención, trabajos en curso, estado de la plataforma y actividad.
import { html, api, gs, hace, fechaHora, wa, PLANES } from '../core.js';
import { describir } from './actividad.js';
import { ETIQUETA, CHIP, resumen } from './estado.js';

export async function render(v, rt, salio) {
  v.innerHTML = html`<div class="cab"><div><h1>Inicio</h1><p>${new Date().toLocaleDateString('es-PY', { weekday: 'long', day: 'numeric', month: 'long' })}</p></div><span id="plat-resumen"></span></div>
    <section class="grid g-kpi" id="kpis" aria-label="Resumen">${[1, 2, 3, 4, 5].map(() => html`<div class="card kpi"><div class="esqueleto" style="height:64px"></div></div>`)}</section>
    <div class="grid g-2" style="margin-top:16px">
      <section class="card" aria-labelledby="att"><div class="card-cab"><h2 id="att">Requiere atención</h2><span id="att-n"></span></div><div id="att-lista"><div class="cargando">Cargando…</div></div></section>
      <div class="col">
        <section class="card" aria-labelledby="jobs"><div class="card-cab"><h2 id="jobs">Trabajos en curso</h2><a href="#/pedido" class="chico">Nuevo pedido</a></div><div id="jobs-lista"><div class="cargando">Cargando…</div></div></section>
        <section class="card" aria-labelledby="plat"><div class="card-cab"><h2 id="plat">Plataforma</h2><a href="#/estado" class="chico">Ver el estado completo</a></div><div id="plat-lista"><div class="cargando">Revisando…</div></div></section>
        <section class="card" aria-labelledby="act"><div class="card-cab"><h2 id="act">Actividad reciente</h2><a href="#/actividad" class="chico">Registro completo</a></div><div id="act-lista"></div></section>
      </div>
    </div>`.s;

  const [r, altas] = await Promise.all([
    api('GET', '/admin/v2/inicio'),
    api('GET', '/admin/provision/jobs', undefined, { silencioso: true }),
  ]);
  if (salio()) return;
  if (!r.success) { v.querySelector('#kpis').innerHTML = html`<div class="aviso bad">${r.error}</div>`.s; return; }
  const k = r.data.kpis;

  // ── Números ──
  const servicios = (k.instancias.activas || 0) + (k.drive || 0) + (k.correo || 0);
  const fund = k.fundadores_restantes;
  v.querySelector('#kpis').innerHTML = html`
    <div class="card kpi"><div class="l">Clientes</div><div class="v">${k.clientes ?? '—'}</div><div class="s">entidades fiscales</div></div>
    <div class="card kpi"><div class="l">Servicios en marcha</div><div class="v">${servicios}</div><div class="s">${k.instancias.activas} ERP · ${k.correo ?? 0} Mail · ${k.drive ?? 0} Drive${k.instancias.suspendidas ? html` · <span style="color:var(--bad)">${k.instancias.suspendidas} suspendida${k.instancias.suspendidas > 1 ? 's' : ''}</span>` : ''}</div></div>
    <div class="card kpi"><div class="l">Leads de la semana</div><div class="v">${k.leads ? k.leads.semana : '—'}</div><div class="s" style="${k.leads && k.leads.sin_responder ? 'color:var(--warn)' : ''}">${k.leads ? (k.leads.sin_responder ? `${k.leads.sin_responder} sin responder hace más de 24 h` : `${k.leads.nuevos} nuevos`) : ''}</div></div>
    <div class="card kpi"><div class="l">Pagos por confirmar</div><div class="v">${k.pagos_pendientes ?? '—'}</div><div class="s"><a href="#/pagos">Ver pagos</a></div></div>
    <div class="card kpi"><div class="l">Lugares de fundador</div><div class="v">${fund ?? '—'} <span class="muted" style="font-size:14px;font-weight:500">de 10</span></div>${fund !== null ? html`<div class="barra"><i style="width:${Math.max(0, Math.min(100, (10 - fund) * 10))}%"></i></div>` : html`<div class="s">sin cargar en Configuración</div>`}</div>
    <div class="card kpi" title="Llega cuando el ERP del grupo esté conectado"><div class="l">Ingreso recurrente</div><div class="v tenue">—</div><div class="s">pronto, desde el ERP</div></div>`.s;

  // ── Requiere atención ──
  const ATT = {
    pago: (a) => html`<span class="chip warn">Pago</span><div class="flex">${a.titulo} · ${PLANES[a.detalle.plan] || a.detalle.plan} · ${gs(a.detalle.monto)}<div class="muted chico">${hace(a.desde)} · falta confirmar y dar el alta</div></div><a class="btn sm pri" href="#/pagos">Revisar</a>`,
    suspendida: (a) => html`<span class="chip bad">Suspendida</span><div class="flex">${a.titulo}<div class="muted chico">${a.detalle.db} · ${a.desde ? 'desde ' + hace(a.desde).replace('hace ', '') : ''}</div></div><a class="btn sm" href="#/servicios/erp?estado=suspended">Ver</a>`,
    lead: (a) => html`<span class="chip info">Lead</span><div class="flex">${a.titulo}${a.detalle.nombre && a.detalle.nombre !== a.titulo ? ` · ${a.detalle.nombre}` : ''}<div class="muted chico">${hace(a.desde)} sin respuesta</div></div>${a.detalle.telefono ? html`<a class="btn sm" href="${wa(a.detalle.telefono, `Hola ${a.detalle.nombre || ''}, te escribo de HEPTA Cloud por tu consulta.`)}" target="_blank" rel="noopener">WhatsApp</a>` : html`<a class="btn sm" href="#/leads">Ver</a>`}`,
    credencial: (a) => html`<span class="chip warn">Credencial</span><div class="flex">${a.titulo} vence el ${new Date(a.detalle.vence).toLocaleDateString('es-PY')}<div class="muted chico">${a.detalle.servicio} · rotarla en Integraciones</div></div><a class="btn sm" href="/admin/#credentials">Abrir ↗</a>`,
    trabajo: (a) => html`<span class="chip bad">Falló</span><div class="flex">Alta de ${a.titulo} · ${a.detalle.paso || ''}<div class="muted chico">${a.detalle.error}</div></div><a class="btn sm" href="#/servicios/drive">Ver</a>`,
  };
  const att = r.data.atencion;
  v.querySelector('#att-n').innerHTML = att.length ? html`<span class="chip bad">${att.length}</span>`.s : html`<span class="chip ok">Nada pendiente</span>`.s;
  v.querySelector('#att-lista').innerHTML = (att.length ? att.map(a => html`<div class="row">${ATT[a.tipo](a)}</div>`).join('')
    : html`<div class="vacio">Todo en orden. Los pagos, leads, suspensiones, credenciales por vencer y altas que fallen aparecen acá.</div>`.s)
    + (r.data.errores.length ? html`<div class="aviso warn" style="margin:12px 16px">No se pudo leer: ${r.data.errores.join(', ')}.</div>`.s : '');

  // Secretos de HEPTA Drive sin bajar (pregunta al agente: puede tardar; se suma cuando llega)
  api('GET', '/admin/drive', undefined, { silencioso: true }).then(d => {
    if (salio() || !d.success) return;
    const pend = (d.data.instancias || []).filter(i => i.secretos_pendientes);
    if (!pend.length) return;
    const lista = v.querySelector('#att-lista');
    if (lista.querySelector('.vacio')) lista.innerHTML = '';
    lista.insertAdjacentHTML('afterbegin', pend.map(i => html`<div class="row"><span class="chip warn">Secretos</span><div class="flex">HEPTA Drive de ${i.registro && i.registro.cliente || i.slug} sin bajar a KeePass<div class="muted chico">incluye la clave del repositorio de respaldo</div></div><a class="btn sm" href="/admin/#drive">Bajar ↗</a></div>`).join(''));
  });

  // ── Trabajos en curso (altas de tenants en memoria del backend) ──
  const enCurso = altas.success ? altas.data.filter(j => j.estado === 'en_curso') : [];
  const recientes = altas.success ? altas.data.filter(j => j.estado !== 'en_curso').slice(0, 3) : [];
  v.querySelector('#jobs-lista').innerHTML = (enCurso.length || recientes.length)
    ? [...enCurso, ...recientes].map(j => html`<div class="row"><span class="chip ${j.estado === 'en_curso' ? 'info' : j.estado === 'ok' ? 'ok' : 'bad'}">${j.estado === 'en_curso' ? 'En curso' : j.estado === 'ok' ? 'Listo' : 'Falló'}</span>
        <div class="flex">Alta de <b>${j.tenant}</b> · ${j.plan_nombre}<div class="muted chico">${j.estado === 'en_curso' ? j.paso : (j.error || j.aviso || 'sin avisos')}</div></div>
        <span class="muted chico">${Math.round(j.segundos / 60)} min</span></div>`).join('')
    : html`<div class="vacio">No hay altas en curso.</div>`.s;

  // ── Actividad ──
  const act = r.data.actividad;
  v.querySelector('#act-lista').innerHTML = act.length ? act.map(l => html`<div class="row"><span class="muted chico" style="width:108px;flex-shrink:0;white-space:nowrap">${fechaHora(l.created_at)}</span><div class="flex"><b>${(l.usuario || l.usuario_email || 'Sistema').split(' ')[0]}</b> ${describir(l)}</div></div>`).join('')
    : html`<div class="vacio">Sin actividad registrada.</div>`.s;

  // ── Plataforma: un renglón por área, del panel Estado (el backend lo guarda 60 s) ──
  const e = await api('GET', '/admin/v2/estado', undefined, { silencioso: true });
  if (salio()) return;
  const caja = v.querySelector('#plat-lista');
  if (!e.success) { caja.innerHTML = html`<div class="vacio">${e.error || 'No se pudo revisar'}</div>`.s; return; }
  const PUNTO = { ok: 'ok', aviso: 'warn', falla: 'bad', sin_dato: '' };
  caja.innerHTML = e.data.grupos.map(g => {
    const mal = g.chequeos.filter(x => x.estado !== 'ok');
    return html`<a class="row sin-subrayado" href="#/estado"><span class="punto ${PUNTO[g.estado]}"></span><div class="flex">${g.nombre}${mal.length ? html`<div class="muted chico">${mal[0].nombre}: ${mal[0].detalle}${mal.length > 1 ? ` (y ${mal.length - 1} más)` : ''}</div>` : ''}</div><span class="chip ${CHIP[g.estado]}">${ETIQUETA[g.estado]}</span></a>`;
  }).join('');
  v.querySelector('#plat-resumen').innerHTML = resumen(e.data).s;
}
