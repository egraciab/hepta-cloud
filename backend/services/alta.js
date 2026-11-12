// ============================================================
//  HEPTA CLOUD — Alta de un tenant en segundo plano
//
//  El alta tarda de 2 a 10 minutos (crear la base e instalar el plan). Antes la petición
//  del Admin quedaba abierta todo ese tiempo y el proxy la cortaba al minuto: el Admin veía
//  un error mientras el alta seguía corriendo. Ahora:
//
//    iniciarAlta(...)  → responde enseguida con un "trabajo" y sigue sola
//    verAlta(id) / listarAltas()  → el Admin consulta cómo va
//
//  Los trabajos viven en memoria (un solo contenedor). Si el backend se reinicia a mitad de
//  un alta, el trabajo se pierde pero el tenant no: se vuelve a pedir el alta con el mismo
//  subdominio y el script retoma donde quedó.
//
//  La contraseña inicial del cliente llega de la API una sola vez y va solo al correo de
//  bienvenida: no se guarda en el trabajo, ni en la base, ni en el log.
// ============================================================
const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool   = require('../config/db');
const { escapeHtml, credencialesDe, textoCredenciales, quitarClaveDeFabrica, detalleError, avisoAlta } =
  require('../config/credenciales_alta');

const BASE_DOMAIN   = 'erp.hepta.com.py';
const TENANT_RE     = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const PLANES        = { starter: 'Despegue', professional: 'Crecimiento' };
const ESPERA_API_MS = 11 * 60 * 1000;          // la API corta a los 10 minutos
const GUARDAR_MS    = 24 * 60 * 60 * 1000;     // cuánto se recuerda un alta terminada

const trabajos = new Map();   // id → trabajo

class ErrorAlta extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ── Vista pública de un trabajo (lo que ve el Admin) ──────────
function vista(t) {
  return {
    id: t.id, tenant: t.tenant, plan: t.plan, plan_nombre: PLANES[t.plan] || t.plan,
    usuario: t.usuario, estado: t.estado, paso: t.paso,
    inicio: t.inicio, fin: t.fin || null,
    segundos: Math.round(((t.fin || Date.now()) - t.inicio) / 1000),
    url: t.url || null, instance_id: t.instance_id || null,
    credenciales_enviadas: !!t.credenciales_enviadas, correo_enviado: !!t.correo_enviado,
    aviso: t.aviso || null, error: t.error || null,
    payment_request_id: t.payment_request_id || null,
  };
}

function limpiar() {
  const ahora = Date.now();
  for (const [id, t] of trabajos)
    if (t.fin && ahora - t.fin > GUARDAR_MS) trabajos.delete(id);
}

const verAlta      = id => (trabajos.has(id) ? vista(trabajos.get(id)) : null);
const listarAltas  = () => { limpiar(); return [...trabajos.values()].sort((a, b) => b.inicio - a.inicio).map(vista); };

// ── POST JSON sin el límite de 5 minutos de fetch ─────────────
// fetch (undici) corta si la respuesta no empieza en 300 s, y un alta puede tardar más.
function postJson(url, apiKey, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('URL de la API de alta inválida')); }
    const datos = JSON.stringify(body);
    const req = (u.protocol === 'https:' ? https : http).request(u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(datos), 'X-API-Key': apiKey || '' },
    }, res => {
      let txt = '';
      res.setEncoding('utf8');
      res.on('data', c => { txt += c; });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(txt); } catch (e) { /* respuesta que no es JSON */ }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`La API de alta no respondió en ${Math.round(timeoutMs / 60000)} minutos`)));
    req.on('error', reject);
    req.end(datos);
  });
}

async function config() {
  const { rows } = await pool.query(
    "SELECT key,value FROM site_config WHERE key IN ('provision_api_url','provision_api_key')");
  const cfg = Object.fromEntries(rows.map(r => [r.key, r.value]));
  if (!cfg.provision_api_url) throw new ErrorAlta(500, 'API de provisioning no configurada');
  return cfg;
}

// ── Iniciar ───────────────────────────────────────────────────
// Valida, registra el trabajo y devuelve su vista. El alta sigue en segundo plano.
async function iniciarAlta({ userId, tenant, plan, label, actorId, paymentRequestId }) {
  tenant = String(tenant || '').trim().toLowerCase();
  plan   = plan || 'starter';

  if (!userId || !tenant) throw new ErrorAlta(400, 'Falta el usuario del cliente o el subdominio');
  if (!TENANT_RE.test(tenant) || tenant.length < 2 || tenant.length > 50)
    throw new ErrorAlta(400, 'Subdominio inválido: solo letras, números y guiones (2 a 50 caracteres)');
  if (plan === 'enterprise')
    throw new ErrorAlta(400, 'El plan Empresa se arma a medida: no tiene alta automática');
  if (!PLANES[plan]) throw new ErrorAlta(400, `Plan desconocido: ${plan}`);

  const db = `${tenant}.${BASE_DOMAIN}`;
  for (const t of trabajos.values())
    if (t.tenant === tenant && t.estado === 'en_curso')
      throw new ErrorAlta(409, `Ya hay un alta en curso para ${tenant}`);

  const { rows: existe } = await pool.query(
    "SELECT id FROM instances WHERE db_name=$1 AND status <> 'cancelled'", [db]);
  if (existe.length) throw new ErrorAlta(409, `El subdominio '${tenant}' ya tiene una instancia`);

  const { rows: us } = await pool.query(
    'SELECT id, email, full_name, role, is_active, last_login_at FROM users WHERE id=$1', [userId]);
  const user = us[0];
  if (!user) throw new ErrorAlta(404, 'Usuario no encontrado');
  if (!user.is_active) throw new ErrorAlta(400, 'Ese usuario está inactivo');
  if (!user.email) throw new ErrorAlta(400, 'Ese usuario no tiene correo');

  const cfg = await config();
  limpiar();

  const t = {
    id: crypto.randomUUID(), tenant, db, plan, usuario: user.email,
    label: label || `${tenant} — Odoo CE`, actorId: actorId || null,
    payment_request_id: paymentRequestId || null,
    estado: 'en_curso', paso: `Creando el sistema e instalando el plan ${PLANES[plan]}`, inicio: Date.now(),
  };
  trabajos.set(t.id, t);
  console.log(`[alta] Iniciando: tenant=${tenant} plan=${plan} user=${user.email} trabajo=${t.id}`);

  ejecutar(t, user, cfg).catch(err => terminarConError(t, err.message));   // sin await: sigue sola
  return vista(t);
}

async function terminarConError(t, mensaje) {
  t.estado = 'error'; t.error = mensaje; t.paso = 'Falló'; t.fin = Date.now();
  console.error(`[alta] ERROR tenant=${t.tenant}: ${mensaje}`);
  if (t.payment_request_id) {
    // Que la solicitud no quede pegada en "provisionando": vuelve a pendiente para reintentar
    try {
      await pool.query(
        "UPDATE payment_requests SET status='pending', updated_at=NOW() WHERE id=$1 AND status='provisioning'",
        [t.payment_request_id]);
    } catch (_) {}
  }
}

async function ejecutar(t, user, cfg) {
  // 1. La API crea la base, instala el plan y fija las credenciales
  const r = await postJson(`${cfg.provision_api_url}/provision`, cfg.provision_api_key, {
    tenant: t.tenant, plan: t.plan,
    client_name: user.full_name || '', client_email: user.email,
  }, ESPERA_API_MS);
  const api = r.data;
  if (!r.ok || !api || !api.success)
    return terminarConError(t, detalleError(api, `La API de alta respondió ${r.status}`));

  // 2. Registrar la instancia
  t.paso = 'Registrando la instancia';
  const { rows: inst } = await pool.query(
    `INSERT INTO instances (user_id,label,instance_url,db_name,plan,odoo_version,status,activated_at)
     VALUES ($1,$2,$3,$4,$5,'19.0','active',NOW()) RETURNING id`,
    [user.id, t.label, api.url, api.db || t.db, t.plan]);
  t.instance_id = inst[0].id;
  t.url = api.url;

  if (t.payment_request_id) {
    await pool.query(
      `UPDATE payment_requests SET status='provisioned', instance_id=$1, updated_at=NOW() WHERE id=$2`,
      [t.instance_id, t.payment_request_id]);
  }
  try {
    await pool.query('INSERT INTO admin_logs (user_id,action,target,detail) VALUES ($1,$2,$3,$4)',
      [t.actorId, 'provision_instance', `instance:${t.instance_id}`,
       JSON.stringify({ tenant: t.tenant, plan: t.plan, url: api.url, credenciales: api.credentials || 'sin_dato' })]);
  } catch (_) {}

  // 3. Correo de bienvenida: el único lugar donde viajan las contraseñas iniciales
  t.paso = 'Enviando el correo de bienvenida';
  const cred   = credencialesDe(api);
  const portal = await accesoPortal(user);
  t.correo_enviado = await correoBienvenida({
    to: user.email, nombre: user.full_name || user.email,
    instancia_url: api.url, plan: PLANES[t.plan], cred, portal,
  });
  t.credenciales_enviadas = !!cred && t.correo_enviado;
  t.aviso = avisoAlta(api, cred, t.correo_enviado, t.tenant);

  t.estado = 'ok'; t.paso = 'Listo'; t.fin = Date.now();
  console.log(`[alta] OK: tenant=${t.tenant} url=${api.url} credenciales=${api.credentials || 'sin_dato'} correo=${t.correo_enviado}`);
}

// ── Acceso al portal ──────────────────────────────────────────
// Un usuario que nunca entró al portal no conoce su contraseña (la cargó el Admin o se generó
// sola). Se le fija una nueva y va en el mismo correo. A quien ya entró alguna vez no se le toca.
async function accesoPortal(user) {
  if (user.role !== 'client' || user.last_login_at) return null;
  try {
    const clave = crypto.randomBytes(12).toString('base64url');
    await pool.query('UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2 AND last_login_at IS NULL',
      [await bcrypt.hash(clave, 10), user.id]);
    return { usuario: user.email, clave };
  } catch (e) {
    console.error('[alta] No se pudo fijar la contraseña del portal:', e.message);
    return null;
  }
}

// ── Correo de bienvenida (plantilla welcome_client) ───────────
async function correoBienvenida({ to, nombre, instancia_url, plan, cred, portal }) {
  const nodemailer = require('nodemailer');
  try {
    const { rows: smtpRows } = await pool.query(
      "SELECT key,value FROM site_config WHERE key LIKE 'smtp%' OR key='logo_url'");
    const smtp = Object.fromEntries(smtpRows.map(r => [r.key, r.value]));
    if (!smtp.smtp_host) { console.log('[welcome_email] SMTP no configurado'); return false; }

    const { rows: tplRows } = await pool.query(
      "SELECT subject, body_html FROM email_templates WHERE slug='welcome_client'");
    if (!tplRows[0]) { console.log('[welcome_email] Plantilla no encontrada'); return false; }

    const logoHtml = smtp.logo_url
      ? `<img src="${smtp.logo_url}" alt="Hepta Cloud" style="max-height:40px;max-width:180px;object-fit:contain"/>`
      : `<div style="display:inline-block;background:#1254A4;border-radius:6px;padding:8px 14px"><span style="color:#ffffff;font-size:14px;font-weight:600;letter-spacing:.5px">HEPTA CLOUD</span></div>`;

    const { rows: wcRows } = await pool.query(
      "SELECT key,value FROM site_config WHERE key LIKE 'email_wc_%' OR key='site_url'");
    const wc = Object.fromEntries(wcRows.map(r => [r.key, r.value]));
    const portalUrl = wc.email_wc_portal_url || (wc.site_url ? wc.site_url + '/portal' : 'https://cloud.hepta.com.py/portal');

    const paso1 = textoCredenciales(cred, wc.email_wc_paso1_desc);
    const paso3 = escapeHtml(wc.email_wc_paso3_desc || 'Gestioná tu suscripción, facturas y soporte') +
      (portal
        ? `<br/>Entrá a <a href="${escapeHtml(portalUrl)}">${escapeHtml(portalUrl)}</a> con ` +
          `<strong>${escapeHtml(portal.usuario)}</strong> y la contraseña ` +
          `<strong style="font-family:monospace">${escapeHtml(portal.clave)}</strong> (es distinta a la del sistema).`
        : '');

    const t = (clave, defecto) => wc[clave] || defecto;
    const armar = str => quitarClaveDeFabrica(String(str)
      .replace(/\{\{nombre\}\}/g, escapeHtml(nombre))
      .replace(/\{\{instancia_url\}\}/g, instancia_url)
      .replace(/\{\{plan\}\}/g, escapeHtml(plan))
      .replace(/\{\{logo_html\}\}/g, logoHtml)
      .replace(/\{\{email_titulo\}\}/g,       t('email_wc_titulo', '¡Tu sistema está listo!'))
      .replace(/\{\{email_subtitulo\}\}/g,    t('email_wc_subtitulo', 'Ya podés acceder a tu sistema'))
      .replace(/\{\{email_cuerpo\}\}/g,       t('email_wc_cuerpo', 'tu instancia fue provisionada y está activa.'))
      .replace(/\{\{email_paso1_titulo\}\}/g, /administrador/i.test(wc.email_wc_paso1_titulo || '') ? 'Ingresá con tu usuario y contraseña' : t('email_wc_paso1_titulo', 'Ingresá con tu usuario y contraseña'))
      .replace(/\{\{email_paso1_desc\}\}/g,   paso1)
      .replace(/\{\{email_paso2_titulo\}\}/g, t('email_wc_paso2_titulo', 'Configurá tu empresa'))
      .replace(/\{\{email_paso2_desc\}\}/g,   t('email_wc_paso2_desc', 'Nombre, RUC, logo y datos de facturación'))
      .replace(/\{\{email_paso3_titulo\}\}/g, t('email_wc_paso3_titulo', 'Explorá tu portal de cliente'))
      .replace(/\{\{email_paso3_desc\}\}/g,   paso3)
      .replace(/\{\{email_cierre\}\}/g,       t('email_wc_cierre', '¿Necesitás ayuda? Respondé este email.'))
      .replace(/\{\{email_version\}\}/g,      t('email_wc_version', 'Hepta Cloud v19'))
      .replace(/\{\{portal_url\}\}/g,         portalUrl), paso1);

    const transporter = nodemailer.createTransport({
      host: smtp.smtp_host, port: parseInt(smtp.smtp_port) || 465,
      secure: smtp.smtp_secure === 'true',
      auth: { user: smtp.smtp_user, pass: smtp.smtp_pass },
      tls: { rejectUnauthorized: false },
    });
    // Si la plantilla guardada no tiene el lugar del paso 3, el acceso al portal va al final:
    // la contraseña del portal ya se cambió y el cliente tiene que recibirla sí o sí.
    let html = armar(tplRows[0].body_html);
    if (portal && !tplRows[0].body_html.includes('{{email_paso3_desc}}'))
      html += `<p style="font-family:sans-serif;font-size:13px;color:#1F2937">${paso3}</p>`;

    await transporter.sendMail({
      from: `${smtp.smtp_from_name} <${smtp.smtp_from_email}>`,
      to, subject: armar(tplRows[0].subject), html,
    });
    console.log(`[welcome_email] Enviado a ${to}`);
    return true;
  } catch (err) {
    console.error('[welcome_email] Error:', err.message);
    return false;
  }
}

module.exports = { iniciarAlta, verAlta, listarAltas, ErrorAlta, PLANES, _correoBienvenida: correoBienvenida };
