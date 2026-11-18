// ============================================================
//  HEPTA CLOUD — Módulos adicionales (rubros) en una instancia
//
//  Instalar un rubro tarda de 1 a 4 minutos (la API corre odoo-bin -i en el servidor de
//  tenants): como el alta, va en segundo plano y el Admin consulta el trabajo.
//    iniciar(...)  → trabajo enseguida;  ver(id) → cómo va
//  El resultado queda en instance_addons (installing → installed / failed).
// ============================================================
const crypto = require('crypto');
const pool   = require('../config/db');
const { postJson, config, ErrorAlta } = require('./alta');

const NIVEL      = { starter: 1, professional: 2, enterprise: 3 };
const ESPERA_MS  = 11 * 60 * 1000;
const GUARDAR_MS = 6 * 60 * 60 * 1000;
const trabajos   = new Map();

function vista(t) {
  return {
    id: t.id, instance_id: t.instance_id, addon: t.addon, estado: t.estado,
    inicio: t.inicio, fin: t.fin || null, segundos: Math.round(((t.fin || Date.now()) - t.inicio) / 1000),
    actualizados: t.actualizados || [], error: t.error || null,
  };
}
const ver = id => (trabajos.has(id) ? vista(trabajos.get(id)) : null);

async function iniciar({ instanceId, addonId, actorId }) {
  const { rows: ins } = await pool.query('SELECT id, db_name, plan, status, label FROM instances WHERE id=$1', [instanceId]);
  const inst = ins[0];
  if (!inst) throw new ErrorAlta(404, 'Instancia no encontrada');
  if (inst.status !== 'active') throw new ErrorAlta(409, 'Solo en instancias activas');
  const { rows: ads } = await pool.query('SELECT * FROM addons WHERE id=$1 AND is_active', [addonId]);
  const addon = ads[0];
  if (!addon) throw new ErrorAlta(404, 'Módulo adicional no encontrado o inactivo');
  if ((NIVEL[inst.plan] || 0) < (NIVEL[addon.min_plan] || 2))
    throw new ErrorAlta(409, `«${addon.name}» necesita el plan Crecimiento o superior`);
  for (const t of trabajos.values())
    if (t.instance_id === inst.id && t.estado === 'en_curso')
      throw new ErrorAlta(409, 'Ya hay una instalación en curso en esta instancia');

  const cfg = await config();
  await pool.query(
    `INSERT INTO instance_addons (instance_id, addon_id, status, error, updated_at) VALUES ($1,$2,'installing',NULL,NOW())
     ON CONFLICT (instance_id, addon_id) DO UPDATE SET status='installing', error=NULL, updated_at=NOW()`,
    [inst.id, addon.id]);

  const t = { id: crypto.randomUUID(), instance_id: inst.id, addon: addon.name, estado: 'en_curso', inicio: Date.now() };
  trabajos.set(t.id, t);
  for (const [id, x] of trabajos) if (x.fin && Date.now() - x.fin > GUARDAR_MS) trabajos.delete(id);
  console.log(`[adicional] ${addon.odoo_module} → ${inst.db_name} (trabajo ${t.id})`);

  (async () => {
    try {
      const r = await postJson(`${cfg.provision_api_url}/install-module`, cfg.provision_api_key,
        { db: inst.db_name, module: addon.odoo_module, min_plan: addon.min_plan }, ESPERA_MS);
      if (!r.ok || !r.data?.success) {
        const d = r.data?.detail;
        throw new Error(typeof d === 'string' ? d : (Array.isArray(d) ? d.map(x => x.msg).join('; ') : `La API respondió ${r.status}`));
      }
      t.actualizados = r.data.actualizados || [];
      await pool.query(
        `UPDATE instance_addons SET status='installed', error=NULL, installed_at=COALESCE(installed_at, NOW()), updated_at=NOW()
          WHERE instance_id=$1 AND addon_id=$2`, [inst.id, addon.id]);
      await pool.query(
        `INSERT INTO admin_logs (user_id, action, target, detail) VALUES ($1,'addon_install',$2,$3)`,
        [actorId || null, `instance:${inst.id}`, JSON.stringify({ addon: addon.slug, db: inst.db_name })]).catch(() => {});
      t.estado = 'ok';
    } catch (err) {
      t.estado = 'error'; t.error = err.message;
      console.error(`[adicional] Falló ${addon.odoo_module} en ${inst.db_name}: ${err.message}`);
      await pool.query(`UPDATE instance_addons SET status='failed', error=$3, updated_at=NOW() WHERE instance_id=$1 AND addon_id=$2`,
        [inst.id, addon.id, err.message.slice(0, 1000)]).catch(() => {});
    } finally { t.fin = Date.now(); }
  })();
  return vista(t);
}

module.exports = { iniciar, ver };
