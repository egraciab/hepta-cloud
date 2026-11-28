// ============================================================
//  HEPTA CLOUD — Estado de la plataforma (panel "Estado" del Admin nuevo)
//
//  Junta en un solo lugar lo que hoy está repartido: HEPTA ERP (API de alta, NGINX perimetral y cada tenant
//  activo), HEPTA Mail (mailcow y sus contenedores), HEPTA Drive (agente y salud de la VM) y lo que ve el
//  vigía de hcsvrnd01 desde afuera, con los respaldos (lo reporta él: POST /api/monitor/vigia).
//
//  Cada chequeo termina en uno de cuatro estados: ok · aviso (funciona, pero hay que mirarlo) · falla ·
//  sin_dato (no se pudo preguntar). Un grupo toma el peor de sus chequeos.
//
//  Las pruebas salen de acá con tiempo límite y en paralelo. El resultado se guarda 60 s en memoria: varios
//  administradores con el panel abierto no multiplican los pedidos a los servidores; "Actualizar" lo
//  renueva, pero no más de una vez cada 10 s. Dos pedidos a la vez comparten la misma revisión.
// ============================================================
const net  = require('net');
const pool = require('../config/db');
const drive = require('./drive');
const mc    = require('./mailcow/client');

const CACHE_MS   = 60 * 1000;
const MINIMO_MS  = 10 * 1000;
const ESPERA_MS  = 8000;
const VIGIA_VIEJO_MIN = 15;           // el vigía reporta cada 5 min: tres reportes perdidos ya es aviso
const PEOR = { ok: 0, sin_dato: 1, aviso: 2, falla: 3 };
const peor = (lista) => lista.reduce((a, b) => (PEOR[b] > PEOR[a] ? b : a), 'ok');

const c = (estado, nombre, detalle, extra) => ({ estado, nombre, detalle: detalle || '', ...(extra || {}) });
const motivo = (e) => String((e && (e.cause && e.cause.code)) || (e && e.message) || e || 'error').slice(0, 200);

async function config(claves) {
  const { rows } = await pool.query('SELECT key, value FROM site_config WHERE key = ANY($1)', [claves]);
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

async function getJson(url, ms = ESPERA_MS) {
  const t = Date.now();
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), redirect: 'manual', headers: { 'User-Agent': 'hepta-cloud-estado/1' } });
  let json = null;
  try { json = await r.json(); } catch (e) { /* no era JSON */ }
  return { status: r.status, json, ms: Date.now() - t };
}

function puerto(host, port, ms = 5000) {
  return new Promise((resolve) => {
    const t = Date.now();
    const s = net.connect({ host, port });
    const fin = (ok, err) => { s.destroy(); resolve({ ok, ms: Date.now() - t, err }); };
    s.setTimeout(ms, () => fin(false, 'sin respuesta'));
    s.once('connect', () => fin(true));
    s.once('error', (e) => fin(false, e.code || e.message));
  });
}

// De a `n` por vez: no salir con 40 pedidos juntos cuando haya 40 tenants
async function deA(n, items, fn) {
  const salida = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; salida[k] = await fn(items[k]); }
  }));
  return salida;
}

// ── HEPTA ERP ────────────────────────────────────────────────
async function grupoErp() {
  const cfg = await config(['provision_api_url', 'perimetral_api_url']);
  const api = async (nombre, base) => {
    if (!base) return c('sin_dato', nombre, 'sin configurar');
    try {
      const r = await getJson(`${base.replace(/\/+$/, '')}/health`);
      const ok = r.status === 200 && (!r.json || !r.json.status || r.json.status === 'ok');
      return c(ok ? 'ok' : 'falla', nombre, ok ? `responde · ${r.ms} ms` : `respondió ${r.status}`);
    } catch (e) { return c('falla', nombre, `no responde (${motivo(e)})`); }
  };

  const { rows: tenants } = await pool.query(
    `SELECT id, label, db_name, custom_domain FROM instances WHERE status = 'active' ORDER BY COALESCE(label, db_name)`);
  const pruebas = await deA(6, tenants, async (t) => {
    const host = t.custom_domain || t.db_name;
    try {
      const r = await getJson(`https://${host}/web/health`);
      return { t, host, ok: r.status === 200, det: r.status === 200 ? `${r.ms} ms` : `respondió ${r.status}` };
    } catch (e) { return { t, host, ok: false, det: motivo(e) }; }
  });
  const caidos = pruebas.filter(p => !p.ok);
  const tenantsC = !tenants.length ? c('ok', 'Tenants activos', 'no hay tenants activos')
    : c(caidos.length ? 'falla' : 'ok', 'Tenants activos',
      caidos.length ? `${caidos.length} de ${tenants.length} no responden` : `los ${tenants.length} responden`,
      { items: pruebas.map(p => ({ estado: p.ok ? 'ok' : 'falla', nombre: p.t.label || p.host, detalle: `${p.host} · ${p.det}`,
        enlace: `#/servicios/erp?q=${encodeURIComponent(p.host)}` })) });

  return { id: 'erp', nombre: 'HEPTA ERP', enlace: '#/servicios/erp', chequeos: [
    await api('API de alta de tenants', cfg.provision_api_url),
    await api('API del NGINX perimetral', cfg.perimetral_api_url),
    tenantsC,
  ] };
}

// ── HEPTA Mail ───────────────────────────────────────────────
async function grupoMail() {
  const chequeos = [];
  const base = (process.env.MAILCOW_URL || '').replace(/\/+$/, '');
  if (!base) return { id: 'mail', nombre: 'HEPTA Mail', enlace: '#/servicios/mail', chequeos: [c('sin_dato', 'mailcow', 'MAILCOW_URL sin configurar')] };
  try {
    const t = Date.now();
    const r = await mc.request('GET', 'get/status/containers');
    const lista = Object.entries(r || {}).map(([k, v]) => ({ nombre: (v && v.container) || k.replace(/-mailcow$/, ''), estado: v && v.state }));
    const parados = lista.filter(x => x.estado !== 'running');
    chequeos.push(c('ok', 'API de mailcow', `responde · ${Date.now() - t} ms`));
    chequeos.push(c(parados.length ? 'falla' : 'ok', 'Contenedores de mailcow',
      parados.length ? `${parados.length} sin correr: ${parados.map(x => x.nombre).join(', ')}` : `los ${lista.length} en marcha`));
  } catch (e) {
    chequeos.push(c('falla', 'API de mailcow', `no responde (${motivo(e)})`));
  }
  const host = new URL(base).hostname;
  const ports = await Promise.all([[465, 'envío'], [587, 'envío'], [993, 'lectura IMAP']].map(async ([p, uso]) => ({ p, uso, r: await puerto(host, p) })));
  const cerrados = ports.filter(x => !x.r.ok);
  chequeos.push(c(cerrados.length ? 'falla' : 'ok', 'Puertos de correo',
    cerrados.length ? `no abren: ${cerrados.map(x => `${x.p} (${x.r.err})`).join(', ')}` : '465, 587 y 993 abren',
    { items: ports.map(x => ({ estado: x.r.ok ? 'ok' : 'falla', nombre: `${x.p} · ${x.uso}`, detalle: x.r.ok ? `${x.r.ms} ms` : x.r.err })) }));
  return { id: 'mail', nombre: 'HEPTA Mail', enlace: '#/servicios/mail', chequeos };
}

// ── HEPTA Drive ──────────────────────────────────────────────
// El antivirus caído es falla (Nextcloud rechaza las subidas); firmas viejas, poca RAM o disco lleno son aviso.
const DRIVE_GRAVE = /^ClamAV$/;
async function grupoDrive() {
  const chequeos = [];
  try {
    const h = await drive.salud();
    chequeos.push(c('ok', 'Agente de alta', `responde · versión ${h.version || '?'}`));
  } catch (e) {
    return { id: 'drive', nombre: 'HEPTA Drive', enlace: '#/servicios/drive', chequeos: [c('falla', 'Agente de alta', motivo(e))] };
  }
  try {
    const s = await drive.saludVm();
    for (const x of s.chequeos || []) chequeos.push(c(x.ok ? 'ok' : (DRIVE_GRAVE.test(x.nombre) ? 'falla' : 'aviso'), x.nombre, x.detalle));
  } catch (e) {
    chequeos.push(c('sin_dato', 'Salud de la VM', motivo(e)));
  }
  return { id: 'drive', nombre: 'HEPTA Drive', enlace: '#/servicios/drive', chequeos };
}

// ── Vigía: vista de afuera y respaldos ───────────────────────
async function gruposVigia() {
  const { rows } = await pool.query("SELECT recibido, datos FROM monitor_reportes WHERE origen = 'vigia'");
  const sinReporte = (det) => [
    { id: 'respaldos', nombre: 'Respaldos', chequeos: [c('sin_dato', 'Copias y retiro al NAS', det)] },
    { id: 'afuera', nombre: 'Vista de afuera', chequeos: [c('sin_dato', 'Vigía de hcsvrnd01', det)] },
  ];
  if (!rows.length) return sinReporte('el vigía todavía no reportó a este panel');
  const { recibido, datos } = rows[0];
  const min = (Date.now() - new Date(recibido).getTime()) / 60000;
  const lista = Array.isArray(datos && datos.chequeos) ? datos.chequeos : [];
  const viejo = min > VIGIA_VIEJO_MIN;
  const vigia = c(viejo ? 'aviso' : 'ok', 'Vigía de hcsvrnd01',
    viejo ? `último reporte hace ${Math.round(min)} min: puede estar caído hcsvrnd01 o su cron` : `reportó hace ${Math.max(0, Math.round(min))} min`);
  const conv = (x) => c(x.ok ? 'ok' : 'falla', x.nombre, x.ok ? (x.destino || '') : (x.motivo || 'falla'));
  const resp = lista.filter(x => x.id === 'respaldos').map(x => c(x.ok ? 'ok' : 'falla', 'Copias y retiro al NAS',
    x.ok ? 'sin alertas · última copia al NAS de menos de 4 h' : (x.motivo || 'falla')));
  return [
    { id: 'respaldos', nombre: 'Respaldos', chequeos: [...(resp.length ? resp : [c('sin_dato', 'Copias y retiro al NAS', 'el reporte no trae respaldos')]), ...(viejo ? [vigia] : [])] },
    { id: 'afuera', nombre: 'Vista de afuera', nota: 'Lo que ve el vigía de hcsvrnd01 a través de Cloudflare y el perimetral, como un cliente.',
      chequeos: [vigia, ...lista.filter(x => x.id !== 'respaldos').map(conv)] },
  ];
}

// ── Junta todo ───────────────────────────────────────────────
async function seguro(nombre, id, fn) {
  try { return await fn(); }
  catch (e) {
    console.error(`[estado ${id}]`, e.message);
    return { id, nombre, chequeos: [c('sin_dato', 'Revisión', `no se pudo revisar: ${motivo(e)}`)] };
  }
}

async function revisar() {
  const t = Date.now();
  const [erp, mail, drv, vigia] = await Promise.all([
    seguro('HEPTA ERP', 'erp', grupoErp),
    seguro('HEPTA Mail', 'mail', grupoMail),
    seguro('HEPTA Drive', 'drive', grupoDrive),
    seguro('Vigía', 'vigia', gruposVigia),
  ]);
  const grupos = [erp, mail, drv, ...(Array.isArray(vigia) ? vigia : [vigia])].map(g => ({
    ...g, estado: peor(g.chequeos.map(x => x.estado)) }));
  const cuenta = { ok: 0, aviso: 0, falla: 0, sin_dato: 0 };
  for (const g of grupos) cuenta[g.estado]++;
  return { revisado: new Date().toISOString(), duracion_ms: Date.now() - t, estado: peor(grupos.map(g => g.estado)), cuenta, grupos };
}

let ultimo = null, enCurso = null;
async function estado({ fresco = false } = {}) {
  const edad = ultimo ? Date.now() - new Date(ultimo.revisado).getTime() : Infinity;
  if (ultimo && edad < (fresco ? MINIMO_MS : CACHE_MS)) return ultimo;
  if (!enCurso) enCurso = revisar().then(r => { ultimo = r; return r; }).finally(() => { enCurso = null; });
  return enCurso;
}

// ── Reporte del vigía ────────────────────────────────────────
// Se guarda solo el último, saneado: tipos conocidos y textos cortos (no confiar en lo que llega por la red).
function sanearReporte(cuerpo) {
  const lista = Array.isArray(cuerpo && cuerpo.chequeos) ? cuerpo.chequeos.slice(0, 50) : null;
  if (!lista) return null;
  const txt = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').slice(0, n);
  return { chequeos: lista.map(x => ({ id: txt(x.id, 120), nombre: txt(x.nombre, 80), destino: txt(x.destino, 160), ok: x.ok === true, motivo: txt(x.motivo, 300) })) };
}
async function guardarReporte(origen, cuerpo) {
  const datos = sanearReporte(cuerpo);
  if (!datos) return false;
  await pool.query(
    `INSERT INTO monitor_reportes (origen, recibido, datos) VALUES ($1, now(), $2)
     ON CONFLICT (origen) DO UPDATE SET recibido = EXCLUDED.recibido, datos = EXCLUDED.datos`, [origen, datos]);
  if (ultimo) ultimo = null;          // que el panel lo muestre en la próxima consulta
  return true;
}

module.exports = { estado, guardarReporte, _test: { peor, sanearReporte, reiniciar: () => { ultimo = null; } } };
