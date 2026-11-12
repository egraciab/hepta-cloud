// ---------------------------------------------------------------------------
// Resolución de credenciales de integración.
//
// Busca la credencial activa de (servicio, entorno) en la base y la descifra.
// Si no hay ninguna cargada, cae al .env, así nada deja de funcionar mientras
// se migra la configuración al panel.
//
// Cachea en memoria 60 segundos: el portal pega muchas veces seguidas y no
// tiene sentido descifrar en cada request. `invalidar()` lo limpia cuando se
// rota una clave desde el panel.
// ---------------------------------------------------------------------------
const pool = require('./db');
const { descifrar } = require('./secretos');

const TTL_MS = 60 * 1000;
const cache = new Map();   // "servicio:entorno" -> { valor, hasta }

const ENTORNO_POR_DEFECTO = process.env.HEPTA_ENTORNO || 'prod';

// Respaldo desde el .env, para no depender de que el panel ya esté cargado.
const RESPALDO_ENV = {
  odoo_tenant: {
    base_url: process.env.ODOO_URL,
    db_name:  process.env.ODOO_DB,
    usuario:  process.env.ODOO_USER,
    secreto:  process.env.ODOO_PASSWORD,
  },
  odoo_erp: {
    base_url: process.env.ODOO_ERP_URL,
    db_name:  process.env.ODOO_ERP_DB,
    usuario:  process.env.ODOO_ERP_USER,
    secreto:  process.env.ODOO_ERP_KEY,
  },
  wisphub: {
    base_url: process.env.WISPHUB_URL,
    secreto:  process.env.WISPHUB_KEY,
  },
};

async function obtener(servicio, entorno = ENTORNO_POR_DEFECTO) {
  const clave = `${servicio}:${entorno}`;
  const guardada = cache.get(clave);
  if (guardada && guardada.hasta > Date.now()) return guardada.valor;

  let valor = null;
  try {
    const { rows } = await pool.query(
      `SELECT id, base_url, db_name, usuario, secreto, expira_el
         FROM integration_credentials
        WHERE servicio = $1 AND entorno = $2 AND activo
        LIMIT 1`,
      [servicio, entorno]
    );
    if (rows[0]) {
      valor = {
        id:        rows[0].id,
        base_url:  rows[0].base_url,
        db_name:   rows[0].db_name,
        usuario:   rows[0].usuario,
        secreto:   descifrar(rows[0].secreto),
        expira_el: rows[0].expira_el,
        origen:    'base',
      };
    }
  } catch (err) {
    // Si la tabla todavía no existe o el descifrado falla, se avisa y se sigue
    // con el .env: una credencial ilegible no debe tumbar el portal.
    console.error('[credenciales] %s/%s: %s', servicio, entorno, err.message);
  }

  if (!valor) {
    const env = RESPALDO_ENV[servicio];
    if (env && env.secreto) {
      valor = { ...env, id: null, expira_el: null, origen: 'env' };
    }
  }

  if (!valor) {
    throw new Error(
      `No hay credencial para ${servicio}/${entorno}: cargala en Admin → Credenciales.`
    );
  }

  cache.set(clave, { valor, hasta: Date.now() + TTL_MS });
  return valor;
}

function invalidar(servicio, entorno) {
  if (!servicio) return cache.clear();
  if (entorno) return cache.delete(`${servicio}:${entorno}`);
  for (const clave of cache.keys()) {
    if (clave.startsWith(`${servicio}:`)) cache.delete(clave);
  }
}

module.exports = { obtener, invalidar, ENTORNO_POR_DEFECTO };
