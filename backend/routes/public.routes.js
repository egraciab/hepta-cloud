const router = require('express').Router();
const pool   = require('../config/db');

router.get('/plans', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM plans WHERE is_active=true ORDER BY sort_order ASC');
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, error: 'Error interno' }); }
});

router.get('/services', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM services WHERE is_active=true ORDER BY type, sort_order ASC');
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, error: 'Error interno' }); }
});

router.get('/pages/:slug', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM pages WHERE slug=$1 AND is_active=true', [req.params.slug]);
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Página no encontrada' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: 'Error interno' }); }
});

module.exports = router;
