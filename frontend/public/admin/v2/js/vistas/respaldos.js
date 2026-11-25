// Respaldos: pantalla reservada para el panel de respaldos (estado por VM, última copia, retiro al NAS,
// prueba de restauración). Hoy esa información vive en los informes por correo y en el vigía de hcsvrnd01.
import { html } from '../core.js';

export async function render(v) {
  v.innerHTML = html`<div class="cab"><div><h1>Respaldos</h1><p>Estado de las copias de cada VM, el retiro al NAS y las pruebas de restauración.</p></div><span class="chip mute">pronto</span></div>
    <section class="card pad"><p style="margin:0 0 8px">Este panel todavía no está conectado. Mientras tanto:</p>
      <ul style="margin:0;padding-left:18px;line-height:1.8;font-size:13px">
        <li>el informe diario de las 22:00 y el semanal llegan por correo;</li>
        <li>el vigía de <b>hcsvrnd01</b> avisa si una copia no corrió o falta el retiro al NAS;</li>
        <li>el detalle está en el runbook <i>runbook-ha-backups.md</i> del Project.</li></ul></section>`.s;
}
