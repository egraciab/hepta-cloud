// ---------------------------------------------------------------------------
// Admin → Clientes (entidades fiscales)
//
// Se monta desde admin.routes.js, que ya aplica requireAuth + requireAdmin:
//     router.use('/clients', require('./clients.routes'));
//
// Una fila de billing_customers = una entidad fiscal = un documento. NO es lo
// mismo que un usuario del portal: un login puede administrar dos empresas, y
// una empresa puede tener dos logins (el dueño y su contadora).
//
// El documento puede ser RUC o CI sola. En Paraguay la cédula no lleva dígito
// verificador; el RUC de una persona física es esa cédula + DV. Por eso el DV
// es opcional y solo se valida cuando el documento es RUC.
// ---------------------------------------------------------------------------
const router = require('express').Router();
const pool   = require('../config/db');
const { requireGodmode } = require('../middleware/auth');
const odoo   = require('../config/odoo');

const CAMPOS = `id, tipo_persona, tipo_doc, numero_doc, dv, doc_norm,
                razon_social, nombre_comercial, email, telefono,
                direccion, ciudad, departamento,
                erp_partner_id, erp_synced_at, erp_sync_state, erp_last_error,
                origen, created_at, updated_at`;

// Dígito verificador paraguayo (módulo 11). Se usa para avisar, no para
// imponer: si el cliente jura que su RUC es otro, gana el cliente, pero que
// quede constancia de que el sistema avisó.
function dvParaguayo(numero) {
  const d = String(numero || '').replace(/\D/g, '');
  let total = 0, k = 2;
  for (let i = d.length - 1; i >= 0; i--) {
    total += parseInt(d[i], 10) * k;
    k = k >= 11 ? 2 : k + 1;
  }
  const resto = total % 11;
  return resto > 1 ? 11 - resto : 0;
}

function normalizar(numero) {
  return String(numero || '').replace(/\D/g, '');
}

function validar(body) {
  const tipoDoc = (body.tipo_doc || '').toLowerCase();
  if (!['ruc', 'ci'].includes(tipoDoc)) return 'El tipo de documento debe ser RUC o CI.';
  if (!normalizar(body.numero_doc)) return 'El número de documento es obligatorio.';
  if (!(body.razon_social || '').trim()) return 'La razón social es obligatoria.';
  if (tipoDoc === 'ruc' && body.dv !== undefined && body.dv !== null && String(body.dv) !== '') {
    const esperado = dvParaguayo(body.numero_doc);
    if (String(body.dv).trim() !== String(esperado) && !body.forzar_dv) {
      return `El DV no coincide: para ${normalizar(body.numero_doc)} el dígito verificador ` +
             `calculado es ${esperado}. Verificá el número, o marcá "forzar" si el documento ` +
             `realmente es así.`;
    }
  }
  return null;
}

// ── Listado ──────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.*,
              COALESCE(u.logins, '[]'::json) AS usuarios,
              COALESCE(s.cantidad, 0)        AS suscripciones
         FROM billing_customers c
         LEFT JOIN LATERAL (
           SELECT json_agg(json_build_object('id', us.id, 'email', us.email,
                                             'full_name', us.full_name, 'rol', abc.rol)) AS logins
             FROM account_billing_customers abc
             JOIN users us ON us.id = abc.user_id
            WHERE abc.billing_customer_id = c.id
         ) u ON true
         LEFT JOIN LATERAL (
           SELECT count(*) AS cantidad FROM subscriptions s WHERE s.billing_customer_id = c.id
         ) s ON true
        ORDER BY c.created_at DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[admin/clients GET]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Alta ─────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const error = validar(req.body);
  if (error) return res.status(400).json({ success: false, error });

  const b = req.body;
  const tipoDoc = b.tipo_doc.toLowerCase();
  // Para RUC sin DV cargado, se completa con el calculado. Para CI no va DV.
  const dv = tipoDoc === 'ruc'
    ? (String(b.dv || '').trim() || String(dvParaguayo(b.numero_doc)))
    : null;

  try {
    const { rows } = await pool.query(
      `INSERT INTO billing_customers
         (tipo_persona, tipo_doc, numero_doc, dv, razon_social, nombre_comercial,
          email, telefono, direccion, ciudad, departamento, origen)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING ${CAMPOS}`,
      [(b.tipo_persona || 'juridica').toLowerCase(), tipoDoc, b.numero_doc.trim(), dv,
       b.razon_social.trim(), b.nombre_comercial || null, b.email || null, b.telefono || null,
       b.direccion || null, b.ciudad || null, b.departamento || null, b.origen || 'hepta_cloud']
    );
    if (b.user_id) {
      await pool.query(
        `INSERT INTO account_billing_customers (user_id, billing_customer_id, rol)
         VALUES ($1, $2, 'titular') ON CONFLICT DO NOTHING`,
        [b.user_id, rows[0].id]
      );
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        success: false,
        error: 'Ya existe una entidad fiscal con ese documento. Un documento, una ficha.' });
    }
    console.error('[admin/clients POST]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Edición ──────────────────────────────────────────────────
// El documento NO se edita si la entidad ya está enlazada al ERP: cambiarlo
// ahí es crear otra entidad, no corregir un campo (ver contrato de datos).
router.put('/:id', async (req, res) => {
  const b = req.body;
  try {
    const { rows: previas } = await pool.query(
      'SELECT erp_partner_id, tipo_doc, numero_doc FROM billing_customers WHERE id = $1',
      [req.params.id]
    );
    if (!previas[0]) return res.status(404).json({ success: false, error: 'No encontrada' });

    const cambiaDocumento = (b.numero_doc && normalizar(b.numero_doc) !== normalizar(previas[0].numero_doc))
                         || (b.tipo_doc && b.tipo_doc.toLowerCase() !== previas[0].tipo_doc);
    if (cambiaDocumento && previas[0].erp_partner_id) {
      return res.status(400).json({
        success: false,
        error: 'Esta entidad ya está enlazada al ERP: el documento no se cambia. ' +
               'Si el cliente pasó a facturar con otro documento, es una entidad nueva.' });
    }
    if (cambiaDocumento) {
      const error = validar({ ...previas[0], ...b });
      if (error) return res.status(400).json({ success: false, error });
    }

    const { rows } = await pool.query(
      `UPDATE billing_customers SET
         tipo_persona     = COALESCE($1, tipo_persona),
         razon_social     = COALESCE($2, razon_social),
         nombre_comercial = COALESCE($3, nombre_comercial),
         email            = COALESCE($4, email),
         telefono         = COALESCE($5, telefono),
         direccion        = COALESCE($6, direccion),
         ciudad           = COALESCE($7, ciudad),
         departamento     = COALESCE($8, departamento),
         tipo_doc         = COALESCE($9, tipo_doc),
         numero_doc       = COALESCE($10, numero_doc),
         dv               = COALESCE($11, dv)
       WHERE id = $12 RETURNING ${CAMPOS}`,
      [b.tipo_persona || null, b.razon_social || null, b.nombre_comercial || null,
       b.email || null, b.telefono || null, b.direccion || null, b.ciudad || null,
       b.departamento || null,
       cambiaDocumento ? b.tipo_doc.toLowerCase() : null,
       cambiaDocumento ? b.numero_doc : null,
       cambiaDocumento ? (b.dv || null) : null,
       req.params.id]
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[admin/clients PUT]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Baja ─────────────────────────────────────────────────────
router.delete('/:id', requireGodmode, async (req, res) => {
  try {
    const { rows: [c] } = await pool.query(
      `SELECT c.erp_partner_id,
              (SELECT count(*) FROM subscriptions s WHERE s.billing_customer_id = c.id) AS subs
         FROM billing_customers c WHERE c.id = $1`,
      [req.params.id]
    );
    if (!c) return res.status(404).json({ success: false, error: 'No encontrada' });
    if (parseInt(c.subs) > 0) {
      return res.status(400).json({
        success: false, error: 'Tiene suscripciones: no se puede borrar.' });
    }
    if (c.erp_partner_id) {
      return res.status(400).json({
        success: false,
        error: 'Ya está enlazada a un contacto del ERP. Borrarla acá dejaría el enlace ' +
               'huérfano; revisalo en Odoo primero.' });
    }
    await pool.query('DELETE FROM billing_customers WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('[admin/clients DELETE]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Vincular con el ERP ──────────────────────────────────────
// Odoo devuelve tracebacks de Python enteros. Traducimos los casos conocidos:
// mostrarle cuarenta líneas de stack a alguien que está cargando un cliente no
// ayuda a nadie.
function traducirErrorOdoo(err) {
  const texto = String(err && err.message ? err.message : err);
  const falla = (err && err.faultString) ? String(err.faultString) : texto;

  if (/hepta_find_or_create.*does not exist|does not exist.*hepta_find_or_create/i.test(falla)) {
    return 'El módulo hepta_integration no está instalado en esa base de Odoo. ' +
           'Instalalo desde Aplicaciones y volvé a intentar.';
  }
  if (/AccessDenied|Access denied|Invalid login/i.test(falla)) {
    return 'Odoo rechazó la credencial. Revisá Admin → Credenciales.';
  }
  if (/AccessError|not allowed to (access|create)/i.test(falla)) {
    return 'El usuario de integración no tiene permisos suficientes en Odoo.';
  }
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/.test(texto)) {
    return 'No se pudo llegar al ERP. Revisá la URL de la credencial y la red.';
  }
  if (/credencial para odoo_erp/i.test(texto)) {
    return 'No hay credencial activa de Odoo ERP. Cargala en Admin → Credenciales.';
  }
  const ultima = falla.split('\n').map(l => l.trim()).filter(Boolean).pop() || texto;
  return ultima.slice(0, 300);
}

router.post('/:id/erp', async (req, res) => {
  try {
    const { rows: [c] } = await pool.query(
      `SELECT ${CAMPOS} FROM billing_customers WHERE id = $1`, [req.params.id]);
    if (!c) return res.status(404).json({ success: false, error: 'No encontrada' });

    const payload = {
      hepta_client_id: c.id,
      tipo_doc: c.tipo_doc,
      numero_doc: c.numero_doc,
      dv: c.dv || '',
      tipo_persona: c.tipo_persona,
      razon_social: c.razon_social,
      nombre_comercial: c.nombre_comercial || '',
      email: c.email || '',
      telefono: c.telefono || '',
      direccion: c.direccion || '',
      ciudad: c.ciudad || '',
      departamento: c.departamento || '',
      unidad: 'hepta_cloud',
    };

    let r;
    try {
      r = await odoo.erp.ejecutar('res.partner', 'hepta_find_or_create', [payload]);
    } catch (err) {
      const mensaje = traducirErrorOdoo(err);
      await pool.query(
        `UPDATE billing_customers SET erp_sync_state='error', erp_last_error=$1 WHERE id=$2`,
        [mensaje, c.id]);
      return res.json({ success: false, error: mensaje });
    }

    // El módulo puede devolver "pendiente": sin documento, documento ambiguo o
    // documento que ya pertenece a otra entidad. Eso NO es un error de red: es
    // una decisión que tiene que tomar una persona, del lado de Odoo.
    if (r.estado !== 'ok' || !r.partner_id) {
      await pool.query(
        `UPDATE billing_customers
            SET erp_sync_state='revision', erp_last_error=$1, erp_synced_at=NOW()
          WHERE id=$2`,
        [`Odoo lo mandó a revisión: ${r.motivo || 'sin motivo'}`, c.id]);
      return res.json({ success: false, error: `Quedó en revisión en Odoo (${r.motivo}). ` +
        'Miralo en Ajustes → HEPTA Cloud → Clientes en revisión.', data: r });
    }

    const { rows } = await pool.query(
      `UPDATE billing_customers
          SET erp_partner_id=$1, erp_sync_state='ok', erp_last_error=NULL, erp_synced_at=NOW()
        WHERE id=$2 RETURNING ${CAMPOS}`,
      [r.partner_id, c.id]);
    res.json({ success: true, data: rows[0], odoo: r });
  } catch (err) {
    console.error('[admin/clients erp]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Vínculo con usuarios del portal ──────────────────────────
router.post('/:id/usuarios', async (req, res) => {
  const { user_id, rol } = req.body;
  if (!user_id) return res.status(400).json({ success: false, error: 'Falta el usuario' });
  try {
    await pool.query(
      `INSERT INTO account_billing_customers (user_id, billing_customer_id, rol)
       VALUES ($1,$2,$3)
       ON CONFLICT (user_id, billing_customer_id) DO UPDATE SET rol = EXCLUDED.rol`,
      [user_id, req.params.id, rol || 'titular']);
    res.json({ success: true });
  } catch (err) {
    console.error('[admin/clients vincular]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/:id/usuarios/:userId', async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM account_billing_customers WHERE billing_customer_id=$1 AND user_id=$2',
      [req.params.id, req.params.userId]);
    res.json({ success: true });
  } catch (err) {
    console.error('[admin/clients desvincular]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Utilidad para el formulario: calcular el DV sin guardar nada.
router.get('/dv/:numero', (req, res) => {
  res.json({ success: true, data: { dv: dvParaguayo(req.params.numero) } });
});

module.exports = router;
