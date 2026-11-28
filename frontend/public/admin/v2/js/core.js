// ============================================================
//  HEPTA CLOUD — Admin nuevo: núcleo
//  html``  → plantillas que ESCAPAN todo lo que se interpola (lo que viene de la base o de un cliente no
//            puede meter HTML). Para insertar HTML armado acá: raw(...) o un html`` anidado.
//  api()   → misma sesión que el Admin actual (localStorage hc_admin_token) y el mismo formato de respuesta.
// ============================================================

// ── Plantillas seguras ───────────────────────────────────────
class Seguro { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Seguro(String(s ?? ''));
export const esc = (t) => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pieza = (v) => {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Seguro) return v.s;
  if (Array.isArray(v)) return v.map(pieza).join('');
  return esc(v);
};
export function html(partes, ...vals) {
  let s = partes[0];
  vals.forEach((v, i) => { s += pieza(v) + partes[i + 1]; });
  return new Seguro(s);
}

// ── Formatos ─────────────────────────────────────────────────
export const gs = (n) => (n === null || n === undefined || n === '' || isNaN(Number(n))) ? '—' : '₲ ' + Number(n).toLocaleString('es-PY', { maximumFractionDigits: 0 });
export const fecha = (d) => d ? new Date(d).toLocaleDateString('es-PY', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
export const fechaHora = (d) => {
  if (!d) return '—';
  const f = new Date(d), dos = (n) => String(n).padStart(2, '0');
  return `${f.getDate()} ${MESES[f.getMonth()]} · ${dos(f.getHours())}:${dos(f.getMinutes())}`;
};
export function hace(d) {
  if (!d) return '—';
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'recién';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  const dd = Math.round(s / 86400);
  return dd === 1 ? 'ayer' : `hace ${dd} días`;
}
export const PLANES = { starter: 'Despegue', professional: 'Crecimiento', enterprise: 'Empresa' };
export const wa = (tel, texto) => {
  let d = String(tel || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('0')) d = '595' + d.slice(1);
  return `https://wa.me/${d}${texto ? '?text=' + encodeURIComponent(texto) : ''}`;
};

// ── Sesión y API ─────────────────────────────────────────────
const CLAVE = 'hc_admin_token';
export const sesion = {
  get token() { try { return localStorage.getItem(CLAVE); } catch (e) { return null; } },
  set token(t) { try { t ? localStorage.setItem(CLAVE, t) : localStorage.removeItem(CLAVE); } catch (e) { /* sin almacenamiento */ } },
  usuario: null,
  get godmode() { return this.usuario && this.usuario.role === 'godmode'; },
};

export async function api(method, path, body, { silencioso = false } = {}) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (sesion.token) opts.headers.Authorization = `Bearer ${sesion.token}`;
  if (body !== undefined) opts.body = JSON.stringify(body);
  let res;
  try { res = await fetch('/api' + path, opts); }
  catch (e) { return { success: false, error: 'No hay conexión con el servidor. Revisá tu internet y probá de nuevo.' }; }
  if (res.status === 401) { sesion.token = null; location.reload(); return { success: false, error: 'Sesión vencida' }; }
  let data;
  try { data = await res.json(); }
  catch (e) {
    const motivo = res.status === 502 || res.status === 504 ? 'el servidor tardó demasiado o se está reiniciando' : 'respuesta inesperada del servidor';
    data = { success: false, error: `No se pudo completar (${res.status}): ${motivo}.` };
  }
  if (res.status === 403 && !data.error) data.error = 'No tenés permiso para esto (hace falta godmode).';
  if (!data.success && !silencioso && method !== 'GET') toast(data.error || 'No se pudo completar', 'bad');
  data.http = res.status;
  return data;
}

// Consulta un trabajo cada `cada` ms hasta que deja de estar en curso. `alPaso` recibe cada estado.
export async function seguir(ruta, alPaso, { cada = 5000, enCurso = (d) => d.estado === 'en_curso' } = {}) {
  for (;;) {
    await new Promise(r => setTimeout(r, cada));
    const r = await api('GET', ruta, undefined, { silencioso: true });
    if (!r.success) return { estado: 'error', error: r.error };
    alPaso && alPaso(r.data);
    if (!enCurso(r.data)) return r.data;
  }
}

// ── UI: avisos, modal, confirmación, menú ────────────────────
export function toast(texto, tipo = '', ms = 6000) {
  const caja = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${tipo}`;
  el.setAttribute('role', tipo === 'bad' ? 'alert' : 'status');
  el.innerHTML = html`<span>${texto}</span><button type="button" aria-label="Cerrar">×</button>`.s;
  el.querySelector('button').onclick = () => el.remove();
  caja.appendChild(el);
  if (ms) setTimeout(() => el.remove(), ms);
}

let modalAbierto = null;
// contenido: html``; botones: [{texto, clase, accion(cerrar, raiz) → true para dejarlo abierto}]
export function modal({ titulo, contenido, botones = [{ texto: 'Cerrar' }], ancho = false, alCerrar } = {}) {
  cerrarModal();
  const velo = document.createElement('div');
  velo.className = 'velo';
  velo.innerHTML = html`<div class="modal ${ancho ? 'ancho' : ''}" role="dialog" aria-modal="true" aria-labelledby="m-titulo">
      <div class="modal-cab"><h2 id="m-titulo">${titulo}</h2><button type="button" class="btn ic sm" data-x aria-label="Cerrar">×</button></div>
      <div class="modal-cuerpo">${contenido}</div>
      <div class="modal-pie">${botones.map((b, i) => html`<button type="button" class="btn ${b.clase || ''}" data-b="${i}">${b.texto}</button>`)}</div>
    </div>`.s;
  const cerrar = () => { if (velo.isConnected) { velo.remove(); modalAbierto = null; alCerrar && alCerrar(); } };
  velo.addEventListener('mousedown', (e) => { if (e.target === velo) cerrar(); });
  velo.querySelector('[data-x]').onclick = cerrar;
  velo.querySelectorAll('[data-b]').forEach(btn => {
    btn.onclick = async () => {
      const b = botones[Number(btn.dataset.b)];
      if (!b.accion) return cerrar();
      btn.disabled = true;
      try { if (!(await b.accion(cerrar, velo))) cerrar(); }
      finally { if (btn.isConnected) btn.disabled = false; }
    };
  });
  document.body.appendChild(velo);
  modalAbierto = { velo, cerrar };
  const foco = velo.querySelector('input,select,textarea') || velo.querySelector('.modal-pie .btn:last-child');
  foco && foco.focus();
  return { raiz: velo, cerrar };
}
export function cerrarModal() { modalAbierto && modalAbierto.cerrar(); }

export function confirmar({ titulo, texto, boton = 'Confirmar', peligro = false, repetir = null }) {
  return new Promise((resolve) => {
    let ok = false;
    const { raiz } = modal({
      titulo,
      contenido: html`<p style="margin:0 0 8px">${texto}</p>${repetir ? html`<label class="fld">Escribí <b>${repetir}</b> para confirmar<input data-rep autocomplete="off"></label>` : ''}`,
      botones: [{ texto: 'Cancelar' }, { texto: boton, clase: peligro ? 'peligro' : 'pri', accion: (cerrar, r) => {
        if (repetir && r.querySelector('[data-rep]').value.trim() !== repetir) { toast('El texto no coincide', 'bad'); return true; }
        ok = true; return false;
      } }],
      alCerrar: () => resolve(ok),
    });
    if (repetir) raiz.querySelector('[data-rep]').focus();
  });
}

let menuAbierto = null;
// items: [{texto, accion, clase, deshabilitado, sep}] — se ubica junto al botón que lo abrió
export function menu(boton, items) {
  cerrarMenu();
  const m = document.createElement('div');
  m.className = 'menu';
  m.setAttribute('role', 'menu');
  m.innerHTML = items.map((it, i) => it.sep ? '<div class="sep" role="separator"></div>'
    : html`<button type="button" role="menuitem" data-i="${i}" class="${it.clase || ''}" ${raw(it.deshabilitado ? 'disabled' : '')}>${it.texto}</button>`.s).join('');
  m.querySelectorAll('[data-i]').forEach(b => { b.onclick = () => { cerrarMenu(); items[Number(b.dataset.i)].accion(); }; });
  document.body.appendChild(m);
  const r = boton.getBoundingClientRect();
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + 'px';
  m.style.top = (r.bottom + h + 8 > innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4) + 'px';
  boton.setAttribute('aria-expanded', 'true');
  menuAbierto = { m, boton, desde: Date.now() };
  const primero = m.querySelector('button:not([disabled])'); primero && primero.focus();
}
export function cerrarMenu() {
  if (!menuAbierto) return;
  menuAbierto.m.remove(); menuAbierto.boton.setAttribute('aria-expanded', 'false'); menuAbierto = null;
}
document.addEventListener('mousedown', (e) => { if (menuAbierto && !menuAbierto.m.contains(e.target) && e.target !== menuAbierto.boton) cerrarMenu(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (menuAbierto) cerrarMenu(); else cerrarModal(); }
});
// Al desplazar la página se cierra (quedaría flotando lejos del botón), salvo justo al abrirlo:
// el navegador desplaza para mostrar el botón tocado y eso no cuenta.
window.addEventListener('scroll', (e) => { if (menuAbierto && Date.now() - menuAbierto.desde > 400 && !menuAbierto.m.contains(e.target)) cerrarMenu(); }, true);

// ── Íconos (trazo, 24×24) ────────────────────────────────────
const P = {
  inicio: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
  clientes: '<path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-4h6v4"/>',
  servicios: '<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/>',
  pedido: '<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/>',
  respaldo: '<path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z"/>',
  estado: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  leads: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5 5h14l3 7v7H2v-7z"/>',
  pagos: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
  planes: '<path d="M20 12l-8 8-9-9V3h8z"/><circle cx="7.5" cy="7.5" r="1"/>',
  sitio: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/>',
  legal: '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4"/>',
  integ: '<path d="M9 7V3M15 7V3M6 7h12v5a6 6 0 01-12 0z"/><path d="M12 18v3"/>',
  correo: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  llave: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3"/>',
  lista: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  buscar: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  puntos: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  salir: '<path d="M9 21H5V3h4"/><path d="M16 17l5-5-5-5M21 12H9"/>',
};
export const icono = (n, tam = 16) => raw(`<svg viewBox="0 0 24 24" width="${tam}" height="${tam}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n] || ''}</svg>`);

// ── Ruta actual ──────────────────────────────────────────────
// #/servicios/erp?q=ryg → { partes: ['servicios','erp'], q: URLSearchParams }
export function ruta() {
  const [camino, qs] = (location.hash.replace(/^#\/?/, '') || 'inicio').split('?');
  return { partes: camino.split('/').filter(Boolean).map(decodeURIComponent), q: new URLSearchParams(qs || '') };
}
export const ir = (h) => { location.hash = h; };

// Estado de una instancia o servicio → chip
export function chipEstado(st) {
  const m = { active: ['ok', 'Activa'], suspended: ['bad', 'Suspendida'], cancelled: ['mute', 'De baja'], creating: ['info', 'Creándose'],
              failed: ['bad', 'Falló'], provisioning: ['info', 'Alta en curso'], pending: ['warn', 'Pendiente'], provisioned: ['ok', 'Dada de alta'] };
  const [c, t] = m[st] || ['mute', st || '—'];
  return html`<span class="chip ${c}">${t}</span>`;
}

// Tabla con búsqueda, orden y paginado del lado del navegador
export function paginar(lista, pagina, porPagina = 20) {
  const total = lista.length, paginas = Math.max(1, Math.ceil(total / porPagina));
  const p = Math.min(Math.max(1, pagina), paginas);
  return { filas: lista.slice((p - 1) * porPagina, p * porPagina), pagina: p, paginas, total, desde: total ? (p - 1) * porPagina + 1 : 0, hasta: Math.min(p * porPagina, total) };
}
export const normal = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
