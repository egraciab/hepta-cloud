const router     = require('express').Router();
const { esSecreto, MASCARA } = require('../config/site_config_publico');
const bcrypt     = require('bcryptjs');
const nodemailer = require('nodemailer');
const path       = require('path');
const fs         = require('fs');
const pool       = require('../config/db');
const { requireAuth, requireAdmin, requireGodmode } = require('../middleware/auth');

router.use(requireAuth, requireAdmin);
router.use((req, res, next) => { res.set("Cache-Control", "no-store, no-cache, must-revalidate"); res.set("Pragma", "no-cache"); next(); });

// Credenciales de integración (claves de API cifradas)
router.use('/credentials', require('./credentials.routes'));

// Clientes: entidades fiscales (billing_customers)
router.use('/clients', require('./clients.routes'));

// ── Site config ──────────────────────────────────────────────
router.get('/config', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT key, value FROM site_config ORDER BY key');
    const config = Object.fromEntries(rows.map(r => [r.key, r.value]));
    // Los secretos no viajan al navegador: se muestran enmascarados (el PUT ignora la máscara).
    for (const k of Object.keys(config)) if (esSecreto(k) && config[k]) config[k] = MASCARA;
    res.json({ success: true, data: config });
  } catch (err) {
    console.error('[admin/config GET]', err.message);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

router.put('/config', async (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object')
    return res.status(400).json({ success: false, error: 'Body inválido' });
  try {
    for (const [key, value] of Object.entries(updates)) {
      if (esSecreto(key) && typeof value === 'string' && value.startsWith('•')) continue;
      await pool.query(
        `INSERT INTO site_config (key, value, updated_at) VALUES ($1,$2,NOW())
         ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()`,
        [key, value]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[admin/config PUT]', err.message);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

// ── Test SMTP ────────────────────────────────────────────────
router.post('/config/smtp-test', async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ success: false, error: 'Email destino requerido' });
  try {
    const { rows } = await pool.query("SELECT key, value FROM site_config WHERE key LIKE 'smtp_%'");
    const cfg = Object.fromEntries(rows.map(r => [r.key, r.value]));
    const transporter = nodemailer.createTransport({
      host: cfg.smtp_host, port: parseInt(cfg.smtp_port) || 465,
      secure: cfg.smtp_secure === 'true',
      auth: { user: cfg.smtp_user, pass: cfg.smtp_pass },
      tls: { rejectUnauthorized: false },
    });
    await transporter.sendMail({
      from: `${cfg.smtp_from_name} <${cfg.smtp_from_email}>`,
      to, subject: 'Test SMTP — Hepta Cloud',
      html: '<p>Si recibís este email, la configuración SMTP está correcta ✅</p>',
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[admin/smtp-test]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Upload logo ──────────────────────────────────────────────
router.post('/upload/logo', async (req, res) => {
  try {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      const buffer = Buffer.concat(chunks);
      const contentType = req.headers['content-type'] || '';
      if (!contentType.startsWith('image/'))
        return res.status(400).json({ success: false, error: 'Solo se aceptan imágenes' });
      const ext = contentType.split('/')[1].replace('jpeg','jpg');
      const filename = `logo_${Date.now()}.${ext}`;
      const uploadDir = path.join(process.env.FRONTEND_PATH || '/app/frontend', 'assets', 'uploads');
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
      fs.writeFileSync(path.join(uploadDir, filename), buffer);
      const url = `/assets/uploads/${filename}`;
      await pool.query(
        `INSERT INTO site_config (key,value,updated_at) VALUES ('logo_url',$1,NOW())
         ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`, [url]
      );
      await pool.query(
        `INSERT INTO uploads (filename,original_name,mime_type,size_bytes,url,uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [filename,'logo',contentType,buffer.length,url,req.user.id]
      );
      res.json({ success: true, data: { url } });
    });
  } catch (err) {
    console.error('[admin/upload/logo]', err.message);
    res.status(500).json({ success: false, error: 'Error al subir imagen' });
  }
});

// ── Plans ────────────────────────────────────────────────────
router.get('/plans', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM plans ORDER BY sort_order ASC');
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, error: 'Error interno' }); }
});

router.post('/plans', async (req, res) => {
  const { name, slug, price, price_label, description, features, is_featured, sort_order, badge_text } = req.body;
  if (!name || !slug) return res.status(400).json({ success: false, error: 'Nombre y slug requeridos' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO plans (name,slug,price,price_label,description,features,is_featured,sort_order,badge_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [name,slug,price||0,price_label||'',description||'',JSON.stringify(features||[]),is_featured||false,sort_order||0,badge_text||null]
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, error: 'Slug ya existe' });
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

router.put('/plans/:id', async (req, res) => {
  const { name, price, price_label, description, features, is_featured, is_active, sort_order, badge_text } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE plans SET name=$1,price=$2,price_label=$3,description=$4,
         features=COALESCE($5,features),is_featured=COALESCE($6,is_featured),
         is_active=COALESCE($7,is_active),sort_order=COALESCE($8,sort_order),
         badge_text=$9,updated_at=NOW()
       WHERE id=$10 RETURNING *`,
      [name,price,price_label,description,
       features?JSON.stringify(features):null,
       is_featured??null,is_active??null,sort_order,badge_text||null,req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Plan no encontrado' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: 'Error interno' }); }
});

router.delete('/plans/:id', requireGodmode, async (req, res) => {
  try {
    await pool.query('DELETE FROM plans WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: 'Error interno' }); }
});

// ── Services ─────────────────────────────────────────────────
router.get('/services', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM services ORDER BY type, sort_order ASC');
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, error: 'Error interno' }); }
});

router.post('/services', async (req, res) => {
  const { type, title, description, icon_svg, is_featured, sort_order, badge_text } = req.body;
  if (!type || !title) return res.status(400).json({ success: false, error: 'Tipo y título requeridos' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO services (type,title,description,icon_svg,is_featured,sort_order,badge_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [type,title,description||'',icon_svg||'',is_featured||false,sort_order||0,badge_text||null]
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: 'Error interno' }); }
});

router.put('/services/:id', async (req, res) => {
  const { title, description, icon_svg, is_featured, is_active, sort_order, badge_text } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE services SET
         title=COALESCE($1,title), description=COALESCE($2,description),
         icon_svg=COALESCE($3,icon_svg), is_featured=COALESCE($4,is_featured),
         is_active=COALESCE($5,is_active), sort_order=COALESCE($6,sort_order),
         badge_text=$7, updated_at=NOW()
       WHERE id=$8 RETURNING *`,
      [title||null,description||null,icon_svg||null,is_featured??null,is_active??null,sort_order??null,badge_text||null,req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Servicio no encontrado' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: 'Error interno' }); }
});

router.delete('/services/:id', requireGodmode, async (req, res) => {
  try {
    await pool.query('DELETE FROM services WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: 'Error interno' }); }
});

// ── Email templates ──────────────────────────────────────────
router.get('/email-templates', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM email_templates ORDER BY id');
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, error: 'Error interno' }); }
});

router.put('/email-templates/:id', async (req, res) => {
  const { subject, body_html, is_active } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE email_templates SET
         subject=COALESCE($1,subject), body_html=COALESCE($2,body_html),
         is_active=COALESCE($3,is_active), updated_at=NOW()
       WHERE id=$4 RETURNING *`,
      [subject||null,body_html||null,is_active??null,req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Template no encontrado' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: 'Error interno' }); }
});

// ── Usuarios ─────────────────────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    // "clientes": las entidades fiscales a las que está vinculado cada usuario
    const { rows } = await pool.query(
      `SELECT u.id,u.email,u.full_name,u.role,u.is_active,u.tenant_partner_id AS odoo_partner_id,
              u.last_login_at,u.created_at,
              COALESCE(c.lista, '[]'::json) AS clientes
         FROM users u
         LEFT JOIN LATERAL (
           SELECT json_agg(json_build_object('id', bc.id, 'razon_social', bc.razon_social)) AS lista
             FROM account_billing_customers abc
             JOIN billing_customers bc ON bc.id = abc.billing_customer_id
            WHERE abc.user_id = u.id
         ) c ON true
        ORDER BY u.created_at DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) { console.error('[admin/users GET]', err.message); res.status(500).json({ success: false, error: 'Error interno' }); }
});

// Alta de usuario. La contraseña es opcional: si no se carga, queda una al azar que nadie
// conoce y el cliente recibe la suya en el correo de bienvenida del alta de su sistema.
// billing_customer_id (opcional) lo vincula de entrada a su entidad fiscal.
router.post('/users', requireGodmode, async (req, res) => {
  const { email, password, full_name, role, odoo_partner_id, billing_customer_id } = req.body;
  if (!email || !full_name)
    return res.status(400).json({ success: false, error: 'Nombre y correo son obligatorios' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email).trim()))
    return res.status(400).json({ success: false, error: 'El correo no parece válido' });
  if (role && !['client', 'admin', 'godmode'].includes(role))
    return res.status(400).json({ success: false, error: 'Rol desconocido' });
  if (password && String(password).length < 8)
    return res.status(400).json({ success: false, error: 'La contraseña tiene que tener al menos 8 caracteres' });
  try {
    const hash = await bcrypt.hash(password || require('crypto').randomBytes(24).toString('base64url'), 10);
    const { rows } = await pool.query(
      `INSERT INTO users (email,password_hash,full_name,role,tenant_partner_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING id,email,full_name,role`,
      [email.toLowerCase().trim(),hash,full_name.trim(),role||'client',odoo_partner_id||null]
    );
    if (billing_customer_id) {
      await pool.query(
        `INSERT INTO account_billing_customers (user_id, billing_customer_id, rol)
         VALUES ($1,$2,'titular') ON CONFLICT DO NOTHING`,
        [rows[0].id, billing_customer_id]);
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, error: 'Email ya registrado' });
    console.error('[admin/users POST]', err.message);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

// Un administrador común edita nombre y estado de los clientes. Cambiar un rol, fijar una contraseña o
// tocar a otro administrador queda para godmode: si no, cualquier admin podía subirse de rol solo.
const ROLES = ['client', 'admin', 'godmode'];
router.put('/users/:id', async (req, res) => {
  const { full_name, role, is_active, odoo_partner_id, password } = req.body;
  const esGodmode = req.user.role === 'godmode';
  try {
    const { rows: [actual] } = await pool.query('SELECT id, role FROM users WHERE id=$1', [req.params.id]);
    if (!actual) return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
    if (role && !ROLES.includes(role))
      return res.status(400).json({ success: false, error: 'Rol desconocido' });
    const cambiaRol = role && role !== actual.role;
    if (!esGodmode && (cambiaRol || password || actual.role !== 'client'))
      return res.status(403).json({ success: false, code: 'SOLO_GODMODE',
        error: 'Cambiar roles o contraseñas, o editar a otro administrador, lo hace solo un usuario godmode.' });
    if (String(actual.id) === String(req.user.id) && (cambiaRol || is_active === false))
      return res.status(400).json({ success: false, error: 'No podés cambiar tu propio rol ni desactivarte.' });
    if (password && String(password).length < 8)
      return res.status(400).json({ success: false, error: 'La contraseña tiene que tener al menos 8 caracteres' });
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await pool.query('UPDATE users SET password_hash=$1,updated_at=NOW() WHERE id=$2',[hash,req.params.id]);
    }
    const { rows } = await pool.query(
      `UPDATE users SET
         full_name=COALESCE($1,full_name), role=COALESCE($2,role),
         is_active=COALESCE($3,is_active), tenant_partner_id=COALESCE($4,tenant_partner_id),
         updated_at=NOW()
       WHERE id=$5 RETURNING id,email,full_name,role,is_active,tenant_partner_id AS odoo_partner_id`,
      [full_name||null,role||null,is_active??null,odoo_partner_id||null,req.params.id]
    );
    if (cambiaRol || password) {
      // Queda registrado quién lo hizo; la contraseña no se guarda en el registro.
      await pool.query('INSERT INTO admin_logs (user_id,action,target,detail) VALUES ($1,$2,$3,$4)',
        [req.user.id, 'update_user_access', `user:${req.params.id}`,
         JSON.stringify({ rol_anterior: actual.role, rol_nuevo: rows[0].role, cambio_clave: !!password })]).catch(() => {});
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) { console.error('[admin/users PUT]', err.message); res.status(500).json({ success: false, error: 'Error interno' }); }
});

// Borrado de usuario. Se borra de verdad SOLO si no tiene nada colgando: sirve
// para el alta cargada con un typo, no para dar de baja a un cliente. Un
// usuario con instancias, pagos o entidad fiscal se desactiva, no se borra,
// porque esas filas quedarían apuntando a un id que ya no existe.
router.delete('/users/:id', requireGodmode, async (req, res) => {
  const id = req.params.id;
  try {
    const { rows: [u] } = await pool.query(
      `SELECT u.id, u.email, u.last_login_at,
              (SELECT count(*) FROM instances i         WHERE i.user_id = u.id) AS instancias,
              (SELECT count(*) FROM payment_requests p  WHERE p.user_id = u.id) AS pagos,
              (SELECT count(*) FROM account_billing_customers a WHERE a.user_id = u.id) AS entidades
         FROM users u WHERE u.id = $1`, [id]);
    if (!u) return res.status(404).json({ success: false, error: 'Usuario no encontrado' });

    const motivos = [];
    if (parseInt(u.instancias) > 0) motivos.push(`${u.instancias} instancia(s)`);
    if (parseInt(u.pagos) > 0)      motivos.push(`${u.pagos} solicitud(es) de pago`);
    if (parseInt(u.entidades) > 0)  motivos.push(`${u.entidades} entidad(es) fiscal(es)`);
    if (u.last_login_at)            motivos.push('ya inició sesión alguna vez');

    if (motivos.length) {
      return res.status(400).json({
        success: false,
        error: `No se puede borrar: ${motivos.join(', ')}. Desactivalo en vez de borrarlo.`,
        code: 'TIENE_DEPENDENCIAS',
      });
    }

    await pool.query('DELETE FROM users WHERE id = $1', [id]);
    console.log('[admin/users DELETE] %s borrado por %s', u.email, req.user.email);
    res.json({ success: true });
  } catch (err) {
    console.error('[admin/users DELETE]', err.message);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

// ── Leads ────────────────────────────────────────────────────
router.get('/leads', async (req, res) => {
  const { status, limit = 50, offset = 0 } = req.query;
  try {
    const params = [];
    let where = '';
    if (status) { params.push(status); where = `WHERE status=$1`; }
    params.push(parseInt(limit), parseInt(offset));
    const li = params.length-1, oi = params.length;
    const { rows } = await pool.query(
      `SELECT * FROM leads ${where} ORDER BY created_at DESC LIMIT $${li} OFFSET $${oi}`, params
    );
    const { rows: cnt } = await pool.query(
      `SELECT COUNT(*) FROM leads ${where}`, status?[status]:[]
    );
    res.json({ success: true, data: rows, total: parseInt(cnt[0].count) });
  } catch (err) { res.status(500).json({ success: false, error: 'Error interno' }); }
});

router.put('/leads/:id', async (req, res) => {
  const { status, odoo_lead_id } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE leads SET status=COALESCE($1,status),odoo_lead_id=COALESCE($2,odoo_lead_id),
         synced_at=CASE WHEN $2 IS NOT NULL THEN NOW() ELSE synced_at END,updated_at=NOW()
       WHERE id=$3 RETURNING *`,
      [status||null,odoo_lead_id||null,req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Lead no encontrado' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: 'Error interno' }); }
});

// ── Pages ────────────────────────────────────────────────
router.get("/pages", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT id, slug, title, is_active, updated_at FROM pages ORDER BY id");
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, error: "Error interno" }); }
});

router.get("/pages/:slug", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM pages WHERE slug=$1", [req.params.slug]);
    if (!rows[0]) return res.status(404).json({ success: false, error: "No encontrada" });
    res.json({ success: true, data: rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: "Error interno" }); }
});

router.put("/pages/:slug", async (req, res) => {
  const { title, content, is_active } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO pages (slug, title, content, is_active, updated_at) VALUES ($1,$2,$3,$4,NOW()) ON CONFLICT (slug) DO UPDATE SET title=$2, content=$3, is_active=$4, updated_at=NOW() RETURNING *`,
      [req.params.slug, title, content, is_active ?? true]
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: "Error interno" }); }
});


// ── DELETE /admin/instances/:id ───────────────────────────────
// Baja de una instancia: se corta el acceso (Odoo y perimetral) y queda como "cancelled". No borra la base
// del cliente. Si el corte falla, NO se marca como dada de baja: antes quedaba cancelada acá y abierta allá.
async function llamarApi(url, key, ruta, body) {
  const r = await fetch(`${url}${ruta}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': key || '' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.success) throw new Error(data.detail || data.error || `respondió ${r.status}`);
}

router.delete('/instances/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT label, db_name, status FROM instances WHERE id=$1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Instancia no encontrada' });
    const { label, status } = rows[0];
    const db     = rows[0].db_name || '';
    const tenant = db.split('.')[0];
    if (status === 'cancelled') return res.json({ success: true, message: 'Ya estaba dada de baja.' });
    if (status === 'provisioning')
      return res.status(409).json({ success: false, error: 'El alta todavía está en curso. Esperá a que termine.' });

    // Una instancia ya suspendida tiene el acceso cortado: no hace falta volver a llamar.
    if (status !== 'suspended') {
      const { rows: cfgRows } = await pool.query(
        "SELECT key,value FROM site_config WHERE key IN ('provision_api_url','provision_api_key','perimetral_api_url','perimetral_api_key')"
      );
      const cfg = Object.fromEntries(cfgRows.map(r => [r.key, r.value]));
      if (!cfg.provision_api_url)
        return res.status(500).json({ success: false, error: 'API de provisioning no configurada: no se puede cortar el acceso.' });
      try {
        await llamarApi(cfg.provision_api_url, cfg.provision_api_key, '/suspend', { db });
      } catch (e) {
        console.error('[baja instancia] Odoo:', e.message);
        return res.status(502).json({ success: false, code: 'CORTE_FALLO',
          error: `No se dio de baja: no se pudo cortar el acceso en Odoo (${e.message}). La instancia sigue activa.` });
      }
      try {
        if (cfg.perimetral_api_url) await llamarApi(cfg.perimetral_api_url, cfg.perimetral_api_key, '/suspend', { tenant });
      } catch (e) {
        // Igual que al suspender: no se cambia el estado, así el reintento vuelve a pedir los dos cortes.
        console.error('[baja instancia] perimetral:', e.message);
        return res.status(502).json({ success: false, code: 'CORTE_PARCIAL',
          error: `No se dio de baja: Odoo quedó cortado pero el perimetral no respondió (${e.message}). Probá de nuevo.` });
      }
    }

    await pool.query(
      "UPDATE instances SET status='cancelled', suspended_at=COALESCE(suspended_at,NOW()), updated_at=NOW() WHERE id=$1",
      [req.params.id]
    );
    await pool.query('INSERT INTO admin_logs (user_id,action,target,detail) VALUES ($1,$2,$3,$4)',
      [req.user.id, 'cancel_instance', `instance:${req.params.id}`, JSON.stringify({ db, tenant })]).catch(() => {});
    console.log(`[admin] Instancia dada de baja: ${db}`);
    res.json({ success: true, message: `"${label || tenant}" dada de baja. El acceso quedó cortado; la base del cliente no se borró.` });
  } catch (err) {
    console.error('[baja instancia]', err.message);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});


// ── Dashboard stats ───────────────────────────────────────
router.get('/dashboard-stats', async (req, res) => {
  try {
    const [leads, users, instances, leadsByStatus, recentLeads] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM leads'),
      pool.query('SELECT COUNT(*) FROM users WHERE role = $1', ['client']),
      pool.query('SELECT COUNT(*) FROM instances WHERE status = $1', ['active']),
      pool.query(`SELECT status, COUNT(*) as count FROM leads GROUP BY status ORDER BY count DESC`),
      pool.query(`SELECT full_name, company_name, source, status, created_at FROM leads ORDER BY created_at DESC LIMIT 5`),
    ]);
    res.json({
      success: true,
      data: {
        total_leads:       parseInt(leads.rows[0].count),
        total_clients:     parseInt(users.rows[0].count),
        active_instances:  parseInt(instances.rows[0].count),
        leads_by_status:   leadsByStatus.rows,
        recent_leads:      recentLeads.rows,
      }
    });
  } catch (err) {
    console.error('[admin/dashboard-stats]', err.message);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

// ── Upload asset genérico (no toca logo_url) ─────────────
router.post('/upload/asset', async (req, res) => {
  const fs   = require('fs');
  const path = require('path');
  try {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      const buffer = Buffer.concat(chunks);
      const contentType = req.headers['content-type'] || '';
      if (!contentType.startsWith('image/'))
        return res.status(400).json({ success: false, error: 'Solo se aceptan imágenes' });
      const ext = contentType.split('/')[1].replace('jpeg','jpg');
      const filename = `asset_${Date.now()}.${ext}`;
      const uploadDir = path.join(process.env.FRONTEND_PATH || '/app/frontend', 'assets', 'uploads');
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
      fs.writeFileSync(path.join(uploadDir, filename), buffer);
      const url = `/assets/uploads/${filename}`;
      await pool.query(
        `INSERT INTO uploads (filename, original_name, mime_type, size_bytes, url, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [filename, 'asset', contentType, buffer.length, url, req.user.id]
      );
      res.json({ success: true, data: { url } });
    });
  } catch (err) {
    console.error('[admin/upload/asset]', err.message);
    res.status(500).json({ success: false, error: 'Error al subir imagen' });
  }
});

// ── Instances ─────────────────────────────────────────────────
router.get('/instances', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT i.*, u.email, u.full_name
       FROM instances i LEFT JOIN users u ON u.id = i.user_id
       ORDER BY i.created_at DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, error: 'Error interno' }); }
});

// El estado NO se edita acá: cambiarlo a mano no suspendía ni reactivaba nada en Odoo. Para eso están
// suspender, reactivar y dar de baja, que sí cortan o devuelven el acceso.
router.put('/instances/:id', async (req, res) => {
  const { label, instance_url, db_name, plan, odoo_version, notes, user_id } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE instances SET
         label=COALESCE($1,label), instance_url=COALESCE($2,instance_url),
         db_name=COALESCE($3,db_name), plan=COALESCE($4,plan),
         odoo_version=COALESCE($5,odoo_version),
         notes=COALESCE($6,notes),
         user_id=COALESCE($8,user_id),
         updated_at=NOW()
       WHERE id=$7 RETURNING *`,
      [label,instance_url,db_name,plan,odoo_version,notes,req.params.id,user_id||null]
    );
    if(!rows[0]) return res.status(404).json({ success: false, error: 'No encontrada' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { console.error('[admin/instances PUT]', err.message); res.status(500).json({ success: false, error: 'Error interno' }); }
});

module.exports = router;
