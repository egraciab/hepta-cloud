'use strict';

/**
 * Servicio de Correo de HEPTA Cloud.
 * Toda la lógica de negocio vive acá; las rutas son una cáscara fina.
 *
 * La API key de mailcow es global (toca cualquier dominio del servidor), así
 * que el aislamiento entre clientes lo garantiza ESTE módulo: ninguna
 * operación del portal se ejecuta sin pasar antes por assertOwnership().
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pool = require('../../config/db');
const mc = require('./client');
const { buildDnsRecords, renderDnsText } = require('./dns');

const DEFAULT_DOMAIN_QUOTA_MB = 10240;
const DEFAULT_MAILBOX_QUOTA_MB = 1024;
const DEFAULT_MAX_MAILBOXES = 50;

const LOCAL_PART_RE = /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/;

class MailServiceError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'MailServiceError';
    this.status = status;
  }
}

/** Password inicial legible pero fuerte: Hepta-7f3a9c2d1b */
const generatePassword = (prefix = 'Hepta') => `${prefix}-${crypto.randomBytes(5).toString('hex')}`;

const normalizeDomain = (d) =>
  String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
const normalizeEmail = (e) => String(e || '').trim().toLowerCase();

/* ---------------------------------------------------------------- helpers */

async function findDomain(domain) {
  const { rows } = await pool.query('SELECT * FROM mail_domains WHERE domain = $1 LIMIT 1', [
    normalizeDomain(domain),
  ]);
  return rows[0] || null;
}

/**
 * Único punto de verdad del aislamiento entre clientes.
 * La propiedad se resuelve por EMAIL: el JWT de RetoPA trae el id de RetoPA,
 * no el de HC, así que el email es la clave compartida entre plataformas.
 */
async function assertOwnership(domain, userEmail, { isAdmin = false, role = null } = {}) {
  const row = await findDomain(domain);
  // 404 y no 403 en ambos casos: no le confirmamos a un tercero que el dominio existe.
  if (!row) throw new MailServiceError(`El dominio ${normalizeDomain(domain)} no está dado de alta en HEPTA Cloud`, 404);

  // Dominio sin dueño: queda bajo custodia de godmode y de nadie más.
  if (!row.owner_email) {
    if (role === 'godmode') return row;
    throw new MailServiceError(
      `El dominio ${normalizeDomain(domain)} no tiene dueño asignado: solo godmode puede gestionarlo`,
      403
    );
  }

  if (isAdmin) return row;

  if (normalizeEmail(row.owner_email) !== normalizeEmail(userEmail)) {
    throw new MailServiceError(`El dominio ${normalizeDomain(domain)} no está dado de alta en HEPTA Cloud`, 404);
  }
  if (row.status === 'suspended') throw new MailServiceError('El servicio de correo está suspendido', 403);
  return row;
}

async function log(domain, action, ok, detail) {
  try {
    await pool.query(
      'INSERT INTO mail_provision_log (domain, action, success, detail) VALUES ($1,$2,$3,$4)',
      [normalizeDomain(domain), action, ok, detail ? String(detail).slice(0, 2000) : null]
    );
  } catch (err) {
    console.error('[mail/log]', err.message); // el log nunca debe tumbar la operación
  }
}

/* ----------------------------------------------------------- provisioning */

/**
 * Alta o re-sincronización de un dominio de correo. Idempotente.
 * Devuelve el plan DNS completo, listo para mostrar en el admin.
 */
async function provisionDomain({
  domain,
  ownerEmail,
  quotaMb = DEFAULT_DOMAIN_QUOTA_MB,
  defQuotaMb = DEFAULT_MAILBOX_QUOTA_MB,
  maxMailboxes = DEFAULT_MAX_MAILBOXES,
  description = '',
  planCode = null,
  dkimSelector = 'dkim',
}) {
  const d = normalizeDomain(domain);
  // El dueño es opcional: un dominio sin dueño queda bajo custodia de godmode
  // hasta que se delegue. Sirve para dar de alta antes de tener al cliente.
  const owner = ownerEmail ? normalizeEmail(ownerEmail) : null;
  if (!d || !d.includes('.')) throw new MailServiceError('Dominio inválido');
  if (owner && !owner.includes('@')) throw new MailServiceError('owner_email inválido');

  // 1. dominio en mailcow (crear, o alinear cuotas si ya existía)
  const existing = await mc.getDomain(d);
  if (!existing) {
    await mc.addDomain({ domain: d, quotaMb, defQuotaMb, maxQuotaMb: quotaMb, mailboxes: maxMailboxes, description });
  } else {
    await mc.editDomain(d, {
      quota: String(quotaMb),
      defquota: String(defQuotaMb),
      maxquota: String(quotaMb),
      mailboxes: String(maxMailboxes),
      active: '1',
    });
  }

  // 2. DKIM: si ya existe, mailcow rechaza el alta — lo ignoramos y leemos la clave
  let dkim = await mc.getDkim(d);
  if (!dkim) {
    try {
      await mc.addDkim(d, dkimSelector, 2048);
    } catch (err) {
      await log(d, 'dkim', false, err.message);
    }
    dkim = await mc.getDkim(d);
  }

  // 3. registro en HEPTA Cloud
  await pool.query(
    `INSERT INTO mail_domains (domain, owner_email, quota_mb, def_quota_mb, max_mailboxes, dkim_selector, plan_code, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'active')
     ON CONFLICT (domain) DO UPDATE SET
       owner_email   = EXCLUDED.owner_email,
       quota_mb      = EXCLUDED.quota_mb,
       def_quota_mb  = EXCLUDED.def_quota_mb,
       max_mailboxes = EXCLUDED.max_mailboxes,
       dkim_selector = EXCLUDED.dkim_selector,
       plan_code     = COALESCE(EXCLUDED.plan_code, mail_domains.plan_code),
       status        = 'active',
       updated_at    = now()`,
    [d, owner, quotaMb, defQuotaMb, maxMailboxes, dkim ? dkim.selector : dkimSelector, planCode]
  );

  await log(d, existing ? 'resync' : 'provision', true, `owner=${owner || '(sin dueño)'} quota=${quotaMb}MB`);

  const dns = buildDnsRecords({ domain: d, dkim });
  return { domain: d, created: !existing, quota_mb: quotaMb, dns, dns_text: renderDnsText(dns) };
}

async function getDnsPlan(domain) {
  const d = normalizeDomain(domain);
  const dkim = await mc.getDkim(d);
  const dns = buildDnsRecords({ domain: d, dkim });
  return { ...dns, dns_text: renderDnsText(dns) };
}

async function setDomainStatus(domain, status) {
  const d = normalizeDomain(domain);
  await mc.editDomain(d, { active: status === 'active' ? '1' : '0' });
  await pool.query('UPDATE mail_domains SET status = $2, updated_at = now() WHERE domain = $1', [d, status]);
  await log(d, `status:${status}`, true, null);
  return { domain: d, status };
}

/* ---------------------------------------------------------------- buzones */

function shapeMailbox(m) {
  const quotaMb = Math.round((Number(m.quota) || 0) / 1048576);
  const usedMb = Math.round((Number(m.quota_used) || 0) / 1048576);
  return {
    address: m.username,
    name: m.name,
    active: String(m.active) === '1' || m.active === 1 || m.active === true,
    quota_mb: quotaMb,
    used_mb: usedMb,
    used_pct: quotaMb ? Math.min(100, Math.round((usedMb / quotaMb) * 100)) : 0,
    last_login: m.last_imap_login || m.last_pop3_login || m.last_smtp_login || null,
  };
}

async function listMailboxes(domain) {
  const d = normalizeDomain(domain);
  const row = await findDomain(d);
  const mailboxes = (await mc.getMailboxes(d)).map(shapeMailbox);
  const assigned = mailboxes.reduce((acc, b) => acc + b.quota_mb, 0);
  const quotaMb = row ? row.quota_mb : DEFAULT_DOMAIN_QUOTA_MB;

  return {
    domain: d,
    quota_mb: quotaMb,
    quota_assigned_mb: assigned,
    quota_available_mb: Math.max(0, quotaMb - assigned),
    max_mailboxes: row ? row.max_mailboxes : DEFAULT_MAX_MAILBOXES,
    def_quota_mb: row ? row.def_quota_mb : DEFAULT_MAILBOX_QUOTA_MB,
    mailboxes,
  };
}

async function createMailbox(domain, { localPart, name, quotaMb, password }) {
  const d = normalizeDomain(domain);
  const lp = String(localPart || '').trim().toLowerCase();
  // Distinguir "no llegó nada" de "llegó algo inválido" ahorra horas de
  // diagnóstico: lo primero suele ser el body sin parsear, no un error del usuario.
  if (!lp) throw new MailServiceError('No llegó el nombre de la casilla (body vacío o sin local_part)');
  if (!LOCAL_PART_RE.test(lp)) {
    throw new MailServiceError(`Nombre de casilla inválido ("${lp}"): usá letras, números, punto, guion y guion bajo`);
  }

  const state = await listMailboxes(d);
  if (state.mailboxes.length >= state.max_mailboxes) {
    throw new MailServiceError(`Llegaste al máximo de ${state.max_mailboxes} casillas de tu plan`);
  }
  if (state.mailboxes.some((m) => m.address === `${lp}@${d}`)) {
    throw new MailServiceError(`La casilla ${lp}@${d} ya existe`);
  }

  const wanted = Number(quotaMb) > 0 ? Math.floor(Number(quotaMb)) : state.def_quota_mb;
  if (wanted > state.quota_available_mb) {
    throw new MailServiceError(
      `No alcanza la cuota: pediste ${wanted}MB y quedan ${state.quota_available_mb}MB libres de los ${state.quota_mb}MB del dominio`
    );
  }

  const pass = password || generatePassword();
  await mc.addMailbox({ localPart: lp, domain: d, name: name || lp, password: pass, quotaMb: wanted });
  await log(d, 'mailbox:create', true, `${lp}@${d} ${wanted}MB`);

  return {
    address: `${lp}@${d}`,
    quota_mb: wanted,
    // Solo se devuelve si la generó HC. Si la eligió el cliente, no la eco.
    password: password ? null : pass,
    force_password_change: true,
  };
}

async function updateMailbox(domain, address, { quotaMb, name, active, password }) {
  const d = normalizeDomain(domain);
  const addr = normalizeEmail(address);
  if (!addr.endsWith(`@${d}`)) throw new MailServiceError('La casilla no pertenece a este dominio', 403);

  const attr = {};

  if (quotaMb !== undefined) {
    const state = await listMailboxes(d);
    const current = state.mailboxes.find((m) => m.address === addr);
    if (!current) throw new MailServiceError('Casilla inexistente', 404);

    const wanted = Math.floor(Number(quotaMb));
    if (!(wanted > 0)) throw new MailServiceError('Cuota inválida');

    const headroom = state.quota_available_mb + current.quota_mb;
    if (wanted > headroom) {
      throw new MailServiceError(`No alcanza la cuota: el máximo asignable a esta casilla es ${headroom}MB`);
    }
    if (wanted < current.used_mb) {
      throw new MailServiceError(`La casilla ya usa ${current.used_mb}MB, no podés bajarla a ${wanted}MB`);
    }
    attr.quota = String(wanted);
  }

  if (name !== undefined) attr.name = String(name).slice(0, 100);
  if (active !== undefined) attr.active = active ? '1' : '0';
  if (password) {
    attr.password = password;
    attr.password2 = password;
  }

  if (Object.keys(attr).length === 0) throw new MailServiceError('Nada para actualizar');

  await mc.editMailbox([addr], attr);
  await log(d, 'mailbox:update', true, `${addr} ${Object.keys(attr).join(',')}`);
  return { address: addr, updated: Object.keys(attr) };
}

async function resetPassword(domain, address) {
  const pass = generatePassword();
  await updateMailbox(domain, address, { password: pass });
  await mc.editMailbox([normalizeEmail(address)], { force_pw_update: '1' });
  return { address: normalizeEmail(address), password: pass, force_password_change: true };
}

async function deleteMailbox(domain, address) {
  const d = normalizeDomain(domain);
  const addr = normalizeEmail(address);
  if (!addr.endsWith(`@${d}`)) throw new MailServiceError('La casilla no pertenece a este dominio', 403);
  await mc.deleteMailbox([addr]);
  await log(d, 'mailbox:delete', true, addr);
  return { address: addr, deleted: true };
}

/* ------------------------------------------------------------------ alias */

async function listAliases(domain) {
  const d = normalizeDomain(domain);
  return (await mc.getAliases(d)).map((a) => ({
    id: a.id,
    address: a.address,
    goto: a.goto,
    active: String(a.active) === '1',
  }));
}

/**
 * Crea un alias: una dirección que no ocupa cuota y reparte a una o varias
 * casillas reales.
 *
 * `localPart` puede ser '@' o '*' para un catch-all (todo lo que llegue a
 * cualquier dirección inexistente del dominio).
 *
 * Por defecto los destinos tienen que ser casillas del MISMO dominio: un alias
 * hacia afuera convierte al servidor en reenviador y es la forma más rápida de
 * terminar en una blacklist. El admin puede levantar esa restricción
 * (allowExternal) para casos de migración.
 */
async function createAlias(domain, { localPart, goto }, { allowExternal = false } = {}) {
  const d = normalizeDomain(domain);
  const lp = String(localPart || '').trim().toLowerCase();

  const esCatchAll = lp === '@' || lp === '*';
  if (!esCatchAll && !LOCAL_PART_RE.test(lp)) {
    if (!lp) throw new MailServiceError('No llegó el nombre del alias (body vacío o sin local_part)');
    throw new MailServiceError(`Alias inválido ("${lp}"): usá letras, números, punto, guion y guion bajo`);
  }
  const address = esCatchAll ? `@${d}` : `${lp}@${d}`;

  const targets = String(goto || '').split(',').map(normalizeEmail).filter(Boolean);
  if (targets.length === 0) throw new MailServiceError('Indicá al menos un destino');

  const boxes = (await listMailboxes(d)).mailboxes.map((m) => m.address);
  if (boxes.includes(address)) {
    throw new MailServiceError(`${address} ya existe como casilla: un alias no puede pisar una casilla real`);
  }

  const externos = targets.filter((t) => !boxes.includes(t));
  if (externos.length && !allowExternal) {
    throw new MailServiceError(
      externos.length === 1
        ? `El destino ${externos[0]} no es una casilla de ${d}`
        : `Estos destinos no son casillas de ${d}: ${externos.join(', ')}`
    );
  }

  const yaExiste = (await listAliases(d)).some((a) => normalizeEmail(a.address) === address);
  if (yaExiste) throw new MailServiceError(`El alias ${address} ya existe`);

  await mc.addAlias({ address, goto: targets.join(',') });
  await log(d, 'alias:create', true, `${address} -> ${targets.join(',')}${externos.length ? ' (con destinos externos)' : ''}`);
  return { address, goto: targets, catch_all: esCatchAll, externos };
}

async function deleteAlias(domain, id) {
  const d = normalizeDomain(domain);
  const found = (await listAliases(d)).find((a) => String(a.id) === String(id));
  if (!found) throw new MailServiceError('Alias inexistente en este dominio', 404);
  await mc.deleteAlias([String(id)]);
  await log(d, 'alias:delete', true, found.address);
  return { id, deleted: true };
}

/* -------------------------------------------------------------- consultas */

async function listDomainsByOwner(ownerEmail) {
  const { rows } = await pool.query(
    `SELECT domain, quota_mb, def_quota_mb, max_mailboxes, status, created_at
       FROM mail_domains WHERE lower(owner_email) = lower($1) ORDER BY domain`,
    [normalizeEmail(ownerEmail)]
  );
  return rows;
}

async function listAllDomains() {
  // Marca si el dueño tiene usuario en el portal: sin eso, el cliente entra
  // y no ve nada. Es el error más común al dar de alta a mano.
  try {
    const { rows } = await pool.query(
      `SELECT d.*, (u.email IS NOT NULL) AS owner_tiene_usuario
         FROM mail_domains d
         LEFT JOIN users u ON lower(u.email) = lower(d.owner_email)
        ORDER BY d.created_at DESC`
    );
    return rows;
  } catch (err) {
    console.error('[mail/listAllDomains join users]', err.message);
    const { rows } = await pool.query('SELECT * FROM mail_domains ORDER BY created_at DESC');
    return rows;
  }
}

/* ------------------------------------------------------- delegación */

/** Usuarios del portal, tolerante a diferencias de esquema. */
async function usuariosDelPortal() {
  try {
    const { rows } = await pool.query('SELECT email, full_name, role, active FROM users ORDER BY email');
    return rows;
  } catch (_) {
    try {
      const { rows } = await pool.query('SELECT email FROM users ORDER BY email');
      return rows;
    } catch (err) {
      console.error('[mail/usuariosDelPortal]', err.message);
      return [];
    }
  }
}

/**
 * Candidatos para delegar la gestión de un dominio: las casillas del propio
 * dominio y los usuarios del portal, marcando en cada caso si esa dirección
 * puede realmente entrar a HEPTA Cloud.
 */
async function getDelegationOptions(domain) {
  const d = normalizeDomain(domain);
  const row = await findDomain(d);
  if (!row) throw new MailServiceError(`El dominio ${d} no está dado de alta en HEPTA Cloud`, 404);

  const usuarios = await usuariosDelPortal();
  const porEmail = new Map(usuarios.map((u) => [normalizeEmail(u.email), u]));

  let casillas = [];
  try {
    casillas = (await mc.getMailboxes(d)).map((m) => normalizeEmail(m.username));
  } catch (err) {
    console.error('[mail/getDelegationOptions mailcow]', err.message);
  }

  const opciones = casillas.map((email) => {
    const u = porEmail.get(email);
    return {
      email,
      origen: 'casilla del dominio',
      tiene_usuario: Boolean(u),
      nombre: u ? u.full_name || null : null,
      activo: u ? u.active !== false : null,
    };
  });

  for (const u of usuarios) {
    const email = normalizeEmail(u.email);
    if (casillas.includes(email)) continue;
    opciones.push({
      email,
      origen: 'usuario del portal',
      tiene_usuario: true,
      nombre: u.full_name || null,
      activo: u.active !== false,
    });
  }

  return { domain: d, owner_email: row.owner_email, opciones };
}

/**
 * Webmail con marca propia: guarda el host (p. ej. mail.cliente.com.py) que
 * el portal le muestra al cliente. HEPTA Cloud solo lo registra; el vhost y el
 * certificado se crean en la VM del Nginx perimetral con webmail_add.sh, que
 * es donde vive Nginx — este backend no tiene acceso a esa máquina.
 */
async function setWebmailHost(domain, webmailHost) {
  const d = normalizeDomain(domain);
  const host = webmailHost ? normalizeDomain(webmailHost) : null;
  if (host && !host.includes('.')) throw new MailServiceError('Host de webmail inválido');

  const row = await findDomain(d);
  if (!row) throw new MailServiceError(`El dominio ${d} no está dado de alta en HEPTA Cloud`, 404);

  await pool.query('UPDATE mail_domains SET webmail_host = $2, updated_at = now() WHERE domain = $1', [d, host]);
  await log(d, 'webmail:set', true, `${row.webmail_host || '(por defecto)'} -> ${host || '(por defecto)'}`);

  const base = process.env.MAIL_HOSTNAME || 'mail.hepta.com.py';
  return {
    domain: d,
    webmail_host: host,
    anterior: row.webmail_host || null,
    // Lo que falta hacer afuera para que esto funcione de verdad:
    cname: host ? { nombre: host.replace(`.${d}`, ''), tipo: 'CNAME', valor: base, proxy: 'desactivado (nube gris)' } : null,
    comando: host ? `sudo ./webmail_add.sh ${host}` : null,
  };
}

/* ------------------------------------------- branding del webmail */

/** Carpeta persistida: frontend/ es un volumen montado, sobrevive al rebuild. */
const LOGO_DIR = path.join(__dirname, '..', '..', '..', 'frontend', 'assets', 'uploads');
const LOGO_RE = /^maillogo_[a-z0-9._-]+\.(png|jpg|jpeg|webp)$/i;

function rutaLogo(nombre) {
  // Solo nombres que generamos nosotros: corta cualquier intento de path traversal.
  if (!nombre || !LOGO_RE.test(nombre)) return null;
  return path.join(LOGO_DIR, nombre);
}

async function findDomainByWebmailHost(host) {
  const h = normalizeDomain(host);
  if (!h) return null;
  const { rows } = await pool.query(
    'SELECT domain, webmail_host, webmail_logo_url, webmail_color, webmail_title FROM mail_domains WHERE lower(webmail_host) = lower($1) LIMIT 1',
    [h]
  );
  return rows[0] || null;
}

/** Guarda logo, color y/o título de marca del webmail. Pasar null borra el valor. */
async function setWebmailBranding(domain, { logoFile, color, titulo } = {}) {
  const d = normalizeDomain(domain);
  const row = await findDomain(d);
  if (!row) throw new MailServiceError(`El dominio ${d} no está dado de alta en HEPTA Cloud`, 404);

  const sets = [];
  const vals = [d];

  if (logoFile !== undefined) {
    if (logoFile && !LOGO_RE.test(logoFile)) throw new MailServiceError('Nombre de logo inválido');
    vals.push(logoFile || null);
    sets.push(`webmail_logo_url = $${vals.length}`);
  }
  if (color !== undefined) {
    const c = color ? String(color).trim() : null;
    if (c && !/^#[0-9a-f]{3,8}$/i.test(c)) throw new MailServiceError('Color inválido: usá formato #RRGGBB');
    vals.push(c);
    sets.push(`webmail_color = $${vals.length}`);
  }
  if (titulo !== undefined) {
    // Va a parar al <title> y al encabezado del login del cliente. Se limpia
    // acá y no en el navegador: los caracteres de markup no tienen por qué
    // llegar nunca a la página.
    let t = titulo ? String(titulo).replace(/[<>]/g, '').trim() : null;
    if (t && t.length > 60) throw new MailServiceError('El título no puede superar los 60 caracteres');
    vals.push(t || null);
    sets.push(`webmail_title = $${vals.length}`);
  }
  if (!sets.length) throw new MailServiceError('Nada para actualizar');

  await pool.query(`UPDATE mail_domains SET ${sets.join(', ')}, updated_at = now() WHERE domain = $1`, vals);
  await log(d, 'webmail:branding', true, sets.join(', '));

  const actualizado = await findDomain(d);
  return {
    domain: d,
    webmail_host: actualizado.webmail_host,
    webmail_logo_url: actualizado.webmail_logo_url,
    webmail_color: actualizado.webmail_color,
    webmail_title: actualizado.webmail_title,
    // Borramos el logo viejo recién ahora, con la fila ya actualizada.
    anterior: row.webmail_logo_url || null,
  };
}

/** Borra un archivo de logo que ya no está referenciado. Nunca tumba la operación. */
function borrarLogo(nombre) {
  const ruta = rutaLogo(nombre);
  if (!ruta) return;
  try { fs.unlinkSync(ruta); } catch (_) { /* si no está, mejor */ }
}

/**
 * Cambia a quién le pertenece el dominio (y por lo tanto quién lo gestiona).
 * Pasar null o cadena vacía lo deja SIN DUEÑO: desaparece de todos los
 * portales y queda bajo custodia de godmode.
 */
async function setDomainOwner(domain, ownerEmail) {
  const d = normalizeDomain(domain);
  const owner = ownerEmail ? normalizeEmail(ownerEmail) : null;
  if (owner && !owner.includes('@')) throw new MailServiceError('Email inválido');

  const row = await findDomain(d);
  if (!row) throw new MailServiceError(`El dominio ${d} no está dado de alta en HEPTA Cloud`, 404);

  const anterior = row.owner_email || null;
  if (normalizeEmail(anterior) === normalizeEmail(owner) || (!anterior && !owner)) {
    return { domain: d, owner_email: owner, anterior, sin_cambios: true };
  }

  const usuarios = await usuariosDelPortal();
  const tieneUsuario = owner ? usuarios.some((u) => normalizeEmail(u.email) === owner) : null;

  await pool.query('UPDATE mail_domains SET owner_email = $2, updated_at = now() WHERE domain = $1', [d, owner]);
  await log(d, 'owner:change', true, `${anterior || '(sin dueño)'} -> ${owner || '(sin dueño)'}`);

  return { domain: d, owner_email: owner, anterior, tiene_usuario: tieneUsuario };
}

async function getProvisionLog(domain, limit = 100) {
  const { rows } = await pool.query(
    'SELECT action, success, detail, created_at FROM mail_provision_log WHERE domain = $1 ORDER BY created_at DESC LIMIT $2',
    [normalizeDomain(domain), limit]
  );
  return rows;
}

module.exports = {
  MailServiceError,
  assertOwnership,
  provisionDomain,
  getDnsPlan,
  setDomainStatus,
  listMailboxes,
  createMailbox,
  updateMailbox,
  resetPassword,
  deleteMailbox,
  listAliases,
  createAlias,
  deleteAlias,
  listDomainsByOwner,
  listAllDomains,
  getDelegationOptions,
  setDomainOwner,
  setWebmailHost,
  setWebmailBranding,
  findDomainByWebmailHost,
  rutaLogo,
  borrarLogo,
  LOGO_DIR,
  findDomain,
  getProvisionLog,
  generatePassword,
  normalizeDomain,
};
