const router = require('express').Router();
const mail = require('../services/mailcow');

/**
 * Branding público del webmail. SIN autenticación a propósito: lo carga el
 * navegador de cualquier persona que entre al webmail del cliente.
 *
 * Montaje:
 *   app.use('/api/public/mail-branding', require('./routes/public_mail.routes'));
 *
 * El vhost de Nginx de cada cliente inyecta:
 *   <link rel="stylesheet" href="https://cloud.hepta.com.py/api/public/mail-branding/<host>.css">
 *
 * Como el CSS se sirve desde acá, las URL relativas de adentro resuelven contra
 * este mismo origen: por eso el logo va como /api/public/mail-branding/<host>/logo
 * y no hace falta configurar ningún dominio absoluto.
 */

/**
 * Cross-Origin-Resource-Policy es obligatorio acá. helmet (o cualquier capa de
 * seguridad por defecto) manda `same-origin`, y con eso el navegador se niega a
 * APLICAR esta hoja en el webmail del cliente: la descarga con 200 pero la
 * descarta con ERR_BLOCKED_BY_RESPONSE.NotSameOrigin, sin error visible en la
 * pagina. Estos dos recursos son publicos a proposito, asi que van en
 * `cross-origin`. Ojo: el header NO es visible desde fetch() aunque este
 * presente (no esta en la lista blanca de CORS), verificar con curl -I.
 */
const CSS_HEADERS = {
  'Content-Type': 'text/css; charset=utf-8',
  'Cache-Control': 'public, max-age=300',
  'Access-Control-Allow-Origin': '*',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

/**
 * CSS de marca para un dominio. Los selectores están acá y en un solo lugar:
 * si mailcow o SOGo cambian su markup, se corrige una vez y se arregla para
 * todos los clientes de golpe, sin tocar ningún servidor.
 *
 * Técnica: el logo de mailcow es un <img> con data URI, no un background.
 * No se puede "reemplazar" el src desde CSS de forma confiable en todos los
 * navegadores, así que ocultamos la imagen y pintamos el logo del cliente como
 * fondo del contenedor. Funciona en cualquier navegador.
 */
function construirCss({ host, logo, color, ocultarAdmin }) {
  const url = `/api/public/mail-branding/${encodeURIComponent(host)}/logo`;
  const partes = [`/* Branding de ${host} — generado por HEPTA Cloud */`];

  if (ocultarAdmin) {
    // El login de mailcow ofrece "Iniciar sesión como administrador" y
    // "...de dominio". En el host de un cliente no tienen nada que hacer.
    // Nginx ya devuelve 404 en /admin y /domainadmin: esto es lo cosmetico.
    partes.push(`
/* ── Accesos de administracion: fuera del host del cliente ──── */
a[href="/admin"],
a[href="/domainadmin"],
a[href$="/admin"][href^="/"],
a[href$="/domainadmin"][href^="/"] {
  display: none !important;
}`);
  }

  if (logo) {
    partes.push(`
/* ── UI de mailcow (Bootstrap): pantalla de login ──────────── */
.mailcow-logo img,
img.main-logo,
img.main-logo-dark {
  display: none !important;
}

.mailcow-logo {
  background-image: url("${url}") !important;
  background-repeat: no-repeat !important;
  background-position: center center !important;
  background-size: contain !important;
  min-height: 90px !important;
}

/* ── SOGo (Angular Material): el webmail ───────────────────── */
#logo,
.sogo-logo,
.md-logo,
img[src*="sogo"] {
  content: url("${url}") !important;
  max-height: 60px !important;
  width: auto !important;
}`);
  }

  if (color) {
    // El color NO se pinta detrás del logo: la mayoría de los logos traen su
    // propio fondo (blanco) y quedarían con franjas de color arriba y abajo.
    // Se aplica donde siempre se ve bien: botón principal, foco y acentos.
    partes.push(`
/* ── Color de marca ─────────────────────────────────────────── */
.btn-primary,
button[type="submit"].btn,
.sogo-login .md-primary,
md-toolbar.md-primary {
  background-color: ${color} !important;
  border-color: ${color} !important;
}

.btn-primary:hover,
.btn-primary:focus,
button[type="submit"].btn:hover {
  filter: brightness(1.12) !important;
}

.form-control:focus {
  border-color: ${color} !important;
  box-shadow: 0 0 0 .2rem ${color}33 !important;
}

a, .nav-link.active { color: ${color} !important; }

/* Línea de acento debajo del logo */
.mailcow-logo {
  border-bottom: 3px solid ${color} !important;
  padding-bottom: 12px !important;
}`);
  }

  if (partes.length === 1) partes.push('/* sin branding configurado para este host */');
  return partes.join('\n');
}

const JS_HEADERS = {
  'Content-Type': 'application/javascript; charset=utf-8',
  'Cache-Control': 'public, max-age=300',
  'Access-Control-Allow-Origin': '*',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

/**
 * El <title> de la pestaña no se puede tocar desde CSS, y el encabezado del
 * login viene en un <legend> sin clase propia. Por eso este script mínimo.
 *
 * No reescribe el título completo: reemplaza las marcas ajenas dentro de él.
 * Así SOGo puede seguir poniendo "Bandeja de entrada — <marca>" al navegar
 * entre carpetas y el resultado sigue teniendo sentido.
 *
 * El título se serializa con JSON.stringify sobre un valor ya saneado en el
 * servicio (sin < ni >), así que no puede romper ni escapar del script.
 */
function construirJs({ titulo }) {
  if (!titulo) return '/* sin titulo configurado para este host */\n';
  return `/* Branding de HEPTA Cloud */
(function () {
  var T = ${JSON.stringify(titulo)};
  function re() { return /mailcow\\s*UI|mailcow|SOGo/gi; }

  function titulo() {
    var t = (document.title || '').replace(re(), T).trim();
    if (!t) t = T;
    t = t.replace(/^(.+?)(\\s*[\\u2014\\-|]\\s*\\1)+$/, '$1');   // sin repetir la marca
    if (document.title !== t) document.title = t;
  }

  function textos() {
    var els = document.querySelectorAll('legend, .card-title, .navbar-brand, h1, h2, h3, h4, h5');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.children.length === 0 && re().test(el.textContent || '')) {
        el.textContent = el.textContent.replace(re(), T);
      }
    }
  }

  function aplicar() { titulo(); textos(); }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', aplicar);
  else aplicar();

  // SOGo reescribe el <title> al cambiar de carpeta.
  if (window.MutationObserver && document.head) {
    new MutationObserver(titulo).observe(document.head, { subtree: true, childList: true, characterData: true });
  }
})();
`;
}

/** JS del host. Igual que el CSS: siempre 200. */
router.get('/:host.js', async (req, res) => {
  const host = String(req.params.host || '').toLowerCase();
  try {
    const row = await mail.findDomainByWebmailHost(host);
    res.set(JS_HEADERS).send(construirJs({ titulo: row && row.webmail_title }));
  } catch (err) {
    console.error('[public/mail-branding js]', err.message);
    res.set(JS_HEADERS).send('/* branding no disponible */\n');
  }
});

/** CSS del host. Siempre 200: un 404 en una hoja de estilos no ayuda a nadie. */
router.get('/:host.css', async (req, res) => {
  const host = String(req.params.host || '').toLowerCase();
  try {
    const row = await mail.findDomainByWebmailHost(host);
    res.set(CSS_HEADERS).send(
      construirCss({
        host,
        logo: row && row.webmail_logo_url,
        color: row && row.webmail_color,
        // ?admin=1 lo pone el vhost que SI deja administrar (--con-admin).
        ocultarAdmin: req.query.admin !== '1',
      })
    );
  } catch (err) {
    console.error('[public/mail-branding css]', err.message);
    res.set(CSS_HEADERS).send('/* branding no disponible */');
  }
});

/** El archivo del logo. */
router.get('/:host/logo', async (req, res) => {
  const host = String(req.params.host || '').toLowerCase();
  try {
    const row = await mail.findDomainByWebmailHost(host);
    if (!row || !row.webmail_logo_url) return res.status(404).end();

    const ruta = mail.rutaLogo(row.webmail_logo_url);
    if (!ruta) return res.status(404).end();

    res.set({
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',  // ver nota arriba
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
    });
    res.sendFile(ruta, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  } catch (err) {
    console.error('[public/mail-branding logo]', err.message);
    res.status(404).end();
  }
});

module.exports = router;
