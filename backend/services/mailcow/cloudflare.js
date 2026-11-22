'use strict';

/**
 * Publicación opcional de los registros en Cloudflare.
 * Reutiliza el mismo token del DNS-01 de Certbot si tiene Zone:Read + DNS:Edit.
 *
 * .env:  CLOUDFLARE_API_TOKEN=...
 *
 * Idempotente: si el registro ya existe con el mismo nombre/tipo, lo edita.
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

async function getZoneId(domain) {
  const zones = await cf(`/zones?name=${encodeURIComponent(domain)}&status=active`);
  if (!zones || zones.length === 0) {
    const err = new Error(`La zona ${domain} no está en esta cuenta de Cloudflare`);
    err.status = 404;
    throw err;
  }
  return zones[0].id;
}

function toCloudflare(record, domain) {
  const name = record.name === '@' ? domain : `${record.name}.${domain}`;
  const base = { type: record.type, name, ttl: record.ttl || 3600, proxied: false };

  if (record.type === 'MX') return { ...base, content: record.value, priority: record.priority ?? 10 };
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
    const match = (existing || []).find((e) => e.type === payload.type && e.name === payload.name);

    if (dryRun) {
      results.push({ record: record.key, action: match ? 'would_update' : 'would_create', name: payload.name });
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

module.exports = { applyDnsPlan, getZoneId, asegurarCname };
