const jwt  = require('jsonwebtoken');
const pool = require('../config/db');

const SECRET = process.env.JWT_SECRET;

// Verifica JWT y adjunta user al request
async function requireAuth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, code: 'NO_TOKEN' });
  }

  const token = header.split(' ')[1];

  let payload;
  try {
    payload = jwt.verify(token, SECRET);
  } catch (e) {
    return res.status(401).json({ success: false, code: 'INVALID_TOKEN' });
  }

  // Verificar blacklist
  if (payload.jti) {
    const { rows } = await pool.query(
      'SELECT 1 FROM token_blacklist WHERE jti = $1',
      [payload.jti]
    );
    if (rows.length) {
      return res.status(401).json({ success: false, code: 'TOKEN_REVOKED' });
    }
  }

  req.user = payload;
  next();
}

// Solo admins y godmode
function requireAdmin(req, res, next) {
  if (!req.user || !['admin', 'godmode'].includes(req.user.role)) {
    return res.status(403).json({ success: false, code: 'FORBIDDEN' });
  }
  next();
}

// Solo godmode
function requireGodmode(req, res, next) {
  if (!req.user || req.user.role !== 'godmode') {
    return res.status(403).json({ success: false, code: 'FORBIDDEN' });
  }
  next();
}

function getAdminToken(req) {
  const header = req.headers['authorization'];
  return header && header.startsWith('Bearer ') ? header.split(' ')[1] : null;
}

module.exports = { requireAuth, requireAdmin, requireGodmode, getAdminToken };
