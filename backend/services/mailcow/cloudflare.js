'use strict';

/**
 * Publicación opcional de los registros en Cloudflare.
 * Reutiliza el mismo token del DNS-01 de Certbot si tiene Zone:Read + DNS:Edit.
 *
 * .env:  CLOUDFLARE_API_TOKEN=...
 *
 * Idempotente: si el registro ya existe con el mismo nombre/tipo, lo edita. Un TXT solo pisa a otro de su misma clase
 * (SPF, DMARC o DKIM): los demás TXT del dominio quedan como estaban.
 */

const { jsonRequest } = require('./http');

const API = 'https://api.cloudflare.com/client/v4';

async function cf(path, { method = 'GET', body } = {}) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    const err = new Error('CLOUDFLARE_API_TOKEN no configurado en el .env');
    err.status = 400;
    throw err;
  }

  const res = await jsonRequest(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body,
    timeoutMs: 20000,
  });

  let data = {};
  try {
    data = res.text ? JSON.parse(res.text) : {};
  } catch (_) {
    throw new Error(`Cloudflare devolvió una respuesta no-JSON (HTTP ${res.status})`);
  }

  if (!res.ok || data.success === false) {
    const msg = (data.errors || []).map((e) => e.message).join('; ') || `HTTP ${res.status}`;
    throw new Error(`Cloudflare: ${msg}`);
  }
  return data.result;
}

// La zona de la cuenta que contiene al dominio: puede ser el dominio mismo (cliente.com.py) o una zona madre
// (rodan.heptacloud.com.py vive en heptacloud.com.py). Los nombres de los registros van completos, así que sirven en
// cualquiera de las dos.
async function getZoneId(domain) {
  const partes = String(domain).toLowerCase().split('.');
  for (let i = 0; i <= partes.length - 2; i++) {
    const zones = await cf(`/zones?name=${encodeURIComponent(partes.slice(i).join('.'))}&status=active`);
    if (zones && zones.length) return zones[0].id;
  }
  const err = new Error(`La zona ${domain} no está en esta cuenta de Cloudflare`);
  err.status = 404;
  throw err;
}

// ── Formato de los registros ──
// Los TXT van entre comillas, como pide Cloudflare (si no, marca el registro con una advertencia). Cada cadena de un
// TXT admite hasta 255 caracteres: la clave DKIM, que es más larga, se parte en varias cadenas seguidas.
const sinComillas = (v) => {
  const t = String(v || '').trim();
  const partes = t.match(/"((?:[^"\\]|\\.)*)"/g);
  return partes && /^"/.test(t) ? partes.map((x) => x.slice(1, -1)).join('') : t;
};
const entreComillas = (v) => (sinComillas(v).match(/.{1,255}/g) || ['']).map((x) => `"${x}"`).join(' ');

// El comentario dice quién creó el registro y para qué, como los de HEPTA Drive
const COMENTARIOS = {
  mx: 'correo entrante',
  spf: 'SPF, quién puede enviar',
  dkim: 'DKIM, firma de los correos',
  dmarc: 'DMARC, política y reportes',
  autodiscover: 'autoconfiguración de Outlook',
  autoconfig: 'autoconfiguración de Thunderbird',
  srv_autodiscover: 'autoconfiguración de Outlook, SRV',
};
const comentario = (record) => `HEPTA Mail: ${COMENTARIOS[record.key] || record.key} (creado por HEPTA Cloud)`;

function toCloudflare(record, domain) {
  const name = record.name === '@' ? domain : `${record.name}.${domain}`;
  const base = { type: record.type, name, ttl: record.ttl || 3600, proxied: false, comment: comentario(record) };

  if (record.type === 'MX') return { ...base, content: record.value, priority: record.priority ?? 10 };
  if (record.type === 'TXT') return { ...base, content: entreComillas(record.value) };
  if (record.type === 'SRV') {
    return {
      ...base,
      data: {
        service: record.service,
        proto: record.proto,
        name: domain,
        priority: record.priority ?? 0,
        weight: record.weight ?? 0,
        port: record.port,
        target: record.target,
      },
    };
  }
  return { ...base, content: record.value };
}

// Qué registro existente reemplaza cada uno. Un TXT solo reemplaza a otro de su misma clase (SPF por SPF, DMARC por
// DMARC, DKIM por DKIM): en la raíz suele haber otros TXT (verificación de Google, de Microsoft…) que no se tocan.
function buscarExistente(existing, payload) {
  const mismos = (existing || []).filter((e) => e.type === payload.type && e.name === payload.name);
  if (payload.type !== 'TXT') return mismos[0];
  const clase = (v) => (sinComillas(v).match(/^v=(spf1|DMARC1|DKIM1)\b/i) || [])[1];
  const buscada = clase(payload.content);
  return buscada ? mismos.find((e) => (clase(e.content) || '').toLowerCase() === buscada.toLowerCase()) : undefined;
}

/**
 * Aplica el plan DNS a Cloudflare.
 * @param {object} plan  salida de buildDnsRecords()
 * @param {object} opts  { onlyRequired = false, dryRun = false }
 */
async function applyDnsPlan(plan, { onlyRequired = false, dryRun = false } = {}) {
  const zoneId = await getZoneId(plan.domain);
  const existing = await cf(`/zones/${zoneId}/dns_records?per_page=500`);
  const results = [];

  for (const record of plan.records) {
    if (onlyRequired && !record.required) continue;
    const payload = toCloudflare(record, plan.domain);
    const match = buscarExistente(existing, payload);

    if (dryRun) {
      // La revisión muestra qué hay hoy, para que nadie pise un registro sin haberlo visto: el valor actual del que se
      // reemplaza, los otros MX que quedarían (solo se reemplaza uno) y los registros de otro tipo que chocarían.
      const mismoNombre = (existing || []).filter((e) => e.name === payload.name);
      const valor = (e) => (e.type === 'MX' ? `${e.priority} ${e.content}` : e.content);
      results.push({
        record: record.key,
        action: match ? 'would_update' : 'would_create',
        name: payload.name,
        type: payload.type,
        nuevo: payload.type === 'SRV' ? `${payload.data.priority} ${payload.data.weight} ${payload.data.port} ${payload.data.target}`
          : payload.type === 'MX' ? `${payload.priority} ${payload.content}` : payload.content,
        actual: match ? valor(match) : null,
        igual: Boolean(match && sinComillas(match.content) === sinComillas(payload.content)),
        otros_mx: payload.type === 'MX' ? mismoNombre.filter((e) => e.type === 'MX' && e !== match).map(valor) : [],
        choca: mismoNombre.filter((e) => e.type !== payload.type && (payload.type === 'CNAME' || e.type === 'CNAME')).map((e) => e.type),
      });
      continue;
    }

    try {
      if (match) {
        await cf(`/zones/${zoneId}/dns_records/${match.id}`, { method: 'PUT', body: payload });
        results.push({ record: record.key, action: 'updated', name: payload.name });
      } else {
        await cf(`/zones/${zoneId}/dns_records`, { method: 'POST', body: payload });
        results.push({ record: record.key, action: 'created', name: payload.name });
      }
    } catch (err) {
      results.push({ record: record.key, action: 'failed', name: payload.name, error: err.message });
    }
  }

  return { zone_id: zoneId, results };
}

/**
 * Deja un CNAME (solo DNS, sin proxy) en la zona que corresponda, si esa zona está en esta cuenta de Cloudflare.
 * No pisa nada: si ya hay un registro con ese nombre que apunta a otro lado, lo informa y no lo toca.
 *
 * @returns {{estado: 'creado'|'ya_estaba'|'sin_zona'|'sin_token', zona?: string}}
 * @throws  si el nombre ya tiene otro registro, o si Cloudflare rechaza el pedido (por ejemplo, token sin permiso)
 */
async function asegurarCname(nombre, destino) {
  if (!process.env.CLOUDFLARE_API_TOKEN) return { estado: 'sin_token' };
  const partes = nombre.split('.');
  let zona = null, zoneId = null;
  // drive.cliente.com.py → se busca cliente.com.py y después com.py (nunca el nombre entero: un CNAME no va en la raíz)
  for (let i = 1; i <= partes.length - 2 && !zoneId; i++) {
    const candidata = partes.slice(i).join('.');
    const zonas = await cf(`/zones?name=${encodeURIComponent(candidata)}&status=active`);
    if (zonas && zonas.length) { zona = candidata; zoneId = zonas[0].id; }
  }
  if (!zoneId) return { estado: 'sin_zona' };

  const existentes = await cf(`/zones/${zoneId}/dns_records?name=${encodeURIComponent(nombre)}&per_page=50`) || [];
  const limpio = (h) => String(h || '').toLowerCase().replace(/\.$/, '');
  if (existentes.length) {
    const igual = existentes.length === 1 && existentes[0].type === 'CNAME' && limpio(existentes[0].content) === limpio(destino);
    if (igual && !existentes[0].proxied) return { estado: 'ya_estaba', zona };
    const err = new Error(igual
      ? `${nombre} ya apunta bien en Cloudflare, pero con el proxy (nube naranja) activado: hay que dejarlo en "solo DNS"`
      : `${nombre} ya tiene en Cloudflare un registro ${existentes.map((e) => e.type).join(', ')} que apunta a otro lado. No lo piso: hay que revisarlo a mano`);
    err.status = 409;
    throw err;
  }
  await cf(`/zones/${zoneId}/dns_records`, {
    method: 'POST',
    body: { type: 'CNAME', name: nombre, content: destino, ttl: 300, proxied: false, comment: 'HEPTA Drive: dominio propio (creado por HEPTA Cloud)' },
  });
  return { estado: 'creado', zona };
}

/**
 * Quita un CNAME que creó HEPTA Cloud. Solo si sigue apuntando al destino esperado: un registro que alguien
 * cambió a mano no se toca. No falla si ya no está o si la zona no es de esta cuenta.
 * @returns {'quitado'|'no_estaba'|'no_es_nuestro'|'sin_zona'|'sin_token'}
 */
async function quitarCname(nombre, destino) {
  if (!process.env.CLOUDFLARE_API_TOKEN) return 'sin_token';
  const partes = nombre.split('.');
  let zoneId = null;
  for (let i = 1; i <= partes.length - 2 && !zoneId; i++) {
    const zonas = await cf(`/zones?name=${encodeURIComponent(partes.slice(i).join('.'))}&status=active`);
    if (zonas && zonas.length) zoneId = zonas[0].id;
  }
  if (!zoneId) return 'sin_zona';
  const existentes = await cf(`/zones/${zoneId}/dns_records?name=${encodeURIComponent(nombre)}&per_page=50`) || [];
  if (!existentes.length) return 'no_estaba';
  const limpio = (h) => String(h || '').toLowerCase().replace(/\.$/, '');
  const nuestro = existentes.length === 1 && existentes[0].type === 'CNAME' && limpio(existentes[0].content) === limpio(destino)
    && String(existentes[0].comment || '').startsWith('HEPTA Drive');
  if (!nuestro) return 'no_es_nuestro';
  await cf(`/zones/${zoneId}/dns_records/${existentes[0].id}`, { method: 'DELETE' });
  return 'quitado';
}

/**
 * La zona de esta cuenta de Cloudflare que contiene a `nombre` (puede ser el nombre mismo: cliente.com.py).
 * @returns {{zona: string, id: string} | null}  null si no está en la cuenta (o falta el token)
 */
async function zonaDe(nombre) {
  if (!process.env.CLOUDFLARE_API_TOKEN) return null;
  const partes = String(nombre).toLowerCase().split('.');
  for (let i = 0; i <= partes.length - 2; i++) {
    const candidata = partes.slice(i).join('.');
    const zonas = await cf(`/zones?name=${encodeURIComponent(candidata)}&status=active`);
    if (zonas && zonas.length) return { zona: candidata, id: zonas[0].id };
  }
  return null;
}

module.exports = { cf, zonaDe, applyDnsPlan, getZoneId, asegurarCname, quitarCname, _prueba: { toCloudflare, buscarExistente, entreComillas, sinComillas } };
