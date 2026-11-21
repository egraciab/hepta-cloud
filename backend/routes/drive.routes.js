// ============================================================
//  HEPTA CLOUD — Admin → HEPTA Drive   (/api/admin/drive)
//
//  El alta responde 202 con un trabajo y el Admin consulta /jobs/:id; el trabajo sigue aunque se
//  cierre la ventana (services/drive.js). El paquete de secretos se baja una vez a KeePass: solo
//  godmode, sin caché y sin dejar su contenido en la base ni en admin_logs.
// ============================================================
const router = require('express').Router();
const pool   = require('../config/db');
const drive  = require('../services/drive');
const { requireAuth, requireAdmin, requireGodmode } = require('../middleware/auth');

router.use(requireAuth, requireAdmin);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store, no-cache, must-revalidate'); res.set('Pragma', 'no-cache'); next(); });

function fail(res, err, tag) {
  if (!err.status || err.status >= 500) console.error(`[${tag}]`, err.message);
  res.status(err.status || 500).json({ success: false, error: err.status ? err.message : 'Error interno', data: err.extra || undefined });
}
async function logAction(req, action, target, detail) {
  try {
    await pool.query('INSERT INTO admin_logs (user_id,action,target,detail) VALUES ($1,$2,$3,$4)',
      [req.user.id, action, target, JSON.stringify(detail || {})]);
  } catch (e) { /* la bitácora no frena la acción */ }
}

// ── Estado del agente ──
router.get('/health', async (req, res) => {
  try { res.json({ success: true, data: await drive.salud() }); }
  catch (err) { res.json({ success: false, error: err.message }); }
});

// ── Instancias ──
router.get('/', async (req, res) => {
  try { res.json({ success: true, data: await drive.listar() }); }
  catch (err) { fail(res, err, 'admin/drive GET'); }
});

// ── Validar un pedido (no cambia nada) ──
router.post('/validar', async (req, res) => {
  try { res.json({ success: true, data: await drive.validar(req.body) }); }
  catch (err) { fail(res, err, 'admin/drive/validar'); }
});

// ── Alta ──
router.post('/', async (req, res) => {
  try {
    const data = await drive.crear(req.body, req.user.id);
    // En la bitácora queda quién pidió qué; los correos de los usuarios no hacen falta ahí
    await logAction(req, 'drive_create', data.slug, { trabajo: data.trabajo, usuarios: (req.body.usuarios || []).length });
    res.status(202).json({ success: true, data });
  } catch (err) { fail(res, err, 'admin/drive POST'); }
});

router.get('/jobs/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const t = Number.isInteger(id) ? await drive.verTrabajo(id) : null;
    if (!t) return res.status(404).json({ success: false, error: 'No existe ese trabajo' });
    res.json({ success: true, data: t });
  } catch (err) { fail(res, err, 'admin/drive/jobs'); }
});

router.post('/:slug/verificar', async (req, res) => {
  try { res.json({ success: true, data: await drive.verificar(req.params.slug) }); }
  catch (err) { fail(res, err, 'admin/drive/verificar'); }
});

// Publicar la dirección (vhost en el NGINX perimetral): reintento o instancia creada por consola
router.post('/:slug/publicar', async (req, res) => {
  try {
    const data = await drive.publicar(req.params.slug);
    await logAction(req, 'drive_publish', data.slug, {});
    res.json({ success: true, data });
  } catch (err) { fail(res, err, 'admin/drive/publicar'); }
});

// Dominio propio del cliente (se suma al nombre de HEPTA). Trabajo en segundo plano.
router.post('/:slug/dominio', async (req, res) => {
  try {
    const data = await drive.dominioPropio(req.params.slug, req.body, req.user.id);
    await logAction(req, 'drive_custom_domain', data.slug, { trabajo: data.trabajo, dominio: data.dominio });
    res.status(202).json({ success: true, data });
  } catch (err) { fail(res, err, 'admin/drive/dominio'); }
});

// ── Usuarios de una instancia ──
router.get('/:slug/usuarios', async (req, res) => {
  try { res.json({ success: true, data: await drive.usuarios(req.params.slug) }); }
  catch (err) { fail(res, err, 'admin/drive/usuarios GET'); }
});

router.post('/:slug/usuarios', async (req, res) => {
  try {
    const data = await drive.agregarUsuarios(req.params.slug, req.body, req.user.id);
    await logAction(req, 'drive_add_users', data.slug, { trabajo: data.trabajo, usuarios: data.usuarios });
    res.status(202).json({ success: true, data });
  } catch (err) { fail(res, err, 'admin/drive/usuarios POST'); }
});

// Cortar o devolver el acceso: reversible, no toca archivos
router.post('/:slug/usuarios/estado', async (req, res) => {
  try {
    const data = await drive.estadoUsuario(req.params.slug, req.body);
    await logAction(req, data.activo ? 'drive_user_enable' : 'drive_user_disable', req.params.slug, { usuario: data.usuario });
    res.json({ success: true, data });
  } catch (err) { fail(res, err, 'admin/drive/usuarios/estado'); }
});

// Borrar a un usuario no se deshace: solo godmode
router.post('/:slug/usuarios/eliminar', requireGodmode, async (req, res) => {
  try {
    const data = await drive.eliminarUsuario(req.params.slug, req.body, req.user.id);
    await logAction(req, 'drive_user_delete', data.slug, { trabajo: data.trabajo, usuario: data.usuario, archivos: data.transferir_a ? `pasados a ${data.transferir_a}` : 'borrados' });
    res.status(202).json({ success: true, data });
  } catch (err) { fail(res, err, 'admin/drive/usuarios/eliminar'); }
});

// ── Secretos del alta (solo godmode) ──
router.get('/:slug/secretos', requireGodmode, async (req, res) => {
  try {
    const csv = await drive.secretos(req.params.slug);
    await logAction(req, 'drive_secrets_download', req.params.slug, {});
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="hepta-drive-${req.params.slug}.csv"`);
    res.send(csv);
  } catch (err) { fail(res, err, 'admin/drive/secretos'); }
});

router.post('/:slug/secretos/guardado', requireGodmode, async (req, res) => {
  try {
    await drive.secretosGuardados(req.params.slug);
    await logAction(req, 'drive_secrets_saved', req.params.slug, {});
    res.json({ success: true });
  } catch (err) { fail(res, err, 'admin/drive/secretos/guardado'); }
});

module.exports = router;
