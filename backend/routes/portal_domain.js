// Agregar a portal.routes.js

// POST /api/portal/domain-request
router.post('/domain-request', async (req, res) => {
  const { instance_id, type, domain, notes } = req.body;
  // type: 'own' (ya tiene dominio) | 'buy' (quiere comprar)

  if (!instance_id || !type)
    return res.status(400).json({ success: false, error: 'instance_id y type son requeridos' });

  try {
    // Verificar que la instancia pertenece al usuario
    const { rows } = await pool.query(
      'SELECT id, label, db_name FROM instances WHERE id=$1 AND user_id=$2',
      [instance_id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Instancia no encontrada' });

    const inst = rows[0];
    const msg = type === 'own'
      ? `Solicitud de activación de dominio propio: ${domain} para instancia ${inst.label} (${inst.db_name}). Notas: ${notes || '—'}`
      : `Solicitud de compra de dominio para instancia ${inst.label} (${inst.db_name}). Dominio deseado: ${domain || 'a definir'}. Notas: ${notes || '—'}`;

    // Registrar como lead interno
    await pool.query(
      `INSERT INTO leads (full_name, email, company_name, message, source, status)
       VALUES ($1, $2, $3, $4, 'domain_request', 'new')`,
      [
        req.user.full_name,
        req.user.email,
        inst.label,
        msg,
      ]
    );

    // Marcar instancia con solicitud pendiente
    await pool.query(
      `UPDATE instances SET
         custom_domain=$1,
         custom_domain_status=$2,
         updated_at=NOW()
       WHERE id=$3`,
      [
        domain || null,
        type === 'own' ? 'pending_dns' : 'pending_purchase',
        instance_id,
      ]
    );

    res.json({
      success: true,
      message: type === 'own'
        ? 'Solicitud recibida. Nuestro equipo verificará el DNS y activará tu dominio en breve.'
        : 'Solicitud recibida. Te contactaremos para gestionar la compra de tu dominio.',
    });
  } catch (err) {
    console.error('[portal/domain-request]', err.message);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});
