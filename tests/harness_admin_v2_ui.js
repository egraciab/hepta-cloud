// ADMIN NUEVO — UI (2026-11-24): /admin/v2/ REAL (index.html, admin.css, js/) servido por express, con la API
// simulada (datos de ejemplo con la forma de las rutas reales). Recorre todas las pantallas en escritorio y celular,
// prueba las acciones principales (menú de una instancia, suspender, clave admin, dominio propio, módulos, pedido,
// confirmar pago, leads) y falla si hay errores de JavaScript. Saca capturas si se le pasa una carpeta.
// Uso: node tests/harness_admin_v2_ui.js [carpeta para capturas]
const path = require('path'), fs = require('fs'), http = require('http');
const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'frontend/public');
const SHOTS = process.argv[2];
let pass = 0, fail = 0;
const check = (n, c, x = '') => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); };

// ── API simulada ──
const hoy = Date.now(), h = (n) => new Date(hoy - n * 3600e3).toISOString();
const RYG = '6f1c2a10-7a1e-4c55-9e1a-0c7b8f4a2d11';
const INST = [
  { id: 7, label: 'Sistema de Rodri', db_name: 'rygtech.erp.hepta.com.py', instance_url: 'https://rygtech.erp.hepta.com.py', plan: 'professional', status: 'active', custom_domain: 'rygtech.com.py', full_name: 'Rodrigo Iglesias', email: 'riglesias@rygtech.com.py', created_at: h(30), notes: '' },
  { id: 5, label: 'Estudio Elena Prono', db_name: 'elenaprono.erp.hepta.com.py', plan: 'professional', status: 'active', full_name: 'Elena Prono', email: 'elena@ejemplo.com.py', created_at: h(60) },
  { id: 3, label: 'Demo Boutique', db_name: 'boutique.erp.hepta.com.py', plan: 'professional', status: 'active', full_name: 'Demo', email: 'demo@hepta.com.py', created_at: h(200) },
  { id: 2, label: 'Ase Legal <script>alert(1)</script>', db_name: 'aselegal.erp.hepta.com.py', plan: 'professional', status: 'suspended', suspended_at: h(300), full_name: 'Ase', email: 'ase@x.com', created_at: h(900) },
  { id: 1, label: 'Tienda 2', db_name: 'tienda2.erp.hepta.com.py', plan: 'starter', status: 'active', full_name: 'T2', email: 't2@x.com', created_at: h(1500) },
];
const LOG = [{ id: 2, action: 'activate_custom_domain', target: 'instance:7', detail: '{"dominio":"rygtech.com.py","estado":"ok"}', usuario: 'Esteban Gracia', created_at: h(1) },
             { id: 1, action: 'suspend_instance', target: 'instance:2', detail: '{"tenant":"aselegal"}', usuario: 'Esteban Gracia', created_at: h(5) }];
const llamadas = [];
let susp = false;
function api(req, body) {
  const u = new URL(req.url, 'http://x'), p = u.pathname.replace(/^\/api/, ''), m = req.method;
  llamadas.push(`${m} ${p}`);
  const ok = (data, extra = {}) => ({ success: true, data, ...extra });
  if (p === '/auth/me') return ok({ id: 1, email: 'steve@hepta.com.py', full_name: 'Esteban Gracia', role: 'godmode' });
  if (p === '/auth/logout') return ok({});
  if (p === '/admin/config') return ok({ logo_url: '' });
  if (p === '/admin/v2/inicio') return ok({ kpis: { clientes: 9, instancias: { activas: 4, suspendidas: 1, total: 5 }, drive: 1, correo: 2, leads: { semana: 7, sin_responder: 2, nuevos: 3 }, pagos_pendientes: 1, fundadores_restantes: 8 },
    atencion: [{ tipo: 'pago', id: 4, titulo: 'Ensayo T82 S.A.', detalle: { plan: 'professional', monto: 329000 }, desde: h(1) },
               { tipo: 'suspendida', id: 2, titulo: 'Ase Legal', detalle: { db: 'aselegal.erp.hepta.com.py' }, desde: h(300) },
               { tipo: 'lead', id: 9, titulo: 'Mburucuyá Bistró', detalle: { nombre: 'Juan', telefono: '0981 222333' }, desde: h(26) },
               { tipo: 'credencial', id: 1, titulo: 'ERP del grupo', detalle: { servicio: 'odoo', vence: new Date(hoy + 5 * 864e5).toISOString() } },
               { tipo: 'trabajo', id: 3, titulo: 'drive otro', detalle: { paso: 'vhost', error: 'límite de Let\'s Encrypt' }, desde: h(2) }],
    actividad: LOG, errores: [] });
  if (p === '/admin/provision/jobs') return ok([{ id: 'a', tenant: 'ensayo', plan_nombre: 'Crecimiento', estado: 'en_curso', paso: 'Usuario del cliente y marca', segundos: 240 }]);
  if (p === '/admin/provision/health') return { success: true, status: 'ok' };
  if (p === '/admin/mail/health') return ok({ mailcow: 'ok' });
  // Pedido con Mail y Drive
  if (p === '/admin/mail/domains' && m === 'POST') { llamadas.push('MAIL ' + JSON.stringify(body)); return ok({ domain: body.domain, created: true }); }
  if (p === '/admin/mail/domains/nuevo.com.py/mailboxes' && m === 'POST') return ok({ address: `${body.local_part}@nuevo.com.py`, password: 'Clave-Una-Vez-1', force_password_change: true });
  if (p === '/admin/mail/domains/nuevo.com.py/dns/publish') {
    llamadas.push('DNS ' + (body && body.dry_run ? 'revision' : 'publicar'));
    return body && body.dry_run
      ? ok({ results: [{ record: 'mx', action: 'would_update', name: 'nuevo.com.py', type: 'MX', nuevo: '10 mail.hepta.com.py', actual: '10 mx.viejo.com', igual: false, otros_mx: ['20 mx2.viejo.com'], choca: [] },
                       { record: 'spf', action: 'would_create', name: 'nuevo.com.py', type: 'TXT', nuevo: '"v=spf1 a:mail.hepta.com.py mx ~all"', actual: null, igual: false, otros_mx: [], choca: [] }] })
      : ok({ results: [{ record: 'mx', action: 'updated', name: 'nuevo.com.py' }, { record: 'spf', action: 'created', name: 'nuevo.com.py' }] });
  }
  if (p === '/admin/drive/validar') return ok({ ok: true, fqdn: 'nuevo.drive.hepta.com.py', usuarios: 1, cuota_total_gb: 5, errores: [], avisos: [] });
  if (p === '/admin/drive' && m === 'POST') { llamadas.push('DRIVE ' + JSON.stringify(body)); return ok({ trabajo: 77, slug: body.slug, avisos: [] }); }
  if (p === '/admin/drive/jobs/77') return ok({ id: 77, status: 'done', step: 'Listo', fqdn: 'nuevo.drive.hepta.com.py' });
  if (p === '/admin/drive/health') return ok({});
  if (p === '/admin/drive') return ok({ instancias: [{ slug: 'elenaprono', fqdn: 'elenaprono.drive.hepta.com.py', usuarios: 5, ultima_copia: '2026-11-24 18:00', secretos_pendientes: true, suspendida: false, registro: { cliente: 'Estudio Elena Prono', status: 'active' } }], agente_error: null });
  if (p === '/admin/mail/domains') return ok([{ domain: 'rygtech.com.py', owner_email: 'riglesias@rygtech.com.py', max_mailboxes: 3, def_quota_mb: 10240, status: 'active', dns_verified_at: h(20), owner_tiene_usuario: true }]);
  if (p === '/admin/v2/clientes') return ok([{ id: RYG, razon_social: 'RYG TECH DISTRIBUTION E.A.S.', nombre_comercial: 'RYG Tech', numero_doc: '80164156', dv: '0', ciudad: 'Lambaré', usuarios: 1, instancias: 1, suspendidas: 0, otros_servicios: 0, erp_partner_id: 12, created_at: h(30) }]);
  if (p === `/admin/v2/clientes/${RYG}`) return ok({ cliente: { id: RYG, razon_social: 'RYG TECH DISTRIBUTION E.A.S.', nombre_comercial: 'RYG Tech', numero_doc: '80164156', dv: '0', ciudad: 'Lambaré', email: 'riglesias@rygtech.com.py', telefono: '0984 215808', erp_partner_id: 12, created_at: h(30) },
    usuarios: [{ id: 22, email: 'riglesias@rygtech.com.py', full_name: 'Rodrigo Iglesias', last_login_at: h(3), is_active: true }],
    instancias: [INST[0]], servicios: [], correo: [{ domain: 'rygtech.com.py', owner_email: 'riglesias@rygtech.com.py', status: 'active', max_mailboxes: 3 }],
    leads: [{ id: 1, company_name: 'RYG', status: 'qualified', plan_slug: 'professional', created_at: h(40) }], actividad: [LOG[0]], errores: [] });
  if (p === '/admin/v2/buscar') return ok([{ tipo: 'cliente', id: RYG, titulo: 'RYG Tech', sub: 'RUC 80164156' }, { tipo: 'instancia', id: 7, titulo: 'Sistema de Rodri', sub: 'rygtech.com.py' }]);
  if (p === '/admin/v2/actividad') return ok(LOG);
  if (p === '/admin/instances' && m === 'GET') return ok(INST.map(i => i.id === 2 && susp ? { ...i, status: 'active' } : i));
  if (/^\/admin\/instances\/\d+$/.test(p) && m === 'PUT') return ok({});
  if (/^\/admin\/provision\/reactivate\/2$/.test(p)) { susp = true; return { success: true, message: 'Instancia aselegal reactivada.' }; }
  if (/^\/admin\/provision\/suspend\/\d+$/.test(p)) return { success: true, message: 'Instancia suspendida.' };
  if (/^\/admin\/provision\/admin-password\/\d+$/.test(p)) return ok({ login: 'admin', password: 'Zq8-secreta-UNA-vez', url: 'https://rygtech.com.py' });
  if (/^\/admin\/provision\/addons\/\d+$/.test(p) && m === 'GET') return ok([{ id: 1, name: 'Boutique', description: 'Talles y colores', price_label: 'A definir', status: null }, { id: 2, name: 'Belleza y SPA', status: 'installed' }]);
  if (/^\/admin\/provision\/addons\/\d+$/.test(p) && m === 'POST') return ok({ job: { id: 'ad1' } });
  if (p === '/admin/provision/addon-jobs/ad1') return ok({ estado: 'ok' });
  if (/^\/admin\/provision\/custom-domain\/\d+$/.test(p) && m === 'GET') return ok({ dominio: 'cliente.com.py', db: 'boutique.erp.hepta.com.py', modo: 'hepta', zona: 'cliente.com.py', destino: 'lb.hepta.com.py',
    registros: [{ nombre: 'cliente.com.py', accion: 'reemplazar', actuales: [{ tipo: 'A', valor: '200.108.133.244', proxy: true }] }, { nombre: 'www.cliente.com.py', accion: 'crear', actuales: [] }],
    ssl: 'full', ssl_cambia: true, otros_con_proxy: [], correo: ['mail.hepta.com.py'], hay_que_reemplazar: true, bloqueos: [] });
  if (/^\/admin\/provision\/custom-domain\/\d+$/.test(p) && m === 'POST') return ok({ job: { id: 'cd1' } });
  if (p === '/admin/provision/custom-domain-jobs/cd1') return ok({ estado: 'ok', avisos: ['SSL de la zona: full → strict'] });
  if (p === '/admin/leads') return ok([{ id: 9, full_name: 'Juan Pérez', company_name: 'Mburucuyá Bistró', email: 'juan@x.com', phone: '0981222333', message: 'Adicionales: HEPTA Mail\n\nQuiero la demo', status: 'new', intent: 'consulta', plan_name: 'Plan Crecimiento', created_at: h(26) }], { total: 1 });
  if (/^\/admin\/leads\/\d+$/.test(p) && m === 'PUT') return ok({});
  if (/^\/admin\/leads\/\d+\/erp$/.test(p)) return ok({});
  if (p === '/admin/payment-requests') return ok([{ id: 4, full_name: 'Ensayo T82', email: 'ensayo@heptacloud.com.py', plan: 'professional', amount: 329000, status: 'pending', created_at: h(1) }]);
  if (p === '/admin/payment-requests/4/confirm') return { success: true, message: 'Pago confirmado', data: { job: { id: 'al1' } } };
  if (p === '/admin/provision/jobs/al1') return ok({ estado: 'ok', tenant: 'ensayo', credenciales_enviadas: true });
  if (p === '/admin/plans') return ok([{ slug: 'starter', name: 'Plan Despegue', price: 169000 }, { slug: 'professional', name: 'Plan Crecimiento', price: 329000 }, { slug: 'enterprise', name: 'Plan Empresa', price: 0 }]);
  if (p === '/admin/provision' && m === 'POST') { llamadas.push('ALTA ' + JSON.stringify(body)); return ok({ job: { id: 'nuevo1' } }); }
  if (p === '/admin/provision/jobs/nuevo1') return ok({ estado: 'ok', paso: 'Listo', segundos: 300, url: 'https://rygtech2.erp.hepta.com.py', credenciales_enviadas: true });
  return { success: false, error: 'ruta simulada no definida: ' + m + ' ' + p };
}

const TIPOS = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/')) {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      // un poco de demora, como en la vida real
      setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(api(req, b ? JSON.parse(b) : undefined))); }, 30);
    });
    return;
  }
  let f = u.pathname.replace(/^\/admin\/v2\/?/, '');
  if (!u.pathname.startsWith('/admin/v2')) { res.statusCode = 404; return res.end(); }
  f = path.join(PUB, 'admin/v2', f || 'index.html');
  if (!f.startsWith(path.join(PUB, 'admin/v2')) || !fs.existsSync(f)) { res.statusCode = 404; return res.end(); }
  res.setHeader('content-type', TIPOS[path.extname(f)] || 'text/plain'); res.end(fs.readFileSync(f));
}).listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}/admin/v2/`;
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  for (const [ancho, alto, tag] of [[1440, 1000, 'escritorio'], [390, 844, 'celular']]) {
    susp = false;
    const ctx = await browser.newContext({ viewport: { width: ancho, height: alto } });
    await ctx.route(u => !String(u).startsWith('http://127.0.0.1'), r => r.abort());
    await ctx.addInitScript(() => { localStorage.setItem('hc_admin_token', 'tok'); window.__alerts = 0; window.alert = () => { window.__alerts++; }; });
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
    const foto = async (n) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `v2-${tag}-${n}.png`), fullPage: true }); };
    const ver = async (hash, selector) => { await page.goto(base + hash); await page.waitForSelector(selector, { timeout: 8000 }); };

    await ver('#/inicio', '#att-lista .row');
    await page.waitForSelector('#plat-lista .punto.ok');
    let t = await page.textContent('#vista');
    check(`[${tag}] inicio: números, atención, trabajos y actividad`, /Lugares de fundador/.test(t) && /Ensayo T82/.test(t) && /Alta de ensayo/.test(t) && /activó el dominio propio de rygtech.com.py/.test(t), t.slice(0, 80));
    await page.waitForFunction(() => /Secretos/.test(document.getElementById('att-lista').textContent));
    check(`[${tag}] inicio: secretos de Drive sin bajar se suman solos`, true);
    check(`[${tag}] menú con contadores`, /Leads\s*3/.test(await page.textContent('#nav')) && /Pagos\s*1/.test(await page.textContent('#nav')));
    await foto('inicio');

    await ver('#/clientes', 'tr.clic');
    await foto('clientes');
    await page.click('tr.clic');
    await page.waitForSelector('[data-inst]');
    t = await page.textContent('#vista');
    check(`[${tag}] ficha de cliente: servicios, usuarios, actividad`, /HEPTA ERP · Crecimiento/.test(t) && /HEPTA Mail · rygtech.com.py/.test(t) && /Rodrigo Iglesias/.test(t) && /Vinculado al ERP/.test(t));
    await foto('cliente');

    await ver('#/servicios/erp', '[data-inst]');
    check(`[${tag}] ERP: texto con HTML se muestra escapado`, (await page.$$eval('script', s => s.filter(x => /alert\(1\)/.test(x.textContent)).length)) === 0 && /Ase Legal <script>/.test(await page.textContent('#tb')));
    await page.click('[data-st="suspended"]');
    check(`[${tag}] ERP: filtro de suspendidas`, (await page.$$('#tb tr')).length === 1);
    await page.click('[data-st=""]');
    await page.fill('#q', 'ryg');
    check(`[${tag}] ERP: búsqueda`, (await page.$$('#tb tr')).length === 1);
    await page.click('[data-inst="7"]');
    await page.waitForSelector('.menu');
    t = await page.textContent('.menu');
    check(`[${tag}] ERP: menú de acciones`, /Módulos adicionales/.test(t) && /Dominio propio/.test(t) && /Clave admin/.test(t) && /Suspender/.test(t));
    await foto('erp-menu');
    // Clave admin: se muestra una vez
    await page.click('.menu button:has-text("Clave admin")');
    await page.click('.modal-pie .btn.pri');
    await page.waitForSelector('#sec');
    check(`[${tag}] clave admin: se muestra`, /Zq8-secreta-UNA-vez/.test(await page.textContent('#sec')));
    await foto('clave');
    await page.click('.modal-pie .btn.pri');
    check(`[${tag}] clave admin: al cerrar no queda en la página`, !(await page.content()).includes('Zq8-secreta-UNA-vez'));
    // Dominio propio: revisión → activar
    await page.fill('#q', '');
    await page.click('[data-inst="3"]'); await page.click('.menu button:has-text("Dominio propio")');
    await page.fill('#d-dom', 'https://www.Cliente.com.py/');
    await page.click('.modal-pie .btn.pri');
    await page.waitForSelector('text=Activar cliente.com.py');
    t = await page.textContent('.modal');
    check(`[${tag}] dominio: la revisión muestra qué reemplaza, el SSL y el correo`, /Reemplaza: A 200.108.133.244 \(proxy\)/.test(t) && /full → Full \(strict\)/.test(t) && /mail.hepta.com.py/.test(t));
    await foto('dominio');
    await page.click('.modal-pie .btn.pri');
    await page.waitForSelector('.toast.ok', { timeout: 9000 });
    check(`[${tag}] dominio: avisa al terminar`, /cliente.com.py activo/.test(await page.textContent('#toasts')));
    check(`[${tag}] dominio: manda reemplazar=true`, llamadas.includes('POST /admin/provision/custom-domain/3'));
    // Reactivar la suspendida
    await page.click('[data-inst="2"]'); await page.click('.menu button:has-text("Reactivar")');
    await page.click('.modal-pie .btn.pri');
    await page.waitForFunction(() => /reactivada/.test(document.getElementById('toasts').textContent));
    check(`[${tag}] reactivar: llama a la ruta y refresca`, llamadas.includes('POST /admin/provision/reactivate/2'));
    // Módulos
    await page.click('[data-inst="7"]'); await page.click('.menu button:has-text("Módulos adicionales")');
    await page.waitForSelector('[data-addon="1"]');
    await page.click('[data-addon="1"]'); await page.click('.modal-pie .btn.pri');
    await page.waitForFunction(() => /Boutique instalado/.test(document.getElementById('toasts').textContent), null, { timeout: 9000 });
    check(`[${tag}] módulos: instala y avisa`, true);

    await ver('#/servicios/mail', '#tb tr td b'); await foto('mail');
    await ver('#/servicios/drive', '#tb tr td b');
    check(`[${tag}] drive: secretos sin bajar`, /sin bajar/.test(await page.textContent('#tb')));
    await ver('#/servicios/dominios', 'table');
    check(`[${tag}] dominios propios`, /rygtech.com.py/.test(await page.textContent('#cont')));

    await ver('#/leads', '[data-lead]');
    await page.selectOption('[data-lead="9"]', 'contacted');
    await page.waitForFunction(() => /Estado actualizado/.test(document.getElementById('toasts').textContent));
    check(`[${tag}] leads: cambia el estado`, llamadas.includes('PUT /admin/leads/9'));
    check(`[${tag}] leads: WhatsApp con mensaje armado`, /wa\.me\/595981222333\?text=Hola%20Juan/.test(await page.getAttribute('#tb a[href*="wa.me"]', 'href')));
    await foto('leads');

    await ver('#/pagos', '[data-conf]');
    await page.click('[data-conf="4"]'); await page.fill('#p-sub', 'ensayo');
    await page.click('.modal-pie .btn.pri');
    await page.waitForFunction(() => /ensayo quedó listo/.test(document.getElementById('toasts').textContent), null, { timeout: 15000 });
    check(`[${tag}] pagos: confirmar da el alta y avisa`, true);

    await ver('#/actividad', '#tb tr td');
    check(`[${tag}] actividad legible`, /suspendió/.test(await page.textContent('#tb')));

    // Pedido completo (solo en escritorio: tarda)
    if (tag === 'escritorio') {
      await ver(`#/pedido?cliente=${RYG}`, '#u');
      await foto('pedido-1');
      await page.click('#sig1');
      await page.waitForSelector('[data-on=erp]');
      check('pedido: si el cliente ya tiene ERP, no lo propone de nuevo', !(await page.isChecked('[data-on=erp]')) && /Ya tiene: rygtech/.test(await page.textContent('#vista')));
      await page.check('[data-on=erp]');
      await page.waitForSelector('#sub');
      check('pedido: subdominio sugerido desde el nombre', (await page.inputValue('#sub')) === 'rygtech');
      await page.fill('#sub', 'Mal Nombre');
      await page.click('#sig2');
      check('pedido: subdominio inválido no avanza', await page.isVisible('#sub'));
      await page.fill('#sub', 'rygtech2');
      await foto('pedido-2');
      await page.click('#sig2'); await page.waitForSelector('#conf');
      await foto('pedido-3');
      await page.click('#conf');
      await page.waitForSelector('#j1 + .chip.ok, .chip.ok:text-is("Listo")', { timeout: 15000 });
      check('pedido: alta con el usuario, subdominio y plan elegidos', llamadas.some(l => l === 'ALTA ' + JSON.stringify({ user_id: 22, tenant: 'rygtech2', plan: 'professional', label: 'Sistema de RYG Tech' })), llamadas.filter(l => /provision/.test(l)).slice(-5).join(' | '));
      await foto('pedido-4');

      // Pedido de Mail y Drive solos (sin ERP), con la revisión del DNS antes de publicar
      await ver('#/inicio', '#vista .kpi');
      const limpiarAvisos = () => page.evaluate(() => { document.getElementById('toasts').innerHTML = ''; });
      await limpiarAvisos();
      await ver(`#/pedido?cliente=${RYG}`, '#u');
      await page.click('#sig1'); await page.waitForSelector('[data-on=erp]');
      await page.check('[data-on=mail]'); await page.waitForSelector('#m-dom');
      await page.fill('#m-dom', 'rygtech.com.py'); await page.press('#m-dom', 'Tab');
      await page.fill('[data-cas="0"][data-k=lp]', 'ventas'); await page.fill('[data-cas="0"][data-k=nombre]', 'Ventas');
      await page.check('[data-on=drive]'); await page.waitForSelector('#d-slug');
      await page.fill('#d-slug', 'nuevo');
      await page.fill('[data-du="0"][data-k=nombre]', 'Ana Gómez'); await page.fill('[data-du="0"][data-k=correo]', 'ana@nuevo.com.py');
      // Precios escalonados: 5 casillas = 120.000 + 40.000 (4.ª) + 36.000 (5.ª); Drive 6 usuarios y 200 GB = Paquete Equipo
      await page.fill('#m-max', '5'); await page.press('#m-max', 'Tab'); await page.waitForTimeout(100);
      check('pedido mail: 5 casillas suman por tramo (196.000)', /196\.000/.test(await page.textContent('aside.card')) || /196\.000/.test(await page.textContent('aside.card')));
      await page.fill('#m-max', '10'); await page.press('#m-max', 'Tab'); await page.waitForTimeout(100);
      check('pedido mail: desde la 10.ª casilla se cotiza', /a cotizar/.test(await page.textContent('aside.card')));
      await page.fill('#m-max', '3'); await page.press('#m-max', 'Tab'); await page.waitForTimeout(100);
      await page.selectOption('#d-gb', '200'); await page.waitForTimeout(100);
      await page.fill('#d-cont', '6'); await page.press('#d-cont', 'Tab'); await page.waitForTimeout(100);
      check('pedido drive: 6 usuarios y 200 GB es el Paquete Equipo (270.000)', /Paquete Equipo/.test(await page.textContent('aside.card')) && /270\.000/.test(await page.textContent('aside.card')));
      await page.selectOption('#d-gb', '100'); await page.waitForTimeout(100);
      await page.fill('#d-cont', '3'); await page.press('#d-cont', 'Tab'); await page.waitForTimeout(100);
      check('pedido: base 120.000 + 150.000 = 270.000', /270\.000/.test(await page.textContent('aside.card')) && !/Paquete/.test(await page.textContent('aside.card')));
      await page.click('#sig2'); await page.waitForTimeout(400);
      check('pedido mail: un dominio que ya tiene correo no avanza', await page.isVisible('#m-dom') && /ya tiene correo/.test(await page.textContent('#toasts')));
      await limpiarAvisos();
      await page.fill('#m-dom', 'nuevo.com.py'); await page.press('#m-dom', 'Tab');
      check('pedido mail: lo cargado sobrevive al repintar', (await page.inputValue('[data-cas="0"][data-k=lp]')) === 'ventas' && (await page.inputValue('#d-slug')) === 'nuevo');
      await foto('pedido-adicionales-2');
      await page.click('#sig2'); await page.waitForSelector('#conf');
      const rev = await page.textContent('#vista');
      check('pedido mail: la revisión muestra casillas y dirección del Drive', /ventas@nuevo\.com\.py/.test(rev) && /nuevo\.drive\.hepta\.com\.py/.test(rev));
      const altasAntes = llamadas.filter(l => l.startsWith('ALTA ')).length;
      await page.click('#conf');
      await page.waitForSelector('#m-dns', { timeout: 15000 });
      await page.waitForSelector('#a-drive + .chip.ok', { timeout: 15000 });
      await foto('pedido-adicionales-4');
      check('pedido mail: no pide el ERP si no se eligió', llamadas.filter(l => l.startsWith('ALTA ')).length === altasAntes);
      const mailAlta = llamadas.find(l => l.startsWith('MAIL '));
      check('pedido mail: crea el dominio sin publicar DNS y con 5 GB por casilla', mailAlta && /"publish_dns":false/.test(mailAlta) && /"quota_mb":15360/.test(mailAlta) && /"max_mailboxes":3/.test(mailAlta), mailAlta);
      check('pedido drive: manda cliente y usuarios', llamadas.some(l => l.startsWith('DRIVE ') && /"slug":"nuevo"/.test(l) && /ana@nuevo\.com\.py/.test(l) && new RegExp(RYG).test(l)));
      check('pedido mail: muestra la contraseña inicial una vez', /Clave-Una-Vez-1/.test(await page.textContent('#vista')));
      check('pedido mail: no publica el DNS sin revisión', !llamadas.includes('DNS publicar'));
      await page.click('#m-dns'); await page.waitForSelector('.modal');
      const md = await page.textContent('.modal');
      check('pedido mail: la revisión del DNS avisa qué reemplaza y los otros MX', /Reemplaza: 10 mx\.viejo\.com/.test(md) && /Quedarían otros MX/.test(md) && /20 mx2\.viejo\.com/.test(md));
      await foto('pedido-adicionales-dns');
      await page.click('.modal .btn.pri'); await page.waitForSelector('.modal .btn.peligro');
      await page.click('.modal .btn.peligro');
      await page.waitForSelector('.chip.ok:text-is("DNS publicado")', { timeout: 10000 });
      check('pedido mail: publica recién después de confirmar el reemplazo', llamadas.indexOf('DNS publicar') > llamadas.indexOf('DNS revision'));
      await ver('#/inicio', '#vista .kpi');
      check('pedido mail: la contraseña no queda en la página al salir', !(await page.content()).includes('Clave-Una-Vez-1'));

      // Búsqueda global
      await page.keyboard.press('Control+k');
      await page.fill('#pq', 'ryg');
      await page.waitForSelector('#pres a');
      await foto('busqueda');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => location.hash.startsWith('#/clientes/'));
      check('búsqueda global: Enter abre el cliente', true);
    } else {
      await page.click('#burger');
      await page.waitForTimeout(300);
      check('[celular] el menú se abre con el botón', await page.isVisible('#nav a[href="#/leads"]'));
      await foto('menu');
      const anchoDoc = await page.evaluate(() => document.documentElement.scrollWidth);
      check('[celular] sin scroll horizontal de la página', anchoDoc <= 392, String(anchoDoc));
    }
    check(`[${tag}] sin errores de JavaScript ni alert()`, errs.length === 0 && (await page.evaluate(() => window.__alerts)) === 0, errs.join(' | '));
    await ctx.close();
  }
  await browser.close(); server.close();
  console.log(`\n${pass} PASS · ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
});
