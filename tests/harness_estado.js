// PANEL "ESTADO" — services/estado.js, GET /api/admin/v2/estado y POST /api/monitor/vigia (2026-11-28), contra un
// Postgres efímero y con fetch, el agente de Drive y mailcow simulados. Prueba: grupos y estados (ok, aviso, falla,
// sin_dato), tenants caídos con detalle, el peor estado manda, caché de 60 s y "fresco", reporte del vigía (clave
// por SHA-256, saneado, respaldos como grupo propio, aviso si el vigía deja de reportar) y que una revisión que
// explota no tumba el panel.
// Uso: NODE_PATH=backend/node_modules node tests/harness_estado.js   (Postgres en /tmp/pgadm:5499, base y rol "hc")
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
process.env.DB_HOST = process.env.PGHOST || '/tmp/pgadm'; process.env.DB_PORT = process.env.PGPORT || '5499';
process.env.DB_NAME = 'hc'; process.env.DB_USER = 'hc'; process.env.DB_PASSWORD = '';
process.env.JWT_SECRET = 'harness-secret-0123456789abcdef';
process.env.MAILCOW_URL = 'https://mail.ejemplo.test';
process.env.MAILCOW_API_KEY = 'x';

let pass = 0, fail = 0;
const check = (n, c, x = '') => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); };

// ── Simulaciones ──
const caidos = new Set(['caido.erp.hepta.com.py']);
let pedidosFetch = 0;
global.fetch = async (url) => {
  pedidosFetch++;
  const u = new URL(url);
  const resp = (status, json) => ({ status, json: async () => json });
  if (u.hostname === 'provision.test') return resp(200, { status: 'ok' });
  if (u.hostname === 'perimetral.test') { const e = new Error('fetch failed'); e.cause = { code: 'ECONNREFUSED' }; throw e; }
  if (caidos.has(u.hostname)) { const e = new Error('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; }
  if (u.hostname === 'viejo2.erp.hepta.com.py') return { status: 301, json: async () => null, headers: { get: (h) => h === 'location' ? 'https://viejo2.com.py/web/health' : null } };
  return resp(200, {});
};
const drive = require(path.join(ROOT, 'backend/services/drive'));
let saludVm = { ok: false, chequeos: [
  { ok: true, nombre: 'ClamAV', detalle: 'responde' }, { ok: false, nombre: 'Firmas de ClamAV', detalle: 'hace 5 días' },
  { ok: true, nombre: 'RAM disponible', detalle: '9 GiB' }, { ok: true, nombre: 'Disco /srv/nextcloud', detalle: '2%' }] };
drive.salud = async () => ({ ok: true, version: '1.5.0' });
drive.saludVm = async () => saludVm;
const mc = require(path.join(ROOT, 'backend/services/mailcow/client'));
mc.request = async () => ({ 'nginx-mailcow': { container: 'nginx-mailcow', state: 'running' }, 'sogo-mailcow': { container: 'sogo-mailcow', state: 'exited' } });
const net = require('net');
net.connect = () => {            // los puertos de correo "abren" al instante
  const ee = new (require('events'))();
  ee.setTimeout = () => {}; ee.destroy = () => {};
  setImmediate(() => ee.emit('connect'));
  return ee;
};

(async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ host: process.env.DB_HOST, port: process.env.DB_PORT, database: 'hc', user: 'hc' });
  const q = (s, p) => pool.query(s, p);
  await q(`DROP TABLE IF EXISTS monitor_reportes, instances, site_config, users, token_blacklist CASCADE;
    CREATE TABLE token_blacklist (jti text);
    CREATE TABLE users (id serial PRIMARY KEY, email text, full_name text, role text, is_active boolean DEFAULT true);
    CREATE TABLE site_config (key text PRIMARY KEY, value text);
    CREATE TABLE instances (id serial PRIMARY KEY, user_id int, label text, db_name text, instance_url text, status text, custom_domain text);`);
  await q(require('fs').readFileSync(path.join(ROOT, 'sql/2026-11-28_monitor_reportes.sql'), 'utf8'));
  const ADM = (await q("INSERT INTO users (email, full_name, role) VALUES ('steve@hepta.com.py','Esteban','godmode') RETURNING id")).rows[0].id;
  await q(`INSERT INTO site_config VALUES ('provision_api_url','https://provision.test'),('perimetral_api_url','https://perimetral.test')`);
  await q(`INSERT INTO instances (label, db_name, status, custom_domain) VALUES
    ('Bien','bien.erp.hepta.com.py','active',null), ('Caído','caido.erp.hepta.com.py','active',null),
    ('Propio','propio.erp.hepta.com.py','active','propio.com.py'), ('Pausada','pausada.erp.hepta.com.py','suspended',null)`);
  await q("INSERT INTO instances (label, db_name, instance_url, status) VALUES ('Viejo','viejo','https://viejo.erp.hepta.com.py','active'),('Viejo 2','viejo2.erp.hepta.com.py',null,'active')");

  const estado = require(path.join(ROOT, 'backend/services/estado'));
  const express = require('express'), jwt = require('jsonwebtoken');
  const app = express(); app.use(express.json());
  app.use('/api/admin', require(path.join(ROOT, 'backend/routes/admin.routes')));
  app.use('/api/monitor', require(path.join(ROOT, 'backend/routes/monitor.routes')));
  const server = await new Promise(res => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const port = server.address().port;
  const tok = jwt.sign({ id: ADM, role: 'godmode' }, process.env.JWT_SECRET);
  const pedir = (method, p, { token = tok, cuerpo, cab = {} } = {}) => new Promise((resolve, reject) => {
    const datos = cuerpo === undefined ? null : JSON.stringify(cuerpo);
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(datos ? { 'Content-Type': 'application/json' } : {}), ...cab } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch (e) { resolve({ status: res.statusCode, body: d }); } });
    });
    req.on('error', reject); if (datos) req.write(datos); req.end();
  });
  const grupo = (d, id) => d.grupos.find(g => g.id === id);

  // ── Panel ──
  let r = await pedir('GET', '/api/admin/v2/estado', { token: null });
  check('sin token: 401', r.status === 401);
  r = await pedir('GET', '/api/admin/v2/estado');
  let d = r.body.data;
  check('responde con 5 grupos', r.status === 200 && d.grupos.map(g => g.id).join() === 'erp,mail,drive,respaldos,afuera', d && d.grupos.map(g => g.id).join());
  const erp = grupo(d, 'erp');
  check('ERP: API de alta ok, perimetral caído', erp.chequeos[0].estado === 'ok' && erp.chequeos[1].estado === 'falla' && /ECONNREFUSED/.test(erp.chequeos[1].detalle));
  const ten = erp.chequeos[2];
  check('ERP: 1 de 5 tenants no responde y 1 para estandarizar (la suspendida no cuenta)', ten.estado === 'falla' && ten.detalle === '1 de 5 no responden y 1 para estandarizar' && ten.items.length === 5, ten.detalle);
  check('ERP: tenant que redirige a un dominio que responde es aviso, con el destino', ten.items.some(i => i.estado === 'aviso' && /redirige a viejo2.com.py/.test(i.detalle)));
  check('ERP: el tenant con dominio propio se prueba por su dominio', ten.items.some(i => i.detalle.startsWith('propio.com.py')));
  check('ERP: tenant viejo (base sin forma de dirección) se prueba por instance_url', ten.items.some(i => i.detalle.startsWith('viejo.erp.hepta.com.py') && i.estado === 'ok'));
  check('ERP: grupo en falla', erp.estado === 'falla');
  const mail = grupo(d, 'mail');
  check('Mail: contenedor parado es falla y se nombra', mail.chequeos[1].estado === 'falla' && /sogo-mailcow/.test(mail.chequeos[1].detalle), mail.chequeos[1].detalle);
  check('Mail: puertos 465, 587 y 993', mail.chequeos[2].estado === 'ok' && mail.chequeos[2].items.length === 3);
  const drv = grupo(d, 'drive');
  check('Drive: firmas viejas son aviso, no falla', drv.estado === 'aviso' && drv.chequeos.find(x => x.nombre === 'Firmas de ClamAV').estado === 'aviso');
  check('Respaldos y vista de afuera: sin dato hasta que reporte el vigía', grupo(d, 'respaldos').estado === 'sin_dato' && grupo(d, 'afuera').estado === 'sin_dato');
  check('el peor estado manda y se cuenta por grupo', d.estado === 'falla' && d.cuenta.falla === 2 && d.cuenta.aviso === 1 && d.cuenta.sin_dato === 2, JSON.stringify(d.cuenta));

  // ── Caché ──
  const antes = pedidosFetch;
  await Promise.all([pedir('GET', '/api/admin/v2/estado'), pedir('GET', '/api/admin/v2/estado')]);
  check('caché: dos pedidos seguidos no vuelven a probar nada', pedidosFetch === antes);
  r = await pedir('GET', '/api/admin/v2/estado?fresco=1');
  check('fresco antes de 10 s: devuelve lo guardado', pedidosFetch === antes && r.body.data.revisado === d.revisado);

  // ── Antivirus caído es falla ──
  saludVm = { ok: false, chequeos: [{ ok: false, nombre: 'ClamAV', detalle: 'no responde' }] };
  estado._test.reiniciar();
  r = await pedir('GET', '/api/admin/v2/estado');
  check('Drive: ClamAV caído es falla', grupo(r.body.data, 'drive').estado === 'falla');

  // ── Reporte del vigía ──
  const CLAVE = crypto.randomBytes(30).toString('hex');
  const reporte = { chequeos: [
    { id: 'http:https://cloud.hepta.com.py/api/health', nombre: 'Hepta Cloud', destino: 'https://cloud.hepta.com.py/api/health', ok: true, motivo: '' },
    { id: 'http:https://rygtech.com.py/', nombre: 'RYG <script>', destino: 'https://rygtech.com.py/', ok: false, motivo: 'Name or service not known' },
    { id: 'respaldos', nombre: 'Respaldos (copia al NAS)', destino: '/mnt/nas', ok: false, motivo: 'la última copia al NAS sin problemas fue hace 7 horas' }] };
  r = await pedir('POST', '/api/monitor/vigia', { token: null, cuerpo: reporte, cab: { 'X-Monitor-Key': CLAVE } });
  check('monitor sin clave cargada: 503', r.status === 503);
  await q("INSERT INTO site_config VALUES ('monitor_api_key', $1)", [crypto.createHash('sha256').update(CLAVE).digest('hex')]);
  r = await pedir('POST', '/api/monitor/vigia', { token: null, cuerpo: reporte, cab: { 'X-Monitor-Key': 'x'.repeat(40) } });
  check('monitor con clave equivocada: 401', r.status === 401);
  r = await pedir('POST', '/api/monitor/vigia', { token: null, cuerpo: reporte });
  check('monitor sin cabecera: 401', r.status === 401);
  r = await pedir('POST', '/api/monitor/otro', { token: null, cuerpo: reporte, cab: { 'X-Monitor-Key': CLAVE } });
  check('origen desconocido: 404', r.status === 404);
  r = await pedir('POST', '/api/monitor/vigia', { token: null, cuerpo: { nada: 1 }, cab: { 'X-Monitor-Key': CLAVE } });
  check('reporte sin chequeos: 422', r.status === 422);
  r = await pedir('POST', '/api/monitor/vigia', { token: null, cuerpo: { chequeos: [...reporte.chequeos, { id: 'x', nombre: 'y', ok: 'true', extra: 'z'.repeat(5000) }] }, cab: { 'X-Monitor-Key': CLAVE } });
  check('reporte válido: 200', r.status === 200);
  const guardado = (await q("SELECT datos FROM monitor_reportes WHERE origen='vigia'")).rows[0].datos;
  check('se guarda saneado: ok solo si es true, sin campos de más', guardado.chequeos[3].ok === false && !('extra' in guardado.chequeos[3]));

  r = await pedir('GET', '/api/admin/v2/estado');
  d = r.body.data;
  const resp = grupo(d, 'respaldos'), af = grupo(d, 'afuera');
  check('respaldos: grupo propio en falla con el motivo', resp.estado === 'falla' && /7 horas/.test(resp.chequeos[0].detalle));
  check('vista de afuera: el vigía al día y el sitio caído', af.chequeos[0].estado === 'ok' && af.chequeos.some(x => x.nombre === 'RYG <script>' && x.estado === 'falla'));
  check('vista de afuera: no repite los respaldos', !af.chequeos.some(x => /Respaldos/.test(x.nombre)));

  // Con el detalle de hepta-backup-informe panel
  const detalle = JSON.parse(require('fs').readFileSync(process.env.PANEL_JSON || '/tmp/claude-0/panel.json', 'utf8'));
  detalle.vms[0].nombre = 'Hepta <img src=x>';
  r = await pedir('POST', '/api/monitor/vigia', { token: null, cuerpo: { ...reporte, respaldos: { ...detalle, basura: 'x', vms: [...detalle.vms, { estado: 'raro' }] } }, cab: { 'X-Monitor-Key': CLAVE } });
  check('reporte con detalle de respaldos: 200', r.status === 200);
  const g2 = (await q("SELECT datos FROM monitor_reportes WHERE origen='vigia'")).rows[0].datos.respaldos;
  check('detalle saneado: sin campos de más y estado desconocido → sin_dato', !('basura' in g2) && g2.vms[g2.vms.length - 1].estado === 'sin_dato');
  r = await pedir('GET', '/api/admin/v2/estado');
  const rg = grupo(r.body.data, 'respaldos');
  const porVm = rg.chequeos.find(x => x.nombre === 'Copias de cada VM');
  check('respaldos: copias por VM con el detalle de cada una', porVm && porVm.items.length === 5 && /ERP del grupo/.test(porVm.detalle) && porVm.estado === 'falla', porVm && porVm.detalle);
  check('respaldos: el error de la VM que falla se ve', porVm.items.some(i => i.nombre === 'ERP del grupo' && /conexión rechazada/.test(i.detalle)));
  check('respaldos: retiro al NAS con espacio libre (aviso al 12 %)', rg.chequeos.some(x => x.nombre === 'Retiro al NAS' && x.estado === 'aviso' && /12% libre/.test(x.detalle)));
  check('respaldos: copia fuera de sitio, export semanal y prueba de restauración', ['Respaldos de datos a Google Drive', 'Export semanal de las VM completas', 'Prueba de restauración del ERP'].every(n => rg.chequeos.some(x => x.nombre === n)), rg.chequeos.map(x => x.nombre).join(' | '));

  await q("UPDATE monitor_reportes SET recibido = now() - interval '40 minutes'");
  estado._test.reiniciar();
  r = await pedir('GET', '/api/admin/v2/estado');
  d = r.body.data;
  check('vigía sin reportar hace 40 min: aviso, también en respaldos', grupo(d, 'afuera').chequeos[0].estado === 'aviso' && grupo(d, 'respaldos').chequeos.some(x => /40 min/.test(x.detalle)));

  // ── Una revisión que explota no tumba el panel ──
  drive.salud = async () => { throw new Error('el agente de HEPTA Drive no respondió a tiempo'); };
  await q('DROP TABLE instances');
  estado._test.reiniciar();
  r = await pedir('GET', '/api/admin/v2/estado');
  d = r.body.data;
  check('sin tabla instances: ERP sin dato, el resto llega', r.status === 200 && grupo(d, 'erp').estado === 'sin_dato' && grupo(d, 'mail').estado === 'falla');
  check('agente caído: Drive en falla con el motivo', grupo(d, 'drive').estado === 'falla' && /no respondió/.test(grupo(d, 'drive').chequeos[0].detalle));

  server.close(); await pool.end();
  const db = require(path.join(ROOT, 'backend/config/db')); await db.end();
  console.log(`\n${pass} PASS · ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
