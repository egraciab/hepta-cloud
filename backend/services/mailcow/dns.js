'use strict';

/**
 * Registros DNS que hay que publicar para que un dominio funcione contra el
 * mailcow de HEPTA.
 *
 * .env:
 *   MAIL_HOSTNAME   mail.hepta.com.py    (FQDN del mailcow, con su A + PTR)
 *   MAIL_DMARC_RUA  dmarc@hepta.com.py   (buzón de reportes agregados)
 *   MAIL_SPF_POLICY ~all | -all          (default ~all; endurecé a -all al verificar)
 */

function buildDnsRecords({ domain, dkim = null, mailHostname, dmarcRua, spfPolicy } = {}) {
  const host = mailHostname || process.env.MAIL_HOSTNAME || 'mail.hepta.com.py';
  const rua = dmarcRua || process.env.MAIL_DMARC_RUA || 'dmarc@hepta.com.py';
  const policy = spfPolicy || process.env.MAIL_SPF_POLICY || '~all';

  const records = [
    {
      key: 'mx',
      type: 'MX',
      name: '@',
      value: host,
      priority: 10,
      ttl: 3600,
      proxied: false,
      required: true,
      note: 'Entrega de correo entrante. Borrá cualquier MX anterior.',
    },
    {
      key: 'spf',
      type: 'TXT',
      name: '@',
      value: `v=spf1 a:${host} mx ${policy}`,
      ttl: 3600,
      proxied: false,
      required: true,
      note: 'Debe existir UN solo registro SPF en el dominio.',
    },
    {
      key: 'dmarc',
      type: 'TXT',
      name: '_dmarc',
      value: `v=DMARC1; p=quarantine; sp=quarantine; adkim=r; aspf=r; fo=1; pct=100; rua=mailto:${rua}`,
      ttl: 3600,
      proxied: false,
      required: true,
      note: 'Arrancá en quarantine; pasá a p=reject cuando los reportes estén limpios.',
    },
    {
      key: 'autodiscover',
      type: 'CNAME',
      name: 'autodiscover',
      value: host,
      ttl: 3600,
      proxied: false,
      required: false,
      note: 'Autoconfiguración de Outlook. En Cloudflare la nube va GRIS.',
    },
    {
      key: 'autoconfig',
      type: 'CNAME',
      name: 'autoconfig',
      value: host,
      ttl: 3600,
      proxied: false,
      required: false,
      note: 'Autoconfiguración de Thunderbird / clientes Mozilla.',
    },
    {
      key: 'srv_autodiscover',
      type: 'SRV',
      name: '_autodiscover._tcp',
      value: `0 0 443 ${host}`,
      service: '_autodiscover',
      proto: '_tcp',
      priority: 0,
      weight: 0,
      port: 443,
      target: host,
      ttl: 3600,
      proxied: false,
      required: false,
      note: 'Opcional, ayuda a Outlook cuando el CNAME no alcanza.',
    },
  ];

  if (dkim && dkim.txt) {
    records.splice(2, 0, {
      key: 'dkim',
      type: 'TXT',
      name: `${dkim.selector || 'dkim'}._domainkey`,
      value: dkim.txt,
      ttl: 3600,
      proxied: false,
      required: true,
      note: 'Clave pública DKIM generada por mailcow para este dominio.',
    });
  }

  return {
    domain,
    mail_hostname: host,
    generated_at: new Date().toISOString(),
    records,
    warnings: [
      'En Cloudflare TODOS estos registros van con proxy desactivado (nube gris).',
      `El PTR de la IP saliente debe resolver a ${host}.`,
      'Si el dominio tenía correo antes, bajá el TTL de los MX 24h antes de migrar.',
    ],
  };
}

/** Render en texto plano, para pegar en un ticket o mandarle al cliente. */
function renderDnsText(plan) {
  const lines = [`Registros DNS para ${plan.domain} (mail host: ${plan.mail_hostname})`, ''];
  for (const r of plan.records) {
    const flag = r.required ? '[requerido]' : '[opcional] ';
    const prio = r.type === 'MX' ? `${r.priority} ` : '';
    lines.push(`${flag} ${r.type.padEnd(5)} ${r.name.padEnd(22)} ${prio}${r.value}`);
  }
  lines.push('', 'Notas:');
  for (const w of plan.warnings) lines.push(`  - ${w}`);
  return lines.join('\n');
}

module.exports = { buildDnsRecords, renderDnsText };
