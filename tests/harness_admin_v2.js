// ADMIN NUEVO — rutas de solo lectura de admin_v2.routes.js (2026-11-24) contra un Postgres efímero con las
// tablas mínimas. Prueba: inicio con lo que requiere atención, ficha de cliente (usuarios, instancias, drive,
// correo, leads, actividad), búsqueda global, actividad paginada, auth (sin token / rol client), y que un bloque
// que falla no rompe el resto.
// Uso: node tests/harness_admin_v2.js   (Postgres en /tmp/pgadm:5499, base y rol "hc"; ver la cabecera del PR)
const path = require('path');
const http = require('http');
const ROOT = path.resolve(__dirname, '..');
process.env.DB_HOST = process.env.PGHOST || '/tmp/pgadm'; process.env.DB_PORT = process.env.PGPORT || '5499';
process.env.DB_NAME = 'hc'; process.env.DB_USER = 'hc'; process.env.DB_PASSWORD = '';
process.env.JWT_SECRET = 'harness-secret-0123456789abcdef';

let pass = 0, fail = 0;
const check = (n, c, x = '') => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); };

const ESQUEMA = `
DROP TABLE IF EXISTS admin_logs, provisioning_jobs, client_services, mail_domains, payment_requests, leads,
  integration_credentials, account_billing_customers, instances, billing_customers, site_config, users, token_blacklist CASCADE;
CREATE TABLE token_blacklist (jti text);
CREATE TABLE users (id serial PRIMARY KEY, email text, full_name text, role text, is_active boolean DEFAULT true,
  last_login_at timestamptz, created_at timestamptz DEFAULT now());
CREATE TABLE site_config (key text PRIMARY KEY, value text);
CREATE TABLE billing_customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), numero_doc text NOT NULL, dv text,
  doc_norm text GENERATED ALWAYS AS (regexp_replace(COALESCE(numero_doc,''), '\\D', '', 'g')) STORED,
  razon_social text NOT NULL, nombre_comercial text, email text, telefono text, ciudad text, erp_partner_id int,
  erp_sync_state text DEFAULT 'pendiente', origen text, created_at timestamptz DEFAULT now());
CREATE TABLE account_billing_customers (user_id int, billing_customer_id uuid, rol text);
CREATE TABLE instances (id serial PRIMARY KEY, user_id int, label text, instance_url text, db_name text, plan text,
  status text, custom_domain text, suspended_at timestamptz, created_at timestamptz DEFAULT now());
CREATE TABLE integration_credentials (id serial PRIMARY KEY, servicio text, etiqueta text, expira_el date, activo boolean DEFAULT true);
CREATE TABLE leads (id serial PRIMARY KEY, full_name text, company_name text, email text, phone text, ruc text,
  status text DEFAULT 'new', plan_slug text, created_at timestamptz DEFAULT now());
CREATE TABLE payment_requests (id serial PRIMARY KEY, full_name text, email text, plan text, amount numeric, status text, created_at timestamptz DEFAULT now());
CREATE TABLE mail_domains (domain text PRIMARY KEY, owner_email text, created_at timestamptz DEFAULT now());
CREATE TABLE client_services (id serial PRIMARY KEY, service text, slug text, billing_customer_id uuid, fqdn text,
  status text, params jsonb DEFAULT '{}', created_at timestamptz DEFAULT now());
CREATE TABLE provisioning_jobs (id serial PRIMARY KEY, client_service_id int, status text, step text, error text,
  started_at timestamptz DEFAULT now());
CREATE TABLE admin_logs (id serial PRIMARY KEY, user_id int, action text, target text, detail text, created_at timestamptz DEFAULT now());`;

(async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ host: process.env.DB_HOST, port: process.env.DB_PORT, database: 'hc', user: 'hc' });
  const q = (s, p) => pool.query(s, p);
  await q(ESQUEMA);
  const ADM = (await q("INSERT INTO users (email, full_name, role) VALUES ('steve@hepta.com.py','Esteban Gracia','godmode') RETURNING id")).rows[0].id;
  const RODRI = (await q("INSERT INTO users (email, full_name, role) VALUES ('riglesias@rygtech.com.py','Rodrigo Iglesias','client') RETURNING id")).rows[0].id;
  const OTRO = (await q("INSERT INTO users (email, full_name, role) VALUES ('otro@x.com','Otro','client') RETURNING id")).rows[0].id;
  const RYG = (await q("INSERT INTO billing_customers (numero_doc, dv, razon_social, nombre_comercial, ciudad) VALUES ('80164156','0','RYG TECH DISTRIBUTION E.A.S.','RYG Tech','Lambaré') RETURNING id")).rows[0].id;
  const OTROC = (await q("INSERT INTO billing_customers (numero_doc, razon_social) VALUES ('1234567','Otro S.A.') RETURNING id")).rows[0].id;
  await q('INSERT INTO account_billing_customers VALUES ($1,$2,$3),($4,$5,$3)', [RODRI, RYG, 'titular', OTRO, OTROC]);
  const I1 = (await q("INSERT INTO instances (user_id,label,db_name,plan,status,custom_domain) VALUES ($1,'Sistema de Rodri','rygtech.erp.hepta.com.py','professional','active','rygtech.com.py') RETURNING id", [RODRI])).rows[0].id;
  const I2 = (await q("INSERT INTO instances (user_id,label,db_name,plan,status,suspended_at) VALUES ($1,'Ase Legal','aselegal.erp.hepta.com.py','professional','suspended',now()) RETURNING id", [OTRO])).rows[0].id;
  await q("INSERT INTO mail_domains (domain, owner_email) VALUES ('rygtech.com.py','RIGLESIAS@rygtech.com.py'),('otro.com.py','otro@x.com')");
  const D = (await q("INSERT INTO client_services (service,slug,billing_customer_id,fqdn,status) VALUES ('drive','rygtech',$1,'rygtech.drive.hepta.com.py','active') RETURNING id", [RYG])).rows[0].id;
  await q("INSERT INTO provisioning_jobs (client_service_id,status,step,error) VALUES ($1,'failed','vhost','certificado'),($1,'done','listo',null)", [D]);
  const D2 = (await q("INSERT INTO client_services (service,slug,billing_customer_id,status) VALUES ('drive','otro',$1,'failed') RETURNING id", [OTROC])).rows[0].id;
  await q("INSERT INTO provisioning_jobs (client_service_id,status,step,error) VALUES ($1,'failed','vhost','límite de Let''s Encrypt')", [D2]);
  await q("INSERT INTO leads (full_name, company_name, email, ruc, created_at) VALUES ('Juan','Mburucuyá Bistró','juan@x.com',null, now() - interval '30 hours'), ('Rodri','RYG','riglesias@rygtech.com.py','80164156-0', now()), ('Contadora','RYG por RUC','otra@x.com','80164156-0', now())");
  await q("INSERT INTO payment_requests (full_name, plan, amount, status) VALUES ('Ensayo T82','professional',329000,'pending'),('Viejo','starter',169000,'provisioned')");
  await q("INSERT INTO integration_credentials (servicio, etiqueta, expira_el) VALUES ('odoo','ERP del grupo', CURRENT_DATE + 5),('x','lejos', CURRENT_DATE + 90)");
  await q("INSERT INTO site_config VALUES ('fundadores_restantes','8')");
  await q('INSERT INTO admin_logs (user_id, action, target, detail) VALUES ($1,$2,$3,$4),($1,$5,$6,$7)',
    [ADM, 'activate_custom_domain', `instance:${I1}`, '{"dominio":"rygtech.com.py"}', 'suspend_instance', `instance:${I2}`, '{}']);

  const express = require('express'), jwt = require('jsonwebtoken');
  const app = express(); app.use(express.json());
  app.use('/api/admin', require(path.join(ROOT, 'backend/routes/admin.routes')));
  const server = await new Promise(res => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const port = server.address().port;
  const tok = (role, id) => jwt.sign({ id, role }, process.env.JWT_SECRET);
  const get = (p, t = tok('godmode', ADM)) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers: t ? { Authorization: 'Bearer ' + t } : {} }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch (e) { resolve({ status: res.statusCode, body: d }); } });
    }).on('error', reject);
  });

  let r = await get('/api/admin/v2/inicio', null);
  check('sin token: 401', r.status === 401);
  r = await get('/api/admin/v2/inicio', tok('client', RODRI));
  check('rol client: 403', r.status === 403);

  r = await get('/api/admin/v2/inicio');
  const d = r.body.data || {};
  check('inicio responde sin errores', r.status === 200 && d.errores && d.errores.length === 0, JSON.stringify(d.errores));
  check('kpis: clientes 2, instancias 1 activa y 1 suspendida', d.kpis.clientes === 2 && d.kpis.instancias.activas === 1 && d.kpis.instancias.suspendidas === 1);
  check('kpis: drive 2, correo 2, fundadores 8, pagos 1', d.kpis.drive === 2 && d.kpis.correo === 2 && d.kpis.fundadores_restantes === 8 && d.kpis.pagos_pendientes === 1);
  check('kpis: leads semana 3, sin responder 1', d.kpis.leads.semana === 3 && d.kpis.leads.sin_responder === 1);
  const tipos = d.atencion.map(a => a.tipo);
  check('atención: pago, suspendida, lead viejo, credencial por vencer', ['pago', 'suspendida', 'lead', 'credencial'].every(t => tipos.includes(t)), tipos.join(','));
  check('atención: solo la credencial que vence pronto', d.atencion.filter(a => a.tipo === 'credencial').length === 1);
  check('atención: trabajo fallido solo si es el último del servicio', d.atencion.filter(a => a.tipo === 'trabajo').map(a => a.titulo).join() === 'drive otro');
  check('actividad con el nombre de quien la hizo', d.actividad.length === 2 && d.actividad[0].usuario === 'Esteban Gracia');

  r = await get(`/api/admin/v2/clientes/${RYG}`);
  const f = r.body.data || {};
  check('ficha: responde', r.status === 200 && f.errores.length === 0, JSON.stringify(f.errores));
  check('ficha: usuario Rodri', f.usuarios.length === 1 && f.usuarios[0].email === 'riglesias@rygtech.com.py');
  check('ficha: su instancia y no la de otro', f.instancias.length === 1 && f.instancias[0].id === I1);
  check('ficha: correo por dueño, sin importar mayúsculas', f.correo.length === 1 && f.correo[0].domain === 'rygtech.com.py');
  check('ficha: drive', f.servicios.length === 1 && f.servicios[0].slug === 'rygtech');
  check('ficha: leads por RUC (con dígito verificador) y por correo', f.leads.length === 2 && f.leads.some(l => l.company_name === 'RYG por RUC'), JSON.stringify(f.leads.map(l => l.company_name)));
  check('ficha: actividad solo de sus instancias', f.actividad.length === 1 && f.actividad[0].action === 'activate_custom_domain');
  r = await get('/api/admin/v2/clientes/no-es-uuid');
  check('ficha: id inválido → 400', r.status === 400);
  r = await get('/api/admin/v2/clientes/00000000-0000-0000-0000-000000000000');
  check('ficha: inexistente → 404', r.status === 404);

  r = await get('/api/admin/v2/clientes');
  const ryg = (r.body.data || []).find(c => c.id === RYG);
  check('lista de clientes con conteos', ryg && ryg.usuarios === 1 && ryg.instancias === 1 && ryg.otros_servicios === 1);

  r = await get('/api/admin/v2/buscar?q=ryg');
  const ts = (r.body.data || []).map(x => x.tipo);
  check('búsqueda: cliente, instancia, correo, drive, usuario y lead', ['cliente', 'instancia', 'correo', 'drive', 'usuario', 'lead'].every(t => ts.includes(t)), ts.join(','));
  r = await get('/api/admin/v2/buscar?q=80164');
  check('búsqueda por RUC', (r.body.data || []).some(x => x.tipo === 'cliente' && x.id === RYG));
  r = await get('/api/admin/v2/buscar?q=r');
  check('búsqueda de 1 letra: vacía', r.body.data.length === 0);
  r = await get('/api/admin/v2/buscar?q=' + encodeURIComponent("'; DROP TABLE users; --"));
  check('búsqueda con comillas: no rompe', r.status === 200 && (await q('SELECT count(*) FROM users')).rows[0].count === '3');

  r = await get('/api/admin/v2/actividad?limit=1&offset=1');
  check('actividad paginada', r.body.data.length === 1 && r.body.data[0].action === 'activate_custom_domain');
  r = await get('/api/admin/v2/actividad?q=suspend');
  check('actividad filtrada', r.body.data.length === 1 && r.body.data[0].action === 'suspend_instance');

  // Un bloque que falla no rompe el resto
  await q('DROP TABLE integration_credentials');
  r = await get('/api/admin/v2/inicio');
  check('tabla que falta: el inicio responde igual y avisa', r.status === 200 && r.body.data.errores.includes('atencion_credenciales') && r.body.data.kpis.clientes === 2, JSON.stringify(r.body.data && r.body.data.errores));

  server.close(); await pool.end();
  const db = require(path.join(ROOT, 'backend/config/db')); await db.end();
  console.log(`\n${pass} PASS · ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
