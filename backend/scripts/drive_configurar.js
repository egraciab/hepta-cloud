// Carga en site_config la conexión con el agente de HEPTA Drive (VM hepta-drive).
// La clave y el certificado entran por la entrada estándar y no se muestran:
//
//   { clave; certificado; } | docker exec -i heptacloud_backend node scripts/drive_configurar.js https://10.10.50.220:8888
//
// Primera línea: la clave de la API. El resto: el certificado del agente (PEM).
const pool = require('../config/db');

const url = process.argv[2] || '';
if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(url)) {
  console.error('Uso: node scripts/drive_configurar.js https://<ip>:<puerto>   (clave y certificado por la entrada estándar)');
  process.exit(2);
}
let entrada = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { entrada += d; });
process.stdin.on('end', async () => {
  const corte = entrada.indexOf('\n');
  const clave = (corte < 0 ? entrada : entrada.slice(0, corte)).trim();
  const cert  = corte < 0 ? '' : entrada.slice(corte + 1).trim();
  if (clave.length < 32) { console.error('ERROR: la primera línea tiene que ser la clave (32 caracteres o más)'); process.exit(1); }
  if (!/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----$/.test(cert)) {
    console.error('ERROR: después de la clave tiene que venir el certificado en formato PEM'); process.exit(1);
  }
  try {
    for (const [k, v] of [['drive_api_url', url], ['drive_api_key', clave], ['drive_api_cert', cert]]) {
      await pool.query(
        `INSERT INTO site_config (key, value, updated_at) VALUES ($1,$2,NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [k, v]);
    }
    console.log(`Conexión con HEPTA Drive guardada: ${url} (clave de ${clave.length} caracteres y certificado, no mostrados)`);
    process.exit(0);
  } catch (e) { console.error('ERROR:', e.message); process.exit(1); }
});
