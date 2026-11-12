// ---------------------------------------------------------------------------
// Clientes XML-RPC de Odoo.
//
// Hay DOS Odoo y no son el mismo sistema:
//
//   odoo_tenant  Odoo 19 CE, el tenant maestro (erp.hepta.com.py, hepta_prod).
//                Manda en lo del tenant: instancias, provisioning.
//   odoo_erp     Odoo 19 Enterprise, el ERP del grupo (heptagroup).
//                Manda en lo comercial: facturas, pagos, tickets de soporte.
//
// Las credenciales salen del panel (Admin → Credenciales), cifradas en la base,
// con respaldo al .env mientras no haya ninguna cargada. Si se rota una clave
// desde el panel, el uid cacheado se descarta solo.
//
// COMPATIBILIDAD: lo que se exporta en la raíz del módulo sigue apuntando al
// TENANT, igual que antes. El portal no cambia de comportamiento por este
// archivo. El cliente del ERP se usa con `odoo.erp.*`, y recién entra en juego
// cuando los clientes tengan su billing_customer con erp_partner_id: sin ese
// enlace, pedirle facturas al ERP con un id del tenant devolvería las de otro.
// ---------------------------------------------------------------------------
const xmlrpc = require('xmlrpc');
const pool   = require('./db');
const credenciales = require('./credenciales');

const TTL_INVOICES = parseInt(process.env.ODOO_CACHE_TTL_INVOICES) || 900;
const TTL_TICKETS  = parseInt(process.env.ODOO_CACHE_TTL_TICKETS)  || 300;

function ttlFor(type) {
  if (type === 'invoices') return TTL_INVOICES;
  if (type === 'tickets')  return TTL_TICKETS;
  return 600;
}

function crearCliente(servicio, entorno) {
  // uid y credencial se cachean juntos: si cambia la credencial, el uid que
  // teníamos ya no vale.
  let _uid = null;
  let _claveUid = null;

  async function credencial() {
    const cred = await credenciales.obtener(servicio, entorno);
    const clave = `${cred.id || 'env'}:${cred.usuario}:${(cred.secreto || '').slice(-6)}`;
    if (clave !== _claveUid) { _uid = null; _claveUid = clave; }
    return cred;
  }

  function makeClient(baseUrl, ruta) {
    const url = new URL(baseUrl);
    const opts = {
      host: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: ruta,
    };
    return url.protocol === 'https:'
      ? xmlrpc.createSecureClient(opts)
      : xmlrpc.createClient(opts);
  }

  function call(baseUrl, ruta, metodo, params) {
    return new Promise((resolve, reject) => {
      makeClient(baseUrl, ruta).methodCall(metodo, params, (err, val) => {
        if (err) return reject(err);
        resolve(val);
      });
    });
  }

  async function getUid() {
    const cred = await credencial();
    if (_uid) return _uid;
    _uid = await call(cred.base_url, '/xmlrpc/2/common', 'authenticate',
      [cred.db_name, cred.usuario, cred.secreto, {}]);
    if (!_uid) {
      throw new Error(
        `Odoo (${servicio}) rechazó a «${cred.usuario}». Si el usuario tiene 2FA, ` +
        'la clave tiene que ser una API key. Revisá Admin → Credenciales.');
    }
    return _uid;
  }

  // Llamada cruda a execute_kw. Útil para create/write, no solo lectura.
  async function ejecutar(modelo, metodo, args = [], kwargs = {}) {
    const cred = await credencial();
    const uid = await getUid();
    return call(cred.base_url, '/xmlrpc/2/object', 'execute_kw',
      [cred.db_name, uid, cred.secreto, modelo, metodo, args, kwargs]);
  }

  async function odooSearch(model, domain, fields, opts = {}) {
    return ejecutar(model, 'search_read', [domain], {
      fields,
      limit: opts.limit || 100,
      order: opts.order || 'id desc',
    });
  }

  // ── Cache ──────────────────────────────────────────────────
  // El tipo se prefija con el servicio para que los dos Odoo no se pisen las
  // filas de odoo_cache. El tenant mantiene los tipos sin prefijo, así lo que
  // ya está cacheado sigue sirviendo.
  function tipoCache(type) {
    return servicio === 'odoo_tenant' ? type : `${servicio}:${type}`;
  }

  async function getCached(partnerId, type) {
    const { rows } = await pool.query(
      `SELECT payload FROM odoo_cache
        WHERE tenant_partner_id = $1 AND cache_type = $2
          AND expires_at > NOW()
        LIMIT 1`,
      [partnerId, tipoCache(type)]
    );
    return rows.length ? rows[0].payload : null;
  }

  async function setCache(partnerId, type, payload) {
    await pool.query(
      `INSERT INTO odoo_cache (tenant_partner_id, cache_type, payload, expires_at)
       VALUES ($1, $2, $3, NOW() + ($4 || ' seconds')::interval)
       ON CONFLICT DO NOTHING`,
      [partnerId, tipoCache(type), JSON.stringify(payload), ttlFor(type)]
    );
  }

  async function invalidateCache(partnerId, type) {
    await pool.query(
      `DELETE FROM odoo_cache WHERE tenant_partner_id = $1 AND cache_type = $2`,
      [partnerId, tipoCache(type)]
    );
  }

  // ── API pública ────────────────────────────────────────────
  async function getInvoices(partnerId) {
    const cached = await getCached(partnerId, 'invoices');
    if (cached) return cached;
    const data = await odooSearch(
      'account.move',
      [['partner_id', '=', partnerId], ['move_type', '=', 'out_invoice']],
      ['name', 'invoice_date', 'invoice_date_due', 'amount_total', 'payment_state', 'state']
    );
    await setCache(partnerId, 'invoices', data);
    return data;
  }

  async function getTickets(partnerId) {
    const cached = await getCached(partnerId, 'tickets');
    if (cached) return cached;
    const data = await odooSearch(
      'helpdesk.ticket',
      [['partner_id', '=', partnerId]],
      ['name', 'stage_id', 'priority', 'create_date', 'user_id', 'description']
    );
    await setCache(partnerId, 'tickets', data);
    return data;
  }

  async function getPartnerInfo(partnerId) {
    const cached = await getCached(partnerId, 'crm_info');
    if (cached) return cached;
    const [data] = await odooSearch(
      'res.partner',
      [['id', '=', partnerId]],
      ['name', 'email', 'phone', 'city', 'vat', 'comment']
    );
    if (data) await setCache(partnerId, 'crm_info', data);
    return data || null;
  }

  async function crearTicket(partnerId, name, description) {
    const id = await ejecutar('helpdesk.ticket', 'create',
      [{ name, description: description || '', partner_id: partnerId }]);
    await invalidateCache(partnerId, 'tickets');
    return id;
  }

  return {
    servicio,
    getUid, ejecutar, odooSearch,
    getInvoices, getTickets, getPartnerInfo, crearTicket,
    getCached, setCache, invalidateCache,
  };
}

const tenant = crearCliente('odoo_tenant');
const erp    = crearCliente('odoo_erp');

// La raíz sigue siendo el tenant: `odoo.getInvoices(...)` hace hoy lo mismo que
// hacía antes de este cambio.
module.exports = { ...tenant, tenant, erp, crearCliente };
