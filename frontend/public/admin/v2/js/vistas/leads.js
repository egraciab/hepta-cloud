// Leads: pedidos y consultas del sitio. Estado, WhatsApp con mensaje armado y envío al ERP.
import { html, raw, api, fechaHora, hace, wa, normal, icono, toast, modal, PLANES } from '../core.js';

const ESTADOS = [['new', 'Nuevo', 'info'], ['contacted', 'Contactado', 'mute'], ['qualified', 'Calificado', 'ok'], ['lost', 'Perdido', 'mute']];

export async function render(v, rt, salio) {
  const POR = 50;
  let estado = rt.q.get('estado') || '', q = rt.q.get('q') || '', pagina = 0, datos = [], total = 0;
  v.innerHTML = html`<div class="cab"><div><h1>Leads</h1><p>Pedidos y consultas del sitio. Los adicionales que marcó el cliente vienen al principio del mensaje.</p></div></div>
    <div class="filtros"><label class="buscar"><span class="sr">Buscar en esta página</span>${icono('buscar')}<input class="inp" id="q" placeholder="Nombre, empresa, correo, teléfono" value="${q}"></label><span class="btns" id="chips"></span></div>
    <section class="card"><div class="tabla-caja"><table><thead><tr><th scope="col">Cuándo</th><th scope="col">Quién</th><th scope="col">Contacto</th><th scope="col">Pedido</th><th scope="col">Estado</th><th scope="col">ERP</th></tr></thead><tbody id="tb"><tr><td colspan="6" class="cargando">Cargando…</td></tr></tbody></table></div>
    <div class="pie-tabla"><span id="info"></span><div class="btns"><button class="btn sm" type="button" id="ant">Anterior</button><button class="btn sm" type="button" id="sig">Siguiente</button></div></div></section>`.s;

  const chips = () => {
    v.querySelector('#chips').innerHTML = [['', 'Todos'], ...ESTADOS.map(e => [e[0], e[1]])].map(([st, t]) =>
      html`<button type="button" class="btn sm ${estado === st ? 'sel' : ''}" data-st="${st}" aria-pressed="${estado === st}">${t}</button>`).join('');
    v.querySelectorAll('[data-st]').forEach(b => b.addEventListener('click', () => { estado = b.dataset.st; pagina = 0; cargar(); }));
  };
  const pintar = () => {
    const nq = normal(q), lista = datos.filter(l => !nq || normal(`${l.full_name} ${l.company_name} ${l.email} ${l.phone} ${l.message}`).includes(nq));
    v.querySelector('#tb').innerHTML = lista.length ? lista.map(l => {
      const msj = String(l.message || '');
      const texto = `Hola ${String(l.full_name || '').split(' ')[0]}, te escribo de HEPTA Cloud por tu ${l.intent === 'contratar' ? 'pedido' : 'consulta'}${l.plan_name ? ' del ' + l.plan_name : ''}.`;
      return html`<tr>
        <td class="nw muted">${fechaHora(l.created_at)}<div class="chico">${hace(l.created_at)}</div></td>
        <td><b>${l.full_name}</b>${l.company_name ? html`<div class="muted chico">${l.company_name}</div>` : ''}${l.ruc ? html`<div class="muted chico">RUC ${l.ruc}</div>` : ''}</td>
        <td class="nw">${l.email ? html`<a href="mailto:${l.email}">${l.email}</a><br>` : ''}${l.phone ? html`<a href="${wa(l.phone, texto)}" target="_blank" rel="noopener">${l.phone} · WhatsApp</a>` : ''}</td>
        <td style="max-width:340px">${l.intent === 'contratar' ? html`<span class="chip warn">Contratar</span> ` : ''}${l.plan_name || (l.plan_slug ? PLANES[l.plan_slug] || l.plan_slug : '')}
          ${msj ? html`<div class="muted chico" style="white-space:pre-line">${msj.length > 180 ? msj.slice(0, 180) + '…' : msj}</div>${msj.length > 180 ? html`<button type="button" class="btn sm" data-ver="${l.id}" style="margin-top:4px">Ver todo</button>` : ''}` : ''}</td>
        <td><label class="sr" for="st-${l.id}">Estado de ${l.full_name}</label><select class="inp" id="st-${l.id}" data-lead="${l.id}" style="width:auto;height:30px">${ESTADOS.map(([v2, t]) => html`<option value="${v2}" ${raw(l.status === v2 ? 'selected' : '')}>${t}</option>`)}</select></td>
        <td>${l.odoo_lead_id ? html`<span class="chip ok" title="Oportunidad ${l.odoo_lead_id}">Enviado</span>` : html`<button type="button" class="btn sm" data-erp="${l.id}">Enviar</button>${l.erp_sync_state === 'error' ? html`<div class="chico" style="color:var(--bad)">${l.erp_last_error || 'No se pudo'}</div>` : ''}`}</td></tr>`;
    }).join('') : html`<tr><td colspan="6" class="vacio">${datos.length ? 'Sin resultados en esta página.' : 'Sin leads.'}</td></tr>`.s;
    v.querySelectorAll('[data-lead]').forEach(s => s.addEventListener('change', async () => {
      const r = await api('PUT', `/admin/leads/${s.dataset.lead}`, { status: s.value });
      if (r.success) { toast('Estado actualizado', 'ok', 2500); const l = datos.find(x => String(x.id) === s.dataset.lead); if (l) l.status = s.value; }
    }));
    v.querySelectorAll('[data-erp]').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true; b.textContent = 'Enviando…';
      const r = await api('POST', `/admin/leads/${b.dataset.erp}/erp`, {});
      if (r.success) { toast('Enviado al ERP como oportunidad', 'ok'); cargar(); } else { b.disabled = false; b.textContent = 'Reintentar'; }
    }));
    v.querySelectorAll('[data-ver]').forEach(b => b.addEventListener('click', () => {
      const l = datos.find(x => String(x.id) === b.dataset.ver);
      modal({ titulo: `Mensaje de ${l.full_name}`, contenido: html`<div style="white-space:pre-line">${l.message}</div>` });
    }));
  };
  const cargar = async () => {
    chips();
    const r = await api('GET', `/admin/leads?limit=${POR}&offset=${pagina * POR}${estado ? '&status=' + encodeURIComponent(estado) : ''}`);
    if (salio()) return;
    if (!r.success) { v.querySelector('#tb').innerHTML = html`<tr><td colspan="6"><div class="aviso bad">${r.error}</div></td></tr>`.s; return; }
    datos = r.data; total = r.total || 0; pintar();
    v.querySelector('#info').textContent = total ? `${pagina * POR + 1}–${pagina * POR + datos.length} de ${total}` : '';
    v.querySelector('#ant').disabled = pagina === 0; v.querySelector('#sig').disabled = (pagina + 1) * POR >= total;
  };
  v.querySelector('#q').addEventListener('input', e => { q = e.target.value; pintar(); });
  v.querySelector('#ant').addEventListener('click', () => { pagina--; cargar(); });
  v.querySelector('#sig').addEventListener('click', () => { pagina++; cargar(); });
  cargar();
}
