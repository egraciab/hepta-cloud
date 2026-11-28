// ============================================================
//  HEPTA CLOUD — Admin nuevo: arranque, menú, rutas y búsqueda global
// ============================================================
import { html, raw, api, sesion, icono, ruta, toast, modal, cerrarModal } from './core.js';

// Menú. `viejo`: todavía vive en el Admin actual (se abre allá, en la sección que corresponde).
const MENU = [
  { id: 'inicio', texto: 'Inicio', ic: 'inicio' },
  { grupo: 'Operación' },
  { id: 'clientes', texto: 'Clientes', ic: 'clientes' },
  { id: 'servicios', texto: 'Servicios', ic: 'servicios' },
  { id: 'pedido', texto: 'Pedidos y altas', ic: 'pedido' },
  { id: 'estado', texto: 'Estado y respaldos', ic: 'estado', cnt: 'estado' },
  { grupo: 'Comercial' },
  { id: 'leads', texto: 'Leads', ic: 'leads', cnt: 'leads' },
  { id: 'pagos', texto: 'Pagos', ic: 'pagos', cnt: 'pagos' },
  { viejo: 'plans', texto: 'Planes y adicionales', ic: 'planes' },
  { grupo: 'Sitio web' },
  { viejo: 'services', texto: 'Contenido', ic: 'sitio' },
  { viejo: 'pages', texto: 'Páginas legales', ic: 'legal' },
  { viejo: 'general', texto: 'Configuración', ic: 'sitio' },
  { grupo: 'Sistema' },
  { viejo: 'credentials', texto: 'Integraciones', ic: 'integ' },
  { viejo: 'smtp', texto: 'Correo saliente', ic: 'correo' },
  { viejo: 'users', texto: 'Equipo y usuarios', ic: 'llave' },
  { id: 'actividad', texto: 'Registro de actividad', ic: 'lista' },
];
const VISTAS = { inicio: 'inicio', clientes: 'clientes', servicios: 'servicios', pedido: 'pedido', leads: 'leads', pagos: 'pagos', actividad: 'actividad', estado: 'estado', respaldos: 'estado' };
const contadores = { leads: 0, pagos: 0, estado: 0 };
let estadoGrave = false;     // alguna falla (rojo) o solo avisos (amarillo)

function pintarMenu() {
  const actual = ruta().partes[0];
  document.getElementById('nav').innerHTML = MENU.map(m => {
    if (m.grupo) return html`<div class="grp">${m.grupo}</div>`;
    if (m.viejo) return html`<a href="/admin/#${m.viejo}" title="Se abre en el Admin actual">${icono(m.ic)}${m.texto}<span class="ext" aria-label="(Admin actual)">↗</span></a>`;
    const n = m.cnt ? contadores[m.cnt] : 0;
    return html`<a href="#/${m.id}" class="${actual === m.id ? 'on' : ''}" ${raw(actual === m.id ? 'aria-current="page"' : '')}>${icono(m.ic)}${m.texto}${m.pronto ? html`<span class="ext">pronto</span>` : ''}${n ? html`<span class="chip ${m.cnt === 'estado' ? (estadoGrave ? 'bad' : 'warn') : m.cnt === 'pagos' ? 'warn' : 'info'} cnt" ${raw(m.cnt === 'estado' ? 'title="Áreas para revisar"' : '')}>${n}</span>` : ''}</a>`;
  }).join('');
}

function contarEstado(d) {
  contadores.estado = d.cuenta.falla + d.cuenta.aviso;
  estadoGrave = d.cuenta.falla > 0;
}
async function actualizarContadores() {
  const [r, e] = await Promise.all([
    api('GET', '/admin/v2/inicio', undefined, { silencioso: true }),
    api('GET', '/admin/v2/estado', undefined, { silencioso: true }),
  ]);
  if (r.success) {
    contadores.leads = (r.data.kpis.leads && r.data.kpis.leads.nuevos) || 0;
    contadores.pagos = r.data.kpis.pagos_pendientes || 0;
  }
  if (e.success) contarEstado(e.data);
  pintarMenu();
}

// ── Rutas ────────────────────────────────────────────────────
let turno = 0;
async function mostrar() {
  const yo = ++turno;
  const { partes } = ruta();
  const nombre = VISTAS[partes[0]] || 'inicio';
  pintarMenu();
  document.getElementById('app').classList.remove('menu-abierto');
  const vista = document.getElementById('vista');
  vista.innerHTML = '<div class="cargando">Cargando…</div>';
  try {
    const mod = await import(`./vistas/${nombre}.js?v=3`);
    if (yo !== turno) return;          // el usuario ya se fue a otra pantalla
    await mod.render(vista, ruta(), () => yo !== turno);
    document.title = `${vista.querySelector('h1')?.textContent || 'Admin'} · HEPTA Cloud`;
  } catch (e) {
    console.error(e);
    if (yo === turno) vista.innerHTML = html`<div class="card pad"><h1>No se pudo abrir esta pantalla</h1><p class="muted">${e.message}</p><p><a href="/admin/">Abrir el Admin actual</a></p></div>`.s;
  }
}

// ── Búsqueda global (Ctrl K) ─────────────────────────────────
const DESTINO = {
  cliente: (r) => `#/clientes/${r.id}`,
  instancia: (r) => `#/servicios/erp?q=${encodeURIComponent(r.titulo)}`,
  correo: (r) => `#/servicios/mail?q=${encodeURIComponent(r.id)}`,
  drive: (r) => `#/servicios/drive?q=${encodeURIComponent(r.id)}`,
  lead: (r) => `#/leads?q=${encodeURIComponent(r.titulo)}`,
  usuario: () => '/admin/#users',
};
function abrirBusqueda() {
  const { raiz } = modal({ titulo: 'Buscar', contenido: html`<div class="paleta"><label class="sr" for="pq">Buscar</label><input id="pq" placeholder="Cliente, instancia, dominio, RUC, correo…" autocomplete="off"><div class="res" id="pres" role="listbox"><div class="vacio" style="border:0">Escribí al menos 2 letras.</div></div></div>`, botones: [] });
  raiz.querySelector('.modal').classList.add('paleta');
  raiz.querySelector('.modal-cab').hidden = true;
  raiz.querySelector('.modal-pie').hidden = true;
  raiz.querySelector('.modal-cuerpo').style.padding = '0';
  const inp = raiz.querySelector('#pq'), res = raiz.querySelector('#pres');
  let t, sel = 0, items = [];
  const pintar = () => {
    res.innerHTML = items.length ? items.map((r, i) => html`<a href="${DESTINO[r.tipo](r)}" role="option" class="${i === sel ? 'on' : ''}" ${raw(i === sel ? 'aria-selected="true"' : '')}><span class="t">${r.tipo}</span><span style="flex:1;min-width:0"><b>${r.titulo}</b><br><span class="muted chico">${r.sub}</span></span></a>`).join('')
      : '<div class="vacio" style="border:0">Sin resultados.</div>';
    res.querySelectorAll('a').forEach(a => a.addEventListener('click', () => cerrarModal()));
  };
  inp.addEventListener('input', () => {
    clearTimeout(t);
    const q = inp.value.trim();
    if (q.length < 2) { res.innerHTML = '<div class="vacio" style="border:0">Escribí al menos 2 letras.</div>'; items = []; return; }
    t = setTimeout(async () => {
      const r = await api('GET', `/admin/v2/buscar?q=${encodeURIComponent(q)}`, undefined, { silencioso: true });
      if (inp.value.trim() !== q) return;
      items = r.success ? r.data : []; sel = 0; pintar();
    }, 220);
  });
  inp.addEventListener('keydown', (e) => {
    if (!items.length) return;
    if (e.key === 'ArrowDown') { sel = (sel + 1) % items.length; pintar(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { sel = (sel - 1 + items.length) % items.length; pintar(); e.preventDefault(); }
    if (e.key === 'Enter') { const d = DESTINO[items[sel].tipo](items[sel]); cerrarModal(); location.href = d; }
  });
  inp.focus();
}

// ── Arranque ─────────────────────────────────────────────────
async function entrar() {
  const me = sesion.token ? await api('GET', '/auth/me', undefined, { silencioso: true }) : null;
  if (!me || !me.success) return mostrarLogin();
  if (!['admin', 'godmode'].includes(me.data.role)) { sesion.token = null; return mostrarLogin('Tu usuario no tiene acceso al Admin.'); }
  sesion.usuario = me.data;
  document.getElementById('login').hidden = true;
  document.getElementById('app').hidden = false;
  const nombre = me.data.full_name || me.data.email;
  document.getElementById('yo-n').textContent = nombre;
  document.getElementById('yo-r').textContent = me.data.role;
  document.getElementById('yo-av').textContent = nombre.split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();
  document.getElementById('salir').innerHTML = icono('salir').s;
  document.getElementById('burger').innerHTML = icono('menu', 18).s;
  window.addEventListener('hashchange', mostrar);
  mostrar();
  actualizarContadores();
  setInterval(actualizarContadores, 120000);
  window.addEventListener('hc:contadores', actualizarContadores);
  window.addEventListener('hc:estado', (ev) => { contarEstado(ev.detail); pintarMenu(); });
  // Logo del sitio, si hay
  api('GET', '/admin/config', undefined, { silencioso: true }).then(r => {
    const u = r.success && r.data.logo_url;
    if (u && /^(\/|https:\/\/)/.test(u)) document.getElementById('sb-logo').innerHTML = html`<img src="${u}" alt="">`.s;
  });
}

function mostrarLogin(error) {
  document.getElementById('app').hidden = true;
  document.getElementById('login').hidden = false;
  const err = document.getElementById('l-err');
  err.hidden = !error; err.textContent = error || '';
  document.getElementById('l-email').focus();
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('l-btn'), err = document.getElementById('l-err');
  const email = document.getElementById('l-email').value.trim(), password = document.getElementById('l-pass').value;
  if (!email || !password) return;
  btn.disabled = true; btn.textContent = 'Entrando…'; err.hidden = true;
  const r = await api('POST', '/auth/login', { email, password }, { silencioso: true });
  btn.disabled = false; btn.textContent = 'Entrar';
  if (!r.success) { err.hidden = false; err.textContent = r.error || 'Correo o contraseña incorrectos'; return; }
  sesion.token = r.data.token;
  entrar();
});
document.getElementById('salir').addEventListener('click', async () => {
  await api('POST', '/auth/logout', {}, { silencioso: true });
  sesion.token = null; location.reload();
});
document.getElementById('abrir-busca').addEventListener('click', abrirBusqueda);
document.getElementById('burger').addEventListener('click', () => document.getElementById('app').classList.toggle('menu-abierto'));
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && !document.getElementById('app').hidden) { e.preventDefault(); abrirBusqueda(); }
});
window.addEventListener('unhandledrejection', (e) => { console.error(e.reason); toast('Algo falló en esta pantalla: ' + ((e.reason && e.reason.message) || e.reason), 'bad'); });

entrar();
