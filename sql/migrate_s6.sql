-- HC-S6: hero badge, botón primario acción, páginas legales
INSERT INTO site_config (key, value) VALUES
  ('hero_badge_text',     'Partner tecnológico · Paraguay'),
  ('hero_badge_show',     'true'),
  ('btn_primary_action',  'modal'),   -- 'modal' | '#planes' | '#soluciones' | url
  ('hero_checks',         'Implementación en días,Hosting en Paraguay,Soporte humano,Sin costos ocultos')
ON CONFLICT (key) DO NOTHING;

-- Tabla para páginas legales
CREATE TABLE IF NOT EXISTS pages (
  id          SERIAL PRIMARY KEY,
  slug        VARCHAR(100) UNIQUE NOT NULL,
  title       VARCHAR(255) NOT NULL,
  content     TEXT,
  is_active   BOOLEAN DEFAULT TRUE,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO pages (slug, title, content) VALUES
('terminos', 'Términos del Servicio', '<h1>Términos del Servicio — Hepta Cloud</h1>
<p><em>Última actualización: 01/2026</em></p>
<p>Estos Términos regulan el uso de los servicios provistos por <strong>HEPTA E.A.S.</strong> ("Hepta", "Hepta Cloud") al cliente ("Cliente"), conforme al plan contratado y/o propuesta aceptada.</p>

<h2>1. Definiciones</h2>
<ul>
<li><strong>Servicio:</strong> prestaciones incluidas en los planes publicados y/o add-ons.</li>
<li><strong>Plan:</strong> modalidad publicada en el sitio o propuesta a medida.</li>
<li><strong>Contenido:</strong> textos, imágenes, logotipos, datos y material entregado por el Cliente.</li>
<li><strong>Soporte 8x5:</strong> atención lunes a viernes, 09:00 a 17:00 (hora Paraguay).</li>
</ul>

<h2>2. Alcance del servicio</h2>
<p>2.1. El alcance exacto se define por el plan seleccionado y lo publicado en el sitio, y/o propuesta comercial aceptada.</p>
<p>2.2. No incluye, salvo acuerdo escrito: branding/diseño de marca, redacción extensa, producción audiovisual, carga masiva de catálogo, integraciones complejas, migraciones, campañas publicitarias o desarrollos a medida.</p>

<h2>3. Requisitos del Cliente</h2>
<p>El Cliente se compromete a entregar Contenido y accesos necesarios, mantener datos de contacto actualizados, y responder validaciones en plazos razonables.</p>

<h2>4. Implementación y tiempos</h2>
<p>Los tiempos dependen de contenido, aprobaciones del Cliente y complejidad del alcance. Hepta publicará el servicio una vez cumplidos requisitos mínimos.</p>

<h2>5. Precios, facturación y pagos</h2>
<p>5.1. Los precios se rigen por el sitio web o por propuesta aceptada.</p>
<p>5.2. Pago anual puede incluir descuento cuando esté indicado en la oferta vigente.</p>
<p>5.3. Ante falta de pago, Hepta podrá suspender el servicio tras notificación. La reactivación se realiza al regularizar saldos.</p>

<h2>6. Renovación, cambios y cancelación</h2>
<p>6.1. Los planes mensuales se renuevan automáticamente.</p>
<p>6.2. Cancelación por parte del Cliente requiere preaviso mínimo de 60 días.</p>
<p>6.3. Al cancelar, el Cliente es responsable de migrar su dominio y servicios externos.</p>

<h2>7. Soporte y SLA</h2>
<p>Canales: WhatsApp, correo o mesa de ayuda (según plan). Horario: Soporte 8x5 (09:00–17:00).</p>

<h2>8. Backups y retención</h2>
<p>Hepta realiza respaldos según su política interna. No se garantiza recuperación ante errores del Cliente.</p>

<h2>9. Seguridad</h2>
<p>El Cliente es responsable de la confidencialidad de sus credenciales y del uso de su instancia.</p>

<h2>10. Limitación de responsabilidad</h2>
<p>Hepta no será responsable por daños indirectos, lucro cesante o pérdida de datos por causas fuera de su control.</p>

<h2>11. Jurisdicción</h2>
<p>Las partes se someten a la jurisdicción de los tribunales de Asunción, Paraguay.</p>

<h2>12. Contacto</h2>
<p>Consultas: <a href="mailto:info@hepta.com.py">info@hepta.com.py</a></p>'),

('privacidad', 'Política de Privacidad', '<h1>Política de Privacidad — Hepta Cloud</h1>
<p><em>Última actualización: 01/2026</em></p>
<p>En <strong>HEPTA E.A.S.</strong> nos comprometemos a proteger la privacidad de nuestros clientes y usuarios.</p>

<h2>1. Datos que recopilamos</h2>
<ul>
<li>Nombre, email y teléfono al solicitar información o contratar.</li>
<li>Datos de uso del sistema (logs, accesos) para soporte y seguridad.</li>
<li>Información de facturación necesaria para la prestación del servicio.</li>
</ul>

<h2>2. Uso de los datos</h2>
<p>Utilizamos tus datos exclusivamente para:</p>
<ul>
<li>Prestar y mejorar nuestros servicios.</li>
<li>Enviarte comunicaciones relacionadas con tu cuenta.</li>
<li>Cumplir obligaciones legales y fiscales.</li>
</ul>

<h2>3. No compartimos tus datos</h2>
<p>No vendemos, alquilamos ni cedemos tus datos personales a terceros, salvo requerimiento legal expreso.</p>

<h2>4. Seguridad</h2>
<p>Implementamos medidas técnicas y organizativas para proteger tus datos contra acceso no autorizado, pérdida o alteración.</p>

<h2>5. Retención</h2>
<p>Conservamos tus datos mientras dure la relación contractual y el tiempo que exijan las obligaciones legales aplicables.</p>

<h2>6. Tus derechos</h2>
<p>Podés solicitar acceso, rectificación, eliminación u oposición al tratamiento de tus datos escribiendo a <a href="mailto:info@hepta.com.py">info@hepta.com.py</a>.</p>

<h2>7. Cookies</h2>
<p>Nuestro sitio puede usar cookies técnicas necesarias para el funcionamiento. No utilizamos cookies de seguimiento publicitario.</p>

<h2>8. Contacto</h2>
<p>Para consultas sobre privacidad: <a href="mailto:info@hepta.com.py">info@hepta.com.py</a> · Asunción, Paraguay.</p>')
ON CONFLICT (slug) DO NOTHING;

GRANT ALL ON TABLE pages TO hepta;
GRANT ALL ON SEQUENCE pages_id_seq TO hepta;
