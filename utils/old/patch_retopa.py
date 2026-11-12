#!/usr/bin/env python3
"""HC S28b - Correr en RetoPA VM solamente"""

HEPTA = '/opt/retopa/frontend/cliente/js/hepta.js'
with open(HEPTA, 'r') as f:
    content = f.read()

if 'loadHCPlans' not in content:
    old = """// ── PLANES HC con Tpago ──────────────────────────────────────
const HC_PLANS = ["""

    new_const = """// ── PLANES HC dinámicos desde API HC ─────────────────────────
let HC_PLANS = [];
const PLAN_COLORS = { starter:'#4F46E5', professional:'#7C3AED', enterprise:'#0F172A' };

async function loadHCPlans() {
    if (HC_PLANS.length) return HC_PLANS;
    try {
        const res = await fetch('https://cloud.hepta.com.py/api/plans');
        const data = await res.json();
        if (data.success && data.data.length) {
            HC_PLANS = data.data.map(p => ({
                slug:     p.slug,
                name:     p.name,
                price:    p.price_label || 'A consultar',
                color:    PLAN_COLORS[p.slug] || '#4F46E5',
                features: Array.isArray(p.features) ? p.features : JSON.parse(p.features || '[]'),
                badge:    p.badge_text || null,
            }));
            return HC_PLANS;
        }
    } catch(e) {}
    // Fallback
    HC_PLANS = [
        { slug:'starter',      name:'Plan Despegue',   price:'₲ 169.000/mes', color:'#4F46E5', features:['CRM de ventas','Facturación básica','Hasta 3 usuarios','Soporte por email'], badge:null },
        { slug:'professional', name:'Plan Crecimiento', price:'₲ 319.000/mes', color:'#7C3AED', features:['Todo lo de Despegue','Usuarios ilimitados','Módulos avanzados','Soporte prioritario'], badge:'Más popular' },
        { slug:'enterprise',   name:'Plan Empresa',     price:'A consultar',   color:'#0F172A', features:['Todo lo de Crecimiento','Implementación dedicada','SLA garantizado','Soporte 24/7'], badge:null },
    ];
    return HC_PLANS;
}

const HC_PLANS_PLACEHOLDER = ["""

    # Encontrar dónde termina el array HC_PLANS original
    start = content.find("// ── PLANES HC con Tpago")
    end   = content.find("];\n\n// Modal", start) + 3
    if start > -1 and end > start:
        content = content[:start] + new_const + content[content.find("[", start)+1:end] + content[end:]
        print("OK HC_PLANS reemplazado (puede quedar placeholder)")
    else:
        print("WARN: no encontré el array HC_PLANS completo")

    # Hacer openHeptaRequest async y cargar planes
    content = content.replace(
        "// Modal de solicitud de instancia HC\nfunction openHeptaRequest() {",
        "// Modal de solicitud de instancia HC\nasync function openHeptaRequest() {\n    await loadHCPlans();"
    )

    with open(HEPTA, 'w') as f:
        f.write(content)
    print("OK hepta.js con loadHCPlans")
else:
    print("- hepta.js ya tiene loadHCPlans")

print("Done RetoPA!")
