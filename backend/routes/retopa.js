// ============================================================
//  HEPTA CLOUD — RetoPA Integration Helper
//  Usado desde provision.routes.js al crear instancias
// ============================================================
const pool = require('../config/db');

async function getRetopaConfig() {
  const { rows } = await pool.query(
    "SELECT key,value FROM site_config WHERE key LIKE 'retopa_%'"
  );
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

async function retopaCall(cfg, method, path, body) {
  const url = `${cfg.retopa_api_url}/api/v2/internal${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type':   'application/json',
      'X-Internal-Key': cfg.retopa_api_key || '',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json();
  if (!res.ok && res.status !== 404) throw new Error(data.error || `RetoPA API error ${res.status}`);
  return data;
}

// Sincronizar usuario HC → RetoPA
async function syncUserToRetopa(user) {
  const cfg = await getRetopaConfig();
  if (cfg.retopa_enabled !== 'true' || !cfg.retopa_api_url) return null;

  try {
    const data = await retopaCall(cfg, 'POST', '/sync-user', {
      email: user.email,
      name:  user.full_name || user.email,
      phone: user.phone || null,
    });
    if (data.success) {
      // Guardar retopa_user_id en HC
      await pool.query(
        'UPDATE users SET retopa_user_id=$1 WHERE id=$2',
        [data.data.id, user.id]
      );
      return data.data;
    }
  } catch(e) {
    console.error('[retopa/sync-user]', e.message);
  }
  return null;
}

// Crear ficha de negocio en RetoPA al provisionar instancia
async function createRetopaListing({ user, instance, listingData }) {
  const cfg = await getRetopaConfig();
  if (cfg.retopa_enabled !== 'true' || cfg.retopa_auto_list !== 'true') return null;
  if (!cfg.retopa_api_url) return null;

  try {
    // Primero sincronizar el usuario
    const retopaUser = await syncUserToRetopa(user);
    if (!retopaUser) return null;

    // Crear la ficha
    const data = await retopaCall(cfg, 'POST', '/create-listing', {
      user_id:     retopaUser.id,
      name:        listingData.business_name || user.full_name,
      trade_name:  listingData.trade_name || null,
      email:       user.email,
      phone:       listingData.phone || user.phone || null,
      whatsapp:    listingData.whatsapp || listingData.phone || null,
      city:        listingData.city || null,
      description: listingData.description || null,
      category_id: listingData.category_id || null,
      ruc:         listingData.ruc || null,
      image_url:   listingData.logo_url || null,
      source:      'hepta_cloud',
    });

    if (data.success) {
      // Guardar retopa_business_id en la instancia
      await pool.query(
        'UPDATE instances SET retopa_business_id=$1 WHERE id=$2',
        [data.data.id, instance.id]
      );
      console.log(`[retopa] Ficha creada: ${data.data.url}`);
      return data.data;
    }
  } catch(e) {
    console.error('[retopa/create-listing]', e.message);
  }
  return null;
}

module.exports = { syncUserToRetopa, createRetopaListing, getRetopaConfig, retopaCall };
