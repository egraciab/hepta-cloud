// ============================================================
//  HEPTA CLOUD — Dominio propio de un tenant de Odoo (cliente.com.py en lugar de cliente.erp.hepta.com.py)
//
//    revisar(instId, dominio)            → qué hay hoy en el DNS y qué se va a cambiar (no cambia nada)
//    iniciar(instId, dominio, opciones)  → trabajo en segundo plano; ver(id) dice cómo va
//
//  El orden importa, para que el sitio no quede ni un minuto sin responder:
//    1. NGINX: vhost y certificado (DNS-01 de Cloudflare: no hace falta que el dominio ya apunte). El subdominio de
//       HEPTA sigue andando.
//    2. DNS: si la zona está en la cuenta de Cloudflare de HEPTA, el dominio y el www pasan a ser CNAME al balanceador
//       (con proxy). Lo que había se guarda en el trabajo y en admin_logs. Si la zona es del cliente, se comprueba
//       que ya apunte al host de HEPTA (solo DNS) y no se toca nada.
//    3. Cloudflare en modo SSL "Full (strict)" (con "Flexible" el redirect a https del NGINX daría un bucle).
//    4. Prueba de https://dominio/web/login desde acá. Si falla, el DNS vuelve a como estaba.
//    5. Recién ahí el subdominio de HEPTA pasa a mandar al dominio propio (301) y Odoo arma sus enlaces con el
//       dominio propio (API de alta, /website-domain).
//
//  Nunca se pisa un registro sin que el administrador lo haya visto en la revisión y confirmado (reemplazar: true).
//  MX, TXT y demás registros del correo no se tocan nunca.
//  Los trabajos viven en memoria, como los de alta.
// ============================================================
const crypto     = require('crypto');
const pool       = require('../config/db');
const cloudflare = require('./mailcow/cloudflare');
const { postJson, ErrorAlta } = require('./alta');

const BASE       = 'erp.hepta.com.py';
const DOMINIO_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const DIRECCION  = ['A', 'AAAA', 'CNAME'];   // los únicos tipos que se reemplazan
const GUARDAR_MS = 24 * 60 * 60 * 1000;
const trabajos   = new Map();

const limpio = h => String(h || '').toLowerCase().replace(/\.$/, '');

function normalizar(dominio) {
  const d = String(dominio || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  if (d.length > 253 || !DOMINIO_RE.test(d)) throw new ErrorAlta(422, 'Dominio inválido: va el nombre, por ejemplo cliente.com.py');
  if (d.endsWith('hepta.com.py')) throw new ErrorAlta(422, 'Ese nombre es de HEPTA: el dominio propio es el del cliente');
  return d;
}

async function config() {
  const { rows } = await pool.query(
    `SELECT key, value FROM site_config WHERE key IN ('perimetral_api_url','perimetral_api_key','provision_api_url',
       'provision_api_key','certbot_email','perimetral_certbot_email','dns_proxy_host','dominio_propio_lb')`);
  const c = Object.fromEntries(rows.map(r => [r.key, (r.value || '').trim()]));
  if (!c.perimetral_api_url) throw new ErrorAlta(500, 'API del NGINX perimetral no configurada');
  return {
    ...c,
    correo: c.certbot_email || c.perimetral_certbot_email || 'admin@hepta.com.py',
    // Zona en la cuenta de HEPTA → CNAME con proxy al balanceador. Zona del cliente → CNAME sin proxy a este host.
    lb: limpio(c.dominio_propio_lb),
    directo: limpio(c.dns_proxy_host),
  };
}

async function instancia(instId, dominio) {
  const { rows } = await pool.query('SELECT id, db_name, label, status, custom_domain FROM instances WHERE id=$1', [instId]);
  const inst = rows[0];
  if (!inst) throw new ErrorAlta(404, 'Instancia no encontrada');
  if (inst.status !== 'active') throw new ErrorAlta(409, 'Solo en instancias activas (reactivala antes)');
  const { rows: otra } = await pool.query(
    "SELECT label FROM instances WHERE lower(custom_domain)=$1 AND id<>$2 AND status<>'cancelled' LIMIT 1", [dominio, inst.id]);
  if (otra[0]) throw new ErrorAlta(409, `${dominio} ya es el dominio de otra instancia (${otra[0].label})`);
  return inst;
}

// ── Revisión: qué hay y qué se haría ──────────────────────────
async function revisar(instId, dominioCrudo) {
  const dominio = normalizar(dominioCrudo);
  const inst = await instancia(instId, dominio);
  const cfg = await config();
  const nombres = [dominio, `www.${dominio}`];

  let zona = null;
  try { zona = await cloudflare.zonaDe(dominio); }
  catch (e) { throw new ErrorAlta(502, `No pude consultar Cloudflare: ${e.message}`); }

  if (!zona || !cfg.lb) {
    // El cliente maneja su DNS (o no hay balanceador configurado): el registro lo crea él, apuntando al host directo
    if (!cfg.directo) throw new ErrorAlta(500, 'Falta el host para dominios de clientes (Configuración → "Host proxy DNS")');
    const estado = [];
    for (const n of nombres) estado.push({ nombre: n, apunta: await apuntaA(n, cfg.directo) });
    return {
      dominio, instancia: inst.label, db: inst.db_name, modo: 'cliente', zona: zona ? zona.zona : null, destino: cfg.directo,
      registros: estado, listo: estado.every(e => e.apunta),
      instrucciones: `En el DNS del dominio: ${dominio} y www.${dominio} como CNAME (o ALIAS en la raíz) a ${cfg.directo}, sin proxy.`,
    };
  }

  // El www solo en la raíz de la zona (cliente.com.py). Para un subdominio (erp.cliente.com.py) no tiene sentido, y el
  // certificado gratuito de Cloudflare cubre un solo nivel: www.erp.cliente.com.py daría error de certificado.
  const conWww = zona.zona === dominio;
  if (!conWww) nombres.pop();
  const todos = await cloudflare.cf(`/zones/${zona.id}/dns_records?per_page=500`) || [];
  const registros = nombres.map(n => {
    const aca = todos.filter(r => limpio(r.name) === n);
    const direccion = aca.filter(r => DIRECCION.includes(r.type));
    const otros = aca.filter(r => !DIRECCION.includes(r.type));
    const ok = direccion.length === 1 && direccion[0].type === 'CNAME' && limpio(direccion[0].content) === cfg.lb && direccion[0].proxied;
    // En la raíz Cloudflare aplana el CNAME y convive con MX y TXT; en www un CNAME no puede convivir con nada
    const bloqueo = n !== zona.zona && otros.length ? `${n} tiene ${otros.map(r => r.type).join(', ')}: un CNAME no puede convivir con eso` : null;
    return {
      nombre: n, accion: ok ? 'nada' : (direccion.length ? 'reemplazar' : 'crear'), bloqueo,
      actuales: direccion.map(r => ({ tipo: r.type, valor: r.content, proxy: !!r.proxied })),
    };
  });
  const otrosConProxy = todos.filter(r => r.proxied && !nombres.includes(limpio(r.name))).map(r => r.name);
  let ssl = null;
  try { ssl = (await cloudflare.cf(`/zones/${zona.id}/settings/ssl`)).value; } catch (e) { ssl = null; }
  return {
    dominio, instancia: inst.label, db: inst.db_name, modo: 'hepta', zona: zona.zona, destino: cfg.lb, registros, con_www: conWww,
    ssl, ssl_cambia: ssl !== 'strict', otros_con_proxy: otrosConProxy,
    correo: todos.filter(r => r.type === 'MX').map(r => r.content),
    hay_que_reemplazar: registros.some(r => r.accion === 'reemplazar'),
    bloqueos: [...registros.map(r => r.bloqueo).filter(Boolean),
      ...(ssl === null ? [`El token de Cloudflare no puede leer el SSL de ${zona.zona}: le falta el permiso Zone Settings (lectura y edición)`] : []),
      ...(ssl !== 'strict' && otrosConProxy.length ? [`La zona está en SSL "${ssl}" y tiene otros nombres con proxy (${otrosConProxy.join(', ')}): pasarla a "Full (strict)" los afecta, revisarlo a mano en Cloudflare`] : [])],
  };
}

async function apuntaA(nombre, destino) {
  const dns = require('dns').promises;
  try {
    const cn = await dns.resolveCname(nombre).catch(() => []);
    if (cn.some(c => limpio(c) === destino)) return true;
    const [a, b] = await Promise.all([dns.resolve4(nombre), dns.resolve4(destino)]);
    return a.length > 0 && a.every(ip => b.includes(ip));
  } catch (e) { return false; }
}

// ── Trabajo ───────────────────────────────────────────────────
function vista(t) {
  return {
    id: t.id, instance_id: t.instance_id, dominio: t.dominio, estado: t.estado, paso: t.paso,
    inicio: t.inicio, fin: t.fin || null, segundos: Math.round(((t.fin || Date.now()) - t.inicio) / 1000),
    avisos: t.avisos, error: t.error || null, dns_previo: t.dns_previo || [],
  };
}
const ver = id => (trabajos.has(id) ? vista(trabajos.get(id)) : null);

async function iniciar(instId, dominioCrudo, { reemplazar = false, actorId = null } = {}) {
  const r = await revisar(instId, dominioCrudo);
  if (r.bloqueos && r.bloqueos.length) throw new ErrorAlta(409, r.bloqueos.join('. '));
  if (r.modo === 'cliente' && !r.listo) throw new ErrorAlta(422, `Todavía no apunta. ${r.instrucciones}`);
  if (r.hay_que_reemplazar && !reemplazar)
    throw new ErrorAlta(409, 'Hay registros que se van a reemplazar: revisalos y confirmá');
  if (r.modo === 'hepta' && r.ssl === null)
    throw new ErrorAlta(409, `El token de Cloudflare no puede leer el SSL de ${r.zona}: le falta el permiso Zone Settings (lectura y edición)`);
  if (r.modo === 'hepta' && r.ssl_cambia && r.otros_con_proxy.length)
    throw new ErrorAlta(409, `La zona está en SSL "${r.ssl || '?'}" y tiene otros nombres con proxy (${r.otros_con_proxy.join(', ')}). ` +
      'Pasarla a "Full (strict)" los afecta: revisarlo a mano en Cloudflare antes.');
  for (const x of trabajos.values())
    if (x.estado === 'en_curso' && (x.instance_id === Number(instId) || x.dominio === r.dominio))
      throw new ErrorAlta(409, 'Ya hay un cambio de dominio en curso para esta instancia');

  const cfg = await config();
  const t = { id: crypto.randomUUID(), instance_id: Number(instId), dominio: r.dominio, estado: 'en_curso',
              paso: 'Certificado y vhost en el NGINX', inicio: Date.now(), avisos: [], dns_previo: [] };
  trabajos.set(t.id, t);
  for (const [id, x] of trabajos) if (x.fin && Date.now() - x.fin > GUARDAR_MS) trabajos.delete(id);
  console.log(`[dominio] ${r.dominio} → ${r.db} (trabajo ${t.id})`);

  const perimetral = async (migrar) => {
    const x = await postJson(`${cfg.perimetral_api_url}/vhost`, cfg.perimetral_api_key,
      { domain: r.dominio, db: r.db, certbot_email: cfg.correo, disable_subdomain: migrar }, 230000);
    if (!x.ok || !x.data?.success) throw new Error(detalle(x, 'NGINX perimetral'));
    return x.data;
  };

  (async () => {
    let zona = null;
    try {
      // 1. Vhost y certificado; el subdominio de HEPTA sigue igual
      const v = await perimetral(false);
      if (!v.ssl) throw new Error(`no salió el certificado: ${String(v.ssl_msg || '').slice(-200)}`);

      // 2 y 3. DNS en Cloudflare (solo si la zona es de HEPTA)
      if (r.modo === 'hepta') {
        t.paso = 'Registros en Cloudflare';
        zona = await cloudflare.zonaDe(r.dominio);
        await cambiarDns(zona.id, r, cfg.lb, t);
        if (r.ssl_cambia) {
          t.paso = 'Cloudflare en SSL "Full (strict)"';
          await cloudflare.cf(`/zones/${zona.id}/settings/ssl`, { method: 'PATCH', body: { value: 'strict' } });
          t.ssl_previo = r.ssl;
          t.avisos.push(`SSL de la zona: ${r.ssl || '?'} → strict`);
        }
      }

      // 4. Que responda de verdad
      t.paso = `Probando https://${r.dominio}`;
      const prueba = await comprobar(r.dominio, r.con_www !== false);
      if (!prueba.www) t.avisos.push(`www.${r.dominio} todavía no redirige desde acá (${prueba.motivo}); el dominio sí anda. Revisar en un rato: curl -sI https://www.${r.dominio}/`);

      // 5. El subdominio pasa al dominio propio y Odoo arma sus enlaces con él
      t.paso = 'El subdominio de HEPTA pasa a mandar al dominio propio';
      await perimetral(true);
      t.paso = 'Dirección del sitio en Odoo';
      const o = await postJson(`${cfg.provision_api_url}/website-domain`, cfg.provision_api_key, { db: r.db, domain: r.dominio }, 200000)
        .catch(e => ({ ok: false, status: 0, data: { detail: e.message } }));
      if (!o.ok) t.avisos.push(o.status === 404
        ? 'La API de alta todavía no tiene /website-domain (falta actualizarla a 1.4.0): Odoo sigue armando enlaces con el nombre de HEPTA'
        : `Odoo no tomó el dominio: ${detalle(o, 'API de alta')}`);

      await pool.query(
        "UPDATE instances SET custom_domain=$1, custom_domain_status='active', instance_url=$2, updated_at=NOW() WHERE id=$3",
        [r.dominio, `https://${r.dominio}`, t.instance_id]);
      t.estado = 'ok'; t.paso = 'Listo';
    } catch (e) {
      const error = String(e.message || e).slice(0, 500);
      // Si el DNS ya se había cambiado, vuelve a como estaba
      if (zona && t.dns_cambiado) {
        try {
          await restaurarDns(zona.id, t);
          if (t.ssl_previo) await cloudflare.cf(`/zones/${zona.id}/settings/ssl`, { method: 'PATCH', body: { value: t.ssl_previo } });
          t.avisos.push('El DNS volvió a como estaba');
        }
        catch (e2) { t.avisos.push(`OJO: no pude restaurar el DNS (${e2.message}). Lo que había está en dns_previo`); }
      }
      // Recién ahora: el Admin muestra el resultado en cuanto ve el estado, y tiene que incluir la vuelta atrás
      t.error = error; t.estado = 'error';
    } finally {
      t.fin = Date.now();
      await pool.query('INSERT INTO admin_logs (user_id, action, target, detail) VALUES ($1,$2,$3,$4)',
        [actorId, 'activate_custom_domain', `instance:${t.instance_id}`,
         JSON.stringify({ dominio: r.dominio, db: r.db, modo: r.modo, estado: t.estado, error: t.error || null,
                          avisos: t.avisos, dns_previo: t.dns_previo })]).catch(() => {});
      console.log(`[dominio] ${r.dominio}: ${t.estado}${t.error ? ' — ' + t.error : ''}`);
    }
  })();
  return vista(t);
}

// Cambia apex y www a CNAME → balanceador (con proxy). Primero guarda lo que había.
async function cambiarDns(zoneId, r, destino, t) {
  for (const reg of r.registros) {
    if (reg.accion === 'nada') continue;
    const viejos = (await cloudflare.cf(`/zones/${zoneId}/dns_records?name=${encodeURIComponent(reg.nombre)}&per_page=50`) || [])
      .filter(x => DIRECCION.includes(x.type));
    for (const x of viejos)
      t.dns_previo.push({ type: x.type, name: x.name, content: x.content, proxied: x.proxied, ttl: x.ttl, comment: x.comment || undefined });
    t.dns_cambiado = true;
    for (const x of viejos) await cloudflare.cf(`/zones/${zoneId}/dns_records/${x.id}`, { method: 'DELETE' });
    await cloudflare.cf(`/zones/${zoneId}/dns_records`, { method: 'POST', body: {
      type: 'CNAME', name: reg.nombre, content: destino, proxied: true, ttl: 1,
      comment: `HEPTA ERP: dominio propio de ${r.db.replace('.' + BASE, '')} (creado por HEPTA Cloud)` } });
  }
}

async function restaurarDns(zoneId, t) {
  const nombres = [...new Set([t.dominio, `www.${t.dominio}`])];
  for (const n of nombres) {
    const nuestros = (await cloudflare.cf(`/zones/${zoneId}/dns_records?name=${encodeURIComponent(n)}&per_page=50`) || [])
      .filter(x => x.type === 'CNAME' && String(x.comment || '').startsWith('HEPTA ERP'));
    for (const x of nuestros) await cloudflare.cf(`/zones/${zoneId}/dns_records/${x.id}`, { method: 'DELETE' });
  }
  for (const x of t.dns_previo) await cloudflare.cf(`/zones/${zoneId}/dns_records`, { method: 'POST', body: x });
}

// ── Prueba desde afuera ──
// Se resuelve con DNS públicos (1.1.1.1 y 8.8.8.8) y no con el de la red: el DNS interno guarda hasta una hora el "no
// existe" de un nombre recién creado (el www, típicamente) y la prueba fallaba con el sitio andando.
const https = require('https');
const { Resolver } = require('dns').promises;
const publico = new Resolver({ timeout: 3000, tries: 2 });
publico.setServers(['1.1.1.1', '8.8.8.8']);

async function ipPublica(nombre) {
  for (const [f, fam] of [['resolve4', 4], ['resolve6', 6]]) {
    try { const a = await publico[f](nombre); if (a.length) return { address: a[0], family: fam }; } catch (e) { /* sigue */ }
  }
  return null;   // sin respuesta de los públicos (¿puerto 53 cerrado?): se usa el DNS del sistema
}

function pedirHttps(url) {
  return ipPublica(new URL(url).hostname).then(dir => new Promise((resolve, reject) => {
    const lookup = dir ? (h, o, cb) => (o && o.all ? cb(null, [dir]) : cb(null, dir.address, dir.family)) : undefined;
    const req = https.request(url, { method: 'GET', timeout: 15000, lookup, headers: { 'User-Agent': 'HEPTA Cloud (prueba de dominio propio)' } }, res => {
      let cuerpo = '';
      res.setEncoding('utf8');
      res.on('data', c => { if (cuerpo.length < 300000) cuerpo += c; });
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location || '', cuerpo }));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('sin respuesta en 15 s'), { code: 'TIMEOUT' })));
    req.on('error', reject);
    req.end();
  }));
}
let pedir = pedirHttps;   // los harness la reemplazan

const esOdoo = t => /odoo|web\/assets/i.test(t || '');

// El dominio tiene que responder con el login de Odoo (hasta 5 minutos: propagación y caché). Si no, se vuelve atrás.
// El www se prueba aparte (hasta 1 minuto) y si no anda queda como aviso: el sitio ya funciona y volver todo atrás
// por el www hacía más daño que dejarlo para revisar.
async function comprobar(dominio, conWww = true) {
  let ultimo = '';
  for (let i = 0; i < 30; i++) {
    try {
      const a = await pedir(`https://${dominio}/web/login`);
      if (a.status === 200 && esOdoo(a.cuerpo)) { ultimo = null; break; }
      ultimo = `login ${a.status}${a.status === 200 ? ' (no es Odoo)' : ''}`;
    } catch (e) { ultimo = e.code || e.message; }
    await new Promise(res => setTimeout(res, 10000));
  }
  if (ultimo !== null) throw new Error(`https://${dominio} no respondió bien en 5 minutos (${ultimo})`);

  if (!conWww) return { www: true };
  let www = '';
  for (let i = 0; i < 6; i++) {
    try {
      const b = await pedir(`https://www.${dominio}/`);
      if (b.status === 301 && b.location.startsWith(`https://${dominio}/`)) return { www: true };
      www = `respondió ${b.status} ${b.location}`;
    } catch (e) { www = e.code || e.message; }
    await new Promise(res => setTimeout(res, 10000));
  }
  return { www: false, motivo: www };
}

function detalle(x, quien) {
  const d = x.data && (x.data.detail || x.data.error);
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) return d.map(e => e.msg).join('; ');
  return `${quien} respondió ${x.status}`;
}

module.exports = { revisar, iniciar, ver, _prueba: { normalizar, usarPedir: f => { pedir = f; }, pedirHttps } };
