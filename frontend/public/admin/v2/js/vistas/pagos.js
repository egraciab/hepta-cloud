// Pagos: solicitudes de pago. Confirmar da el alta (en segundo plano, con avance) y cancelar la descarta.
import { html, api, gs, fecha, hace, chipEstado, toast, modal, confirmar, seguir, PLANES } from '../core.js';
const actualizarContadores = () => window.dispatchEvent(new Event('hc:contadores'));

export async function render(v, rt, salio) {
  let estado = rt.q.get('estado') ?? 'pending';
  v.innerHTML = html`<div class="cab"><div><h1>Pagos</h1><p>Solicitudes de pago del sitio y del portal. Al confirmar un pago se da el alta del sistema.</p></div></div>
    <div class="filtros" id="chips"></div>
    <section class="card"><div class="tabla-caja"><table><thead><tr><th scope="col">#</th><th scope="col">Cliente</th><th scope="col">Plan</th><th scope="col">Monto</th><th scope="col">Estado</th><th scope="col">Fecha</th><th scope="col"><span class="sr">Acciones</span></th></tr></thead><tbody id="tb"><tr><td colspan="7" class="cargando">Cargando…</td></tr></tbody></table></div></section>`.s;
  const cargar = async () => {
    v.querySelector('#chips').innerHTML = [['pending', 'Pendientes'], ['provisioned', 'Dados de alta'], ['cancelled', 'Cancelados'], ['', 'Todos']].map(([st, t]) =>
      html`<button type="button" class="btn sm ${estado === st ? 'sel' : ''}" data-st="${st}" aria-pressed="${estado === st}">${t}</button>`).join('');
    v.querySelectorAll('[data-st]').forEach(b => b.addEventListener('click', () => { estado = b.dataset.st; cargar(); }));
    const r = await api('GET', estado ? `/admin/payment-requests?status=${encodeURIComponent(estado)}` : '/admin/payment-requests');
    if (salio()) return;
    const tb = v.querySelector('#tb');
    if (!r.success) { tb.innerHTML = html`<tr><td colspan="7"><div class="aviso bad">${r.error}</div></td></tr>`.s; return; }
    tb.innerHTML = r.data.length ? r.data.map(p => html`<tr>
        <td class="muted">${p.id}</td>
        <td><b>${p.full_name || '—'}</b><div class="muted chico">${p.email || ''}</div>${p.notes ? html`<div class="muted chico">${p.notes}</div>` : ''}</td>
        <td>${PLANES[p.plan] || p.plan}</td><td class="nw"><b>${gs(p.amount)}</b></td><td>${chipEstado(p.status)}</td>
        <td class="nw muted">${fecha(p.created_at)}<div class="chico">${hace(p.created_at)}</div></td>
        <td class="nw">${p.status === 'pending' ? html`<button class="btn sm pri" type="button" data-conf="${p.id}">Confirmar y dar de alta</button> <button class="btn sm" type="button" data-canc="${p.id}">Cancelar</button>`
          : p.instance_url ? html`<a class="btn sm" href="${p.instance_url}" target="_blank" rel="noopener">Ver sistema</a>` : ''}</td></tr>`).join('')
      : html`<tr><td colspan="7" class="vacio">Sin solicitudes${estado === 'pending' ? ' pendientes' : ''}.</td></tr>`.s;
    tb.querySelectorAll('[data-canc]').forEach(b => b.addEventListener('click', async () => {
      if (!(await confirmar({ titulo: `Cancelar la solicitud #${b.dataset.canc}`, boton: 'Cancelar la solicitud', peligro: true, texto: 'La solicitud queda cancelada. No se devuelve ningún pago: si hubo uno, se gestiona aparte.' }))) return;
      const res = await api('POST', `/admin/payment-requests/${b.dataset.canc}/cancel`, {});
      if (res.success) { toast('Solicitud cancelada', 'ok'); cargar(); actualizarContadores(); }
    }));
    tb.querySelectorAll('[data-conf]').forEach(b => b.addEventListener('click', () => confirmarPago(r.data.find(p => String(p.id) === b.dataset.conf), cargar)));
  };
  cargar();
}

function confirmarPago(p, cargar) {
  modal({
    titulo: `Confirmar el pago de ${p.full_name || p.email}`,
    contenido: html`<div class="aviso info">${PLANES[p.plan] || p.plan} · ${gs(p.amount)} por mes. Al confirmar se da el alta: tarda de 2 a 8 minutos y sigue aunque cierres esta ventana. El cliente recibe su usuario y contraseña por correo.</div>
      <div class="col" style="gap:12px;margin-top:8px">
        <label class="fld">Subdominio<input id="p-sub" placeholder="cliente" autocomplete="off" pattern="[a-z0-9\\-]+"><span class="ayuda">Queda en &lt;subdominio&gt;.erp.hepta.com.py. Minúsculas, números y guiones.</span></label>
        <label class="fld">Nombre de la instancia (opcional)<input id="p-label" placeholder="Sistema de …"></label></div>`,
    botones: [{ texto: 'Cancelar' }, { texto: 'Confirmar y dar de alta', clase: 'pri', accion: async (cerrar, r) => {
      const subdomain = r.querySelector('#p-sub').value.trim().toLowerCase(), label = r.querySelector('#p-label').value.trim();
      if (!/^[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?$/.test(subdomain)) { toast('Revisá el subdominio: minúsculas, números y guiones', 'bad'); return true; }
      const res = await api('POST', `/admin/payment-requests/${p.id}/confirm`, { subdomain, label });
      if (!res.success) return true;
      cerrar(); cargar(); actualizarContadores();
      if (!res.data || !res.data.job) { toast(res.message || 'Confirmado', 'ok'); return; }
      toast(`Alta de ${subdomain} en curso. Te aviso acá cuando termine.`, '', 10000);
      const fin = await seguir(`/admin/provision/jobs/${res.data.job.id}`, null, { cada: 8000 });
      cargar();
      if (fin.estado === 'ok') toast(`✓ ${subdomain} quedó listo${fin.credenciales_enviadas ? '. El cliente recibió su usuario y contraseña.' : '.'}${fin.aviso ? ' Aviso: ' + fin.aviso : ''}`, 'ok', 0);
      else toast(`El alta de ${subdomain} falló: ${fin.error || 'sin detalle'}. La solicitud volvió a pendiente.`, 'bad', 0);
    } }],
  });
}
