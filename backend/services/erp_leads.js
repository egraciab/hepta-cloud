// Pedidos del sitio → ERP del grupo (Odoo Enterprise): un contacto y una oportunidad en el CRM por cada pedido.
//
// Se enciende con site_config.odoo_erp_crm_enabled = 'true' (Admin → Configuración general). Usa la credencial
// "odoo_erp" de Admin → Credenciales. Nunca frena el pedido: si el ERP no responde, el lead queda en HEPTA Cloud
// con el motivo, y se reenvía desde Admin → Leads.
//
// Reglas:
//  - Un lead se envía una sola vez (leads.odoo_lead_id). Reenviar no duplica.
//  - Contacto: se busca por correo; si no hay, por teléfono; si no existe, se crea. No se le carga el RUC como
//    identificación fiscal: eso lo hace el alta de la entidad fiscal (hepta_find_or_create), que valida el documento.
//  - Oportunidad (no "lead"): así aparece en el flujo de ventas aunque el CRM no tenga activada la etapa de leads.
const pool = require('../config/db');
const odoo = require('../config/odoo');
const { traducirErrorOdoo } = require('../config/odoo_errores');

async function config() {
  const { rows } = await pool.query("SELECT key, value FROM site_config WHERE key LIKE 'odoo_erp_crm_%'");
  const c = Object.fromEntries(rows.map(r => [r.key.replace('odoo_erp_crm_', ''), (r.value || '').trim()]));
  const entero = v => (/^\d+$/.test(v || '') ? parseInt(v, 10) : null);
  return { activo: c.enabled === 'true', company_id: entero(c.company_id), team_id: entero(c.team_id), user_id: entero(c.user_id) };
}

const html = t => String(t == null ? '' : t).replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));

async function buscarOCrearContacto(lead, ctx) {
  const campos = ['id', 'name'];
  if (lead.email) {
    const r = await odoo.erp.ejecutar('res.partner', 'search_read', [[['email', '=ilike', lead.email]]], { fields: campos, limit: 1, order: 'id asc', ...ctx });
    if (r.length) return { id: r[0].id, creado: false };
  }
  if (lead.phone) {
    const r = await odoo.erp.ejecutar('res.partner', 'search_read', [[['phone', '=', lead.phone]]], { fields: campos, limit: 1, order: 'id asc', ...ctx });
    if (r.length) return { id: r[0].id, creado: false };
  }
  const vals = {
    name: lead.full_name,
    email: lead.email || false,
    phone: lead.phone || false,
    company_name: lead.company_name || false,
    comment: `Contacto creado por un pedido en cloud.hepta.com.py (#${lead.id}).` + (lead.ruc ? ` RUC informado: ${html(lead.ruc)}.` : ''),
  };
  const id = await odoo.erp.ejecutar('res.partner', 'create', [vals], ctx);
  return { id: Array.isArray(id) ? id[0] : id, creado: true };
}

// Envía un lead al ERP. Devuelve { ok, odoo_lead_id, erp_partner_id } o { ok:false, error }.
async function enviarLead(leadId, { forzar = false } = {}) {
  const { rows: [lead] } = await pool.query(
    `SELECT l.*, p.name AS plan_name, p.price AS plan_price, p.price_label AS plan_price_label
       FROM leads l LEFT JOIN plans p ON p.slug = l.plan_slug WHERE l.id = $1`, [leadId]);
  if (!lead) return { ok: false, error: 'No existe ese lead.' };
  if (lead.odoo_lead_id) return { ok: true, odoo_lead_id: lead.odoo_lead_id, erp_partner_id: lead.erp_partner_id, ya_estaba: true };

  const cfg = await config();
  if (!cfg.activo && !forzar) return { ok: false, apagado: true, error: 'El envío al ERP está apagado (Configuración general).' };

  const ctx = cfg.company_id ? { context: { allowed_company_ids: [cfg.company_id] } } : {};
  try {
    const contacto = await buscarOCrearContacto(lead, ctx);
    const quien = lead.company_name || lead.full_name;
    const esAlta = lead.intent === 'contratar';
    const vals = {
      name: (esAlta ? `Contratación ${lead.plan_name || 'Hepta Cloud'}` : (lead.plan_name ? `Consulta por ${lead.plan_name}` : 'Consulta Hepta Cloud')) + ` — ${quien}`,
      type: 'opportunity',
      partner_id: contacto.id,
      contact_name: lead.full_name,
      partner_name: lead.company_name || false,
      email_from: lead.email || false,
      phone: lead.phone || false,
      referred: `cloud.hepta.com.py #${lead.id}`,
      expected_revenue: lead.plan_price ? Number(lead.plan_price) : 0,
      description:
        `<p><strong>${esAlta ? 'Pidió contratar' : 'Consulta'} desde cloud.hepta.com.py</strong> (pedido #${lead.id})</p>` +
        (lead.plan_name ? `<p>Plan: ${html(lead.plan_name)}${lead.plan_price_label ? ' · ' + html(lead.plan_price_label) : ''}</p>` : '') +
        (lead.ruc ? `<p>RUC informado: ${html(lead.ruc)}</p>` : '') +
        (lead.acepta_terminos_at ? '<p>Aceptó los términos del servicio y la política de privacidad.</p>' : '') +
        (lead.message ? `<p>Mensaje:<br/>${html(lead.message).replace(/\n/g, '<br/>')}</p>` : ''),
    };
    if (cfg.company_id) vals.company_id = cfg.company_id;
    if (cfg.team_id) vals.team_id = cfg.team_id;
    // Sin esto Odoo asigna como vendedor al usuario de integración. Vacío = sin vendedor (lo reparte el equipo).
    vals.user_id = cfg.user_id || false;

    const creado = await odoo.erp.ejecutar('crm.lead', 'create', [vals], ctx);
    const odooLeadId = Array.isArray(creado) ? creado[0] : creado;
    await pool.query(
      `UPDATE leads SET odoo_lead_id=$1, erp_partner_id=$2, erp_sync_state='ok', erp_last_error=NULL, synced_at=NOW() WHERE id=$3`,
      [odooLeadId, contacto.id, lead.id]);
    return { ok: true, odoo_lead_id: odooLeadId, erp_partner_id: contacto.id, contacto_creado: contacto.creado };
  } catch (err) {
    const mensaje = traducirErrorOdoo(err);
    console.error('[erp_leads]', lead.id, mensaje);
    await pool.query(`UPDATE leads SET erp_sync_state='error', erp_last_error=$1 WHERE id=$2`, [mensaje, lead.id]).catch(() => {});
    return { ok: false, error: mensaje };
  }
}

module.exports = { enviarLead, config };
