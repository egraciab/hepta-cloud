// Nuevo pedido: cliente → servicios → revisión → avance.
// Cada servicio corre por su lado y con las rutas de siempre:
//   HEPTA ERP   → POST /api/admin/provision (segundo plano; se sigue /provision/jobs/:id)
//   HEPTA Mail  → POST /api/admin/mail/domains (sin publicar DNS) + una casilla por vez. El DNS se publica recién
//                 después de ver qué registros se crean o se reemplazan (dry_run) y confirmarlo.
//   HEPTA Drive → POST /api/admin/drive (segundo plano; se sigue /drive/jobs/:id), validado antes con /drive/validar.
// Se pueden pedir solos o juntos. El dominio gestionado y la factura/suscripción en el ERP del grupo: pronto.
// Las contraseñas iniciales de las casillas se muestran una sola vez y viven solo en esta pantalla.
import { html, raw, api, gs, toast, seguir, modal, confirmar, PLANES } from '../core.js';

const SUB = /^[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?$/;
const DOMINIO = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const CASILLA = /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/;
const SLUG = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
const CORREO = /^[a-z0-9._+-]{1,64}@[a-z0-9.-]{3,190}$/;
const TAMANOS_CASILLA_GB = [5, 10];   // 5 GB de fábrica; 10 GB para estudios o a pedido

// ── Precios de lista (con IVA) ──
// Correo: el paquete cubre 3 casillas; cada casilla de más se cobra al precio de su tramo (la 4.ª a 40.000, de la 5.ª a
// la 9.ª a 36.000, desde la 10.ª a cotizar). Por tramo y no "todas al precio del último": así sumar una casilla nunca
// baja el total. Drive: 3 usuarios y 100 GB; usuario de más 30.000, bloque de 100 GB 60.000; dos paquetes cerrados.
const MAIL = { base: 120000, incluidas: 3, tramos: [[4, 4, 40000], [5, 9, 36000]] };
const DRIVE = { base: 150000, usuarios: 3, gb: 100, usuarioExtra: 30000, bloqueGb: 100, precioBloque: 60000,
  paquetes: [{ nombre: 'Paquete Equipo', usuarios: 6, gb: 200, precio: 270000 }, { nombre: 'Paquete Estudio', usuarios: 10, gb: 500, precio: 450000 }] };
const precioCasilla = (i) => { const t = MAIL.tramos.find(([a, b]) => i >= a && i <= b); return t ? t[2] : null; };
function precioMail(n) {
  let total = MAIL.base;
  for (let i = MAIL.incluidas + 1; i <= n; i++) { const p = precioCasilla(i); if (p === null) return null; total += p; }
  return total;
}
function precioDrive(usuarios, gb) {
  const suelto = DRIVE.base + Math.max(0, usuarios - DRIVE.usuarios) * DRIVE.usuarioExtra
    + Math.ceil(Math.max(0, gb - DRIVE.gb) / DRIVE.bloqueGb) * DRIVE.precioBloque;
  const paq = DRIVE.paquetes.find(x => x.usuarios === usuarios && x.gb === gb);
  return paq ? { precio: paq.precio, paquete: paq.nombre, suelto } : { precio: suelto, suelto };
}
const textoMail = (n) => { const p = precioMail(n); return p === null ? `${n} casillas: a cotizar` : `${n} casillas · ${gs(p)} / mes`; };

const sinAcentos = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const sugerido = (c) => sinAcentos(c.nombre_comercial || c.razon_social)
  .replace(/\b(s\.?a\.?|e\.?a\.?s\.?|s\.?r\.?l\.?|unipersonal)\b/g, '').replace(/[^a-z0-9]+/g, '').slice(0, 20);

export async function render(v, rt, salio) {
  const st = {
    paso: 1, cliente: null, usuarios: [], usuario: '', instancias: [],
    erp: { on: true, plan: 'professional', sub: '', label: '' },
    mail: { on: false, dominio: '', max: 3, gb: 5, casillas: [{ lp: '', nombre: '' }] },
    drive: { on: false, slug: '', cuota: 5, equipo: 0, contratados: 3, gb: 100, usuarios: [{ nombre: '', correo: '' }] },
    revision: { drive: null, mailExiste: false },
    av: { erp: null, mail: null, drive: null },
  };
  const [cl, pl] = await Promise.all([api('GET', '/admin/v2/clientes'), api('GET', '/admin/plans', undefined, { silencioso: true })]);
  if (salio()) return;
  const clientes = cl.success ? cl.data : [];
  const planes = (pl.success ? pl.data : []).filter(p => ['starter', 'professional'].includes(p.slug));
  const precio = (slug) => { const p = planes.find(x => x.slug === slug); return p ? Number(p.price) : null; };
  const preCliente = rt.q.get('cliente');
  const usuarioSel = () => st.usuarios.find(x => String(x.id) === String(st.usuario)) || null;
  const nombreCliente = () => st.cliente ? (st.cliente.nombre_comercial || st.cliente.razon_social) : '';
  const textoDrive = () => { const d = precioDrive(st.drive.contratados, st.drive.gb); return `${d.paquete ? d.paquete + ': ' : ''}${gs(d.precio)} / mes${d.paquete ? ` (sueltos serían ${gs(d.suelto)})` : ''}`; };
  const usuariosDrive = () => st.drive.usuarios.filter(u => u.nombre.trim() || u.correo).length || 1;
  const asignadoGb = () => usuariosDrive() * (st.drive.cuota || 0) + (st.drive.equipo || 0);
  const textoAsignado = () => `Asignado ${asignadoGb()} de ${st.drive.gb} GB`;

  const cab = () => html`<div class="cab"><h1>Nuevo pedido</h1>
    <ol class="pasos-cab" aria-label="Pasos">${['Cliente', 'Servicios', 'Revisión', 'Avance'].map((t, i) => html`<li class="${st.paso === i + 1 ? 'on' : st.paso > i + 1 ? 'hecho' : ''}" ${raw(st.paso === i + 1 ? 'aria-current="step"' : '')}><span class="n">${st.paso > i + 1 ? '✓' : i + 1}</span>${t}</li>${i < 3 ? html`<li aria-hidden="true" class="tenue">—</li>` : ''}`)}</ol></div>`;

  const resumen = () => {
    const lineas = [];
    if (st.erp.on) lineas.push([`HEPTA ERP · ${PLANES[st.erp.plan]}`, precio(st.erp.plan)]);
    if (st.mail.on) lineas.push([`HEPTA Mail · ${st.mail.max} casillas`, precioMail(st.mail.max)]);
    if (st.drive.on) { const d = precioDrive(st.drive.contratados, st.drive.gb); lineas.push([`HEPTA Drive · ${d.paquete ? d.paquete + ' · ' : ''}${st.drive.contratados} usuarios, ${st.drive.gb} GB`, d.precio]); }
    const aCotizar = lineas.some(([, p]) => p === null);
    const total = lineas.reduce((t, [, p]) => t + (Number(p) || 0), 0);
    return html`<aside class="card pad" style="flex:1 1 300px" aria-labelledby="rs"><h2 id="rs" style="margin-bottom:10px">Resumen</h2>
      <div class="sum"><span>${nombreCliente() || 'Sin cliente'}</span></div>
      ${lineas.length ? lineas.map(([n, p]) => html`<div class="sum"><span>${n}</span><span>${p === null ? 'a cotizar' : gs(p)}</span></div>`) : html`<div class="sum muted"><span>Ningún servicio elegido</span></div>`}
      <div class="sum" style="border-top:1px solid var(--linea);margin-top:6px;padding-top:10px;font-weight:700;font-size:15px"><span>Por mes</span><span>${aCotizar ? 'a cotizar' : gs(total)}</span></div>
      <p class="muted chico" style="margin:8px 0 0">Precios de lista con IVA. Los acuerdos especiales se cargan en el ERP.</p>
      <div class="aviso info chico" style="margin-top:12px">La factura del primer mes y la suscripción se cargan en el ERP del grupo como hasta ahora (pronto, automático).</div></aside>`;
  };

  // ── Paso 1: cliente ──
  const paso1 = () => {
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
        ? html`<label class="fld">Usuario del portal (titular)<select id="u">${st.usuarios.map(u => html`<option value="${u.id}" ${raw(String(st.usuario) === String(u.id) ? 'selected' : '')}>${u.full_name || u.email} · ${u.email}</option>`)}</select><span class="ayuda">Recibe la bienvenida del sistema y queda como dueño del correo.</span></label>`.s
        : html`<div class="aviso warn">Este cliente no tiene usuarios del portal. Para HEPTA ERP hace falta uno: crealo en el Admin actual (Usuarios → Nuevo, vinculado al cliente). Mail y Drive se pueden pedir igual.</div>`.s;
      const u = v.querySelector('#u'); if (u) { st.usuario = u.value; u.addEventListener('change', () => { st.usuario = u.value; }); }
    };
    const elegir = async (id) => {
      st.cliente = clientes.find(c => c.id === id) || null; st.usuarios = []; st.usuario = ''; st.instancias = [];
      if (st.cliente) {
        const f = await api('GET', `/admin/v2/clientes/${id}`);
        st.usuarios = f.success ? f.data.usuarios.filter(u => u.is_active !== false) : [];
        st.instancias = f.success ? (f.data.instancias || []).filter(i => ['active', 'suspended'].includes(i.status)) : [];
        st.usuario = st.usuarios[0] ? st.usuarios[0].id : '';
      }
      pintarUsuarios();
    };
    v.querySelector('#cli').addEventListener('change', (e) => elegir(e.target.value));
    v.querySelector('#sig1').addEventListener('click', () => {
      if (!st.cliente) return toast('Elegí el cliente', 'bad');
      const base = sugerido(st.cliente);
      if (!st.erp.sub) st.erp.sub = base;
      if (!st.erp.label) st.erp.label = `Sistema de ${nombreCliente()}`;
      if (!st.drive.slug) st.drive.slug = base.length >= 3 && /^[a-z]/.test(base) ? base : '';
      // Sin usuario no hay alta de ERP; si ya tiene uno, lo normal es sumarle servicios (se puede tildar para otra instancia)
      if (!st.usuarios.length || st.instancias.length) st.erp.on = false;
      st.paso = 2; pintar();
    });
    if (st.cliente) pintarUsuarios();
    else if (preCliente && clientes.some(c => c.id === preCliente)) { v.querySelector('#cli').value = preCliente; elegir(preCliente); }
  };

  // ── Paso 2: servicios ──
  const cabServicio = (clave, titulo, sub, deshab) => html`<label class="btns" style="justify-content:space-between;cursor:${deshab ? 'not-allowed' : 'pointer'}">
    <span><b style="font-size:15px">${titulo}</b><br><span class="muted chico">${sub}</span></span>
    <span class="btns"><input type="checkbox" data-on="${clave}" ${raw(st[clave].on ? 'checked' : '')} ${raw(deshab ? 'disabled' : '')} aria-label="Pedir ${titulo}"></span></label>`;

  const paso2 = () => {
    const sinUsuario = !st.usuarios.length;
    v.innerHTML = html`${cab()}<div class="btns" style="align-items:flex-start;gap:16px"><div class="col" style="flex:999 1 480px;min-width:0">
      <section class="card pad" aria-labelledby="s-erp">${cabServicio('erp', 'HEPTA ERP', sinUsuario ? 'Necesita un usuario del portal (paso 1)' : st.instancias.length ? `Ya tiene: ${st.instancias.map(i => (i.custom_domain || i.db_name)).join(', ')}. Tildalo solo para sumar otra instancia.` : 'Sistema de gestión con su plan', sinUsuario)}
        ${st.erp.on ? html`<div style="margin-top:12px">
          <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px" role="radiogroup" aria-label="Plan">
            ${['starter', 'professional'].map(s => html`<label class="opcion ${st.erp.plan === s ? 'on' : ''}"><input type="radio" name="plan" value="${s}" ${raw(st.erp.plan === s ? 'checked' : '')}><span><b>${PLANES[s]}</b><br><span class="muted">${gs(precio(s))} / mes</span></span></label>`)}
            <label class="opcion" aria-disabled="true" title="Plan Empresa: se cotiza y no tiene alta automática"><input type="radio" disabled><span><b>Empresa</b><br><span class="muted">a cotizar</span></span></label></div>
          <div class="btns" style="margin-top:12px;align-items:flex-start">
            <label class="fld" style="flex:1 1 220px">Subdominio<input id="sub" value="${st.erp.sub}" autocomplete="off"><span class="ayuda" id="sub-ok">${st.erp.sub}.erp.hepta.com.py</span></label>
            <label class="fld" style="flex:1 1 220px">Nombre de la instancia<input id="lab" value="${st.erp.label}"></label></div>
          <p class="muted chico" style="margin:10px 0 0">Los módulos de rubro y el dominio propio se suman después del alta, desde Servicios → ⋯.</p></div>` : ''}</section>

      <section class="card pad" aria-labelledby="s-mail">${cabServicio('mail', 'HEPTA Mail', `Correo con su dominio · ${gs(MAIL.base)} / mes hasta ${MAIL.incluidas} casillas`)}
        ${st.mail.on ? html`<div style="margin-top:12px">
          <div class="btns" style="align-items:flex-start">
            <label class="fld" style="flex:2 1 240px">Dominio del correo<input id="m-dom" value="${st.mail.dominio}" placeholder="cliente.com.py" autocomplete="off"><span class="ayuda">Sin www. El cliente tiene que poder cambiar su DNS (o tenerlo en nuestra cuenta de Cloudflare).</span></label>
            <label class="fld" style="flex:1 1 150px">Casillas contratadas<input id="m-max" type="number" min="${MAIL.incluidas}" max="50" value="${st.mail.max}"><span class="ayuda" id="m-precio">${textoMail(st.mail.max)}</span></label>
            <label class="fld" style="flex:1 1 120px">Tamaño por casilla<select id="m-gb">${TAMANOS_CASILLA_GB.map(g => html`<option value="${g}" ${raw(st.mail.gb === g ? 'selected' : '')}>${g} GB${g === 10 ? ' (estudios)' : ''}</option>`)}</select></label></div>
          <div class="muted chico" style="margin:12px 0 4px;font-weight:600">Casillas a crear ahora</div>
          <div id="m-cas">${st.mail.casillas.map((c, i) => html`<div class="btns" style="margin-bottom:6px;flex-wrap:nowrap">
            <input class="inp" data-cas="${i}" data-k="lp" value="${c.lp}" placeholder="nombre" aria-label="Casilla ${i + 1}" style="flex:1 1 120px;min-width:0">
            <span class="muted chico" style="white-space:nowrap">@${st.mail.dominio || 'dominio'}</span>
            <input class="inp" data-cas="${i}" data-k="nombre" value="${c.nombre}" placeholder="Nombre y apellido" aria-label="Nombre de la casilla ${i + 1}" style="flex:2 1 160px;min-width:0">
            <button class="btn ic sm" type="button" data-quitar-cas="${i}" aria-label="Quitar casilla ${i + 1}" ${raw(st.mail.casillas.length < 2 ? 'disabled' : '')}>×</button></div>`)}</div>
          <button class="btn sm" type="button" id="m-mas">+ Casilla</button>
          <p class="muted chico" style="margin:10px 0 0">El DNS no se publica solo: al terminar te muestro qué registros se crean o se reemplazan y confirmás. Si el correo del cliente hoy está en otro lado, se coordina antes (el MX nuevo lo corta).</p></div>` : ''}</section>

      <section class="card pad" aria-labelledby="s-drive">${cabServicio('drive', 'HEPTA Drive', `Nube privada · ${gs(DRIVE.base)} / mes con ${DRIVE.usuarios} usuarios y ${DRIVE.gb} GB`)}
        ${st.drive.on ? html`<div style="margin-top:12px">
          <div class="btns" style="align-items:flex-start">
            <label class="fld" style="flex:2 1 220px">Nombre de la instancia<input id="d-slug" value="${st.drive.slug}" autocomplete="off"><span class="ayuda" id="d-slug-ok">${st.drive.slug || 'nombre'}.drive.hepta.com.py · no se cambia después</span></label>
            <label class="fld" style="flex:1 1 120px">Usuarios contratados<input id="d-cont" type="number" min="${DRIVE.usuarios}" max="200" value="${st.drive.contratados}"></label>
            <label class="fld" style="flex:1 1 120px">Espacio contratado<select id="d-gb">${[100, 200, 300, 400, 500, 750, 1000].map(g => html`<option value="${g}" ${raw(st.drive.gb === g ? 'selected' : '')}>${g} GB</option>`)}</select></label></div>
          <div class="muted chico" id="d-precio" style="margin-top:4px">${textoDrive()}</div>
          <div class="btns" style="align-items:flex-start;margin-top:10px">
            <label class="fld" style="flex:1 1 110px">GB por usuario<input id="d-cuota" type="number" min="1" max="9999" value="${st.drive.cuota}"></label>
            <label class="fld" style="flex:1 1 110px">Carpeta Equipo (GB)<input id="d-equipo" type="number" min="0" max="99999" value="${st.drive.equipo}"><span class="ayuda" id="d-asig">${textoAsignado()}</span></label></div>
          <div class="muted chico" style="margin:12px 0 4px;font-weight:600">Usuarios (reciben la invitación por correo)</div>
          <div id="d-us">${st.drive.usuarios.map((u, i) => html`<div class="btns" style="margin-bottom:6px;flex-wrap:nowrap">
            <input class="inp" data-du="${i}" data-k="nombre" value="${u.nombre}" placeholder="Nombre y apellido" aria-label="Nombre del usuario ${i + 1}" style="flex:1 1 150px;min-width:0">
            <input class="inp" data-du="${i}" data-k="correo" value="${u.correo}" placeholder="correo@cliente.com.py" aria-label="Correo del usuario ${i + 1}" style="flex:1 1 170px;min-width:0" type="email">
            <button class="btn ic sm" type="button" data-quitar-du="${i}" aria-label="Quitar usuario ${i + 1}" ${raw(st.drive.usuarios.length < 2 ? 'disabled' : '')}>×</button></div>`)}</div>
          <button class="btn sm" type="button" id="d-mas">+ Usuario</button>
          ${st.mail.on ? html`<p class="muted chico" style="margin:10px 0 0">Si los usuarios van a usar las casillas nuevas, el correo se crea primero en este mismo pedido; las invitaciones llegan cuando el DNS del correo esté publicado.</p>` : ''}</div>` : ''}</section>

      <section class="card pad" aria-labelledby="s-dom"><div class="btns" style="justify-content:space-between"><span><b style="font-size:15px">Dominio gestionado</b> <span class="chip mute">pronto</span><br><span class="muted chico">HC-DOMINIO · ${gs(33000)} / mes · el registro en NIC.PY sigue siendo a mano</span></span></div></section>

      <div class="btns" style="justify-content:space-between"><button class="btn" type="button" id="atr">Atrás</button><button class="btn pri" type="button" id="sig2">Revisar pedido</button></div></div>${resumen()}</div>`.s;

    v.querySelectorAll('[data-on]').forEach(c => c.addEventListener('change', () => { st[c.dataset.on].on = c.checked; pintar(); }));
    v.querySelectorAll('input[name=plan]').forEach(r => r.addEventListener('change', () => { st.erp.plan = r.value; pintar(); }));
    const sub = v.querySelector('#sub');
    if (sub) sub.addEventListener('input', () => { st.erp.sub = sub.value.trim().toLowerCase(); const ok = SUB.test(st.erp.sub); const o = v.querySelector('#sub-ok'); o.textContent = ok ? `${st.erp.sub}.erp.hepta.com.py` : 'Minúsculas, números y guiones (sin espacios ni puntos)'; o.style.color = ok ? '' : 'var(--bad)'; });
    const lab = v.querySelector('#lab'); if (lab) lab.addEventListener('input', () => { st.erp.label = lab.value; });
    const md = v.querySelector('#m-dom');
    if (md) md.addEventListener('change', () => { st.mail.dominio = md.value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''); pintar(); });
    const mgb = v.querySelector('#m-gb'); if (mgb) mgb.addEventListener('change', () => { st.mail.gb = Number(mgb.value); });
    const mm = v.querySelector('#m-max');
    if (mm) mm.addEventListener('change', () => { st.mail.max = Math.max(MAIL.incluidas, Math.min(50, parseInt(mm.value, 10) || MAIL.incluidas)); pintar(); });
    v.querySelectorAll('[data-cas]').forEach(i => i.addEventListener('input', () => { st.mail.casillas[Number(i.dataset.cas)][i.dataset.k] = i.dataset.k === 'lp' ? i.value.trim().toLowerCase() : i.value; }));
    v.querySelectorAll('[data-quitar-cas]').forEach(b => b.addEventListener('click', () => { st.mail.casillas.splice(Number(b.dataset.quitarCas), 1); pintar(); }));
    const mmas = v.querySelector('#m-mas');
    if (mmas) mmas.addEventListener('click', async () => {
      // Pasar de lo contratado es sumar una casilla al pedido: se confirma con su precio
      if (st.mail.casillas.length >= st.mail.max) {
        const n = st.mail.max + 1, p = precioCasilla(n);
        const ok = await confirmar({ titulo: '¿Sumar una casilla?', boton: 'Sumar casilla',
          texto: p === null ? `Serían ${n} casillas: desde la 10.ª el precio se cotiza aparte. Se puede cargar igual y el monto se acuerda en el ERP.`
            : `Serían ${n} casillas: la ${n}.ª suma ${gs(p)} por mes (total ${gs(precioMail(n))}).` });
        if (!ok) return;
        st.mail.max = n;
      }
      st.mail.casillas.push({ lp: '', nombre: '' }); pintar();
    });
    const ds = v.querySelector('#d-slug');
    if (ds) ds.addEventListener('input', () => { st.drive.slug = ds.value.trim().toLowerCase(); const ok = SLUG.test(st.drive.slug) && !st.drive.slug.includes('--'); const o = v.querySelector('#d-slug-ok'); o.textContent = ok ? `${st.drive.slug}.drive.hepta.com.py · no se cambia después` : 'De 3 a 32: minúsculas, números y guiones, empezando con una letra'; o.style.color = ok ? '' : 'var(--bad)'; });
    const asig = () => { const a = v.querySelector('#d-asig'); if (a) { a.textContent = textoAsignado(); a.style.color = asignadoGb() > st.drive.gb ? 'var(--bad)' : ''; } };
    const dc = v.querySelector('#d-cuota'); if (dc) dc.addEventListener('input', () => { st.drive.cuota = parseInt(dc.value, 10) || 0; asig(); });
    const de = v.querySelector('#d-equipo'); if (de) de.addEventListener('input', () => { st.drive.equipo = parseInt(de.value, 10) || 0; asig(); });
    const dco = v.querySelector('#d-cont'); if (dco) dco.addEventListener('change', () => { st.drive.contratados = Math.max(DRIVE.usuarios, Math.min(200, parseInt(dco.value, 10) || DRIVE.usuarios)); pintar(); });
    const dgb = v.querySelector('#d-gb'); if (dgb) dgb.addEventListener('change', () => { st.drive.gb = Number(dgb.value); pintar(); });
    asig();
    v.querySelectorAll('[data-du]').forEach(i => i.addEventListener('input', () => { st.drive.usuarios[Number(i.dataset.du)][i.dataset.k] = i.dataset.k === 'correo' ? i.value.trim().toLowerCase() : i.value; }));
    v.querySelectorAll('[data-quitar-du]').forEach(b => b.addEventListener('click', () => { st.drive.usuarios.splice(Number(b.dataset.quitarDu), 1); pintar(); }));
    const dmas = v.querySelector('#d-mas');
    if (dmas) dmas.addEventListener('click', async () => {
      if (st.drive.usuarios.length >= st.drive.contratados) {
        const n = st.drive.contratados + 1, d = precioDrive(n, st.drive.gb);
        const ok = await confirmar({ titulo: '¿Sumar un usuario?', boton: 'Sumar usuario',
          texto: `Serían ${n} usuarios: suma ${gs(DRIVE.usuarioExtra)} por mes (total ${gs(d.precio)}${d.paquete ? `, ${d.paquete}` : ''}).` });
        if (!ok) return;
        st.drive.contratados = n;
      }
      st.drive.usuarios.push({ nombre: '', correo: '' }); pintar();
    });
    v.querySelector('#atr').addEventListener('click', () => { st.paso = 1; pintar(); });
    v.querySelector('#sig2').addEventListener('click', async (e) => {
      const error = validarLocal();
      if (error) return toast(error, 'bad');
      e.target.disabled = true;
      try { if (await revisarEnServidor()) { st.paso = 3; pintar(); } }
      finally { if (e.target.isConnected) e.target.disabled = false; }
    });
  };

  const validarLocal = () => {
    if (!st.erp.on && !st.mail.on && !st.drive.on) return 'Elegí al menos un servicio';
    if (st.erp.on) {
      if (!st.usuario) return 'HEPTA ERP necesita un usuario del portal';
      if (!SUB.test(st.erp.sub)) return 'Revisá el subdominio del ERP';
    }
    if (st.mail.on) {
      if (!DOMINIO.test(st.mail.dominio)) return 'Revisá el dominio del correo';
      const lps = st.mail.casillas.map(c => c.lp).filter(Boolean);
      if (!lps.length) return 'Cargá al menos una casilla';
      if (lps.some(l => !CASILLA.test(l))) return 'Las casillas van en minúsculas: letras, números, punto, guion y guion bajo';
      if (new Set(lps).size !== lps.length) return 'Hay casillas repetidas';
      if (lps.length > st.mail.max) return `Pediste ${lps.length} casillas y el máximo es ${st.mail.max}`;
    }
    if (st.drive.on) {
      if (!SLUG.test(st.drive.slug) || st.drive.slug.includes('--')) return 'Revisá el nombre de la instancia de Drive';
      const us = st.drive.usuarios.filter(u => u.nombre.trim() || u.correo);
      if (!us.length) return 'Cargá al menos un usuario de Drive';
      if (us.some(u => !u.nombre.trim() || !CORREO.test(u.correo))) return 'Cada usuario de Drive necesita nombre y un correo válido';
      if (us.length > st.drive.contratados) return `Cargaste ${us.length} usuarios de Drive y están contratados ${st.drive.contratados}`;
      if (asignadoGb() > st.drive.gb) return `El espacio asignado (${asignadoGb()} GB) pasa lo contratado (${st.drive.gb} GB): bajá la cuota por usuario o la carpeta Equipo`;
    }
    return '';
  };

  const pedidoDrive = () => ({
    slug: st.drive.slug, cuota_gb: st.drive.cuota, equipo_gb: st.drive.equipo, billing_customer_id: st.cliente.id,
    usuarios: st.drive.usuarios.filter(u => u.nombre.trim() || u.correo).map(u => ({ nombre: u.nombre.trim(), correo: u.correo })),
  });

  // Lo que solo sabe el servidor: si el dominio de correo ya existe y si el agente de Drive acepta el pedido
  const revisarEnServidor = async () => {
    st.revision = { drive: null, mailExiste: false };
    if (st.mail.on) {
      const r = await api('GET', '/admin/mail/domains', undefined, { silencioso: true });
      if (!r.success) { toast('No pude consultar los dominios de correo: ' + (r.error || ''), 'bad'); return false; }
      if ((r.data || []).some(d => String(d.domain).toLowerCase() === st.mail.dominio)) {
        toast(`${st.mail.dominio} ya tiene correo en HEPTA. Las casillas nuevas se suman desde Servicios → HEPTA Mail.`, 'bad', 0);
        return false;
      }
    }
    if (st.drive.on) {
      const r = await api('POST', '/admin/drive/validar', pedidoDrive(), { silencioso: true });
      if (!r.success) { toast('Drive: ' + (r.error || 'no se pudo validar'), 'bad', 0); return false; }
      st.revision.drive = r.data;
      if (!r.data.ok) { toast('Drive: ' + ((r.data.errores || []).join(' · ') || 'el agente no acepta el pedido'), 'bad', 0); return false; }
    }
    return true;
  };

  // ── Paso 3: revisión ──
  const paso3 = () => {
    const u = usuarioSel() || {};
    const vd = st.revision.drive;
    v.innerHTML = html`${cab()}<div class="btns" style="align-items:flex-start;gap:16px"><section class="card pad" style="flex:999 1 480px;min-width:0" aria-labelledby="pr">
      <h2 id="pr" style="margin-bottom:12px">Revisá antes de confirmar</h2>
      <dl class="kv"><dt>Cliente</dt><dd>${st.cliente.razon_social}</dd>${u.email ? html`<dt>Titular</dt><dd>${u.full_name || ''} · ${u.email}</dd>` : ''}</dl>
      ${st.erp.on ? html`<h3 class="chico" style="margin:16px 0 6px">HEPTA ERP</h3><dl class="kv"><dt>Plan</dt><dd>${PLANES[st.erp.plan]}</dd><dt>Dirección</dt><dd>${st.erp.sub}.erp.hepta.com.py</dd><dt>Nombre</dt><dd>${st.erp.label}</dd></dl>` : ''}
      ${st.mail.on ? html`<h3 class="chico" style="margin:16px 0 6px">HEPTA Mail</h3><dl class="kv"><dt>Dominio</dt><dd>${st.mail.dominio}</dd><dt>Casillas</dt><dd>${st.mail.casillas.filter(c => c.lp).map(c => `${c.lp}@${st.mail.dominio}`).join(', ')} (contratadas ${st.mail.max}, ${st.mail.gb} GB cada una)</dd><dt>Precio</dt><dd>${precioMail(st.mail.max) === null ? 'a cotizar' : gs(precioMail(st.mail.max)) + ' / mes'}</dd><dt>DNS</dt><dd>se revisa y se publica al terminar</dd></dl>` : ''}
      ${st.drive.on ? html`<h3 class="chico" style="margin:16px 0 6px">HEPTA Drive</h3><dl class="kv"><dt>Dirección</dt><dd>${(vd && vd.fqdn) || st.drive.slug + '.drive.hepta.com.py'}</dd><dt>Usuarios</dt><dd>${pedidoDrive().usuarios.map(x => x.correo).join(', ')}</dd><dt>Contratado</dt><dd>${st.drive.contratados} usuarios y ${st.drive.gb} GB · ${textoDrive()}</dd><dt>Asignado</dt><dd>${st.drive.cuota} GB por usuario${st.drive.equipo ? ` + ${st.drive.equipo} GB de Equipo` : ''}${vd && vd.cuota_total_gb ? ` · ${vd.cuota_total_gb} GB en total` : ''}</dd></dl>
        ${vd && vd.avisos && vd.avisos.length ? html`<div class="aviso warn" style="margin-top:8px">${vd.avisos.join(' · ')}</div>` : ''}` : ''}
      <div class="aviso warn" style="margin-top:14px">Esto crea los servicios en producción.${st.erp.on ? ' El titular recibe por correo el usuario y la contraseña del sistema.' : ''}${st.drive.on ? ' Los usuarios de Drive reciben su invitación.' : ''} Las direcciones no se cambian después.</div>
      <div class="btns" style="justify-content:space-between;margin-top:14px"><button class="btn" type="button" id="atr">Atrás</button><button class="btn pri" type="button" id="conf">Confirmar y dar de alta</button></div></section>${resumen()}</div>`.s;
    v.querySelector('#atr').addEventListener('click', () => { st.paso = 2; pintar(); });
    v.querySelector('#conf').addEventListener('click', (e) => { e.target.disabled = true; st.paso = 4; pintar(); lanzar(); });
  };

  // ── Paso 4: avance ──
  const lanzar = () => {
    if (st.erp.on) altaErp();
    if (st.mail.on) altaMail();
    if (st.drive.on) altaDrive();
  };
  const refrescar = () => { if (!salio() && st.paso === 4) pintarAvance(); };

  const altaErp = async () => {
    st.av.erp = { estado: 'en_curso', paso: 'Pidiendo el alta' }; refrescar();
    const r = await api('POST', '/admin/provision', { user_id: Number(st.usuario), tenant: st.erp.sub, plan: st.erp.plan, label: st.erp.label });
    if (!r.success) { st.av.erp = { estado: 'error', error: r.error }; refrescar(); return; }
    st.av.erp = { ...r.data.job, estado: 'en_curso' }; refrescar();
    const fin = await seguir(`/admin/provision/jobs/${r.data.job.id}`, (j) => { st.av.erp = j; refrescar(); }, { cada: 8000 });
    st.av.erp = { ...st.av.erp, ...fin }; refrescar();
    if (salio()) toast(fin.estado === 'ok' ? `✓ ${st.erp.sub} quedó listo` : `El alta de ${st.erp.sub} falló: ${fin.error || ''}`, fin.estado === 'ok' ? 'ok' : 'bad', 0);
  };

  const altaMail = async () => {
    const m = st.av.mail = { estado: 'en_curso', paso: 'Creando el dominio', casillas: [], claves: [] }; refrescar();
    const u = usuarioSel();
    const r = await api('POST', '/admin/mail/domains', {
      domain: st.mail.dominio, owner_email: u ? u.email : undefined, quota_mb: st.mail.max * st.mail.gb * 1024,
      def_quota_mb: st.mail.gb * 1024, max_mailboxes: st.mail.max, plan_code: 'HC-CORREO-3', publish_dns: false,
    });
    if (!r.success) { Object.assign(m, { estado: 'error', error: r.error }); refrescar(); return; }
    for (const c of st.mail.casillas.filter(x => x.lp)) {
      m.paso = `Creando ${c.lp}@${st.mail.dominio}`; refrescar();
      const rc = await api('POST', `/admin/mail/domains/${encodeURIComponent(st.mail.dominio)}/mailboxes`, { local_part: c.lp, name: c.nombre.trim() || c.lp, quota_mb: st.mail.gb * 1024 }, { silencioso: true });
      if (rc.success) { m.casillas.push({ dir: rc.data.address, ok: true }); if (rc.data.password) m.claves.push({ dir: rc.data.address, clave: rc.data.password }); }
      else m.casillas.push({ dir: `${c.lp}@${st.mail.dominio}`, ok: false, error: rc.error });
    }
    Object.assign(m, { estado: m.casillas.some(c => !c.ok) ? 'aviso' : 'ok', paso: 'Dominio y casillas creados; falta el DNS' });
    refrescar();
  };

  const altaDrive = async () => {
    st.av.drive = { status: 'running', step: 'Pidiendo el alta' }; refrescar();
    const r = await api('POST', '/admin/drive', pedidoDrive());
    if (!r.success) { st.av.drive = { status: 'failed', error: r.error }; refrescar(); return; }
    st.av.drive = { status: 'running', step: 'En cola', slug: r.data.slug, avisos: r.data.avisos || [] }; refrescar();
    const fin = await seguir(`/admin/drive/jobs/${r.data.trabajo}`, (j) => { st.av.drive = { ...st.av.drive, ...j }; refrescar(); }, { cada: 8000, enCurso: (d) => d.status === 'running' });
    st.av.drive = { ...st.av.drive, ...fin, status: fin.status || (fin.estado === 'error' ? 'failed' : st.av.drive.status) }; refrescar();
    if (salio()) toast(st.av.drive.status === 'done' ? `✓ HEPTA Drive ${st.drive.slug} quedó listo` : `El alta de Drive ${st.drive.slug} falló`, st.av.drive.status === 'done' ? 'ok' : 'bad', 0);
  };

  const chipDe = (ok, bad, txtOk = 'Listo') => html`<span class="chip ${ok ? 'ok' : bad ? 'bad' : 'info'}">${ok ? txtOk : bad ? 'Falló' : 'En curso'}</span>`;
  const linea = (ok, bad, titulo, sub = '') => html`<div class="paso"><span class="d ${ok ? 'ok' : bad ? 'bad' : 'run'}">${ok ? '✓' : bad ? '✕' : '…'}</span><div><b>${titulo}</b>${sub ? html`<div class="muted chico">${sub}</div>` : ''}</div></div>`;

  const pintarAvance = () => {
    const tarjetas = [];
    if (st.erp.on) {
      const j = st.av.erp || {}; const ok = j.estado === 'ok', bad = j.estado === 'error';
      tarjetas.push(html`<section class="card pad" aria-labelledby="a-erp"><div class="btns" style="justify-content:space-between;margin-bottom:8px"><h2 id="a-erp">HEPTA ERP · ${PLANES[st.erp.plan]}</h2>${chipDe(ok, bad)}</div>
        ${linea(ok, bad, j.paso || 'Empezando', j.segundos ? `${Math.floor(j.segundos / 60)} min ${j.segundos % 60} s` : '')}
        ${bad ? html`<div class="aviso bad">${j.error || 'Sin detalle'}</div>` : ''}${j.aviso ? html`<div class="aviso warn">${j.aviso}</div>` : ''}
        ${ok ? html`<div class="aviso ok">${j.credenciales_enviadas ? 'El titular recibió su usuario y contraseña por correo.' : 'Listo.'}</div>${j.url ? html`<a class="btn sm" href="${j.url}" target="_blank" rel="noopener">Abrir el sistema ↗</a>` : ''}` : html`<p class="muted chico">Sigue aunque cierres esta página: el avance queda en Inicio → Trabajos en curso.</p>`}</section>`);
    }
    if (st.mail.on) {
      const m = st.av.mail || {}; const bad = m.estado === 'error', listo = m.estado === 'ok' || m.estado === 'aviso';
      tarjetas.push(html`<section class="card pad" aria-labelledby="a-mail"><div class="btns" style="justify-content:space-between;margin-bottom:8px"><h2 id="a-mail">HEPTA Mail · ${st.mail.dominio}</h2>${listo && !m.dnsOk ? html`<span class="chip warn">Falta el DNS</span>` : chipDe(listo, bad)}</div>
        ${linea(listo, bad, m.paso || 'Empezando')}
        ${bad ? html`<div class="aviso bad">${m.error || 'Sin detalle'}</div>` : ''}
        ${(m.casillas || []).map(c => linea(c.ok, !c.ok, c.dir, c.ok ? '' : c.error || 'no se pudo crear'))}
        ${m.claves && m.claves.length ? html`<div class="aviso warn" style="margin-top:8px"><b>Contraseñas iniciales: copialas ahora.</b> No se guardan y no se vuelven a mostrar; se piden cambiar en el primer ingreso.
          ${m.claves.map((k, i) => html`<div class="btns" style="margin-top:6px;flex-wrap:nowrap"><code style="flex:1;min-width:0;overflow-wrap:anywhere">${k.dir} · ${k.clave}</code><button class="btn sm" type="button" data-copiar="${i}">Copiar</button></div>`)}</div>` : ''}
        ${listo ? html`<div class="btns" style="margin-top:10px">${m.dnsOk ? html`<span class="chip ok">DNS publicado</span>` : html`<button class="btn sm pri" type="button" id="m-dns">Revisar y publicar el DNS</button>`}</div>` : ''}</section>`);
    }
    if (st.drive.on) {
      const d = st.av.drive || {}; const ok = d.status === 'done', bad = d.status === 'failed';
      tarjetas.push(html`<section class="card pad" aria-labelledby="a-drive"><div class="btns" style="justify-content:space-between;margin-bottom:8px"><h2 id="a-drive">HEPTA Drive · ${st.drive.slug}</h2>${chipDe(ok, bad)}</div>
        ${linea(ok, bad, d.step || 'Empezando')}
        ${bad ? html`<div class="aviso bad">${d.error || 'Sin detalle'}</div>` : ''}${d.avisos && d.avisos.length ? html`<div class="aviso warn">${d.avisos.join(' · ')}</div>` : ''}
        ${ok ? html`<div class="aviso ok">Los usuarios recibieron su invitación por correo.</div><div class="btns">${d.fqdn ? html`<a class="btn sm" href="https://${d.fqdn}" target="_blank" rel="noopener">Abrir ↗</a>` : ''}<a class="btn sm" href="/admin/#drive">Bajar los secretos a KeePass ↗</a></div>` : html`<p class="muted chico">Tarda unos minutos y sigue aunque cierres esta página.</p>`}</section>`);
    }
    v.innerHTML = html`${cab()}<div class="grid g-3">${tarjetas}
      <section class="card pad" aria-labelledby="a-erpg"><h2 id="a-erpg" style="margin-bottom:8px">En el ERP del grupo</h2>
        <div class="paso"><span class="d">1</span><div class="muted">Factura del primer mes y suscripción: se cargan a mano como hasta ahora (pronto, automático).</div></div>
        <a class="btn sm" href="#/clientes/${st.cliente.id}" style="margin-top:8px">Ver el cliente</a></section></div>`.s;
    v.querySelectorAll('[data-copiar]').forEach(b => b.addEventListener('click', async () => {
      const k = st.av.mail.claves[Number(b.dataset.copiar)];
      try { await navigator.clipboard.writeText(k.clave); toast('Copiada', 'ok', 2500); } catch (e) { toast('No se pudo copiar: seleccionala y copiala a mano', 'bad'); }
    }));
    const bdns = v.querySelector('#m-dns'); if (bdns) bdns.addEventListener('click', () => revisarDns());
  };

  // ── DNS del correo: primero se mira, después se publica ──
  const revisarDns = async () => {
    const dom = st.mail.dominio;
    const r = await api('POST', `/admin/mail/domains/${encodeURIComponent(dom)}/dns/publish`, { dry_run: true }, { silencioso: true });
    if (!r.success) {
      // La zona no está en nuestra cuenta de Cloudflare: los registros los carga quien administre ese DNS
      const p = await api('GET', `/admin/mail/domains/${encodeURIComponent(dom)}/dns`);
      if (!p.success) return;
      modal({ titulo: `DNS de ${dom}`, ancho: true,
        contenido: html`<p style="margin-top:0">${r.error || ''}. Estos registros los tiene que cargar quien administre el DNS del dominio:</p>
          <pre style="white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;background:var(--fondo);padding:10px;border-radius:8px;max-height:50vh;overflow:auto">${p.data.dns_text || ''}</pre>`,
        botones: [{ texto: 'Copiar todo', accion: async () => { try { await navigator.clipboard.writeText(p.data.dns_text || ''); toast('Copiado', 'ok', 2500); } catch (e) { toast('No se pudo copiar', 'bad'); } return true; } }, { texto: 'Cerrar', clase: 'pri' }] });
      return;
    }
    const filas = r.data.results || [];
    const reemplaza = filas.filter(f => f.action === 'would_update' && !f.igual);
    const otrosMx = [...new Set(filas.flatMap(f => f.otros_mx || []))];
    const choques = filas.filter(f => (f.choca || []).length);
    modal({ titulo: `DNS del correo de ${dom}`, ancho: true,
      contenido: html`<p style="margin-top:0">La zona está en la cuenta de Cloudflare de HEPTA. Esto es lo que quedaría (nada se cambia todavía):</p>
        ${filas.map(f => html`<div class="row" style="padding:8px 0;align-items:flex-start"><div class="flex"><b>${f.type}</b> ${f.name}<div class="muted chico" style="overflow-wrap:anywhere">${f.nuevo}</div>
          ${f.action === 'would_update' && !f.igual ? html`<div class="chico" style="color:var(--warn);overflow-wrap:anywhere">Reemplaza: ${f.actual}</div>` : ''}
          ${(f.choca || []).length ? html`<div class="chico" style="color:var(--bad)">Choca con un registro ${f.choca.join(', ')} del mismo nombre: no se va a poder crear</div>` : ''}</div>
          <span class="chip ${f.action === 'would_create' ? 'info' : f.igual ? 'mute' : 'warn'}">${f.action === 'would_create' ? 'crear' : f.igual ? 'ya está' : 'reemplazar'}</span></div>`)}
        ${otrosMx.length ? html`<div class="aviso warn" style="margin-top:10px"><b>Quedarían otros MX:</b> ${otrosMx.join(' · ')}. Se reemplaza uno solo: los demás hay que borrarlos a mano en Cloudflare, o el correo llega a dos lados.</div>` : ''}
        ${reemplaza.some(f => f.type === 'MX') ? html`<div class="aviso warn" style="margin-top:10px">Cambia el MX: desde que se publica, el correo nuevo del dominio entra a HEPTA Mail. Si hoy está en otro servidor, coordinalo antes.</div>` : ''}
        ${choques.length ? html`<div class="aviso bad" style="margin-top:10px">Hay registros que chocan. Revisalos en Cloudflare antes de publicar.</div>` : ''}`,
      botones: [{ texto: 'Cancelar' }, { texto: reemplaza.length ? 'Publicar y reemplazar' : 'Publicar', clase: 'pri', accion: async () => {
        if (reemplaza.length && !(await confirmar({ titulo: 'Reemplazar registros DNS', texto: `Se reemplazan ${reemplaza.length} registro(s) de ${dom}: ${reemplaza.map(f => `${f.type} ${f.name}`).join(', ')}.`, boton: 'Reemplazar', peligro: true }))) return true;
        const pub = await api('POST', `/admin/mail/domains/${encodeURIComponent(dom)}/dns/publish`, {});
        if (!pub.success) return true;
        const fallos = (pub.data.results || []).filter(x => x.action === 'failed');
        if (fallos.length) toast(`DNS publicado con ${fallos.length} error(es): ${fallos.map(x => `${x.name} (${x.error})`).join(' · ')}`, 'bad', 0);
        else toast('DNS del correo publicado', 'ok');
        st.av.mail.dnsOk = !fallos.length; refrescar();
        return false;
      } }] });
  };

  const pintar = () => {
    if (st.paso === 1) return paso1();
    if (st.paso === 2) return paso2();
    if (st.paso === 3) return paso3();
    return pintarAvance();
  };
  pintar();
}
