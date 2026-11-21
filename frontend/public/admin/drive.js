/* ═══ HEPTA Cloud — HEPTA Drive (admin) ═══════════════════════════════════
   Pantalla del Admin para dar de alta y mirar las instancias de Nextcloud de los clientes.
   Bloque autocontenido: se monta solo en el menú (debajo de Instancias) y en .content.
   Usa api(), authHeaders(), showAlert(), currentUser, sectionLoaders y sectionTitles del Admin.
   Todo dato que viene de afuera se escapa antes de ir al HTML.
   Para quitarlo: borrar la etiqueta <script src="drive.js"> del index.html. */
(function () {
  if (window.__heptaDriveAdmin) return;
  window.__heptaDriveAdmin = true;

  const ICON = '<svg viewBox="0 0 24 24"><path d="M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z"/></svg>';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = id => document.getElementById(id);
  const esGod = () => typeof currentUser !== 'undefined' && currentUser && currentUser.role === 'godmode';
  const fecha = t => { if (!t) return '—'; const d = new Date(t); return isNaN(d) ? '—' : d.toLocaleString('es-PY', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); };
  let sondeo = null;

  /* ── menú ── */
  const menu = document.querySelector('.sidebar-menu');
  if (menu) {
    const item = document.createElement('div');
    item.className = 'menu-item';
    item.setAttribute('onclick', "showSection('drive',this)");
    item.innerHTML = ICON + 'HEPTA Drive';
    const ref = menu.querySelector('[onclick*="\'instances\'"]');
    if (ref) ref.insertAdjacentElement('afterend', item); else menu.appendChild(item);
  }

  /* ── sección y ventana de alta ── */
  const content = document.querySelector('.main .content') || document.querySelector('.content');
  if (!content) return;
  const sec = document.createElement('div');
  sec.className = 'section';
  sec.id = 'section-drive';
  sec.innerHTML = `
    <div class="alert alert-success" id="drive-ok"></div>
    <div class="alert alert-error" id="drive-err"></div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-body" style="display:flex;align-items:center;justify-content:space-between;gap:12px">
        <div style="display:flex;align-items:center;gap:10px">
          <div id="drive-dot" style="width:10px;height:10px;border-radius:50%;background:var(--gray-200)"></div>
          <span style="font-size:13px;color:var(--gray-600)">Servidor de HEPTA Drive: <strong id="drive-dot-text">verificando…</strong></span>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="loadDrive()">Actualizar</button>
      </div>
    </div>

    <div class="card" id="drive-job-card" style="display:none;margin-bottom:16px">
      <div class="card-header"><div class="card-title" id="drive-job-title">Alta en curso</div></div>
      <div class="card-body" id="drive-job-body" style="font-size:13px"></div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">Instancias</div>
        <button class="btn btn-primary btn-sm" onclick="driveNueva()">
          <svg viewBox="0 0 24 24" width="14" height="14"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Nueva instancia
        </button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Instancia</th><th>Cliente</th><th>Usuarios</th><th>Datos</th><th>Respaldo</th><th>Secretos</th><th></th></tr></thead>
          <tbody id="drive-tbody"><tr><td colspan="7" class="text-muted" style="text-align:center;padding:24px">Cargando…</td></tr></tbody>
        </table>
      </div>
    </div>`;
  content.appendChild(sec);

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'drive-modal';
  modal.innerHTML = `
    <div class="modal" style="max-width:620px">
      <div class="modal-title">Nueva instancia de HEPTA Drive</div>
      <div class="alert alert-error" id="drive-m-err"></div>
      <div class="alert alert-success" id="drive-m-ok"></div>
      <div class="form-group">
        <label class="form-label">Nombre de la instancia *</label>
        <div style="display:flex;align-items:center;gap:8px">
          <input class="form-input" id="drive-slug" placeholder="micliente" style="flex:1" autocomplete="off"/>
          <span style="font-size:13px;color:var(--gray-600);white-space:nowrap">.drive.hepta.com.py</span>
        </div>
        <div class="form-hint">Minúsculas, números y guiones. No se puede cambiar después: las aplicaciones de los usuarios quedan atadas a esta dirección.</div>
      </div>
      <div class="form-group">
        <label class="form-label">Cliente</label>
        <select class="form-select" id="drive-cliente"><option value="">— sin vincular por ahora —</option></select>
      </div>
      <div class="form-group">
        <label class="form-label">Usuarios * <span style="font-weight:400;color:var(--gray-400)">(uno por línea)</span></label>
        <textarea class="form-textarea" id="drive-usuarios" rows="6" style="font-family:ui-monospace,Menlo,monospace;font-size:12px" placeholder="ana@cliente.com.py, Ana Pérez&#10;beto@cliente.com.py, Beto Gómez, 50"></textarea>
        <div class="form-hint">correo, nombre y, si no es la cuota por defecto, los GB. Cada usuario recibe una invitación por correo para poner su contraseña.</div>
      </div>
      <div class="grid-2">
        <div class="form-group"><label class="form-label">Cuota por usuario (GB)</label><input class="form-input" type="number" min="1" id="drive-cuota" value="5"/></div>
        <div class="form-group"><label class="form-label">Carpeta de equipo (GB)</label><input class="form-input" type="number" min="0" id="drive-equipo" value="0"/>
          <div class="form-hint">0 = sin carpeta compartida.</div></div>
      </div>
      <div id="drive-m-validacion" style="font-size:13px;margin-bottom:8px"></div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="document.getElementById('drive-modal').classList.remove('open')">Cancelar</button>
        <button class="btn btn-secondary" id="drive-btn-validar" onclick="driveValidar()">Validar</button>
        <button class="btn btn-primary" id="drive-btn-crear" onclick="driveCrear()">Dar de alta</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const modalU = document.createElement('div');
  modalU.className = 'modal-overlay';
  modalU.id = 'drive-u-modal';
  modalU.innerHTML = `
    <div class="modal" style="max-width:820px">
      <div class="modal-title" id="drive-u-title">Usuarios</div>
      <div class="alert alert-error" id="drive-u-err"></div>
      <div class="alert alert-success" id="drive-u-ok"></div>
      <div class="table-wrap" style="max-height:300px;overflow-y:auto;margin-bottom:12px">
        <table>
          <thead><tr><th>Usuario</th><th style="min-width:170px">Espacio usado</th><th>Último ingreso</th><th></th></tr></thead>
          <tbody id="drive-u-tbody"></tbody>
        </table>
      </div>
      <div id="drive-u-baja" style="display:none;border:1px solid #FCA5A5;background:#FEF2F2;border-radius:8px;padding:14px;margin-bottom:16px;font-size:13px"></div>
      <div class="form-group">
        <label class="form-label">Agregar usuarios <span style="font-weight:400;color:var(--gray-400)">(uno por línea)</span></label>
        <textarea class="form-textarea" id="drive-u-nuevos" rows="4" style="font-family:ui-monospace,Menlo,monospace;font-size:12px" placeholder="carla@cliente.com.py, Carla Ruiz&#10;dario@cliente.com.py, Darío Sosa, 50"></textarea>
        <div class="form-hint">correo, nombre y, si no es la cuota por defecto, los GB. Nacen como usuarios comunes (no administradores) y reciben la invitación por correo. Si el correo ya existe, solo se le actualiza la cuota.</div>
      </div>
      <div class="form-group" style="max-width:220px"><label class="form-label">Cuota por defecto (GB)</label><input class="form-input" type="number" min="1" id="drive-u-cuota" value="5"/></div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="document.getElementById('drive-u-modal').classList.remove('open')">Cerrar</button>
        <button class="btn btn-primary" id="drive-u-btn" onclick="driveAgregarUsuarios()">Agregar</button>
      </div>
    </div>`;
  document.body.appendChild(modalU);
  let slugUsuarios = null;

  function lineasUsuarios(texto) {
    return texto.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
      const p = l.split(/[,;|\t]/).map(x => x.trim());
      const u = { correo: (p[0] || '').toLowerCase(), nombre: p[1] || '' };
      if (p[2]) u.cuota_gb = Number(p[2]);
      return u;
    });
  }

  const tam = b => { if (b == null) return '—'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, n = Number(b); while (n >= 1024 && i < 4) { n /= 1024; i++; } return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`; };
  function barraUso(u) {
    if (u.usado_bytes == null) return `<span class="text-muted">${esc(u.cuota === 'none' ? 'sin límite' : (u.cuota || '—'))}</span>`;
    if (!u.cuota_bytes) return `${esc(tam(u.usado_bytes))} <span class="text-muted">· sin límite</span>`;
    const pct = Math.min(100, Math.round(u.usado_bytes * 100 / u.cuota_bytes));
    const color = pct >= 90 ? 'var(--red)' : pct >= 75 ? '#D97706' : '#1254A4';
    return `<div style="height:8px;background:var(--gray-200);border-radius:4px;overflow:hidden"><div style="height:100%;width:${Math.max(pct, 1)}%;background:${color}"></div></div>
      <div class="text-sm" style="margin-top:3px">${esc(tam(u.usado_bytes))} de ${esc(tam(u.cuota_bytes))} <span class="text-muted">· ${pct}%</span></div>`;
  }
  let usuariosVistos = [];

  async function cargarUsuarios() {
    const slug = slugUsuarios;
    const r = await api('GET', `/admin/drive/${encodeURIComponent(slug)}/usuarios`);
    if (!r || !r.success) { $('drive-u-tbody').innerHTML = `<tr><td colspan="4" style="color:var(--red);padding:16px">${esc((r && r.error) || 'No se pudo cargar')}</td></tr>`; return; }
    usuariosVistos = r.data;
    const ingreso = u => { const t = Date.parse(u.ultimo_ingreso); return (!t || t < 86400000) ? 'nunca' : fecha(u.ultimo_ingreso); };
    $('drive-u-tbody').innerHTML = r.data.map((u, n) => `<tr${u.activo ? '' : ' style="opacity:.6"'}>
      <td><strong>${esc(u.nombre)}</strong>${u.admin ? ' <span class="badge badge-blue">administrador de HEPTA</span>' : ''}${u.activo ? '' : ' <span class="badge badge-red">sin acceso</span>'}
        <div class="text-muted text-sm">${esc(u.correo || u.uid)}</div></td>
      <td>${barraUso(u)}</td><td>${esc(ingreso(u))}</td>
      <td style="white-space:nowrap;text-align:right">${u.admin ? '' : `
        <button class="btn btn-secondary btn-sm" onclick="driveEstadoUsuario(${n},this)">${u.activo ? 'Quitar acceso' : 'Devolver acceso'}</button>
        ${esGod() ? `<button class="btn btn-danger btn-sm" onclick="driveBajaUsuario(${n})">Eliminar</button>` : ''}`}</td></tr>`).join('')
      || '<tr><td colspan="4" class="text-muted" style="padding:16px">Sin usuarios.</td></tr>';
  }

  window.driveUsuarios = async function (slug) {
    slugUsuarios = slug;
    $('drive-u-title').textContent = `Usuarios de ${slug}`;
    $('drive-u-err').className = 'alert alert-error'; $('drive-u-ok').className = 'alert alert-success';
    $('drive-u-nuevos').value = ''; $('drive-u-cuota').value = 5; $('drive-u-baja').style.display = 'none';
    $('drive-u-tbody').innerHTML = '<tr><td colspan="4" class="text-muted" style="text-align:center;padding:16px">Cargando…</td></tr>';
    modalU.classList.add('open');
    await cargarUsuarios();
  };

  // Quitar el acceso es lo primero ante una salida de personal: es inmediato, se deshace y no toca archivos
  window.driveEstadoUsuario = async function (n, btn) {
    const u = usuariosVistos[n]; if (!u) return;
    if (u.activo && !confirm(`¿Quitarle el acceso a ${u.nombre} (${u.uid})?\n\nNo va a poder entrar, pero sus archivos quedan. Se puede devolver cuando quieras.`)) return;
    btn.disabled = true;
    const r = await api('POST', `/admin/drive/${encodeURIComponent(slugUsuarios)}/usuarios/estado`, { usuario: u.uid, activo: !u.activo });
    if (!r.success) { showAlert('drive-u-err', 'error', r.error, 0); btn.disabled = false; return; }
    showAlert('drive-u-ok', 'success', u.activo ? `${u.uid} ya no puede entrar. Sus archivos siguen ahí.` : `${u.uid} puede volver a entrar.`, 5000);
    cargarUsuarios();
  };

  window.driveBajaUsuario = function (n) {
    const u = usuariosVistos[n]; if (!u) return;
    const destinos = usuariosVistos.filter(x => x.uid !== u.uid && x.activo && !x.admin);
    const caja = $('drive-u-baja');
    caja.dataset.uid = u.uid;
    caja.innerHTML = `<div style="font-weight:600;color:#991B1B;margin-bottom:8px">Eliminar a ${esc(u.nombre)} (${esc(u.uid)})</div>
      <div style="margin-bottom:8px">Esto no se deshace. ¿Qué hacemos con sus archivos${u.usado_bytes != null ? ` (${esc(tam(u.usado_bytes))})` : ''}?</div>
      <label style="display:block;margin-bottom:6px"><input type="radio" name="drive-u-que" value="pasar" ${destinos.length ? 'checked' : 'disabled'} onchange="driveBajaOpcion()"/>
        Pasarlos a otro usuario: <select class="form-select" id="drive-u-destino" style="display:inline-block;width:auto;padding:4px 8px">${destinos.map(d => `<option value="${esc(d.uid)}">${esc(d.nombre)} · ${esc(d.uid)}</option>`).join('') || '<option value="">no hay otro usuario activo</option>'}</select>
        <span class="text-muted">(le aparecen en una carpeta nueva)</span></label>
      <label style="display:block;margin-bottom:8px"><input type="radio" name="drive-u-que" value="borrar" ${destinos.length ? '' : 'checked'} onchange="driveBajaOpcion()"/> Borrarlos junto con el usuario</label>
      <div id="drive-u-conf" style="display:${destinos.length ? 'none' : 'block'};margin-bottom:8px">Para confirmar, escribí su correo: <input class="form-input" id="drive-u-conf-in" style="display:inline-block;width:260px;padding:4px 8px" autocomplete="off"/></div>
      <div style="display:flex;gap:8px"><button class="btn btn-danger btn-sm" id="drive-u-baja-btn" onclick="driveBajaConfirmar()">Eliminar usuario</button>
        <button class="btn btn-secondary btn-sm" onclick="document.getElementById('drive-u-baja').style.display='none'">Cancelar</button></div>`;
    caja.style.display = '';
    caja.scrollIntoView({ block: 'nearest' });
  };
  window.driveBajaOpcion = function () {
    $('drive-u-conf').style.display = document.querySelector('input[name="drive-u-que"]:checked').value === 'borrar' ? 'block' : 'none';
  };
  window.driveBajaConfirmar = async function () {
    const uid = $('drive-u-baja').dataset.uid;
    const pasar = document.querySelector('input[name="drive-u-que"]:checked').value === 'pasar';
    const cuerpo = pasar ? { usuario: uid, transferir_a: $('drive-u-destino').value } : { usuario: uid, confirmar: $('drive-u-conf-in').value };
    $('drive-u-baja-btn').disabled = true;
    try {
      const r = await api('POST', `/admin/drive/${encodeURIComponent(slugUsuarios)}/usuarios/eliminar`, cuerpo);
      if (!r.success) { showAlert('drive-u-err', 'error', r.error, 0); return; }
      modalU.classList.remove('open');
      seguirTrabajo(r.data.trabajo);
    } finally { $('drive-u-baja-btn').disabled = false; }
  };

  window.driveAgregarUsuarios = async function () {
    const usuarios = lineasUsuarios($('drive-u-nuevos').value);
    if (!usuarios.length) { showAlert('drive-u-err', 'error', 'Cargá al menos un usuario.', 4000); return; }
    $('drive-u-btn').disabled = true;
    try {
      const r = await api('POST', `/admin/drive/${encodeURIComponent(slugUsuarios)}/usuarios`, { usuarios, cuota_gb: Number($('drive-u-cuota').value) || 5 });
      if (!r.success) { showAlert('drive-u-err', 'error', r.error, 0); return; }
      modalU.classList.remove('open');
      seguirTrabajo(r.data.trabajo);
    } finally { $('drive-u-btn').disabled = false; }
  };

  /* ── pedido desde el formulario ── */
  function pedido() {
    const usuarios = lineasUsuarios($('drive-usuarios').value);
    return {
      slug: $('drive-slug').value.trim().toLowerCase(),
      billing_customer_id: $('drive-cliente').value || null,
      cuota_gb: Number($('drive-cuota').value) || 5,
      equipo_gb: Number($('drive-equipo').value) || 0,
      usuarios,
    };
  }

  window.driveNueva = async function () {
    ['drive-slug', 'drive-usuarios'].forEach(i => { $(i).value = ''; });
    $('drive-cuota').value = 5; $('drive-equipo').value = 0; $('drive-m-validacion').innerHTML = '';
    $('drive-m-err').className = 'alert alert-error'; $('drive-m-ok').className = 'alert alert-success';
    modal.classList.add('open');
    const r = await api('GET', '/admin/clients');
    if (r && r.success) {
      $('drive-cliente').innerHTML = '<option value="">— sin vincular por ahora —</option>' +
        r.data.map(c => `<option value="${esc(c.id)}">${esc(c.razon_social)}${c.numero_doc ? ' · ' + esc(c.numero_doc) : ''}</option>`).join('');
    }
  };

  function mostrarValidacion(v) {
    const lista = (t, color, arr) => (arr && arr.length)
      ? `<div style="color:${color};margin-top:4px"><strong>${t}</strong><ul style="margin:4px 0 0 18px">${arr.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '';
    $('drive-m-validacion').innerHTML =
      (v.ok ? `<div style="color:#047857"><strong>Se puede dar de alta.</strong> ${esc(v.fqdn || '')} · ${esc(v.usuarios)} usuario/s · ${esc(v.cuota_total_gb)} GB en total</div>` : '') +
      lista('No se puede:', 'var(--red)', v.errores) + lista('Para tener en cuenta:', '#92400E', v.avisos);
  }

  window.driveValidar = async function () {
    $('drive-btn-validar').disabled = true;
    try {
      const r = await api('POST', '/admin/drive/validar', pedido());
      if (!r.success) { showAlert('drive-m-err', 'error', r.error, 0); $('drive-m-validacion').innerHTML = ''; return; }
      $('drive-m-err').className = 'alert alert-error';
      mostrarValidacion(r.data);
    } finally { $('drive-btn-validar').disabled = false; }
  };

  window.driveCrear = async function () {
    const p = pedido();
    if (!confirm(`Se va a crear ${p.slug}.drive.hepta.com.py con ${p.usuarios.length} usuario/s. Cada uno recibe la invitación por correo apenas termina. ¿Seguimos?`)) return;
    $('drive-btn-crear').disabled = true;
    try {
      const r = await api('POST', '/admin/drive', p);
      if (!r.success) { showAlert('drive-m-err', 'error', r.error, 0); if (r.data) mostrarValidacion(r.data); return; }
      modal.classList.remove('open');
      seguirTrabajo(r.data.trabajo);
    } finally { $('drive-btn-crear').disabled = false; }
  };

  /* ── avance del alta ── */
  function pintarTrabajo(t) {
    $('drive-job-card').style.display = '';
    const dir = `https://${t.fqdn || t.slug + '.drive.hepta.com.py'}`;
    const cerrar = `<div style="margin-top:10px"><button class="btn btn-secondary btn-sm" onclick="document.getElementById('drive-job-card').style.display='none'">Cerrar</button></div>`;
    if (t.action === 'delete_user') {
      $('drive-job-title').textContent = `Baja de un usuario de ${t.slug}`;
      $('drive-job-body').innerHTML = t.status === 'running' ? `<div>Paso: <strong>${esc(t.step || 'En cola')}</strong></div><div class="text-muted text-sm" style="margin-top:6px">Si hay que pasar muchos archivos puede tardar unos minutos.</div>`
        : t.status === 'done' ? `<div style="color:#047857"><strong>Listo.</strong> El usuario fue eliminado.</div>${cerrar}`
        : `<div style="color:var(--red)"><strong>${esc(t.error || 'No se pudo eliminar')}</strong></div><div class="text-muted" style="margin-top:6px">El usuario quedó sin acceso pero no se borró nada más.</div>${cerrar}`;
      return;
    }
    if (t.action === 'add_users') {
      $('drive-job-title').textContent = `Usuarios de ${t.slug}`;
      $('drive-job-body').innerHTML = t.status === 'running' ? '<div>Creando los usuarios y enviando las invitaciones…</div>'
        : t.status === 'done' ? `<div style="color:#047857"><strong>Listo.</strong> Los usuarios nuevos ya recibieron su invitación por correo.</div>${cerrar}`
        : `<div style="color:var(--red)"><strong>${esc(t.error || 'No se pudieron agregar')}</strong></div><div class="text-muted" style="margin-top:6px">Se puede repetir con los mismos datos: los que ya se crearon no se duplican.</div>${cerrar}`;
      return;
    }
    if (t.status === 'running') {
      $('drive-job-title').textContent = `Alta en curso: ${t.slug}`;
      $('drive-job-body').innerHTML = `<div>Paso: <strong>${esc(t.step || 'En cola')}</strong></div>
        <div class="text-muted text-sm" style="margin-top:6px">Tarda entre 2 y 5 minutos. Podés cerrar esta ventana: el alta sigue.</div>`;
    } else if (t.status === 'done') {
      $('drive-job-title').textContent = `Alta terminada: ${t.slug}`;
      $('drive-job-body').innerHTML = `<div style="color:#047857"><strong>La instancia está creada</strong> en el puerto ${esc(t.port)} y los usuarios ya fueron invitados.</div>
        <div style="margin-top:10px">Falta publicar la dirección. En <code>hcsvrnd01</code>:</div>
        <pre style="background:var(--gray-100,#f3f4f6);padding:10px;border-radius:6px;font-size:12px;overflow-x:auto;margin:6px 0">lxc exec dkr-hgsvrlnx003 --project HEPTA -- drive_vhost_add.sh ${esc(t.slug)} ${esc(t.port)}</pre>
        <div>Después: <a href="${esc(dir)}" target="_blank" rel="noopener">${esc(dir)}</a>. El respaldo se da de alta solo en los próximos 10 minutos.</div>
        <div style="margin-top:8px;color:#92400E"><strong>No te olvides de los secretos:</strong> bajalos a KeePass desde la tabla de abajo. Ahí va la contraseña de las copias de este cliente.</div>
        <div style="margin-top:10px"><button class="btn btn-secondary btn-sm" onclick="document.getElementById('drive-job-card').style.display='none'">Cerrar</button></div>`;
    } else {
      $('drive-job-title').textContent = `El alta de ${t.slug} no terminó bien`;
      $('drive-job-body').innerHTML = `<div style="color:var(--red)"><strong>${esc(t.error || 'Error sin detalle')}</strong></div>
        <div class="text-muted" style="margin-top:6px">Último paso: ${esc(t.step || '—')}. El alta se puede repetir con los mismos datos: sigue desde donde quedó.</div>
        <div style="margin-top:10px"><button class="btn btn-secondary btn-sm" onclick="document.getElementById('drive-job-card').style.display='none'">Cerrar</button></div>`;
    }
  }

  function seguirTrabajo(id) {
    if (sondeo) clearInterval(sondeo);
    const vuelta = async () => {
      const r = await api('GET', `/admin/drive/jobs/${id}`);
      if (!r || !r.success) return;
      pintarTrabajo(r.data);
      if (r.data.status !== 'running') { clearInterval(sondeo); sondeo = null; cargarTabla(); }
    };
    vuelta();
    sondeo = setInterval(vuelta, 8000);
  }

  /* ── tabla ── */
  function fila(i) {
    const reg = i.registro || {};
    if (i.solo_registro) {
      const est = reg.status === 'creating' ? '<span class="badge badge-blue">creándose</span>' : reg.status === 'failed' ? '<span class="badge badge-red">alta fallida</span>' : '<span class="badge badge-red">no está en el servidor</span>';
      return `<tr><td><strong>${esc(i.slug)}</strong><div class="text-muted text-sm">${esc(i.fqdn || '')}</div></td><td>${esc(reg.cliente || '—')}</td><td colspan="4">${est}</td>
        <td>${reg.status === 'creating' && reg.ultimo_trabajo ? `<button class="btn btn-secondary btn-sm" onclick="driveVerTrabajo(${Number(reg.ultimo_trabajo)})">Ver avance</button>` : ''}</td></tr>`;
    }
    const resp = i.respaldo === 'enrolado' ? `<span class="badge badge-green">al día</span><div class="text-muted text-sm">${esc(fecha(i.ultima_copia))}</div>`
      : i.respaldo === 'pendiente' ? '<span class="badge badge-blue">dándose de alta</span>' : '<span class="badge badge-red">sin configurar</span>';
    const sec = i.secretos_pendientes
      ? `<span class="badge badge-red">pendientes</span>${esGod() ? `<div style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap">
           <button class="btn btn-secondary btn-sm" onclick="driveSecretos('${esc(i.slug)}')">Bajar</button>
           <button class="btn btn-secondary btn-sm" onclick="driveGuardados('${esc(i.slug)}')">Ya los guardé</button></div>` : '<div class="text-muted text-sm">solo godmode</div>'}`
      : '<span class="badge badge-gray">en KeePass</span>';
    const caidos = Number(i.contenedores) < 4 ? ` <span class="badge badge-red">${esc(i.contenedores)}/4 contenedores</span>` : '';
    return `<tr>
      <td><strong>${esc(i.slug)}</strong>${caidos}<div class="text-sm"><a href="https://${esc(i.fqdn)}" target="_blank" rel="noopener">${esc(i.fqdn)}</a> · puerto ${esc(i.puerto)}</div></td>
      <td>${esc(reg.cliente || '—')}${reg.creado_por ? `<div class="text-muted text-sm">alta: ${esc(reg.creado_por)}</div>` : ''}</td>
      <td>${esc(i.usuarios)}</td><td>${esc(i.datos || '—')}</td><td>${resp}</td><td>${sec}</td>
      <td style="white-space:nowrap"><button class="btn btn-secondary btn-sm" onclick="driveUsuarios('${esc(i.slug)}')">Usuarios</button>
          <button class="btn btn-secondary btn-sm" onclick="driveVerificar('${esc(i.slug)}',this)">Verificar</button></td></tr>`;
  }

  async function cargarTabla() {
    const r = await api('GET', '/admin/drive');
    const tb = $('drive-tbody');
    if (!r || !r.success) { tb.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--red)">${esc((r && r.error) || 'No se pudo cargar')}</td></tr>`; return; }
    const d = r.data;
    $('drive-dot').style.background = d.agente_error ? 'var(--red)' : '#10B981';
    $('drive-dot-text').textContent = d.agente_error ? d.agente_error : 'conectado';
    tb.innerHTML = d.instancias.length ? d.instancias.map(fila).join('')
      : '<tr><td colspan="7" class="text-muted" style="text-align:center;padding:24px">Todavía no hay instancias.</td></tr>';
    // Si hay un alta abierta y no la estamos mirando, mostrarla
    const abierta = d.instancias.find(i => i.registro && i.registro.status === 'creating' && i.registro.ultimo_trabajo);
    if (abierta && !sondeo) seguirTrabajo(abierta.registro.ultimo_trabajo);
  }

  window.driveVerTrabajo = id => seguirTrabajo(id);

  window.driveVerificar = async function (slug, btn) {
    if (btn) btn.disabled = true;
    try {
      const r = await api('POST', `/admin/drive/${encodeURIComponent(slug)}/verificar`);
      if (r.success && r.data.ok) showAlert('drive-ok', 'success', `${slug}: responde bien, con doble factor obligatorio, OnlyOffice y antivirus.`, 6000);
      else showAlert('drive-err', 'error', `${slug}: ${r.success ? r.data.detalle : r.error}`, 0);
    } finally { if (btn) btn.disabled = false; }
  };

  // El paquete para KeePass: se baja como archivo, sin mostrarse en pantalla
  window.driveSecretos = async function (slug) {
    let res;
    try { res = await fetch(`/api/admin/drive/${encodeURIComponent(slug)}/secretos`, { headers: authHeaders(), cache: 'no-store' }); }
    catch (e) { showAlert('drive-err', 'error', 'No hay conexión con el servidor.', 0); return; }
    if (!res.ok) { let m = `Error ${res.status}`; try { m = (await res.json()).error || m; } catch (e) { /* sin detalle */ } showAlert('drive-err', 'error', m, 0); return; }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url; a.download = `hepta-drive-${slug}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showAlert('drive-ok', 'success', `Paquete de ${slug} descargado. Importalo en KeePass (File → Import → Generic CSV), arrastrá el grupo "${slug}" adentro de Vault → Hepta Drive, borrá el archivo de la PC y marcá "Ya los guardé".`, 0);
  };

  window.driveGuardados = async function (slug) {
    if (!confirm(`¿Los secretos de ${slug} ya están en KeePass?\n\nAl confirmar se borran del servidor y no se pueden volver a bajar. Entre ellos está la contraseña de las copias de este cliente.`)) return;
    const r = await api('POST', `/admin/drive/${encodeURIComponent(slug)}/secretos/guardado`);
    if (!r.success) { showAlert('drive-err', 'error', r.error, 0); return; }
    showAlert('drive-ok', 'success', `Secretos de ${slug} borrados del servidor.`, 5000);
    cargarTabla();
  };

  function loadDrive() { $('drive-ok').className = 'alert alert-success'; $('drive-err').className = 'alert alert-error'; return cargarTabla(); }
  window.loadDrive = loadDrive;
  try { sectionTitles.drive = 'HEPTA Drive'; } catch (e) { /* sin navegación */ }
  try { sectionLoaders.drive = loadDrive; } catch (e) { /* sin navegación */ }
})();
