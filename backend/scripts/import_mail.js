#!/usr/bin/env node
'use strict';

/**
 * Importa a HEPTA Cloud los dominios de correo que YA existen en mailcow.
 *
 * A diferencia de provision_mail.js, este script NO escribe nada en mailcow:
 * lee las cuotas y casillas reales y las registra en `mail_domains` tal como
 * están. Sirve para adoptar los clientes que diste de alta a mano.
 *
 *   # 1. ver qué encontraría, sin escribir nada (por defecto)
 *   docker compose exec backend node scripts/import_mail.js
 *
 *   # 2. importar de verdad
 *   docker compose exec backend node scripts/import_mail.js --apply
 *
 *   # 3. un dominio puntual, con dueño explícito
 *   docker compose exec backend node scripts/import_mail.js --only empresa.com.py \
 *       --owner juan@empresa.com.py --apply
 *
 *   # 4. con mapeo dominio -> dueño en JSON
 *   docker compose exec backend node scripts/import_mail.js --map /tmp/duenos.json --apply
 *
 * Formato de --map:  { "empresa.com.py": "juan@empresa.com.py", ... }
 *
 * Cómo resuelve el dueño, en orden:
 *   1. --owner (solo con --only)
 *   2. el archivo de --map
 *   3. un único usuario de HC cuyo email termine en @<dominio>
 *   4. si no hay uno solo y claro, no adivina: lo marca SIN DUEÑO y lo saltea
 */

try { require('dotenv').config(); } catch (_) {}

const path = require('path');
const ROOT = path.join(__dirname, '..');
const mc = require(path.join(ROOT, 'services', 'mailcow', 'client'));
const pool = require(path.join(ROOT, 'config', 'db'));

/* mailcow devuelve las cuotas en BYTES al leer, pero las recibe en MB al
   escribir. Heurística: por encima de 1e6 lo tratamos como bytes (1e6 MB = 1 TB,
   nadie configura un dominio así). */
function normMb(v) {
  const n = Number(v) || 0;
  return n > 1e6 ? Math.round(n / 1048576) : Math.round(n);
}
const fmt = (mb) => (mb >= 1024 ? (mb / 1024).toFixed(mb % 1024 ? 1 : 0) + ' GB' : mb + ' MB');

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const k = t.slice(2);
    if (['apply', 'help'].includes(k)) a[k] = true;
    else a[k] = argv[++i];
  }
  return a;
}

async function usuariosDeHC() {
  try {
    const { rows } = await pool.query('SELECT email FROM users WHERE email IS NOT NULL');
    return rows.map((r) => String(r.email).toLowerCase());
  } catch (err) {
    console.warn(`  ! No pude leer la tabla users (${err.message}); sigo sin autodetección de dueño.`);
    return [];
  }
}

(async () => {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0].split('/**')[1]);
    process.exit(0);
  }

  const mapa = args.map ? JSON.parse(require('fs').readFileSync(args.map, 'utf8')) : {};
  const emails = await usuariosDeHC();

  console.log(`\n${args.apply ? '== IMPORTANDO ==' : '== SIMULACIÓN (agregá --apply para escribir) =='}\n`);

  // 1. dominios en mailcow
  const todos = await mc.request('GET', 'get/domain/all');
  if (!Array.isArray(todos) || !todos.length) {
    console.log('mailcow no devolvió dominios.');
    if (pool.end) await pool.end();
    return;
  }

  // 2. los que ya están en HEPTA Cloud
  const yaRegistrados = new Map();
  try {
    const { rows } = await pool.query('SELECT domain, owner_email FROM mail_domains');
    rows.forEach((r) => yaRegistrados.set(r.domain, r.owner_email));
  } catch (err) {
    console.error(`ERROR leyendo mail_domains: ${err.message}`);
    process.exit(1);
  }

  const filtro = args.only ? String(args.only).toLowerCase() : null;
  let importados = 0, salteados = 0, existentes = 0;

  for (const d of todos) {
    const dominio = String(d.domain_name || '').toLowerCase();
    if (!dominio) continue;
    if (filtro && dominio !== filtro) continue;

    const quotaMb = normMb(d.max_quota_for_domain ?? d.quota);
    const defQuotaMb = normMb(d.def_quota_for_mbox ?? d.defquota) || 1024;
    const maxBuzones = Number(d.max_num_mboxes_for_domain ?? d.mailboxes) || 50;

    // casillas reales, para el reporte
    let buzones = [];
    try { buzones = await mc.getMailboxes(dominio); } catch (_) {}
    const asignado = buzones.reduce((acc, m) => acc + normMb(m.quota), 0);

    // dueño
    let owner = null, origen = '';
    if (filtro && args.owner) { owner = String(args.owner).toLowerCase(); origen = '--owner'; }
    else if (mapa[dominio]) { owner = String(mapa[dominio]).toLowerCase(); origen = '--map'; }
    else {
      const candidatos = emails.filter((e) => e.endsWith('@' + dominio));
      if (candidatos.length === 1) { owner = candidatos[0]; origen = 'usuario HC'; }
      else if (candidatos.length > 1) origen = `${candidatos.length} usuarios posibles`;
    }

    const yaEsta = yaRegistrados.has(dominio);

    console.log(`${dominio}`);
    console.log(`   cuota ${fmt(quotaMb)} · ${buzones.length}/${maxBuzones} casillas · ${fmt(asignado)} asignados · def ${fmt(defQuotaMb)}`);
    for (const b of buzones) {
      console.log(`     - ${b.username}  ${fmt(normMb(b.quota))}  (usa ${fmt(normMb(b.quota_used))})`);
    }

    if (yaEsta) {
      console.log(`   → YA REGISTRADO en HEPTA Cloud (dueño: ${yaRegistrados.get(dominio)}), no lo toco\n`);
      existentes += 1;
      continue;
    }
    // Sin dueño ya no es motivo para saltear: se importa igual y queda bajo
    // custodia de godmode hasta que lo delegues desde el admin.
    if (!owner) {
      console.log(`   → SIN DUEÑO${origen ? ` (${origen})` : ''}: se importa bajo custodia de godmode`);
      salteados += 1;
    }

    // DKIM: solo aviso, no lo creo (crear una clave nueva rompería la firma actual)
    let dkim = null;
    try { dkim = await mc.getDkim(dominio); } catch (_) {}
    if (!dkim) console.log('   ! ATENCIÓN: este dominio no tiene DKIM en mailcow');

    if (!args.apply) {
      console.log(`   → se importaría ${owner ? `con dueño ${owner} (${origen})` : 'SIN DUEÑO (solo godmode)'}\n`);
      importados += 1;
      continue;
    }

    await pool.query(
      `INSERT INTO mail_domains (domain, owner_email, quota_mb, def_quota_mb, max_mailboxes, dkim_selector, status)
       VALUES ($1,$2,$3,$4,$5,$6,'active')
       ON CONFLICT (domain) DO NOTHING`,
      [dominio, owner, quotaMb, defQuotaMb, maxBuzones, dkim ? dkim.selector : 'dkim']
    );
    await pool.query(
      'INSERT INTO mail_provision_log (domain, action, success, detail) VALUES ($1,$2,TRUE,$3)',
      [dominio, 'import', `owner=${owner || '(sin dueño)'}${origen ? ` (${origen})` : ''} quota=${quotaMb}MB`]
    );
    console.log(`   → IMPORTADO ${owner ? `con dueño ${owner} (${origen})` : 'SIN DUEÑO (solo godmode)'}\n`);
    importados += 1;
  }

  console.log('─'.repeat(60));
  console.log(`${importados} ${args.apply ? 'importado(s)' : 'a importar'} · ${existentes} ya registrado(s) · ${salteados} sin dueño`);
  if (!args.apply && importados) console.log('\nVolvé a correrlo con --apply para escribir en HEPTA Cloud.');
  if (salteados) {
    console.log('Los que quedaron sin dueño solo los ve godmode. Podés asignarlos después desde');
    console.log('Admin → Correo → Gestión, o acá mismo con --map { "dominio": "email" }.');
  }

  // Aviso: el dueño tiene que existir como usuario del portal
  const faltantes = [];
  for (const [dom, o] of yaRegistrados) if (o && !emails.includes(String(o).toLowerCase())) faltantes.push(`${dom} → ${o}`);
  if (faltantes.length) {
    console.log('\n! Dominios cuyo dueño NO tiene usuario en HEPTA Cloud (no van a ver nada al entrar):');
    faltantes.forEach((f) => console.log(`    ${f}`));
  }

  if (pool.end) await pool.end();
})().catch(async (err) => {
  console.error(`\nERROR: ${err.message}`);
  if (err.details) console.error(err.details);
  try { if (pool.end) await pool.end(); } catch (_) {}
  process.exit(1);
});
