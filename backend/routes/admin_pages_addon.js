// Pages routes - agregar al final de admin.routes.js

// GET /api/admin/pages
router.get('/pages', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, slug, title, is_active, updated_at FROM pages ORDER BY id');
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, error: 'Error interno' }); }
});

// GET /api/admin/pages/:slug
router.get('/pages/:slug', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM pages WHERE slug=$1', [req.params.slug]);
    if (!rows[0]) return res.status(404).json({ success: false, error: 'No encontrada' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: 'Error interno' }); }
});

// PUT /api/admin/pages/:slug
router.put('/pages/:slug', async (req, res) => {
  const { title, content, is_active } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO pages (slug, title, content, is_active, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (slug) DO UPDATE SET title=$2, content=$3, is_active=$4, updated_at=NOW()
       RETURNING *`,
      [req.params.slug, title, content, is_active ?? true]
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: 'Error interno' }); }
});

module.exports = router;
