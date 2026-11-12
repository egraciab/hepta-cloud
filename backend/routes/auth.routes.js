const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const pool    = require('../config/db');
const { requireAuth } = require('../middleware/auth');

const SECRET  = process.env.JWT_SECRET;
const EXPIRES = process.env.JWT_EXPIRES_IN || '7d';

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, error: 'Email y contraseña requeridos' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE email = $1 AND is_active = true',
      [email.toLowerCase().trim()]
    );
    const user = rows[0];

    if (!user) {
      return res.status(401).json({ success: false, error: 'Credenciales inválidas' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ success: false, error: 'Credenciales inválidas' });
    }

    const jti = uuidv4();
    const token = jwt.sign(
      {
        jti,
        id:              user.id,
        email:           user.email,
        role:            user.role,
        full_name:       user.full_name,
        // La columna se llama tenant_partner_id (partner del tenant maestro, no del ERP).
        // La propiedad del token conserva el nombre viejo para no invalidar sesiones.
        odoo_partner_id: user.tenant_partner_id,
      },
      SECRET,
      { expiresIn: EXPIRES }
    );

    await pool.query(
      'UPDATE users SET last_login_at = NOW() WHERE id = $1',
      [user.id]
    );

    res.json({
      success: true,
      data: {
        token,
        user: {
          id:        user.id,
          email:     user.email,
          full_name: user.full_name,
          role:      user.role,
        }
      }
    });
  } catch (err) {
    console.error('[auth/login]', err.message);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

// POST /api/auth/logout
router.post('/logout', requireAuth, async (req, res) => {
  try {
    if (req.user.jti) {
      const expiresAt = new Date(req.user.exp * 1000);
      await pool.query(
        'INSERT INTO token_blacklist (jti, user_id, expires_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [req.user.jti, req.user.id, expiresAt]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[auth/logout]', err.message);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, full_name, role, tenant_partner_id AS odoo_partner_id, last_login_at FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[auth/me]', err.message);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

// POST /api/auth/change-password
router.post('/change-password', requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password || new_password.length < 8) {
    return res.status(400).json({ success: false, error: 'Contraseña nueva debe tener al menos 8 caracteres' });
  }

  try {
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const valid = await bcrypt.compare(current_password, rows[0].password_hash);
    if (!valid) return res.status(401).json({ success: false, error: 'Contraseña actual incorrecta' });

    const hash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);

    res.json({ success: true });
  } catch (err) {
    console.error('[auth/change-password]', err.message);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

module.exports = router;
