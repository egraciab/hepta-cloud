// ── Credenciales iniciales de un tenant ───────────────────────────────────────
// La API de alta devuelve el usuario y la contraseña inicial del cliente UNA sola vez
// (credentials = 'nuevas'). HEPTA Cloud los pone en el correo de bienvenida y no los guarda:
// ni en la base, ni en admin_logs, ni en la respuesta al navegador, ni en console.log.
// Nunca más "admin / admin".

const escapeHtml = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Lo que devolvió la API → { usuario, clave } o null si no hay credenciales nuevas
function credencialesDe(apiData) {
  if (apiData && apiData.credentials === 'nuevas' && apiData.admin_login && apiData.admin_password)
    return { usuario: apiData.admin_login, clave: apiData.admin_password };
  return null;
}

const TEXTO_CON_CLAVE = 'Usuario: {{usuario}} · Contraseña: {{clave}} (cambiala al primer ingreso)';
const TEXTO_SIN_CLAVE = 'Ingresá con el usuario y la contraseña que ya tenés. Si no los tenés, respondé este correo y te ayudamos.';

// Texto (HTML) del paso "ingresá con tus credenciales". `plantilla` es el texto editable del
// Admin (email_wc_paso1_desc): se usa solo si trae {{clave}}; el texto viejo con admin/admin
// se ignora.
function textoCredenciales(cred, plantilla) {
  if (!cred) return TEXTO_SIN_CLAVE;
  const base = plantilla && plantilla.includes('{{clave}}') ? plantilla : TEXTO_CON_CLAVE;
  return escapeHtml(base)
    .replace(/\{\{usuario\}\}/g, `<strong>${escapeHtml(cred.usuario)}</strong>`)
    .replace(/\{\{clave\}\}/g, `<strong style="font-family:monospace">${escapeHtml(cred.clave)}</strong>`);
}

// Red de seguridad: si una plantilla guardada en la base todavía trae el texto de fábrica,
// se reemplaza antes de enviar.
const quitarClaveDeFabrica = (html, texto) =>
  String(html).replace(/Usuario:\s*admin\s*[·\/|-]\s*Contraseña:\s*admin(\s*\([^)<]*\))?/gi, texto);

// La API responde { detail: 'texto' } o, si falla una validación, { detail: [{ msg }] }
function detalleError(apiData, porDefecto) {
  const d = apiData && (apiData.detail || apiData.error);
  if (Array.isArray(d)) return d.map(x => String(x.msg || '').replace(/^Value error,\s*/, '')).join(' · ') || porDefecto;
  return d ? String(d) : porDefecto;
}

// Aviso para el Admin cuando el alta terminó pero falta algo que tiene que resolver una persona
function avisoAlta(apiData, cred, correoEnviado, tenant) {
  if (cred && !correoEnviado)
    return `El sistema quedó creado, pero el correo de bienvenida NO salió y la contraseña inicial no se guarda en ningún lado. ` +
           `Fijale una al cliente en el servidor de tenants: tools/tenants/clave_usuario.sh ${tenant} ${cred.usuario}`;
  if (cred) return null;
  const c = apiData && apiData.credentials;
  if (c === undefined)
    return 'La API de alta respondió sin el estado de credenciales (versión vieja): el sistema puede haber nacido con la contraseña de fábrica. Revisalo con tools/tenants/auditar_clave_admin.sh.';
  if (c === 'solo_admin') return 'El sistema quedó creado, pero sin usuario para el cliente (el alta no recibió su correo).';
  if (c === 'sin_cambios') return 'Esa base ya existía: se revisó el plan y no se cambió ninguna contraseña.';
  return null;
}

module.exports = { escapeHtml, credencialesDe, textoCredenciales, quitarClaveDeFabrica, detalleError, avisoAlta };
