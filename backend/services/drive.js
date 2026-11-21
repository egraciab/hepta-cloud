// ============================================================
//  HEPTA CLOUD — HEPTA Drive (Nextcloud por cliente)
//
//  El alta la hace el agente de la VM hepta-drive (infra/hepta-drive/agente). Acá se valida el
//  pedido, se registra a quién pertenece el servicio (client_services), se pide el alta y se
//  sigue el trabajo (provisioning_jobs) aunque el Admin cierre la ventana.
//
//  Conexión: site_config drive_api_url, drive_api_key y drive_api_cert (certificado propio del
//  agente; es el único que se acepta). Se cargan con backend/scripts/drive_configurar.js.
//
//  Secretos del alta: no pasan por la base. Se piden al agente en el momento de bajarlos.
// ============================================================
const https = require('https');
const http  = require('http');
const dns   = require('dns').promises;
const { URL } = require('url');
const pool  = require('../config/db');

const SLUG    = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
const CORREO  = /^[a-z0-9._+-]{1,64}@[a-z0-9.-]{3,190}$/;
const NOMBRE  = /^[^"'\\`$|<>\r\n]{1,80}$/;
const UUID    = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CADA_MS   = 8000;
const ESPERA_MS = 30 * 60 * 1000;
const siguiendo = new Set();          // trabajos que este proceso ya está siguiendo

class ErrorDrive extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra || null; }
}

async function config() {
  const { rows } = await pool.query(
    "SELECT key, value FROM site_config WHERE key IN ('drive_api_url','drive_api_key','drive_api_cert')");
  const c = Object.fromEntries(rows.map(r => [r.key, r.value]));
  if (!c.drive_api_url || !c.drive_api_key || !c.drive_api_cert)
    throw new ErrorDrive(503, 'HEPTA Drive no está configurado en este servidor (falta cargar la conexión con el agente)');
  return c;
}

// Pedido al agente. Solo se acepta su certificado: cualquier otro corta la conexión antes de mandar la clave.
async function pedir(method, ruta, cuerpo, { timeoutMs = 20000 } = {}) {
  const c = await config();
  const u = new URL(c.drive_api_url + ruta);
  const payload = cuerpo === undefined ? null : JSON.stringify(cuerpo);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method,
      ca: c.drive_api_cert, rejectUnauthorized: true,
      headers: {
        'X-API-Key': c.drive_api_key,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, res => {
      let texto = '';
      res.setEncoding('utf8');
      res.on('data', d => { texto += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(texto); } catch (e) { /* no era JSON (el paquete de secretos es CSV) */ }
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, texto, json });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('el agente de HEPTA Drive no respondió a tiempo')));
    req.on('error', e => reject(new ErrorDrive(502, `No se pudo hablar con el agente de HEPTA Drive: ${e.message}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Dirección pública: el vhost lo crea la API del NGINX perimetral ──
async function perimetral(method, ruta, cuerpo, esperaMs = 50000) {
  const { rows } = await pool.query("SELECT key, value FROM site_config WHERE key IN ('perimetral_api_url','perimetral_api_key')");
  const c = Object.fromEntries(rows.map(r => [r.key, r.value]));
  if (!c.perimetral_api_url || !c.perimetral_api_key) throw new ErrorDrive(503, 'La API del NGINX perimetral no está configurada');
  const u = new URL(c.perimetral_api_url.replace(/\/+$/, '') + ruta);
  const payload = cuerpo === undefined ? null : JSON.stringify(cuerpo);
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname, method,
      headers: { 'X-API-Key': c.perimetral_api_key, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) },
    }, res => {
      let texto = '';
      res.setEncoding('utf8');
      res.on('data', d => { texto += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(texto); } catch (e) { /* sin JSON */ }
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, json });
      });
    });
    req.setTimeout(esperaMs, () => req.destroy(new Error('el NGINX perimetral no respondió a tiempo')));
    req.on('error', e => reject(new ErrorDrive(502, `No se pudo hablar con el NGINX perimetral: ${e.message}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

// Crea (o repite) el vhost de una instancia y deja anotado si quedó publicada.
async function publicarVhost(slug, puerto) {
  let error = null;
  try {
    const r = await perimetral('POST', '/drive-vhost', { slug, port: Number(puerto) });
    if (!r.ok) {
      const d = r.json && r.json.detail;
      error = r.status === 404 ? 'la API del NGINX todavía no tiene la función de publicar un drive (falta actualizarla)'
        : (typeof d === 'string' ? d : `respuesta ${r.status} del NGINX perimetral`);
    }
  } catch (e) { error = e.message; }
  await pool.query(
    `UPDATE client_services SET params = jsonb_set(params, '{publicado}', $2::jsonb), updated_at = NOW()
      WHERE service = 'drive' AND slug = $1`, [slug, error ? 'false' : 'true']);
  if (error) throw new ErrorDrive(502, error);
  return true;
}

// Botón "Publicar": para reintentar, o para una instancia creada por consola.
async function publicar(slug) {
  const s = slugValido(slug);
  const r = await pedir('GET', `/clientes/${s}`, undefined, { timeoutMs: 30000 });
  if (r.status === 404) throw new ErrorDrive(404, 'No existe esa instancia');
  if (!r.ok || !r.json || !r.json.puerto) throw new ErrorDrive(502, detalle(r));
  if (r.json.fqdn !== `${s}.drive.hepta.com.py`) throw new ErrorDrive(409, 'Esta instancia tiene una dirección propia: su vhost se maneja aparte');
  await pool.query(
    `INSERT INTO client_services (service, slug, fqdn, port, status) VALUES ('drive', $1, $2, $3, 'active')
     ON CONFLICT (service, slug) DO NOTHING`, [s, r.json.fqdn, r.json.puerto]);
  await publicarVhost(s, r.json.puerto);
  return { slug: s, fqdn: r.json.fqdn };
}

const detalle = r => (r.json && r.json.detail) || `respuesta ${r.status} del agente`;

// ── Pedido ───────────────────────────────────────────────────
function slugValido(slug) {
  const s = String(slug || '').trim().toLowerCase();
  if (!SLUG.test(s) || s.includes('--'))
    throw new ErrorDrive(422, 'Nombre inválido: minúsculas, números y guiones, de 3 a 32 caracteres, empezando con una letra');
  return s;
}
function entero(v, nombre, min, max, defecto) {
  if (v === undefined || v === null || v === '') return defecto;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new ErrorDrive(422, `${nombre} tiene que ser un número entre ${min} y ${max}`);
  return n;
}
function pedidoValido(b) {
  b = b || {};
  const slug = slugValido(b.slug);
  const cuota_gb  = entero(b.cuota_gb, 'La cuota por usuario', 1, 9999, 5);
  const equipo_gb = entero(b.equipo_gb, 'La carpeta de equipo', 0, 99999, 0);
  const usuarios = usuariosValidos(b.usuarios, cuota_gb);
  const cliente = b.billing_customer_id ? String(b.billing_customer_id) : null;
  if (cliente && !UUID.test(cliente)) throw new ErrorDrive(422, 'Cliente inválido');
  return { slug, cuota_gb, equipo_gb, usuarios, billing_customer_id: cliente };
}
function usuariosValidos(lista, cuota_gb) {
  if (!Array.isArray(lista) || !lista.length) throw new ErrorDrive(422, 'Cargá al menos un usuario');
  if (lista.length > 200) throw new ErrorDrive(422, 'Hasta 200 usuarios por pedido');
  const vistos = new Set();
  return lista.map((u, i) => {
    const correo = String((u && u.correo) || '').trim().toLowerCase();
    const nombre = String((u && u.nombre) || '').trim();
    if (!CORREO.test(correo)) throw new ErrorDrive(422, `Usuario ${i + 1}: correo inválido`);
    if (!NOMBRE.test(nombre)) throw new ErrorDrive(422, `Usuario ${i + 1} (${correo}): falta el nombre o tiene caracteres no permitidos`);
    if (vistos.has(correo)) throw new ErrorDrive(422, `El correo ${correo} está repetido`);
    vistos.add(correo);
    return { correo, nombre, cuota_gb: entero(u.cuota_gb, `Usuario ${i + 1}: la cuota`, 1, 9999, cuota_gb) };
  });
}
const paraAgente = p => ({ slug: p.slug, cuota_gb: p.cuota_gb, equipo_gb: p.equipo_gb, usuarios: p.usuarios });

// ── Consultas ────────────────────────────────────────────────
async function salud() {
  const r = await pedir('GET', '/health', undefined, { timeoutMs: 6000 });
  if (!r.ok) throw new ErrorDrive(502, detalle(r));
  return r.json;
}

// Lo que hay en la VM (la verdad sobre qué existe) más lo que sabe HEPTA Cloud (de quién es, quién lo pidió).
async function listar() {
  reanudar().catch(() => {});
  const { rows } = await pool.query(
    `SELECT cs.id, cs.slug, cs.fqdn, cs.port, cs.status, cs.params, cs.created_at, cs.billing_customer_id,
            bc.razon_social AS cliente, u.email AS creado_por,
            (SELECT j.id FROM provisioning_jobs j WHERE j.client_service_id = cs.id ORDER BY j.id DESC LIMIT 1) AS ultimo_trabajo
       FROM client_services cs
       LEFT JOIN billing_customers bc ON bc.id = cs.billing_customer_id
       LEFT JOIN users u ON u.id = cs.created_by
      WHERE cs.service = 'drive' AND cs.status <> 'cancelled'
      ORDER BY cs.slug`);
  let enVm = [], agente = null;
  try {
    const r = await pedir('GET', '/clientes', undefined, { timeoutMs: 30000 });
    if (!r.ok) throw new ErrorDrive(502, detalle(r));
    enVm = (r.json && r.json.clientes) || [];
  } catch (e) { agente = e.message; }
  const porSlug = new Map(rows.map(r => [r.slug, r]));
  const salida = enVm.map(v => ({ ...v, registro: porSlug.get(v.slug) || null }));
  for (const r of rows) if (!enVm.some(v => v.slug === r.slug)) salida.push({ slug: r.slug, fqdn: r.fqdn, solo_registro: true, registro: r });
  return { instancias: salida, agente_error: agente };
}

async function validar(cuerpo) {
  const p = pedidoValido(cuerpo);
  const r = await pedir('POST', '/validar', paraAgente(p), { timeoutMs: 30000 });
  if (!r.json || r.json.ok === undefined) throw new ErrorDrive(r.status === 422 ? 422 : 502, detalle(r));
  return r.json;
}

// ── Alta ─────────────────────────────────────────────────────
async function crear(cuerpo, actorId) {
  const p = pedidoValido(cuerpo);
  if (p.billing_customer_id) {
    const { rows } = await pool.query('SELECT 1 FROM billing_customers WHERE id = $1', [p.billing_customer_id]);
    if (!rows.length) throw new ErrorDrive(404, 'Ese cliente no existe');
  }
  const { rows: ya } = await pool.query(
    "SELECT id, status FROM client_services WHERE service = 'drive' AND slug = $1", [p.slug]);
  if (ya[0] && ya[0].status === 'active') throw new ErrorDrive(409, `Ya hay una instancia activa con el nombre «${p.slug}»`);
  const { rows: abiertos } = await pool.query("SELECT 1 FROM provisioning_jobs WHERE status = 'running' LIMIT 1");
  if (abiertos.length) throw new ErrorDrive(409, 'Ya hay un alta en curso. Esperá a que termine.');

  const v = await pedir('POST', '/validar', paraAgente(p), { timeoutMs: 30000 });
  if (!v.json || v.json.ok === undefined) throw new ErrorDrive(v.status === 422 ? 422 : 502, detalle(v));
  if (!v.json.ok) throw new ErrorDrive(422, `No se puede dar de alta: ${(v.json.errores || []).join('; ')}`, v.json);

  const r = await pedir('POST', '/crear', paraAgente(p), { timeoutMs: 30000 });
  if (r.status !== 202 || !r.json || !r.json.trabajo) throw new ErrorDrive(r.status === 409 ? 409 : 502, detalle(r));

  // El alta ya arrancó en la VM: a partir de acá nada puede dejarla sin registro
  const params = { cuota_gb: p.cuota_gb, equipo_gb: p.equipo_gb, usuarios: p.usuarios };
  const { rows: cs } = await pool.query(
    `INSERT INTO client_services (service, slug, billing_customer_id, fqdn, status, params, created_by)
     VALUES ('drive', $1, $2, $3, 'creating', $4, $5)
     ON CONFLICT (service, slug) DO UPDATE
       SET status = 'creating', params = EXCLUDED.params, updated_at = NOW(),
           billing_customer_id = COALESCE(EXCLUDED.billing_customer_id, client_services.billing_customer_id)
     RETURNING id`,
    [p.slug, p.billing_customer_id, v.json.fqdn || null, JSON.stringify(params), actorId || null]);
  const { rows: j } = await pool.query(
    `INSERT INTO provisioning_jobs (client_service_id, action, remote_job_id, status, step, actor_id)
     VALUES ($1, 'create', $2, 'running', 'En cola', $3) RETURNING id`,
    [cs[0].id, r.json.trabajo, actorId || null]);
  seguir(j[0].id);
  return { trabajo: j[0].id, slug: p.slug, avisos: v.json.avisos || [] };
}

async function cerrar(jobId, ok, paso, error, resultado) {
  const { rows } = await pool.query(
    `UPDATE provisioning_jobs SET status = $2, step = COALESCE($3, step), error = $4, finished_at = NOW()
      WHERE id = $1 AND status = 'running' RETURNING client_service_id, action`,
    [jobId, ok ? 'done' : 'failed', paso || null, error || null]);
  if (!rows.length || rows[0].action !== 'create') return;   // sumar usuarios no cambia el estado de la instancia
  await pool.query(
    `UPDATE client_services SET status = $2, port = COALESCE($3, port), fqdn = COALESCE($4, fqdn), updated_at = NOW() WHERE id = $1`,
    [rows[0].client_service_id, ok ? 'active' : 'failed', (resultado && resultado.puerto) || null, (resultado && resultado.fqdn) || null]);
}

// Consulta al agente y deja el trabajo al día. Devuelve true si ya terminó.
async function actualizar(jobId) {
  const { rows } = await pool.query('SELECT remote_job_id, status, action FROM provisioning_jobs WHERE id = $1', [jobId]);
  if (!rows[0] || rows[0].status !== 'running') return true;
  if (!rows[0].remote_job_id) {
    // Un trabajo que corre entero acá (dominio propio). Si este proceso no lo tiene, quedó de antes de un reinicio.
    if (locales.has(jobId)) return false;
    await cerrar(jobId, false, null, 'Se interrumpió por un reinicio del servidor. Se puede repetir: sigue desde donde quedó.');
    return true;
  }
  const r = await pedir('GET', `/trabajos/${rows[0].remote_job_id}`);
  if (r.status === 404) { await cerrar(jobId, false, null, 'El agente ya no tiene este trabajo. Revisar el estado de la instancia en la VM.'); return true; }
  if (!r.ok || !r.json) throw new ErrorDrive(502, detalle(r));
  const t = r.json;
  if (t.estado === 'en_curso') {
    await pool.query("UPDATE provisioning_jobs SET step = $2 WHERE id = $1 AND status = 'running'", [jobId, String(t.paso || '').slice(0, 200)]);
    return false;
  }
  if (t.estado === 'listo' && rows[0].action === 'create') {
    // La instancia ya está creada. Falta publicarla; si el NGINX no responde, el alta vale igual y queda el aviso.
    await pool.query("UPDATE provisioning_jobs SET step = 'Publicando la dirección' WHERE id = $1 AND status = 'running'", [jobId]);
    let aviso = null;
    try {
      if (!t.resultado || !t.resultado.puerto) throw new Error('el agente no informó el puerto');
      await publicarVhost(t.slug, t.resultado.puerto);
    } catch (e) { aviso = `La instancia está creada, pero la dirección no quedó publicada: ${e.message}`.slice(0, 500); }
    await cerrar(jobId, true, 'Listo', aviso, t.resultado);
  }
  else if (t.estado === 'listo') await cerrar(jobId, true, 'Listo', null, t.resultado);
  else await cerrar(jobId, false, String(t.paso || '').slice(0, 200), String(t.error || 'No terminó bien').slice(0, 500));
  return true;
}

function seguir(jobId) {
  if (siguiendo.has(jobId)) return;
  siguiendo.add(jobId);
  const inicio = Date.now();
  let fallas = 0;
  const vuelta = async () => {
    try {
      if (await actualizar(jobId)) { siguiendo.delete(jobId); return; }
      fallas = 0;
    } catch (e) {
      // El agente puede no responder un momento; el alta sigue en la VM
      if (++fallas % 10 === 1) console.error(`[drive] trabajo ${jobId}: ${e.message}`);
    }
    if (Date.now() - inicio > ESPERA_MS) {
      siguiendo.delete(jobId);
      await cerrar(jobId, false, null, 'Tardó más de 30 minutos. Revisar la instancia en la VM.').catch(() => {});
      return;
    }
    setTimeout(vuelta, CADA_MS).unref();
  };
  setTimeout(vuelta, 2000).unref();
}

// Trabajos que quedaron abiertos (por ejemplo, si el backend se reinició durante un alta)
async function reanudar() {
  const { rows } = await pool.query("SELECT id FROM provisioning_jobs WHERE status = 'running'");
  rows.forEach(r => seguir(r.id));
}

async function verTrabajo(jobId) {
  const { rows } = await pool.query(
    `SELECT j.id, j.action, j.status, j.step, j.error, j.started_at, j.finished_at, cs.slug, cs.fqdn, cs.port
       FROM provisioning_jobs j JOIN client_services cs ON cs.id = j.client_service_id WHERE j.id = $1`, [jobId]);
  if (!rows[0]) return null;
  if (rows[0].status === 'running') seguir(rows[0].id);
  return rows[0];
}

// ── Usuarios de una instancia ────────────────────────────────
async function usuarios(slug) {
  const s = slugValido(slug);
  const r = await pedir('GET', `/clientes/${s}/usuarios`, undefined, { timeoutMs: 70000 });
  if (r.status === 404) throw new ErrorDrive(404, 'No existe esa instancia');
  if (!r.ok || !r.json) throw new ErrorDrive(502, detalle(r));
  return r.json.usuarios || [];
}

// Suma usuarios a una instancia que ya existe. Nacen como usuarios comunes y reciben la invitación por correo.
async function agregarUsuarios(slug, cuerpo, actorId) {
  const s = slugValido(slug);
  const cuota_gb = entero((cuerpo || {}).cuota_gb, 'La cuota por usuario', 1, 9999, 5);
  const lista = usuariosValidos((cuerpo || {}).usuarios, cuota_gb);
  const { rows: abiertos } = await pool.query("SELECT 1 FROM provisioning_jobs WHERE status = 'running' LIMIT 1");
  if (abiertos.length) throw new ErrorDrive(409, 'Hay otro trabajo en curso. Esperá a que termine.');
  const r = await pedir('POST', `/clientes/${s}/usuarios`, { cuota_gb, usuarios: lista }, { timeoutMs: 30000 });
  if (r.status !== 202 || !r.json || !r.json.trabajo)
    throw new ErrorDrive([404, 409, 422].includes(r.status) ? r.status : 502, detalle(r));
  // Una instancia creada por consola todavía no tiene registro acá: se registra ahora
  const { rows: cs } = await pool.query(
    `INSERT INTO client_services (service, slug, fqdn, status, created_by)
     VALUES ('drive', $1, $2, 'active', $3)
     ON CONFLICT (service, slug) DO UPDATE SET updated_at = NOW() RETURNING id`,
    [s, null, actorId || null]);
  const { rows: j } = await pool.query(
    `INSERT INTO provisioning_jobs (client_service_id, action, remote_job_id, status, step, actor_id)
     VALUES ($1, 'add_users', $2, 'running', 'En cola', $3) RETURNING id`,
    [cs[0].id, r.json.trabajo, actorId || null]);
  seguir(j[0].id);
  return { trabajo: j[0].id, slug: s, usuarios: lista.length };
}

// Corta o devuelve el acceso de un usuario. Sus archivos no se tocan.
async function estadoUsuario(slug, cuerpo) {
  const s = slugValido(slug);
  const usuario = String((cuerpo || {}).usuario || '').trim().toLowerCase();
  if (!CORREO.test(usuario)) throw new ErrorDrive(422, 'Usuario inválido');
  if (typeof (cuerpo || {}).activo !== 'boolean') throw new ErrorDrive(422, 'Falta indicar si queda habilitado');
  const r = await pedir('POST', `/clientes/${s}/usuarios/estado`, { usuario, activo: cuerpo.activo }, { timeoutMs: 70000 });
  if (!r.ok) throw new ErrorDrive([404, 409, 422].includes(r.status) ? r.status : 502, detalle(r));
  return { usuario, activo: cuerpo.activo };
}

// Borra a un usuario. Con transferir_a, antes pasa sus archivos a otro usuario; sin eso, se borran con él.
async function eliminarUsuario(slug, cuerpo, actorId) {
  const s = slugValido(slug);
  const usuario = String((cuerpo || {}).usuario || '').trim().toLowerCase();
  const transferir_a = String((cuerpo || {}).transferir_a || '').trim().toLowerCase() || null;
  if (!CORREO.test(usuario)) throw new ErrorDrive(422, 'Usuario inválido');
  if (transferir_a && (!CORREO.test(transferir_a) || transferir_a === usuario)) throw new ErrorDrive(422, 'El destino de los archivos tiene que ser otro usuario');
  // Sin destino los archivos se pierden: se pide escribir el correo, para que no sea un clic de más
  if (!transferir_a && String((cuerpo || {}).confirmar || '').trim().toLowerCase() !== usuario)
    throw new ErrorDrive(422, 'Para borrar a un usuario junto con sus archivos hay que escribir su correo como confirmación');
  const { rows: abiertos } = await pool.query("SELECT 1 FROM provisioning_jobs WHERE status = 'running' LIMIT 1");
  if (abiertos.length) throw new ErrorDrive(409, 'Hay otro trabajo en curso. Esperá a que termine.');
  const r = await pedir('POST', `/clientes/${s}/usuarios/eliminar`, { usuario, transferir_a }, { timeoutMs: 30000 });
  if (r.status !== 202 || !r.json || !r.json.trabajo)
    throw new ErrorDrive([404, 409, 422].includes(r.status) ? r.status : 502, detalle(r));
  const { rows: cs } = await pool.query(
    `INSERT INTO client_services (service, slug, fqdn, status, created_by)
     VALUES ('drive', $1, NULL, 'active', $2)
     ON CONFLICT (service, slug) DO UPDATE SET updated_at = NOW() RETURNING id`, [s, actorId || null]);
  const { rows: j } = await pool.query(
    `INSERT INTO provisioning_jobs (client_service_id, action, remote_job_id, status, step, actor_id)
     VALUES ($1, 'delete_user', $2, 'running', 'En cola', $3) RETURNING id`,
    [cs[0].id, r.json.trabajo, actorId || null]);
  seguir(j[0].id);
  return { trabajo: j[0].id, slug: s, usuario, transferir_a };
}

// ── Dominio propio del cliente ───────────────────────────────
// Se suma al nombre de HEPTA, que sigue andando. Cuatro pasos, todos repetibles: comprobar que el dominio ya apunta
// acá, que la instancia lo acepte, certificado y vhost en el NGINX, y recién al final usarlo como dirección principal.
const DOMINIO = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const locales = new Set();            // trabajos que corren enteros en este proceso (no los sigue el agente)

async function apuntaAca(dominio, destino) {
  const limpio = h => String(h || '').toLowerCase().replace(/\.$/, '');
  try { if ((await dns.resolveCname(dominio)).some(c => limpio(c) === destino)) return true; } catch (e) { /* sin CNAME directo */ }
  let a = [], b = [];
  try { a = await dns.resolve4(dominio); } catch (e) { return false; }
  try { b = await dns.resolve4(destino); } catch (e) { throw new ErrorDrive(502, `No pude resolver ${destino} desde este servidor`); }
  return a.length > 0 && a.every(ip => b.includes(ip));
}

async function dominioPropio(slug, cuerpo, actorId) {
  const s = slugValido(slug);
  const dominio = String((cuerpo || {}).dominio || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (dominio.length > 253 || !DOMINIO.test(dominio)) throw new ErrorDrive(422, 'Dominio inválido: va el nombre completo, por ejemplo drive.cliente.com.py');
  if (dominio.endsWith('hepta.com.py')) throw new ErrorDrive(422, 'Ese nombre es de HEPTA: el dominio propio es el del cliente');
  const { rows: abiertos } = await pool.query("SELECT 1 FROM provisioning_jobs WHERE status = 'running' LIMIT 1");
  if (abiertos.length) throw new ErrorDrive(409, 'Hay otro trabajo en curso. Esperá a que termine.');
  const r = await pedir('GET', `/clientes/${s}`, undefined, { timeoutMs: 30000 });
  if (r.status === 404) throw new ErrorDrive(404, 'No existe esa instancia');
  if (!r.ok || !r.json) throw new ErrorDrive(502, detalle(r));
  const destino = `${s}.drive.hepta.com.py`;
  if (r.json.fqdn !== destino) throw new ErrorDrive(409, 'Esta instancia no nació con una dirección de HEPTA Drive: su dominio se maneja aparte');
  if (r.json.dominio && r.json.dominio !== dominio) throw new ErrorDrive(409, `Esta instancia ya tiene el dominio propio ${r.json.dominio}. Para cambiarlo, primero hay que quitarlo (por consola).`);
  if (!(await apuntaAca(dominio, destino)))
    throw new ErrorDrive(422, `${dominio} todavía no apunta a ${destino}. Hay que crear un registro CNAME y esperar a que se propague.`);

  const { rows: cs } = await pool.query(
    `INSERT INTO client_services (service, slug, fqdn, port, status, created_by) VALUES ('drive', $1, $2, $3, 'active', $4)
     ON CONFLICT (service, slug) DO UPDATE SET updated_at = NOW() RETURNING id`, [s, destino, r.json.puerto || null, actorId || null]);
  const { rows: j } = await pool.query(
    `INSERT INTO provisioning_jobs (client_service_id, action, status, step, actor_id)
     VALUES ($1, 'custom_domain', 'running', 'Preparando la instancia', $2) RETURNING id`, [cs[0].id, actorId || null]);
  const id = j[0].id;
  locales.add(id);
  const paso = t => pool.query("UPDATE provisioning_jobs SET step = $2 WHERE id = $1 AND status = 'running'", [id, t]);
  const agente = async fase => {
    const x = await pedir('POST', `/clientes/${s}/dominio`, { dominio, fase }, { timeoutMs: 250000 });
    if (!x.ok) throw new Error(detalle(x));
  };
  (async () => {
    try {
      await agente('aceptar');
      await paso('Certificado y publicación en el NGINX');
      const v = await perimetral('POST', '/drive-dominio', { slug: s, dominio }, 180000);
      if (!v.ok) {
        const d = v.json && v.json.detail;
        throw new Error(v.status === 404 ? 'la API del NGINX todavía no tiene la función de dominio propio (falta actualizarla)' : (typeof d === 'string' ? d : `respuesta ${v.status} del NGINX perimetral`));
      }
      await paso('Cambiando la dirección principal');
      await agente('principal');
      await pool.query("UPDATE client_services SET params = jsonb_set(params, '{dominio}', to_jsonb($2::text)), updated_at = NOW() WHERE id = $1", [cs[0].id, dominio]);
      await cerrar(id, true, 'Listo', null);
    } catch (e) {
      await cerrar(id, false, null, String(e.message || e).slice(0, 500)).catch(() => {});
    } finally { locales.delete(id); }
  })();
  return { trabajo: id, slug: s, dominio };
}

// ── Sobre una instancia ──────────────────────────────────────
async function verificar(slug) {
  const s = slugValido(slug);
  const r = await pedir('POST', `/clientes/${s}/verificar`, undefined, { timeoutMs: 70000 });
  if (!r.ok || !r.json) throw new ErrorDrive(502, detalle(r));
  return r.json;
}

// El paquete para KeePass. Viene del agente y se entrega tal cual: no se guarda ni se registra su contenido.
async function secretos(slug) {
  const s = slugValido(slug);
  const r = await pedir('GET', `/clientes/${s}/secretos`);
  if (r.status === 404) throw new ErrorDrive(404, 'No hay secretos pendientes de esa instancia');
  if (!r.ok) throw new ErrorDrive(502, detalle(r));
  return r.texto;
}
async function secretosGuardados(slug) {
  const s = slugValido(slug);
  const r = await pedir('POST', `/clientes/${s}/secretos/guardado`);
  if (r.status === 404) throw new ErrorDrive(404, 'No hay secretos pendientes de esa instancia');
  if (!r.ok) throw new ErrorDrive(502, detalle(r));
  return true;
}

module.exports = { ErrorDrive, salud, listar, validar, crear, verTrabajo, verificar, usuarios, agregarUsuarios, estadoUsuario, eliminarUsuario, publicar, dominioPropio, secretos, secretosGuardados, reanudar };
