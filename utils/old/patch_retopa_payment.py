#!/usr/bin/env python3
"""HC S28 - Mejorar modal de solicitud HC en RetoPA con Tpago"""
import os

JS = '/opt/retopa/frontend/cliente/js/hepta.js'

with open(JS, 'r') as f:
    content = f.read()

# Reemplazar openHeptaRequest con versión mejorada con planes y Tpago
old_modal = """// Modal de solicitud de instancia HC
function openHeptaRequest() {"""

new_modal = """// ── PLANES HC con Tpago ──────────────────────────────────────
const HC_PLANS = [
    {
        slug: 'starter',
        name: 'Plan Despegue',
        price: '₲ 169.000/mes',
        color: '#4F46E5',
        features: ['CRM de ventas', 'Facturación básica', 'Hasta 3 usuarios', 'Soporte por email'],
        badge: null,
    },
    {
        slug: 'professional',
        name: 'Plan Crecimiento',
        price: '₲ 319.000/mes',
        color: '#7C3AED',
        features: ['Todo lo de Despegue', 'Usuarios ilimitados', 'Módulos avanzados', 'Soporte prioritario'],
        badge: 'Más popular',
    },
    {
        slug: 'enterprise',
        name: 'Plan Empresa',
        price: 'A consultar',
        color: '#0F172A',
        features: ['Todo lo de Crecimiento', 'Implementación dedicada', 'SLA garantizado', 'Soporte 24/7'],
        badge: null,
    },
];

// Modal de solicitud de instancia HC
function openHeptaRequest() {"""

if old_modal in content:
    content = content.replace(old_modal, new_modal)
    print("✓ Planes HC agregados")

# Reemplazar el contenido del modal
old_modal_html = """    div.innerHTML = `
        <div class="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <h3 class="text-lg font-black text-gray-900 mb-1">Solicitar sistema Hepta Cloud</h3>
            <p class="text-sm text-gray-500 mb-4">Completá y te contactamos en menos de 24 horas hábiles.</p>
            <div id="heptaReqErr" class="hidden bg-red-50 text-red-600 text-sm rounded-lg px-3 py-2 mb-3"></div>
            <div id="heptaReqOk" class="hidden bg-green-50 text-green-700 text-sm rounded-lg px-3 py-2 mb-3"></div>
            <div class="space-y-3">
                <div>
                    <label class="text-xs font-semibold text-gray-500 uppercase tracking-wide">Plan de interés</label>
                    <select id="heptaReqPlan" class="mt-1 w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-indigo-400">
                        <option value="starter">Starter</option>
                        <option value="professional" selected>Professional</option>
                        <option value="enterprise">Enterprise</option>
                    </select>
                </div>
                <div>
                    <label class="text-xs font-semibold text-gray-500 uppercase tracking-wide">Mensaje (opcional)</label>
                    <textarea id="heptaReqMsg" rows="2" placeholder="Contanos brevemente qué necesitás..."
                        class="mt-1 w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-indigo-400 resize-none"></textarea>
                </div>
            </div>
            <div class="flex gap-3 mt-5">
                <button onclick="document.getElementById('heptaRequestModal').classList.add('hidden')"
                    class="flex-1 border border-gray-200 text-gray-600 font-semibold px-4 py-2.5 rounded-xl text-sm hover:bg-gray-50 transition-colors">
                    Cancelar
                </button>
                <button onclick="submitHeptaRequest()"
                    class="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-bold px-4 py-2.5 rounded-xl text-sm transition-colors">
                    Enviar solicitud
                </button>
            </div>
        </div>`;"""

new_modal_html = """    div.innerHTML = `
        <div style="background:#fff;border-radius:20px;padding:24px;width:100%;max-width:480px;box-shadow:0 25px 50px rgba(0,0,0,.25)">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
                <div>
                    <h3 style="font-size:18px;font-weight:900;color:#0F172A;margin:0 0 2px">Elegí tu plan</h3>
                    <p style="font-size:13px;color:#64748B;margin:0">Todos incluyen implementación y soporte local</p>
                </div>
                <button onclick="document.getElementById('heptaRequestModal').classList.add('hidden')"
                    style="background:none;border:none;cursor:pointer;color:#94A3B8;font-size:20px">✕</button>
            </div>
            <div id="heptaReqErr" style="display:none;background:#FEF2F2;color:#DC2626;font-size:13px;border-radius:8px;padding:10px 14px;margin-bottom:12px"></div>
            <div id="heptaReqOk"  style="display:none;background:#F0FDF4;color:#16A34A;font-size:13px;border-radius:8px;padding:10px 14px;margin-bottom:12px"></div>

            <!-- Cards de planes -->
            <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:16px" id="heptaPlanCards">
                ${HC_PLANS.map(p => `
                <label style="cursor:pointer">
                    <input type="radio" name="heptaPlan" value="${p.slug}" ${p.slug==='professional'?'checked':''} style="display:none"/>
                    <div class="hepta-plan-card" data-plan="${p.slug}"
                        style="border:2px solid ${p.slug==='professional'?p.color:'#E2E8F0'};border-radius:12px;padding:14px 16px;transition:.15s;background:${p.slug==='professional'?'#FAF5FF':'#fff'};position:relative"
                        onclick="selectHeptaPlan('${p.slug}')">
                        ${p.badge?`<span style="position:absolute;top:-10px;right:12px;background:${p.color};color:#fff;font-size:10px;font-weight:700;padding:2px 10px;border-radius:10px">${p.badge}</span>`:''}
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
                            <span style="font-weight:800;color:#0F172A;font-size:15px">${p.name}</span>
                            <span style="font-weight:700;color:${p.color};font-size:14px">${p.price}</span>
                        </div>
                        <div style="display:flex;flex-wrap:wrap;gap:4px">
                            ${p.features.map(f=>`<span style="font-size:11px;background:#F1F5F9;color:#475569;padding:2px 8px;border-radius:6px">✓ ${f}</span>`).join('')}
                        </div>
                    </div>
                </label>`).join('')}
            </div>

            <div style="margin-bottom:14px">
                <label style="font-size:11px;font-weight:700;color:#94A3B8;text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:6px">Nombre de tu empresa (opcional)</label>
                <input id="heptaReqBiz" placeholder="Ej: Panadería San Pedro"
                    style="width:100%;border:1.5px solid #E2E8F0;border-radius:10px;padding:10px 14px;font-size:13px;outline:none;box-sizing:border-box"/>
            </div>

            <button onclick="submitHeptaRequest()" id="heptaReqBtn"
                style="width:100%;background:#4F46E5;color:#fff;font-weight:800;font-size:15px;padding:14px;border-radius:12px;border:none;cursor:pointer">
                Continuar al pago →
            </button>
            <p style="text-align:center;font-size:11px;color:#94A3B8;margin-top:10px">
                Plan Empresa: <a href="https://wa.me/595986484905?text=Quiero%20información%20sobre%20el%20Plan%20Empresa" target="_blank" style="color:#4F46E5">consultanos por WhatsApp</a>
            </p>
        </div>`;"""

if old_modal_html in content:
    content = content.replace(old_modal_html, new_modal_html)
    print("✓ Modal HTML mejorado")
else:
    print("WARN: modal HTML no encontrado")

# Agregar función selectHeptaPlan
old_submit = "async function submitHeptaRequest() {"
new_submit = """function selectHeptaPlan(slug) {
    document.querySelectorAll('.hepta-plan-card').forEach(card => {
        const plan = HC_PLANS.find(p => p.slug === card.dataset.plan);
        if (!plan) return;
        if (card.dataset.plan === slug) {
            card.style.borderColor = plan.color;
            card.style.background = slug === 'enterprise' ? '#F8FAFC' : '#FAF5FF';
            card.querySelector('input') && (card.querySelector('input').checked = true);
        } else {
            card.style.borderColor = '#E2E8F0';
            card.style.background = '#fff';
        }
    });
    document.querySelector(`input[value="${slug}"]`) &&
        (document.querySelector(`input[value="${slug}"]`).checked = true);
    const btn = document.getElementById('heptaReqBtn');
    if (btn) btn.textContent = slug === 'enterprise' ? 'Solicitar asesoría →' : 'Continuar al pago →';
}

async function submitHeptaRequest() {"""

if old_submit in content:
    content = content.replace(old_submit, new_submit)
    print("✓ selectHeptaPlan agregado")

# Mejorar submitHeptaRequest para redirigir a Tpago
old_fn = """async function submitHeptaRequest() {
    const plan = document.getElementById('heptaReqPlan')?.value || 'professional';
    const msg  = document.getElementById('heptaReqMsg')?.value || '';
    const err  = document.getElementById('heptaReqErr');
    const ok   = document.getElementById('heptaReqOk');

    try {
        const res = await fetch('/api/v2/client/hepta-request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
            body: JSON.stringify({ plan, message: msg })
        });
        const data = await res.json();
        if (data.success) {
            if (ok) { ok.textContent = '✓ Solicitud enviada. Te contactamos pronto.'; ok.classList.remove('hidden'); }
            setTimeout(() => document.getElementById('heptaRequestModal')?.classList.add('hidden'), 2500);
        } else {
            if (err) { err.textContent = data.error || 'Error al enviar'; err.classList.remove('hidden'); }
        }
    } catch(e) {
        if (err) { err.textContent = 'Error de conexión'; err.classList.remove('hidden'); }
    }
}"""

new_fn = """async function submitHeptaRequest() {
    const planInput = document.querySelector('input[name="heptaPlan"]:checked');
    const plan = planInput?.value || 'professional';
    const biz  = document.getElementById('heptaReqBiz')?.value || '';
    const err  = document.getElementById('heptaReqErr');
    const ok   = document.getElementById('heptaReqOk');
    const btn  = document.getElementById('heptaReqBtn');

    if (btn) { btn.disabled = true; btn.textContent = 'Procesando...'; }

    try {
        // Llamar a HC API para registrar la solicitud
        const res = await fetch('https://cloud.hepta.com.py/api/portal/payment-request', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${getToken()}`
            },
            body: JSON.stringify({ plan, business_name: biz })
        });
        const data = await res.json();

        if (data.success) {
            if (data.data.type === 'tpago') {
                // Mostrar confirmación y redirigir a Tpago
                if (ok) {
                    ok.style.display = 'block';
                    ok.textContent = '✓ Redirigiendo a Tpago para completar el pago...';
                }
                setTimeout(() => {
                    window.open(data.data.tpago_link, '_blank');
                    document.getElementById('heptaRequestModal')?.classList.add('hidden');
                    // Mostrar mensaje de seguimiento
                    showToastClient('¡Listo! Completá el pago en Tpago. Te avisaremos cuando tu sistema esté listo.', 'success');
                }, 1500);
            } else if (data.data.type === 'contact') {
                if (ok) {
                    ok.style.display = 'block';
                    ok.textContent = '✓ ' + data.data.message;
                }
                setTimeout(() => document.getElementById('heptaRequestModal')?.classList.add('hidden'), 2500);
            }
        } else {
            if (err) { err.style.display = 'block'; err.textContent = data.error || 'Error al procesar'; }
            if (btn) { btn.disabled = false; btn.textContent = 'Continuar al pago →'; }
        }
    } catch(e) {
        if (err) { err.style.display = 'block'; err.textContent = 'Error de conexión con Hepta Cloud'; }
        if (btn) { btn.disabled = false; btn.textContent = 'Continuar al pago →'; }
    }
}"""

if old_fn in content:
    content = content.replace(old_fn, new_fn)
    print("✓ submitHeptaRequest mejorado con Tpago")
else:
    print("WARN: submitHeptaRequest no encontrado")

with open(JS, 'w') as f:
    f.write(content)
print("✓ hepta.js actualizado con flujo Tpago")
