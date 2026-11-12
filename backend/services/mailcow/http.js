'use strict';

/**
 * Helper HTTP mínimo, compatible con cualquier Node.
 * Usa fetch nativo si existe (Node 18+); si no, cae a https/http del core.
 * Así el módulo anda igual si el contenedor corre Node 16 o Node 22.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

const HAS_FETCH = typeof fetch === 'function';

function nativeRequest(url, { method, headers, payload, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'http:' ? http : https;

    const req = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'http:' ? 80 : 443),
        path: `${target.pathname}${target.search}`,
        method,
        headers: payload
          ? { ...headers, 'Content-Length': Buffer.byteLength(payload) }
          : headers,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, text: data });
        });
      }
    );

    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout luego de ${timeoutMs}ms`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * @returns {Promise<{status:number, ok:boolean, text:string}>}
 */
async function jsonRequest(url, { method = 'GET', headers = {}, body, timeoutMs = 15000 } = {}) {
  const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);

  if (!HAS_FETCH) {
    return nativeRequest(url, { method, headers, payload, timeoutMs });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body: payload, signal: controller.signal });
    return { status: res.status, ok: res.ok, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { jsonRequest, HAS_FETCH };
