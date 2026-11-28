// ============================================================
//  HEPTA CLOUD — Reportes de los monitores (/api/monitor)
//
//    POST /api/monitor/vigia   el vigía de hcsvrnd01 manda, cada 5 minutos, lo que revisó (sitios vistos desde
//                              afuera, correo y respaldos). El panel "Estado" del Admin nuevo lo muestra.
//
//  Autenticación: cabecera X-Monitor-Key. En site_config se guarda solo su SHA-256 (monitor_api_key): la clave
//  vive en KeePass y en /etc/hepta-vigia.conf (600) de hcsvrnd01, y si se filtrara la base no sirve para reportar.
// ============================================================
const crypto = require('crypto');
const router = require('express').Router();
const pool   = require('../config/db');
const estado = require('../services/estado');

const ORIGENES = new Set(['vigia']);
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

async function conClave(req, res, next) {
  try {
    const clave = req.get('x-monitor-key') || '';
    const { rows } = await pool.query("SELECT value FROM site_config WHERE key = 'monitor_api_key'");
    const guardado = rows[0] && /^[0-9a-f]{64}$/i.test(rows[0].value) ? Buffer.from(rows[0].value, 'hex') : null;
    if (!guardado) return res.status(503).json({ success: false, error: 'Monitor sin configurar', code: 'NO_CONFIG' });
    if (clave.length < 32 || !crypto.timingSafeEqual(sha(clave), guardado))
      return res.status(401).json({ success: false, error: 'Clave inválida', code: 'BAD_KEY' });
    next();
  } catch (err) {
    console.error('[monitor auth]', err.message);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
}

router.post('/:origen', conClave, async (req, res) => {
  if (!ORIGENES.has(req.params.origen)) return res.status(404).json({ success: false, error: 'Origen desconocido' });
  try {
    const ok = await estado.guardarReporte(req.params.origen, req.body);
    if (!ok) return res.status(422).json({ success: false, error: 'Falta la lista de chequeos' });
    res.json({ success: true });
  } catch (err) {
    console.error('[monitor POST]', err.message);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

module.exports = router;
