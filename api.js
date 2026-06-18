// Timestamp: 2026-06-18 14:37:14 -04:00
// js/api.js
import { CONFIG } from './config.js';

// Appel générique à l’API kiosque-reparation (Edge function)
export async function api(path, opts = {}) {
  if (!CONFIG.USE_MOCK && !CONFIG.API_BASE) {
    throw new Error('API_BASE manquant');
  }
  if (CONFIG.USE_MOCK) {
    return mockApi(path, opts);
  }

  const url = `${CONFIG.API_BASE}${path}`;
  const headers = {
    'Content-Type': 'application/json',
  };

  const res = await fetch(url, {
    method: opts.method || 'POST',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('Erreur API', path, res.status, text);
    throw new Error(`API error ${res.status}`);
  }

  return res.json();
}
// Liste les BT assignés à un technicien (par son username)
export async function apiListMesBT(username) {
  if (!username) {
    throw new Error("username manquant pour apiListMesBT");
  }

  const url = `/repairs/by-tech?username=${encodeURIComponent(username)}`;

  // On suppose que api() préfixe déjà avec l'URL de la edge function Supabase
  const data = await api(url, { method: "GET" });

  if (!data || data.ok === false) {
    throw new Error(data?.error || "Erreur inconnue dans apiListMesBT");
  }

  return data.items || [];
}

export async function apiListRepairsCache(limit = 100) {
  if (!CONFIG.REPAIRS_CACHE_API) {
    throw new Error("REPAIRS_CACHE_API manquant");
  }

  const url = new URL(CONFIG.REPAIRS_CACHE_API);
  const wantedLimit = Number(limit);
  if (Number.isFinite(wantedLimit) && wantedLimit > 0) {
    url.searchParams.set("limit", String(Math.floor(wantedLimit)));
  }

  const res = await fetch(url.toString(), { method: "GET" });
  if (!res.ok) {
    const text = await res.text();
    console.error("Erreur apiListRepairsCache", res.status, text);
    throw new Error(`repairs-cache error ${res.status}`);
  }

  const data = await res.json();
  if (!data || data.ok === false) {
    throw new Error(data?.error || "Erreur inconnue dans apiListRepairsCache");
  }

  return Array.isArray(data.items) ? data.items : [];
}

export async function apiFetchOverviewHome(limit = 5) {
  const wantedLimit = Number(limit);
  const qs = Number.isFinite(wantedLimit) && wantedLimit > 0
    ? `?limit=${encodeURIComponent(String(Math.floor(wantedLimit)))}`
    : '';

  const data = await api(`/repairs/overview/home${qs}`, { method: 'GET' });
  if (!data || data.ok === false) {
    throw new Error(data?.error || 'Erreur inconnue dans apiFetchOverviewHome');
  }

  return {
    open: Array.isArray(data.open) ? data.open : [],
    done: Array.isArray(data.done) ? data.done : [],
  };
}

// Recherche d'un BT par ID unique ou code (ex. "REP1437", "rep1437", "1437")
export async function apiGetBTById(idUnique) {
  const value = String(idUnique ?? '').trim();
  if (!value) {
    throw new Error('ID unique vide');
  }

  console.log('[apiGetBTById] Appel /repairs/by-id avec id_unique =', value);

  const res = await fetch(`${CONFIG.API_BASE}/repairs/by-id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id_unique: value }), // ⬅️ cohérent avec le Edge
  });

  const rawText = await res.text();
  console.log('[apiGetBTById] HTTP', res.status, 'raw response =', rawText);

  let data = null;
  try {
    data = JSON.parse(rawText);
  } catch (e) {
    console.error('[apiGetBTById] JSON.parse error', e);
    throw new Error("Réponse invalide du serveur");
  }

  // Cas OK
  if (res.ok && data && data.ok && data.item) {
    return data.item;
  }

  // Cas "podioError" renvoyé par le Edge
  if (data && data.podioError) {
    throw new Error(`Erreur Podio (raison: ${data.reason || 'inconnue'})`);
  }

  // Cas "pas trouvé" ou autre
  throw new Error(data?.error || 'BT introuvable');
}



// Lookup Podio/Hector (Edge podio-lookup)
export async function apiLookupInventory(inventory) {
  const res = await fetch(
    `${CONFIG.LOOKUP_BASE}/by-inventory?inventory=${encodeURIComponent(inventory)}`
  );
  if (!res.ok) throw new Error(`lookup error ${res.status}`);
  return res.json();
}

// Rafraîchit le "dernier bon créé" via repairs-list et podio-lookup
export async function refreshLastCreated() {
  if (!CONFIG.REPAIRS_CACHE_API) return;

  try {
    const res = await fetch(CONFIG.REPAIRS_CACHE_API);
    if (!res.ok) {
      console.warn('Impossible de récupérer repairs-list', res.status);
      return;
    }
    const data = await res.json();
    return data; // on laisse app.js décider quoi faire avec
  } catch (e) {
    console.warn('Erreur refreshLastCreated', e);
  }
}

// Variante: rafraîchir par app_item_id dans Podio, si ton backend le gère
export async function refreshLastCreatedFromPodio(appItemId) {
  if (!appItemId) return null;
  const url = `${CONFIG.LOOKUP_BASE}/by-app-item-id?app_item_id=${encodeURIComponent(appItemId)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`lookup by-app-item-id error ${res.status}`);
  return res.json();
}

// Variante: rafraîchir par inventaire
export async function refreshLastCreatedByInventory(inv) {
  if (!inv) return null;
  const url = `${CONFIG.LOOKUP_BASE}/by-inventory?inventory=${encodeURIComponent(inv)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`lookup by-inventory error ${res.status}`);
  return res.json();
}

// Mock pour DEV local si CONFIG.USE_MOCK === true
function mockApi(path, opts = {}) {
  console.log('[MOCK API]', path, opts);

  // à partir d’ici, tu colles ton code actuel de mockApi tel quel,
  // en le laissant privé (pas de "export"), par exemple :
  const _store = { items: [] };

  function _latestByInv(inv) {
    return _store.items
      .filter(i => i.inventory === inv)
      .sort((a, b) => b.createdAt - a.createdAt)[0] || null;
  }

  // ... [copie TON mock existant ici] ...

  return Promise.resolve({ ok: true });
}
