-- Política de privacidad de Hepta Cloud, versión 1.0. Reemplaza el texto de 01/2026.
-- Texto fuente y pendientes: doc del Project "politica-privacidad-hepta-cloud.md" (2026-11-16).
-- ANTES de aplicar: confirmación de Steve (6 puntos), tipografías servidas desde el propio sitio (el texto lo afirma)
-- y respaldo (pg_dump de heptacloud). No lleva credenciales. El texto anterior queda en el respaldo y en sql/migrate_s6.sql.
BEGIN;
UPDATE pages SET title = 'Política de Privacidad', updated_at = NOW(), content = $privacidad$
<h1>Política de Privacidad — Hepta Cloud</h1>
<p><em>Versión 1.0 — vigente desde el 30 de noviembre de 2026.</em></p>
<h2>1. Quién es responsable de tus datos</h2>
<p><strong>HEPTA E.A.S.</strong> (RUC 80117760-0), con domicilio en Balderrama 371 y calle Ciudad del Este, Luque, Paraguay, es quien presta Hepta Cloud y responde por los datos personales que se describen en esta política.</p>
<p>Para cualquier consulta sobre tus datos: <a href="mailto:soporte@hepta.com.py">soporte@hepta.com.py</a>.</p>
<h2>2. Dos situaciones distintas</h2>
<ul>
<li><strong>Tus datos como cliente o interesado.</strong> Son los que nos das para contratar y usar Hepta Cloud (punto 3). De esos datos el responsable es HEPTA.</li>
<li><strong>Los datos que vos cargás en tu sistema.</strong> Tus clientes, proveedores, empleados, ventas y facturas son tuyos: el responsable sos vos y HEPTA solo los aloja y los procesa para prestarte el servicio, siguiendo tus instrucciones (punto 8).</li>
</ul>
<h2>3. Qué datos recopilamos</h2>
<ul>
<li><strong>Cuando nos escribís desde el sitio:</strong> nombre, correo, teléfono, empresa, tu mensaje y la dirección IP desde la que lo enviaste.</li>
<li><strong>Cuando contratás:</strong> nombre de la persona de contacto, correo, teléfono, y los datos para facturar (razón social, RUC, dirección).</li>
<li><strong>Cuando usás el portal de clientes:</strong> tu usuario, tu contraseña (guardada cifrada de forma que nadie puede leerla, tampoco nosotros) y la fecha de tus ingresos.</li>
<li><strong>Pagos:</strong> el plan, el importe, la fecha y el medio de pago. No recibimos ni guardamos datos de tarjetas.</li>
<li><strong>Soporte:</strong> lo que nos contás en cada pedido y lo que hacemos para resolverlo.</li>
<li><strong>Registros técnicos:</strong> dirección IP, fecha y hora de acceso y acciones de administración, para seguridad y para diagnosticar fallas.</li>
</ul>
<p>No pedimos datos sensibles (salud, creencias, origen, entre otros) y te pedimos que no nos los envíes por los formularios.</p>
<h2>4. Para qué los usamos</h2>
<ul>
<li>Para responder tu consulta y prepararte una propuesta.</li>
<li>Para dar de alta, prestar, mantener y cobrar el servicio que contrataste.</li>
<li>Para avisarte de novedades del servicio: vencimientos, mantenimientos, cambios de precio o de estos documentos.</li>
<li>Para cumplir obligaciones legales, contables y tributarias.</li>
<li>Para cuidar la seguridad del servicio y prevenir usos indebidos.</li>
</ul>
<p>No usamos tus datos para publicidad de terceros ni tomamos decisiones automáticas sobre vos.</p>
<p>Nos basamos en el contrato que tenemos con vos, en tu pedido cuando nos consultás, en nuestras obligaciones legales y en nuestro interés legítimo en mantener el servicio seguro.</p>
<h2>5. Con quién los compartimos</h2>
<p>No vendemos ni alquilamos tus datos. Solo los comparten quienes necesitan verlos para prestarte el servicio:</p>
<ul>
<li><strong>Empresas del grupo HEPTA</strong>, para la facturación y la administración.</li>
<li><strong>RetoPA</strong>, el directorio de negocios del grupo, <strong>solo si vos pedís o aceptás</strong> que tu negocio figure ahí.</li>
<li><strong>La DNIT (SET)</strong>, por las facturas electrónicas que te emitimos.</li>
<li><strong>Proveedores técnicos</strong>, con lo mínimo necesario: el servicio que guarda nuestra copia de contingencia cifrada (punto 6) y los servicios de red que protegen y distribuyen el sitio.</li>
<li><strong>Autoridades</strong>, cuando una norma o una orden escrita de autoridad competente lo exige.</li>
</ul>
<p>El correo que te enviamos sale de nuestro propio servidor de correo, en Paraguay.</p>
<h2>6. Dónde se guardan y cómo los protegemos</h2>
<ul>
<li>Tus datos y tu sistema se alojan en servidores propios de HEPTA en Paraguay.</li>
<li>Hacemos copias de respaldo automáticas varias veces por día.</li>
<li>Guardamos además una copia de contingencia <strong>cifrada</strong> fuera de nuestras instalaciones, con un proveedor internacional. Sale cifrada de nuestros equipos y solo HEPTA tiene las claves: el proveedor no puede leerla.</li>
<li>El acceso a los sistemas está limitado al personal que lo necesita, las conexiones van cifradas y las contraseñas no se guardan en texto legible.</li>
<li>Ningún sistema es infalible. Si ocurre un incidente que afecte tus datos, te avisamos sin demora y te contamos qué pasó y qué hicimos.</li>
</ul>
<h2>7. Cuánto tiempo los conservamos</h2>
<ul>
<li><strong>Consultas que no terminan en contratación:</strong> hasta 24 meses, salvo que nos pidas antes que las borremos.</li>
<li><strong>Datos de tu cuenta y de tu sistema:</strong> mientras seas cliente y 30 días después de la baja; luego se eliminan, también de los respaldos a medida que estos vencen.</li>
<li><strong>Facturas y registros contables:</strong> el tiempo que exigen las normas tributarias y comerciales.</li>
<li><strong>Registros técnicos:</strong> hasta 12 meses.</li>
</ul>
<h2>8. Los datos que cargás en tu sistema</h2>
<ul>
<li>Son tuyos y vos decidís qué cargar, para qué y por cuánto tiempo. Te corresponde tener permiso de las personas cuyos datos cargás e informarles.</li>
<li>HEPTA los trata solo para alojar, respaldar, mantener y darte soporte. No los usa para fines propios ni los comparte, salvo lo indicado en el punto 5 para proveedores técnicos y autoridades.</li>
<li>Entramos a tu sistema únicamente para configurarlo, mantenerlo o resolver un pedido tuyo de soporte.</li>
<li>Si una persona nos pide algo sobre datos que están en tu sistema, te lo derivamos para que respondas vos.</li>
<li>Cuando te das de baja, podés llevarte tus datos y los eliminamos como indican los <a href="/terminos">términos del servicio</a>.</li>
</ul>
<h2>9. Tus derechos</h2>
<p>Podés pedirnos en cualquier momento:</p>
<ul>
<li><strong>Acceso:</strong> saber qué datos tuyos tenemos y cómo los usamos.</li>
<li><strong>Rectificación:</strong> corregir los que estén mal o desactualizados.</li>
<li><strong>Supresión:</strong> que los borremos cuando ya no hagan falta.</li>
<li><strong>Oposición:</strong> que dejemos de usarlos para un fin determinado.</li>
<li><strong>Portabilidad:</strong> recibirlos en un formato que puedas llevar a otro proveedor.</li>
</ul>
<p>Escribinos a <a href="mailto:soporte@hepta.com.py">soporte@hepta.com.py</a> desde el correo registrado en tu cuenta, o indicando datos que nos permitan confirmar que sos vos. Es gratis. Te respondemos dentro de los <strong>10 días hábiles</strong>.</p>
<p>Hay datos que no podemos borrar aunque lo pidas, como las facturas, porque la ley nos obliga a conservarlos.</p>
<p>Si considerás que no respetamos tus derechos, podés reclamar ante la Agencia Nacional de Protección de Datos Personales.</p>
<h2>10. Cookies y servicios de terceros en el sitio</h2>
<ul>
<li>El sitio no usa cookies de publicidad ni herramientas de seguimiento.</li>
<li>El portal de clientes guarda en tu navegador un dato técnico para mantener tu sesión abierta. Se borra al cerrar sesión.</li>
<li>Las tipografías del sitio se cargan desde nuestro propio servidor.</li>
</ul>
<h2>11. Menores de edad</h2>
<p>Hepta Cloud es un servicio para empresas y profesionales. No está dirigido a menores de 18 años y no recopilamos sus datos a sabiendas.</p>
<h2>12. Cambios en esta política</h2>
<p>Si cambiamos algo importante, te avisamos por correo con al menos 15 días de anticipación. La versión vigente y su fecha están siempre en <a href="https://cloud.hepta.com.py/privacidad">cloud.hepta.com.py/privacidad</a>.</p>
<h2>13. Marco legal</h2>
<p>Esta política se rige por la Ley N.º 7593/2025 de Protección de Datos Personales de la República del Paraguay y sus reglamentaciones.</p>
$privacidad$ WHERE slug = 'privacidad';
COMMIT;
