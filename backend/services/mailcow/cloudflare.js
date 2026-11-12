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

module.exports = { applyDnsPlan, getZoneId };
