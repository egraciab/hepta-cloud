const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const pool    = require('../config/db');
const { requireAuth } = require('../middleware/auth');

const SECRET  = process.env.JWT_SECRET;
const EXPIRES = process.env.JWT_EXPIRES_IN || '7d';

// Freno a la fuerza bruta: 10 intentos fallidos cada 15 minutos por dirección IP.
// Los ingresos correctos no cuentan (un equipo detrás de la misma IP no se bloquea por usar el sistema).
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10, skipSuccessfulRequests: true,
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, code: 'TOO_MANY_ATTEMPTS', error: 'Demasiados intentos. Probá de nuevo en 15 minutos.' },
});

// POST /api/auth/login
router.post('/login', loginLimiter, async (req, res) => {
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

// ── Recuperar contraseña ─────────────────────────────────────
// 1) /forgot: si el correo es de un usuario activo, le llega un enlace de un solo uso (vale 1 hora).
//    La respuesta es siempre la misma, exista o no la cuenta, para no revelar quién es cliente.
// 2) /reset: con el código del enlace se fija la contraseña nueva.
const crypto = require('crypto');
const { enviarCorreo, marco } = require('../services/correo');
const sha256 = t => crypto.createHash('sha256').update(String(t)).digest('hex');

const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
  message: { success: false, code: 'TOO_MANY_ATTEMPTS', error: 'Demasiados pedidos. Probá de nuevo en una hora.' },
});
const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { success: false, code: 'TOO_MANY_ATTEMPTS', error: 'Demasiados intentos. Probá de nuevo en 15 minutos.' },
});

router.post('/forgot', forgotLimiter, async (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  const respuesta = { success: true, message: 'Si ese correo tiene una cuenta, te enviamos un enlace para crear una contraseña nueva. Revisá también la carpeta de spam.' };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ success: false, error: 'Escribí tu correo' });
  try {
    const { rows: [user] } = await pool.query('SELECT id, email, full_name FROM users WHERE email=$1 AND is_active=true', [email]);
    if (user) {
      // A lo sumo 3 enlaces vigentes por cuenta: nadie puede llenarle la casilla a un cliente.
      const { rows: [{ n }] } = await pool.query(
        "SELECT count(*)::int AS n FROM password_resets WHERE user_id=$1 AND used_at IS NULL AND expires_at > NOW()", [user.id]);
      if (n < 3) {
        const token = crypto.randomBytes(32).toString('base64url');
        const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip;
        await pool.query(
          "INSERT INTO password_resets (user_id, token_hash, expires_at, ip_address) VALUES ($1,$2,NOW() + INTERVAL '1 hour',$3)",
          [user.id, sha256(token), ip]);
        const { rows: cfg } = await pool.query("SELECT value FROM site_config WHERE key='site_url'");
        const base = (cfg[0]?.value || 'https://cloud.hepta.com.py').replace(/\/+$/, '');
        // El código va después de # : así no viaja al servidor ni queda en los registros del proxy.
        const enlace = `${base}/portal/#reset=${token}`;
        const ok = await enviarCorreo({
          to: user.email,
          subject: 'Creá una contraseña nueva para tu cuenta de Hepta Cloud',
          html: marco('Creá una contraseña nueva', `
            <p style="font-size:14px;line-height:1.6">Recibimos un pedido para cambiar la contraseña de tu cuenta del portal de clientes.</p>
            <p style="margin:22px 0"><a href="${enlace}" style="background:#1254A4;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700;font-size:14px">Crear contraseña nueva</a></p>
            <p style="font-size:13px;line-height:1.6;color:#4B5563">El enlace vale por 1 hora y se puede usar una sola vez. Si no lo pediste vos, no hagas nada: tu contraseña sigue siendo la misma.</p>
            <p style="font-size:12px;color:#6B7280;word-break:break-all">Si el botón no funciona, copiá esta dirección en tu navegador:<br>${enlace}</p>`),
        });
        // El enlace no va al log: quien lea el log podría entrar a la cuenta.
        console.log('[auth/forgot] pedido para usuario %s: correo %s', user.id, ok ? 'enviado' : 'NO enviado');
      }
    }
    res.json(respuesta);
  } catch (err) {
    console.error('[auth/forgot]', err.message);
    res.status(500).json({ success: false, error: 'No pudimos procesar el pedido. Probá de nuevo en un momento.' });
  }
});

router.post('/reset', resetLimiter, async (req, res) => {
  const { token, new_password } = req.body;
  if (!token || !new_password || String(new_password).length < 8)
    return res.status(400).json({ success: false, error: 'La contraseña nueva tiene que tener al menos 8 caracteres' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [r] } = await client.query(
      `SELECT pr.id, pr.user_id FROM password_resets pr JOIN users u ON u.id = pr.user_id
        WHERE pr.token_hash=$1 AND pr.used_at IS NULL AND pr.expires_at > NOW() AND u.is_active = true
        FOR UPDATE OF pr`, [sha256(token)]);
    if (!r) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, code: 'ENLACE_INVALIDO', error: 'El enlace ya se usó o venció. Pedí uno nuevo.' });
    }
    const hash = await bcrypt.hash(String(new_password), 10);
    await client.query('UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2', [hash, r.user_id]);
    // Se gastan todos los enlaces pendientes de esa cuenta, no solo el usado.
    await client.query('UPDATE password_resets SET used_at=NOW() WHERE user_id=$1 AND used_at IS NULL', [r.user_id]);
    await client.query('COMMIT');
    console.log('[auth/reset] contraseña cambiada por enlace, usuario %s', r.user_id);
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[auth/reset]', err.message);
    res.status(500).json({ success: false, error: 'Error interno' });
  } finally { client.release(); }
});

module.exports = router;
