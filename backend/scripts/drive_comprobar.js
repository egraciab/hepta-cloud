// Comprueba que HEPTA Drive quedó listo en este servidor: tablas con permisos, conexión cargada y agente que responde.
//   docker exec heptacloud_backend node scripts/drive_comprobar.js
const pool = require('../config/db');
(async () => {
  let mal = 0;
  const dice = (ok, texto) => { console.log(`${ok ? 'OK ' : 'MAL'}  ${texto}`); if (!ok) mal++; };
  try {
    const { rows } = await pool.query(
      `SELECT has_table_privilege('client_services', 'SELECT,INSERT,UPDATE') AS a,
              has_table_privilege('provisioning_jobs', 'SELECT,INSERT,UPDATE') AS b,
              has_sequence_privilege('client_services_id_seq', 'USAGE') AS c,
              has_sequence_privilege('provisioning_jobs_id_seq', 'USAGE') AS d`);
    dice(rows[0].a && rows[0].b && rows[0].c && rows[0].d, 'tablas client_services y provisioning_jobs, con permisos para el backend');
  } catch (e) { dice(false, `tablas: ${e.message}`); }
  try {
    const salud = await require('../services/drive').salud();
    dice(salud && salud.ok, `agente de HEPTA Drive responde (versión ${salud && salud.version})`);
  } catch (e) { dice(false, `agente: ${e.message}`); }
  process.exit(mal ? 1 : 0);
})();
