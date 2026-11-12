#!/usr/bin/env node
'use strict';

/**
 * Alta de un dominio de correo desde la línea de comandos.
 * Mismo camino que usa el botón del admin — sirve para el primer cliente
 * mientras la UI no está, y para soporte después.
 *
 * Correlo DENTRO del contenedor (ahí están las env vars y la red):
 *
 *   docker compose exec backend node scripts/provision_mail.js \
 *     --domain adelanta.com.py \
 *     --owner contacto@adelanta.com.py \
 *     --quota 10240 --defquota 1024 --max-mailboxes 20 \
 *     --mailbox info \
 *     --publish-dns
 *
 * Flags:
 *   --domain          dominio a dar de alta (requerido)
 *   --owner           email del cliente dueño en HEPTA Cloud (requerido)
 *   --quota           cuota total del dominio en MB (default 10240)
 *   --defquota        cuota por defecto de cada casilla en MB (default 1024)
 *   --max-mailboxes   tope de casillas (default 50)
 *   --mailbox NAME    crea la casilla NAME@dominio (repetible)
 *   --publish-dns     publica además los registros en Cloudflare
 *   --dry-run         con --publish-dns, solo muestra qué haría
 */

try { require('dotenv').config(); } catch (_) { /* dentro del contenedor las env ya vienen del env_file */ }

const path = require('path');
const ROOT = path.join(__dirname, '..');
const mail = require(path.join(ROOT, 'services', 'mailcow'));
const { applyDnsPlan } = require(path.join(ROOT, 'services', 'mailcow', 'cloudflare'));
const pool = require(path.join(ROOT, 'config', 'db'));

function parseArgs(argv) {
  const args = { mailbox: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (['publish-dns', 'dry-run', 'help'].includes(key)) args[key] = true;
    else if (key === 'mailbox') args.mailbox.push(argv[++i]);
    else args[key] = argv[++i];
  }
  return args;
}

(async () => {
  const args = parseArgs(process.argv);

  if (args.help || !args.domain || !args.owner) {
    console.log('\nUso: node scripts/provision_mail.js --domain <dominio> --owner <email> [--quota MB]');
    console.log('     [--defquota MB] [--max-mailboxes N] [--mailbox nombre]... [--publish-dns] [--dry-run]\n');
    process.exit(args.help ? 0 : 1);
  }

  console.log(`\n== Provisionando ${args.domain} ==`);
  const result = await mail.provisionDomain({
    domain: args.domain,
    ownerEmail: args.owner,
    quotaMb: args.quota ? Number(args.quota) : undefined,
    defQuotaMb: args.defquota ? Number(args.defquota) : undefined,
    maxMailboxes: args['max-mailboxes'] ? Number(args['max-mailboxes']) : undefined,
  });
  console.log(result.created ? '  dominio creado en mailcow' : '  dominio ya existía, cuotas re-sincronizadas');

  const credentials = [];
  for (const name of args.mailbox) {
    try {
      const box = await mail.createMailbox(args.domain, { localPart: name });
      credentials.push(box);
      console.log(`  casilla creada: ${box.address} (${box.quota_mb}MB)`);
    } catch (err) {
      console.error(`  ! casilla ${name}: ${err.message}`);
    }
  }

  console.log(`\n${result.dns_text}\n`);

  if (args['publish-dns']) {
    console.log('== Publicando en Cloudflare ==');
    try {
      const cf = await applyDnsPlan(result.dns, { dryRun: Boolean(args['dry-run']) });
      for (const r of cf.results) {
        console.log(`  ${r.action.padEnd(14)} ${r.name}${r.error ? ` — ${r.error}` : ''}`);
      }
    } catch (err) {
      console.error(`  ! Cloudflare: ${err.message}`);
    }
  }

  if (credentials.length) {
    console.log('\n== Credenciales iniciales (se piden cambiar en el primer login) ==');
    for (const c of credentials) console.log(`  ${c.address}  ${c.password || '(definida por vos)'}`);
  }

  console.log(`\nListo. Verificá con:  dig MX ${args.domain} +short\n`);
  if (pool && typeof pool.end === 'function') await pool.end();
})().catch(async (err) => {
  console.error(`\nERROR: ${err.message}`);
  if (err.details) console.error(err.details);
  try { if (pool && pool.end) await pool.end(); } catch (_) {}
  process.exit(1);
});
