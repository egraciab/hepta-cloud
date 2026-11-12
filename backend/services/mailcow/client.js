'use strict';

/**
 * Cliente de la API de mailcow — HEPTA Cloud.
 *
 * OJO: mailcow devuelve HTTP 200 incluso cuando la operación falla, con un
 * body tipo [{ "type": "danger", "msg": [...] }]. Por eso todo POST pasa por
 * assertOk().
 *
 * .env:
 *   MAILCOW_URL         https://mail.hepta.com.py
 *   MAILCOW_API_KEY     API key read-write (mailcow > Access > API)
 *   MAILCOW_TIMEOUT_MS  opcional, default 15000
 */

const { jsonRequest } = require('./http');

const BASE = () => (process.env.MAILCOW_URL || '').replace(/\/+$/, '');
const KEY = () => process.env.MAILCOW_API_KEY || '';
const TIMEOUT = () => Number(process.env.MAILCOW_TIMEOUT_MS || 15000);

class MailcowError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'MailcowError';
    this.status = 502;
    this.details = details;
  }
}

async function request(method, path, body) {
  if (!BASE() || !KEY()) {
    throw new MailcowError('MAILCOW_URL / MAILCOW_API_KEY no están configurados en el .env');
  }

  let res;
  try {
    res = await jsonRequest(`${BASE()}/api/v1/${path}`, {
      method,
      headers: {
        'X-API-Key': KEY(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body,
      timeoutMs: TIMEOUT(),
    });
  } catch (err) {
    throw new MailcowError(`No se pudo contactar a mailcow: ${err.message}`);
  }

  if (!res.ok) {
    throw new MailcowError(`mailcow respondió HTTP ${res.status}`, String(res.text).slice(0, 500));
  }
  if (!res.text) return null;

  try {
    return JSON.parse(res.text);
  } catch (_) {
    throw new MailcowError(
      'Respuesta no-JSON de mailcow (¿API key inválida o IP no permitida?)',
      String(res.text).slice(0, 500)
    );
  }
}

function assertOk(data) {
  const items = Array.isArray(data) ? data : [data];
  for (const item of items) {
    if (item && typeof item === 'object' && item.type && !['success', 'info'].includes(item.type)) {
      const msg = Array.isArray(item.msg) ? item.msg.flat().join(' ') : item.msg || item.type;
      throw new MailcowError(`mailcow rechazó la operación: ${msg}`, item);
    }
  }
  return data;
}

const post = async (path, body) => assertOk(await request('POST', path, body));
const get = (path) => request('GET', path);

/* ------------------------------------------------------------- dominios */

const addDomain = ({
  domain,
  quotaMb = 10240,
  defQuotaMb = 1024,
  maxQuotaMb = null,
  mailboxes = 50,
  aliases = 400,
  description = '',
}) =>
  post('add/domain', {
    domain,
    description,
    aliases: String(aliases),
    mailboxes: String(mailboxes),
    defquota: String(defQuotaMb),
    maxquota: String(maxQuotaMb ?? quotaMb),
    quota: String(quotaMb),
    active: '1',
    gal: '0',
    backupmx: '0',
    relay_all_recipients: '0',
    rl_frame: 'h',
    rl_value: '',
    restart_sogo: '1',
  });

async function getDomain(domain) {
  const res = await get(`get/domain/${encodeURIComponent(domain)}`);
  if (!res || (Array.isArray(res) && res.length === 0)) return null;
  const item = Array.isArray(res) ? res[0] : res;
  return item && item.domain_name ? item : null;
}

const editDomain = (domain, attr) => post('edit/domain', { items: [domain], attr });
const deleteDomain = (domain) => post('delete/domain', [domain]);

/* ----------------------------------------------------------------- DKIM */

const addDkim = (domain, selector = 'dkim', keySize = 2048) =>
  post('add/dkim', { domains: domain, dkim_selector: selector, key_size: String(keySize) });

async function getDkim(domain) {
  const res = await get(`get/dkim/${encodeURIComponent(domain)}`);
  if (!res || !res.dkim_txt) return null;
  return { selector: res.dkim_selector || 'dkim', txt: res.dkim_txt, pubkey: res.pubkey };
}

/* --------------------------------------------------------------- buzones */

const addMailbox = ({ localPart, domain, name = '', password, quotaMb = 1024, forcePwUpdate = true, active = true }) =>
  post('add/mailbox', {
    local_part: localPart,
    domain,
    name: name || localPart,
    password,
    password2: password,
    quota: String(quotaMb),
    active: active ? '1' : '0',
    force_pw_update: forcePwUpdate ? '1' : '0',
    tls_enforce_in: '1',
    tls_enforce_out: '1',
  });

const editMailbox = (addresses, attr) =>
  post('edit/mailbox', { items: Array.isArray(addresses) ? addresses : [addresses], attr });

const deleteMailbox = (addresses) =>
  post('delete/mailbox', Array.isArray(addresses) ? addresses : [addresses]);

async function getMailboxes(domain) {
  const res = await get(`get/mailbox/all/${encodeURIComponent(domain)}`);
  return Array.isArray(res) ? res : [];
}

/* ----------------------------------------------------------------- alias */

const addAlias = ({ address, goto, active = true }) =>
  post('add/alias', { address, goto, active: active ? '1' : '0' });

const deleteAlias = (ids) => post('delete/alias', Array.isArray(ids) ? ids : [ids]);

async function getAliases(domain) {
  const res = await get(`get/alias/all/${encodeURIComponent(domain)}`);
  return Array.isArray(res) ? res : [];
}

/* ------------------------------------------------------------ conectividad */

/** Ping barato para el health-check del admin. */
async function ping() {
  const res = await get('get/status/containers');
  return Boolean(res);
}

module.exports = {
  MailcowError,
  request,
  addDomain,
  getDomain,
  editDomain,
  deleteDomain,
  addDkim,
  getDkim,
  addMailbox,
  editMailbox,
  deleteMailbox,
  getMailboxes,
  addAlias,
  deleteAlias,
  getAliases,
  ping,
};
