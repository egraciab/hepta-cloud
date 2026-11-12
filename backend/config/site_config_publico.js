// Qué claves de site_config son internas (credenciales o infraestructura) y cuáles son secretos.
//
//  · esClaveSensible(key): no se entrega en /api/site-config (público). Incluye direcciones internas.
//  · esSecreto(key):       además se enmascara en el Admin (GET /api/admin/config) y no se pisa si
//                          vuelve enmascarado (PUT).
//
// Regla para agregar una clave nueva con una credencial: que su nombre termine en _key, _token,
// _pass, _password o _secret, o que empiece con uno de los prefijos internos de abajo.
const SECRETO = /(pass(word)?|secret|token|api_?key|_key)$/i;
const INTERNO = /^(smtp_|provision_|perimetral_|cloudflare_|certbot_|odoo_|mailcow_|retopa_api_|retopa_auto_|retopa_enabled$)/i;

const esSecreto = key => SECRETO.test(String(key || ''));
const esClaveSensible = key => esSecreto(key) || INTERNO.test(String(key || ''));
const MASCARA = '••••••••';

module.exports = { esSecreto, esClaveSensible, MASCARA };
