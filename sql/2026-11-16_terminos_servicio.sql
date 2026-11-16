-- Términos del servicio de Hepta Cloud, versión 1.0 (tarea t42). Reemplaza el texto de 01/2026.
-- Texto fuente y decisiones: doc del Project "terminos-servicio-hepta-cloud-borrador.md" (Steve, 2026-11-16).
-- ANTES de aplicar: revisión del abogado y respaldo (pg_dump de heptacloud). No lleva credenciales.
-- La tabla de planes NO va en el texto: <div data-planes></div> la arma la página con lo cargado en el Admin.
-- Para volver al texto anterior: está en el respaldo y en sql/migrate_s6.sql.
BEGIN;
UPDATE pages SET title = 'Términos del Servicio', updated_at = NOW(), content = $terminos$
<h1>Términos del Servicio — Hepta Cloud</h1>
<p><em>Versión 1.0 — vigente desde el 30 de noviembre de 2026.</em></p>
<h2>1. Quiénes somos y qué es este documento</h2>
<p>Hepta Cloud es un servicio de <strong>HEPTA E.A.S.</strong> (RUC 80117760-0), con domicilio en Balderrama 371 y calle Ciudad del Este, Luque, Paraguay. Estos términos regulan el uso de Hepta Cloud por parte de quien lo contrata ("el cliente", "vos").</p>
<p>Al contratar un plan, pagar una factura o usar el sistema, aceptás estos términos. Si contratás en nombre de una empresa, declarás que podés obligarla.</p>
<h2>2. Qué incluye el servicio</h2>
<p>Hepta Cloud te da un sistema de gestión en línea (basado en Odoo 19 Community), configurado para Paraguay, alojado y mantenido por nosotros, al que entrás desde el navegador con tu propia dirección.</p>
<p>Los planes, lo que incluye cada uno y sus precios vigentes son los publicados en <strong><a href="https://cloud.hepta.com.py">cloud.hepta.com.py</a></strong> al momento de contratar. Esa publicación forma parte de estos términos. El precio que te corresponde es el del plan que contrataste y figura en tu factura; solo cambia como indica el punto 5.</p>
<div data-planes></div>
<p>El plan Empresa se rige además por lo que se acuerde por escrito en una propuesta aparte, que complementa estos términos.</p>
<p>Todos los planes incluyen la puesta en marcha inicial, una capacitación de arranque, el alojamiento, las actualizaciones de seguridad y los respaldos.</p>
<p><strong>Lo que no incluye</strong>, salvo que se acuerde y se cotice aparte: migración de datos desde otro sistema, desarrollos o módulos a medida, diseño del sitio o de la tienda más allá de la plantilla, carga de productos o de clientes, y asesoramiento contable o impositivo.</p>
<p>El cobro en línea con Bancard en la tienda necesita que tengas tu propia cuenta de comercio en Bancard. Esa relación es entre vos y Bancard.</p>
<h2>3. Alta y acceso</h2>
<ul>
<li>Damos de alta tu sistema después de recibir el primer pago, que es el precio de un mes completo de tu plan.</li>
<li>Te llega un correo de bienvenida con tu usuario y una contraseña inicial. Cambiala en el primer ingreso. No guardamos esa contraseña.</li>
<li>Sos responsable de tus usuarios y contraseñas y de lo que se haga con ellos. Si creés que alguien entró sin permiso, avisanos enseguida.</li>
<li>HEPTA conserva un usuario administrador técnico en tu sistema. Lo usamos solo para configurarlo, mantenerlo y darte soporte.</li>
<li>Los usuarios incluidos son los que indica tu plan. Podés pasar a un plan superior cuando quieras.</li>
</ul>
<h2>4. Facturación electrónica (plan Crecimiento)</h2>
<ul>
<li><strong>El contribuyente sos vos.</strong> La habilitación como facturador electrónico ante la DNIT (SET), el timbrado, el certificado digital (.p12) y el código de seguridad (CSC) son tuyos y los gestionás vos. Te damos una guía paso a paso.</li>
<li><strong>Nosotros configuramos el sistema</strong> con esos datos y verificamos que emita correctamente.</li>
<li>Tu certificado y tu código de seguridad quedan guardados en nuestros servidores únicamente para firmar tus documentos. No los usamos para otra cosa ni los entregamos a terceros.</li>
<li>Sos responsable de los datos que cargás en cada documento (cliente, importes, impuestos) y de tus obligaciones impositivas. Hepta Cloud es la herramienta; no reemplaza a tu contador.</li>
<li>La aprobación de cada documento depende de los sistemas de la DNIT. Si esos sistemas no responden, no depende de nosotros.</li>
</ul>
<h2>5. Precio, facturación y pago</h2>
<ul>
<li>Los precios son mensuales, en guaraníes y con IVA incluido. Los vigentes son los publicados en <a href="https://cloud.hepta.com.py">cloud.hepta.com.py</a>.</li>
<li>Facturamos por mes adelantado, por mes calendario. La factura electrónica te llega por correo.</li>
<li><strong>Primer mes y prorrateo.</strong> Tu primer pago cubre un mes corrido desde el día en que te entregamos el sistema. Para ordenar la facturación al mes calendario, la factura siguiente se prorratea: cobra solo los días que faltan hasta fin de ese mes. Desde ahí, cada factura es por un mes completo.</li>
<li class="ejemplo" style="list-style:none">Ejemplo: si te entregamos el sistema el 20 de noviembre, ese pago cubre hasta el 19 de diciembre; la factura de diciembre cobra del 20 al 31 de diciembre, y la de enero ya es por el mes entero. Nunca pagás dos veces el mismo día.</li>
<li>Medios de pago: transferencia bancaria, tPago y pago con QR. Los datos para pagar van en cada factura.</li>
<li>La factura vence a los <strong>5 días</strong> de emitida.</li>
<li>Un cambio en los precios publicados rige de inmediato para las contrataciones nuevas. A quien ya es cliente se lo avisamos por correo con al menos <strong>30 días</strong> de anticipación. Si no estás de acuerdo, podés dar de baja el servicio antes de que rija el precio nuevo.</li>
<li>No hay permanencia mínima: el servicio es mes a mes.</li>
</ul>
<h2>6. Falta de pago y suspensión</h2>
<ul>
<li>Si una factura no se paga a su vencimiento, te avisamos por correo.</li>
<li>A los <strong>10 días</strong> de vencida podemos <strong>suspender</strong> el acceso. Tus datos no se tocan.</li>
<li>Al regularizar el pago, reactivamos el servicio dentro del día hábil siguiente.</li>
<li>A los <strong>60 días</strong> de suspensión sin regularizar, podemos dar de baja el servicio como indica el punto 11.</li>
</ul>
<h2>7. Tus datos</h2>
<ul>
<li><strong>Los datos son tuyos.</strong> Todo lo que cargás (clientes, ventas, facturas, productos, archivos) te pertenece. Nosotros lo alojamos y lo procesamos solo para prestarte el servicio.</li>
<li><strong>Dónde están.</strong> Tu sistema y tus datos se alojan en servidores propios de HEPTA en Paraguay.</li>
<li><strong>Respaldos.</strong> Hacemos copias automáticas varias veces por día y las conservamos en un segundo equipo. Además guardamos una copia cifrada fuera de nuestras instalaciones, que solo HEPTA puede leer, para poder recuperar el servicio ante un siniestro.</li>
<li><strong>Para qué sirven los respaldos.</strong> Son para recuperar el servicio si algo falla de nuestro lado. Si borrás algo por error, hacemos lo posible por recuperarlo, pero no lo garantizamos.</li>
<li><strong>Confidencialidad.</strong> No vendemos ni cedemos tus datos. Solo los entregamos si una autoridad competente lo exige por escrito, y te avisamos salvo que la ley lo impida.</li>
<li><strong>Datos personales.</strong> Respecto de los datos personales de tus clientes y empleados que cargás en el sistema, el responsable sos vos y HEPTA actúa como encargado, siguiendo tus instrucciones y la Ley N.º 7593/2025 de Protección de Datos Personales.</li>
<li><strong>Llevarte tus datos.</strong> Mientras el servicio esté activo podés exportar tu información desde el sistema. También podés pedirnos una copia completa de tu base de datos: una vez por año sin costo; las siguientes se cotizan.</li>
</ul>
<h2>8. Disponibilidad y mantenimiento</h2>
<ul>
<li>Trabajamos para que el servicio esté disponible todo el tiempo, con equipos redundantes y monitoreo permanente. <strong>No garantizamos un porcentaje de disponibilidad</strong> en los planes Despegue y Crecimiento; en el plan Empresa se puede acordar.</li>
<li>Los mantenimientos programados los hacemos, en lo posible, fuera del horario comercial y con aviso previo.</li>
<li>No respondemos por cortes causados por terceros o por fuerza mayor: tu conexión a internet, proveedores de internet o de energía, los sistemas de la DNIT, Bancard u otros servicios externos.</li>
</ul>
<h2>9. Soporte</h2>
<ul>
<li><strong>Despegue:</strong> por correo, a <a href="mailto:soporte@hepta.com.py">soporte@hepta.com.py</a>.</li>
<li><strong>Crecimiento:</strong> por correo (<a href="mailto:soporte@hepta.com.py">soporte@hepta.com.py</a>) y por WhatsApp al +595 985 605737, con prioridad.</li>
<li>Horario: lunes a viernes de 8 a 17, hora de Paraguay.</li>
<li>El soporte cubre el funcionamiento del sistema y dudas de uso. No cubre asesoramiento contable, carga de datos ni desarrollos, que se cotizan aparte.</li>
</ul>
<h2>10. Uso aceptable</h2>
<p>No podés usar Hepta Cloud para actividades ilegales, para enviar correo masivo no solicitado, para alojar contenido que infrinja derechos de terceros, ni para intentar acceder a sistemas o datos de otros clientes. Tampoco podés revender el servicio sin un acuerdo escrito. Si detectamos un uso así, podemos suspender el servicio; cuando sea posible, te avisamos antes.</p>
<h2>11. Baja del servicio</h2>
<ul>
<li><strong>Podés dar de baja cuando quieras</strong>, avisando por correo. La baja rige al final del mes ya facturado. No devolvemos meses ya pagados.</li>
<li>Después de la baja conservamos tus datos <strong>30 días</strong>, durante los cuales podés pedir una copia o reactivar. Pasado ese plazo los eliminamos, también de los respaldos a medida que estos vencen.</li>
<li><strong>Importante:</strong> tus obligaciones de conservar documentos tributarios siguen siendo tuyas. Antes de dar de baja, descargá tus facturas y libros.</li>
<li>Podemos dar de baja el servicio por falta de pago (punto 6), por uso indebido (punto 10) o, con 60 días de aviso, si dejamos de ofrecerlo. En ese último caso te ayudamos a llevarte tus datos.</li>
</ul>
<h2>12. Responsabilidad</h2>
<ul>
<li>Prestamos el servicio con la diligencia de un proveedor profesional, pero ningún sistema está libre de fallas.</li>
<li>En la medida que la ley lo permita, nuestra responsabilidad total frente a vos se limita a lo que pagaste por el servicio en los últimos <strong>3 meses</strong>, y no respondemos por lucro cesante ni por daños indirectos.</li>
<li>Esto no limita los derechos que te da la Ley N.º 1334/98 de Defensa del Consumidor y del Usuario cuando corresponda.</li>
</ul>
<h2>13. Propiedad del software</h2>
<p>El sistema se basa en Odoo Community, software libre con licencia LGPL-3. Los módulos, la configuración y la marca de Hepta Cloud son de HEPTA. Contratar el servicio te da derecho a usarlos mientras esté activo; no te transfiere su propiedad.</p>
<h2>14. Cambios en estos términos</h2>
<p>Podemos actualizar estos términos. Si el cambio te afecta, te avisamos por correo con al menos 15 días de anticipación. Si seguís usando el servicio después de esa fecha, se entiende que los aceptás. La versión vigente y su fecha están siempre en <a href="https://cloud.hepta.com.py">cloud.hepta.com.py</a>.</p>
<h2>15. Ley aplicable y contacto</h2>
<p>Estos términos se rigen por las leyes de la República del Paraguay. Cualquier diferencia que no podamos resolver conversando se somete a los tribunales de la ciudad de Asunción.</p>
<p>Contacto: <a href="mailto:soporte@hepta.com.py">soporte@hepta.com.py</a> · WhatsApp +595 985 605737.</p>
$terminos$ WHERE slug = 'terminos';
COMMIT;
