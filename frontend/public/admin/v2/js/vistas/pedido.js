// Nuevo pedido: cliente → servicios → revisión → avance.
// En esta versión se da de alta HEPTA ERP (la ruta de siempre, /api/admin/provision, en segundo plano).
// HEPTA Mail, HEPTA Drive y el dominio gestionado se muestran pero quedan desactivados hasta que el backend
// tenga el pedido unificado (diseño en el Project: diseno-aprovisionamiento-unificado.md); mientras, se dan
// de alta desde el Admin actual. La factura y la suscripción en el ERP del grupo, igual: pronto.
import { html, raw, api, gs, toast, seguir, PLANES } from '../core.js';

const SUB = /^[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?$/;

export async function render(v, rt, salio) {
  const st = { paso: 1, cliente: null, usuarios: [], usuario: '', plan: 'professional', sub: '', label: '', job: null };
  const [cl, pl] = await Promise.all([api('GET', '/admin/v2/clientes'), api('GET', '/admin/plans', undefined, { silencioso: true })]);
  if (salio()) return;
  const clientes = cl.success ? cl.data : [];
  const planes = (pl.success ? pl.data : []).filter(p => ['starter', 'professional'].includes(p.slug));
  const precio = (slug) => { const p = planes.find(x => x.slug === slug); return p ? Number(p.price) : null; };
  const preCliente = rt.q.get('cliente');

  const cab = () => html`<div class="cab"><h1>Nuevo pedido</h1>
    <ol class="pasos-cab" aria-label="Pasos">${['Cliente', 'Servicios', 'Revisión', 'Avance'].map((t, i) => html`<li class="${st.paso === i + 1 ? 'on' : st.paso > i + 1 ? 'hecho' : ''}" ${raw(st.paso === i + 1 ? 'aria-current="step"' : '')}><span class="n">${st.paso > i + 1 ? '✓' : i + 1}</span>${t}</li>${i < 3 ? html`<li aria-hidden="true" class="tenue">—</li>` : ''}`)}</ol></div>`;

  const resumen = () => {
    const pp = precio(st.plan);
    return html`<aside class="card pad" style="flex:1 1 300px" aria-labelledby="rs"><h2 id="rs" style="margin-bottom:10px">Resumen</h2>
      <div class="sum"><span>${st.cliente ? (st.cliente.nombre_comercial || st.cliente.razon_social) : 'Sin cliente'}</span></div>
      <div class="sum"><span>Plan ${PLANES[st.plan]}</span><span>${gs(pp)}</span></div>
      <div class="sum" style="border-top:1px solid var(--linea);margin-top:6px;padding-top:10px;font-weight:700;font-size:15px"><span>Por mes</span><span>${gs(pp)}</span></div>
      <div class="aviso info chico" style="margin-top:12px">Al confirmar: alta del sistema en segundo plano (2 a 10 minutos) y correo de bienvenida al usuario. La factura del primer mes y la suscripción se cargan en el ERP como hasta ahora (pronto, automático).</div></aside>`;
  };

  const pintar = () => {
    if (st.paso === 1) {
      v.innerHTML = html`${cab()}<div class="btns" style="align-items:flex-start;gap:16px"><section class="card pad" style="flex:999 1 480px;min-width:0" aria-labelledby="pc">
        <h2 id="pc" style="margin-bottom:12px">¿Para qué cliente?</h2>
        <label class="fld">Cliente<select id="cli"><option value="">Elegí un cliente…</option>${clientes.map(c => html`<option value="${c.id}" ${raw(st.cliente && st.cliente.id === c.id ? 'selected' : '')}>${c.nombre_comercial || c.razon_social} · RUC ${c.numero_doc}</option>`)}</select>
          <span class="ayuda">¿No está? <a href="/admin/#clients">Crealo en el Admin actual ↗</a> y volvé.</span></label>
        <div id="usr" style="margin-top:12px"></div>
        <div class="btns" style="justify-content:flex-end;margin-top:16px"><button class="btn pri" type="button" id="sig1">Siguiente</button></div></section>${resumen()}</div>`.s;
      const pintarUsuarios = () => {
        const caja = v.querySelector('#usr');
        if (!st.cliente) { caja.innerHTML = ''; return; }
        caja.innerHTML = st.usuarios.length
          ? html`<label class="fld">Usuario que recibe el sistema<select id="u">${st.usuarios.map(u => html`<option value="${u.id}" ${raw(String(st.usuario) === String(u.id) ? 'selected' : '')}>${u.full_name || u.email} · ${u.email}</option>`)}</select><span class="ayuda">Le llega la bienvenida con su usuario y contraseña.</span></label>`.s
          : html`<div class="aviso warn">Este cliente no tiene usuarios del portal. Creale uno en el Admin actual (Usuarios → Nuevo, vinculado al cliente) y volvé.</div>`.s;
        const u = v.querySelector('#u'); if (u) { st.usuario = u.value; u.addEventListener('change', () => { st.usuario = u.value; }); }
      };
      const elegir = async (id) => {
        st.cliente = clientes.find(c => c.id === id) || null; st.usuarios = []; st.usuario = '';
        if (st.cliente) { const f = await api('GET', `/admin/v2/clientes/${id}`); st.usuarios = f.success ? f.data.usuarios.filter(u => u.is_active !== false) : []; st.usuario = st.usuarios[0] ? st.usuarios[0].id : ''; }
        pintarUsuarios();
      };
      v.querySelector('#cli').addEventListener('change', (e) => elegir(e.target.value));
      v.querySelector('#sig1').addEventListener('click', () => {
        if (!st.cliente) return toast('Elegí el cliente', 'bad');
        if (!st.usuario) return toast('El cliente necesita un usuario del portal', 'bad');
        if (!st.sub) st.sub = String(st.cliente.nombre_comercial || st.cliente.razon_social).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\b(s\.?a\.?|e\.?a\.?s\.?|s\.?r\.?l\.?|unipersonal)\b/g, '').replace(/[^a-z0-9]+/g, '').slice(0, 20);
        if (!st.label) st.label = `Sistema de ${st.cliente.nombre_comercial || st.cliente.razon_social}`;
        st.paso = 2; pintar();
      });
      if (st.cliente) pintarUsuarios();
      else if (preCliente && clientes.some(c => c.id === preCliente)) { v.querySelector('#cli').value = preCliente; elegir(preCliente); }
      return;
    }
    if (st.paso === 2) {
      v.innerHTML = html`${cab()}<div class="btns" style="align-items:flex-start;gap:16px"><div class="col" style="flex:999 1 480px;min-width:0">
        <section class="card pad" aria-labelledby="pp"><h2 id="pp" style="margin-bottom:12px">Plan del sistema</h2>
          <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px" role="radiogroup" aria-label="Plan">
            ${['starter', 'professional'].map(s => html`<label class="opcion ${st.plan === s ? 'on' : ''}"><input type="radio" name="plan" value="${s}" ${raw(st.plan === s ? 'checked' : '')}><span><b>${PLANES[s]}</b><br><span class="muted">${gs(precio(s))} / mes</span></span></label>`)}
            <label class="opcion" aria-disabled="true" title="Plan Empresa: se cotiza y no tiene alta automática"><input type="radio" disabled><span><b>Empresa</b><br><span class="muted">a cotizar</span></span></label></div>
          <div class="btns" style="margin-top:14px;align-items:flex-start">
            <label class="fld" style="flex:1 1 220px">Subdominio<input id="sub" value="${st.sub}" autocomplete="off"><span class="ayuda" id="sub-ok">${st.sub}.erp.hepta.com.py</span></label>
            <label class="fld" style="flex:1 1 220px">Nombre de la instancia<input id="lab" value="${st.label}"></label></div>
          <p class="muted chico" style="margin:10px 0 0">Los módulos de rubro (Boutique, Belleza y SPA) se instalan después del alta, desde Servicios → ⋯ → Módulos adicionales. El dominio propio, también al final.</p></section>
        <section class="card pad" aria-labelledby="pa"><h2 id="pa" style="margin-bottom:4px">Adicionales</h2>
          <p class="muted chico" style="margin:0 0 10px">Todavía se dan de alta desde el Admin actual. Cuando el pedido unificado esté listo, se eligen acá y cada uno corre como un trabajo aparte.</p>
          ${[['HEPTA Mail', 'HC-CORREO-3 · ₲ 120.000 / mes', '/admin/#mail'], ['HEPTA Drive', 'HC-NUBE-3 · ₲ 150.000 / mes', '/admin/#drive'], ['Dominio gestionado', 'HC-DOMINIO · ₲ 33.000 / mes', '#/servicios/dominios']].map(([n, d, u]) =>
            html`<div class="row" style="padding:10px 0"><input type="checkbox" disabled aria-label="${n} (pronto)"><div class="flex"><b>${n}</b> <span class="chip mute">pronto</span><div class="muted chico">${d}</div></div><a class="btn sm" href="${u}">Hacerlo ahora ↗</a></div>`)}
        </section>
        <div class="btns" style="justify-content:space-between"><button class="btn" type="button" id="atr">Atrás</button><button class="btn pri" type="button" id="sig2">Revisar pedido</button></div></div>${resumen()}</div>`.s;
      v.querySelectorAll('input[name=plan]').forEach(r => r.addEventListener('change', () => { st.plan = r.value; pintar(); }));
      const sub = v.querySelector('#sub');
      sub.addEventListener('input', () => { st.sub = sub.value.trim().toLowerCase(); const ok = SUB.test(st.sub); v.querySelector('#sub-ok').textContent = ok ? `${st.sub}.erp.hepta.com.py` : 'Minúsculas, números y guiones (sin espacios ni puntos)'; v.querySelector('#sub-ok').style.color = ok ? '' : 'var(--bad)'; });
      v.querySelector('#lab').addEventListener('input', (e) => { st.label = e.target.value; });
      v.querySelector('#atr').addEventListener('click', () => { st.paso = 1; pintar(); });
      v.querySelector('#sig2').addEventListener('click', () => { if (!SUB.test(st.sub)) return toast('Revisá el subdominio', 'bad'); st.paso = 3; pintar(); });
      return;
    }
    if (st.paso === 3) {
      const u = st.usuarios.find(x => String(x.id) === String(st.usuario)) || {};
      v.innerHTML = html`${cab()}<div class="btns" style="align-items:flex-start;gap:16px"><section class="card pad" style="flex:999 1 480px;min-width:0" aria-labelledby="pr">
        <h2 id="pr" style="margin-bottom:12px">Revisá antes de confirmar</h2>
        <dl class="kv"><dt>Cliente</dt><dd>${st.cliente.razon_social}</dd><dt>Usuario</dt><dd>${u.full_name || ''} · ${u.email || ''}</dd>
          <dt>Sistema</dt><dd>HEPTA ERP · Plan ${PLANES[st.plan]}</dd><dt>Dirección</dt><dd>${st.sub}.erp.hepta.com.py</dd><dt>Nombre</dt><dd>${st.label}</dd></dl>
        <div class="aviso warn" style="margin-top:14px">Esto crea el sistema en producción y le manda al cliente su usuario y contraseña. Revisá el subdominio: después no se cambia.</div>
        <div class="btns" style="justify-content:space-between;margin-top:14px"><button class="btn" type="button" id="atr">Atrás</button><button class="btn pri" type="button" id="conf">Confirmar y dar de alta</button></div></section>${resumen()}</div>`.s;
      v.querySelector('#atr').addEventListener('click', () => { st.paso = 2; pintar(); });
      v.querySelector('#conf').addEventListener('click', async (e) => {
        e.target.disabled = true;
        const r = await api('POST', '/admin/provision', { user_id: Number(st.usuario), tenant: st.sub, plan: st.plan, label: st.label });
        if (!r.success) { e.target.disabled = false; return; }
        st.job = r.data.job; st.paso = 4; pintar();
        const fin = await seguir(`/admin/provision/jobs/${st.job.id}`, (j) => { if (!salio()) { st.job = j; pintarAvance(); } }, { cada: 8000 });
        if (salio()) { if (fin.estado === 'ok') toast(`✓ ${st.sub} quedó listo`, 'ok', 0); else toast(`El alta de ${st.sub} falló: ${fin.error || ''}`, 'bad', 0); return; }
        st.job = { ...st.job, ...fin }; pintarAvance();
      });
      return;
    }
    pintarAvance();
  };

  const pintarAvance = () => {
    const j = st.job || {};
    const listo = j.estado === 'ok', fallo = j.estado === 'error';
    v.innerHTML = html`${cab()}<div class="grid g-3">
      <section class="card pad" aria-labelledby="j1"><div class="btns" style="justify-content:space-between;margin-bottom:8px"><h2 id="j1">HEPTA ERP · ${PLANES[st.plan]}</h2>
        <span class="chip ${listo ? 'ok' : fallo ? 'bad' : 'info'}">${listo ? 'Listo' : fallo ? 'Falló' : 'En curso'}</span></div>
        <div class="paso"><span class="d ${listo ? 'ok' : fallo ? 'bad' : 'run'}">${listo ? '✓' : fallo ? '✕' : '…'}</span><div><b>${j.paso || 'Empezando'}</b><div class="muted chico">${j.segundos ? `${Math.floor(j.segundos / 60)} min ${j.segundos % 60} s` : ''}</div></div></div>
        ${fallo ? html`<div class="aviso bad">${j.error || 'Sin detalle'}</div>` : ''}
        ${j.aviso ? html`<div class="aviso warn">${j.aviso}</div>` : ''}
        ${listo ? html`<div class="aviso ok">${j.credenciales_enviadas ? 'El cliente recibió su usuario y contraseña por correo.' : 'Listo.'}</div><div class="btns">${j.url ? html`<a class="btn sm" href="${j.url}" target="_blank" rel="noopener">Abrir el sistema ↗</a>` : ''}<a class="btn sm pri" href="#/clientes/${st.cliente.id}">Ver el cliente</a></div>` : html`<p class="muted chico">Sigue aunque cierres esta página: el avance queda en Inicio → Trabajos en curso.</p>`}</section>
      <section class="card pad" aria-labelledby="j2"><h2 id="j2" style="margin-bottom:8px">En el ERP del grupo</h2>
        <div class="paso"><span class="d">1</span><div class="muted">Factura del primer mes y suscripción: se cargan a mano como hasta ahora (pronto, automático).</div></div></section></div>`.s;
  };

  pintar();
}
