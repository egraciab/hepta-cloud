// ---------------------------------------------------------------------------
// Cifrado de secretos de integración (AES-256-GCM)
//
// La clave maestra vive en el .env como HEPTA_SECRET_KEY (64 caracteres hex =
// 32 bytes). Se cifra y descifra ACA, en el proceso de Node: a Postgres solo
// llega el texto cifrado. Con pgcrypto la clave maestra viajaría como
// parámetro de la consulta y podría terminar en los logs del motor.
//
// Formato guardado: iv(12) || tag(16) || ciphertext
//
// Para generar la clave maestra:
//     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// ---------------------------------------------------------------------------
const crypto = require('crypto');

const ALGORITMO = 'aes-256-gcm';
const LARGO_IV  = 12;
const LARGO_TAG = 16;

function claveMaestra() {
  const hex = process.env.HEPTA_SECRET_KEY;
  if (!hex) {
    throw new Error(
      'Falta HEPTA_SECRET_KEY en el .env. Generar con: ' +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('HEPTA_SECRET_KEY debe ser de 64 caracteres hexadecimales (32 bytes).');
  }
  return Buffer.from(hex, 'hex');
}

function cifrar(texto) {
  if (typeof texto !== 'string' || !texto) {
    throw new Error('No hay nada que cifrar.');
  }
  const iv = crypto.randomBytes(LARGO_IV);
  const cipher = crypto.createCipheriv(ALGORITMO, claveMaestra(), iv);
  const ct = Buffer.concat([cipher.update(texto, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

function descifrar(buffer) {
  if (!buffer || buffer.length <= LARGO_IV + LARGO_TAG) {
    throw new Error('El secreto guardado está vacío o incompleto.');
  }
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const iv  = buf.subarray(0, LARGO_IV);
  const tag = buf.subarray(LARGO_IV, LARGO_IV + LARGO_TAG);
  const ct  = buf.subarray(LARGO_IV + LARGO_TAG);
  const decipher = crypto.createDecipheriv(ALGORITMO, claveMaestra(), iv);
  decipher.setAuthTag(tag);
  // Si la clave maestra cambió o el dato fue alterado, esto lanza. Es
  // deliberado: mejor un error claro que una credencial silenciosamente rota.
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

function ultimos4(texto) {
  return (texto || '').slice(-4);
}

// Chequeo temprano: que el arranque falle con un mensaje entendible en vez de
// romper recién cuando alguien abre la pantalla de credenciales.
function verificarConfiguracion() {
  claveMaestra();
  const prueba = 'hepta';
  if (descifrar(cifrar(prueba)) !== prueba) {
    throw new Error('El cifrado de secretos no está funcionando.');
  }
  return true;
}

module.exports = { cifrar, descifrar, ultimos4, verificarConfiguracion };
