// ---------------------------------------------------------------------------
// Admin → Credenciales de integración
//
// Se monta desde admin.routes.js, que ya aplica requireAuth + requireAdmin:
//     router.use('/credentials', require('./credentials.routes'));
//
// Reglas:
// - El secreto NUNCA se devuelve. Ni al crear, ni al listar, ni al probar.
//   Solo viajan los últimos 4 caracteres, para reconocerla en pantalla.
// - Crear una credencial para un (servicio, entorno) que ya tiene una activa
//   es una ROTACIÓN: la vieja queda inactiva y la nueva la referencia.
// - Escribir y borrar es solo godmode. Listar y probar, cualquier admin.
// ---------------------------------------------------------------------------
const router = require('express').Router();
const xmlrpc = require('xmlrpc');
const pool   = require('../config/db');
const { requireGodmode } = require('../middleware/auth');
const { cifrar, ultimos4 } = require('../config/secretos');
const credenciales = require('../config/credenciales');

const DIAS_AVISO = 15;
const DIAS_VIGENCIA_DEFECTO = 90;

const CAMPOS = `id, servicio, entorno, etiqueta, base_url, db_name, usuario,
                secreto_ultimos4, expira_el, activo, reemplaza_a,
                ultima_prueba_el, ultima_prueba_ok, ultimo_error,
                notas, creado_por, created_at, updated_at`;

function conEstado(fila) {
  let dias = null;
  if (fila.expira_el) {
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    dias = Math.round((new Date(fila.expira_el) - hoy) / 86400000);
  }
  return {
    ...fila,
    dias_para_vencer: dias,
    vencida:     dias !== null && dias < 0,
    por_vencer:  dias !== null && dias >= 0 && dias <= DIAS_AVISO,
  };
}

// ── Listado ──────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${CAMPOS} FROM integration_credentials
        ORDER BY servicio, entorno, activo DESC, created_at DESC`
    );
    res.json({ success: true, data: rows.map(conEstado) });
  } catch (err) {
    console.error('[admin/credentials GET]', err.message);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

// ── Alertas para el banner del dashboard ─────────────────────
router.get('/alertas', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${CAMPOS} FROM integration_credentials
        WHERE activo AND expira_el IS NOT NULL
          AND expira_el <= CURRENT_DATE + $1::int
        ORDER BY expira_el`,
      [DIAS_AVISO]
    );
    res.json({ success: true, data: rows.map(conEstado) });
  } catch (err) {
    console.error('[admin/credentials alertas]', err.message);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

// ── Alta y rotación ──────────────────────────────────────────
router.post('/', requireGodmode, async (req, res) => {
  const { servicio, entorno, etiqueta, base_url, db_name, usuario,
          secreto, expira_el, notas } = req.body;

  if (!servicio || !entorno || !secreto) {
    return res.status(400).json({
      success: false, error: 'Servicio, entorno y clave son requeridos' });
  }

  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');

    // La activa anterior del mismo servicio/entorno pasa a inactiva. No se
    // borra: queda como historial de qué clave estuvo puesta y hasta cuándo.
    const { rows: previas } = await cliente.query(
      `UPDATE integration_credentials SET activo = false
        WHERE servicio = $1 AND entorno = $2 AND activo
        RETURNING id`,
      [servicio, entorno]
    );

    const vence = expira_el || null;
    const { rows } = await cliente.query(
      `INSERT INTO integration_credentials
         (servicio, entorno, etiqueta, base_url, db_name, usuario,
          secreto, secreto_ultimos4, expira_el, reemplaza_a, notas, creado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
               COALESCE($9::date, CURRENT_DATE + $10::int), $11, $12, $13)
       RETURNING ${CAMPOS}`,
      [servicio, entorno, etiqueta || null, base_url || null, db_name || null,
       usuario || null, cifrar(secreto), ultimos4(secreto), vence,
       DIAS_VIGENCIA_DEFECTO, previas[0] ? previas[0].id : null,
       notas || null, req.user.id]
    );

    await cliente.query('COMMIT');
    credenciales.invalidar(servicio, entorno);
    res.json({ success: true, data: conEstado(rows[0]) });
  } catch (err) {
    await cliente.query('ROLLBACK');
    console.error('[admin/credentials POST]', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    cliente.release();
  }
});

// ── Editar metadatos (nunca el secreto: eso es una rotación) ──
router.put('/:id', requireGodmode, async (req, res) => {
  const { etiqueta, notas, expira_el, activo, base_url, db_name, usuario } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE integration_credentials SET
         etiqueta  = COALESCE($1, etiqueta),
         notas     = COALESCE($2, notas),
         expira_el = COALESCE($3::date, expira_el),
         activo    = COALESCE($4::boolean, activo),
         base_url  = COALESCE($5, base_url),
         db_name   = COALESCE($6, db_name),
         usuario   = COALESCE($7, usuario)
       WHERE id = $8 RETURNING ${CAMPOS}`,
      [etiqueta ?? null, notas ?? null, expira_el ?? null, activo ?? null,
       base_url ?? null, db_name ?? null, usuario ?? null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, error: 'No encontrada' });
    credenciales.invalidar(rows[0].servicio, rows[0].entorno);
    res.json({ success: true, data: conEstado(rows[0]) });
  } catch (err) {
    console.error('[admin/credentials PUT]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Borrar (solo inactivas, para no perder el historial en uso) ──
router.delete('/:id', requireGodmode, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM integration_credentials WHERE id = $1 AND NOT activo RETURNING id, servicio, entorno',
      [req.params.id]
    );
    if (!rows[0]) {
      return res.status(400).json({
        success: false,
        error: 'No existe o está activa. Desactivala antes de borrarla.' });
    }
    credenciales.invalidar(rows[0].servicio, rows[0].entorno);
    res.json({ success: true });
  } catch (err) {
    console.error('[admin/credentials DELETE]', err.message);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

// ── Prueba de conexión ───────────────────────────────────────
function llamarXmlrpc(baseUrl, ruta, metodo, params) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl);
    const opts = {
      host: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: ruta,
    };
    const cliente = url.protocol === 'https:'
      ? xmlrpc.createSecureClient(opts)
      : xmlrpc.createClient(opts);
    cliente.methodCall(metodo, params, (err, val) => err ? reject(err) : resolve(val));
  });
}

// Los errores de Odoo llegan como un traceback de Python entero. Mostrarle eso
// a alguien que está cargando una clave no ayuda: se traduce a lo que pasó.
function traducirError(err, cred) {
  const texto = String(err && err.message ? err.message : err);
  const falla = (err && err.faultString) ? String(err.faultString) : texto;

  if (/registries\[db_name\]|KeyError|database .*does not exist|no existe la base/i.test(falla)) {
    return `La base «${cred.db_name || '(vacía)'}» no existe en ${cred.base_url}. `
         + 'Revisá que la URL y el nombre de la base sean del mismo servidor.';
  }
  if (/AccessDenied|Access denied|Invalid login|Wrong login/i.test(falla)) {
    return 'Usuario o clave rechazados por Odoo.';
  }
  if (/ECONNREFUSED/.test(texto)) {
    return `No hay nada escuchando en ${cred.base_url}. ¿Puerto correcto? ¿Firewall?`;
  }
  if (/ETIMEDOUT|ESOCKETTIMEDOUT|EHOSTUNREACH|ENETUNREACH/.test(texto)) {
    return `No se llega a ${cred.base_url} desde este servidor (tiempo agotado).`;
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(texto)) {
    return `No se pudo resolver el nombre de ${cred.base_url}.`;
  }
  if (/certificate|SSL|TLS/i.test(texto)) {
    return `Problema de certificado con ${cred.base_url}.`;
  }
  // Desconocido: la primera línea útil, no las cuarenta del traceback.
  const primera = falla.split('\n').map(l => l.trim()).filter(Boolean).pop() || texto;
  return primera.slice(0, 300);
}

async function probarOdoo(cred) {
  if (!cred.base_url) throw new Error('Falta la URL.');
  if (!cred.db_name)  throw new Error('Falta el nombre de la base de datos.');
  if (!cred.usuario)  throw new Error('Falta el usuario.');

  const version = await llamarXmlrpc(cred.base_url, '/xmlrpc/2/common', 'version', []);
  const uid = await llamarXmlrpc(cred.base_url, '/xmlrpc/2/common', 'authenticate',
    [cred.db_name, cred.usuario, cred.secreto, {}]);
  if (!uid) {
    // Con 2FA activo la contraseña no sirve: tiene que ser una API key.
    throw new Error(
      `Odoo rechazó a «${cred.usuario}» en la base «${cred.db_name}». `
      + 'Si el usuario tiene 2FA, la clave tiene que ser una API key, no la contraseña.');
  }
  const contactos = await llamarXmlrpc(cred.base_url, '/xmlrpc/2/object', 'execute_kw',
    [cred.db_name, uid, cred.secreto, 'res.partner', 'search_count', [[]]]);
  return { servidor: version.server_version, uid, contactos_visibles: contactos };
}

async function probarWisphub(cred) {
  const url = (cred.base_url || 'https://api.wisphub.net').replace(/\/$/, '') + '/api/clientes/?limit=1';
  const r = await fetch(url, { headers: { Authorization: `Api-Key ${cred.secreto}` } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const datos = await r.json();
  return { total_clientes: datos.count ?? null };
}

router.post('/:id/probar', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, servicio, entorno, base_url, db_name, usuario, secreto FROM integration_credentials WHERE id = $1',
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, error: 'No encontrada' });

    const { descifrar } = require('../config/secretos');
    const cred = { ...rows[0], secreto: descifrar(rows[0].secreto) };

    let detalle;
    try {
      detalle = cred.servicio === 'wisphub'
        ? await probarWisphub(cred)
        : await probarOdoo(cred);
    } catch (err) {
      const mensaje = traducirError(err, cred);
      await pool.query(
        `UPDATE integration_credentials
            SET ultima_prueba_el = NOW(), ultima_prueba_ok = false, ultimo_error = $1
          WHERE id = $2`,
        [mensaje, cred.id]
      );
      return res.json({ success: false, error: mensaje });
    }

    await pool.query(
      `UPDATE integration_credentials
          SET ultima_prueba_el = NOW(), ultima_prueba_ok = true, ultimo_error = NULL
        WHERE id = $1`,
      [cred.id]
    );
    res.json({ success: true, data: detalle });
  } catch (err) {
    console.error('[admin/credentials probar]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
