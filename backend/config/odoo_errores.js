// Traduce un error de XML-RPC de Odoo a algo que una persona pueda leer en el Admin.
function traducirErrorOdoo(err) {
  const texto = String(err && err.message ? err.message : err);
  const falla = (err && err.faultString) ? String(err.faultString) : texto;

  if (/hepta_find_or_create.*does not exist|does not exist.*hepta_find_or_create/i.test(falla)) {
    return 'El módulo hepta_integration no está instalado en esa base de Odoo. ' +
           'Instalalo desde Aplicaciones y volvé a intentar.';
  }
  if (/crm\.lead.*(doesn't exist|does not exist)|Object crm\.lead/i.test(falla)) {
    return 'La base de Odoo no tiene la aplicación CRM instalada.';
  }
  if (/AccessDenied|Access denied|Invalid login/i.test(falla)) {
    return 'Odoo rechazó la credencial. Revisá Admin → Credenciales.';
  }
  if (/AccessError|not allowed to (access|create|modify)|no tiene permiso|no puede/i.test(falla)) {
    return 'El usuario de integración no tiene permisos suficientes en Odoo.';
  }
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket hang up/.test(texto)) {
    return 'No se pudo llegar al ERP. Revisá la URL de la credencial y la red.';
  }
  if (/credencial para odoo_erp/i.test(texto)) {
    return 'No hay credencial activa de Odoo ERP. Cargala en Admin → Credenciales.';
  }
  const ultima = falla.split('\n').map(l => l.trim()).filter(Boolean).pop() || texto;
  return ultima.slice(0, 300);
}

module.exports = { traducirErrorOdoo };
