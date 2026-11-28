// Estado: ERP, Mail, Drive, respaldos y la vista de afuera, de un vistazo. Lo que está mal va primero.
// Los datos los junta el backend (GET /admin/v2/estado, guardado 60 s); acá solo se pintan y se renuevan
// cada minuto mientras la pantalla esté abierta y visible.
import { html, raw, api, hace } from '../core.js';

export const ETIQUETA = { ok: 'En orden', aviso: 'Para mirar', falla: 'Falla', sin_dato: 'Sin dato' };
export const CHIP = { ok: 'ok', aviso: 'warn', falla: 'bad', sin_dato: 'mute' };
const PUNTO = { ok: 'ok', aviso: 'warn', falla: 'bad', sin_dato: '' };
const ORDEN = { falla: 0, aviso: 1, sin_dato: 2, ok: 3 };
const CADA_MS = 60000;

export function resumen(d) {
  if (d.estado === 'ok') return html`<span class="chip ok">Todo en orden</span>`;
  const n = d.cuenta.falla + d.cuenta.aviso + d.cuenta.sin_dato;
  return html`<span class="chip ${CHIP[d.estado]}">${n} ${n === 1 ? 'área' : 'áreas'} para revisar</span>`;
}

function chequeo(x) {
  const fila = html`<span class="punto ${PUNTO[x.estado]}" title="${ETIQUETA[x.estado]}"></span>
    <div class="flex"><b>${x.nombre}</b><div class="${x.estado === 'ok' ? 'muted' : ''} chico" ${raw(x.estado === 'falla' ? 'style="color:var(--bad)"' : x.estado === 'aviso' ? 'style="color:var(--warn)"' : '')}>${x.detalle}</div></div>`;
  if (!x.items || !x.items.length) return html`<div class="row">${fila}</div>`;
  const items = [...x.items].sort((a, b) => ORDEN[a.estado] - ORDEN[b.estado]);
  // Si hay alguno caído, se abre solo
  return html`<details class="det" ${raw(items.some(i => i.estado !== 'ok') ? 'open' : '')}><summary class="row">${fila}<span class="muted chico">${items.length}</span></summary>
    ${items.map(i => html`<div class="row sub"><span class="punto ${PUNTO[i.estado]}"></span><div class="flex">${i.enlace ? html`<a href="${i.enlace}">${i.nombre}</a>` : i.nombre}<div class="muted chico">${i.detalle}</div></div></div>`)}</details>`;
}

function grupo(g) {
  return html`<section class="card estado-${g.estado}" aria-labelledby="g-${g.id}">
    <div class="card-cab"><h2 id="g-${g.id}">${g.enlace ? html`<a href="${g.enlace}" class="sin-subrayado">${g.nombre}</a>` : g.nombre}</h2><span class="chip ${CHIP[g.estado]}">${ETIQUETA[g.estado]}</span></div>
    ${g.nota ? html`<div class="muted chico" style="padding:0 16px 10px">${g.nota}</div>` : ''}
    ${g.chequeos.map(chequeo)}</section>`;
}

export async function render(v, rt, salio) {
  v.innerHTML = html`<div class="cab"><div><h1>Estado</h1><p>ERP, correo, Drive, respaldos y lo que ve un cliente desde afuera. Se actualiza solo cada minuto.</p></div>
      <div class="btns"><span id="e-res"></span><span class="muted chico" id="e-hora"></span><button class="btn sm" type="button" id="e-re">Actualizar</button></div></div>
    <div id="e-grupos" class="grid g-2">${[1, 2, 3, 4].map(() => html`<div class="card pad"><div class="esqueleto" style="height:120px"></div></div>`)}</div>`.s;
  const btn = v.querySelector('#e-re');
  let ultimo = null;

  const pintar = (d) => {
    ultimo = d;
    v.querySelector('#e-res').innerHTML = resumen(d).s;
    v.querySelector('#e-hora').textContent = `revisado ${hace(d.revisado)}`;
    v.querySelector('#e-hora').title = new Date(d.revisado).toLocaleString('es-PY');
    const grupos = [...d.grupos].sort((a, b) => ORDEN[a.estado] - ORDEN[b.estado]);
    v.querySelector('#e-grupos').innerHTML = grupos.map(grupo).join('');
  };

  const cargar = async (fresco) => {
    btn.disabled = true; btn.textContent = 'Revisando…';
    const r = await api('GET', `/admin/v2/estado${fresco ? '?fresco=1' : ''}`, undefined, { silencioso: true });
    if (salio()) return;
    btn.disabled = false; btn.textContent = 'Actualizar';
    if (!r.success) {
      if (!ultimo) v.querySelector('#e-grupos').innerHTML = html`<div class="aviso bad">${r.error || 'No se pudo revisar el estado'}</div>`.s;
      else v.querySelector('#e-hora').textContent = `no se pudo actualizar · ${hace(ultimo.revisado)}`;
      return;
    }
    pintar(r.data);
    window.dispatchEvent(new CustomEvent('hc:estado', { detail: r.data }));
  };

  btn.addEventListener('click', () => cargar(true));
  await cargar(false);
  // Renovar cada minuto mientras la pantalla siga abierta (y la pestaña a la vista)
  const t = setInterval(() => {
    if (salio()) return clearInterval(t);
    if (!document.hidden) cargar(false);
    else if (ultimo) v.querySelector('#e-hora').textContent = `revisado ${hace(ultimo.revisado)}`;
  }, CADA_MS);
}
