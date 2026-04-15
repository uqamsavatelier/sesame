import { supa, SUPABASE_URL, SUPABASE_ANON_KEY } from "./supabaseClient.js";
import { ensureAuditSyncStarted, logAuditEvent } from "./audit.js";

ensureAuditSyncStarted();

function safeAudit(input) {
  void logAuditEvent(input);
}

function toIntOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function normalizeGroup(group) {
  const raw = String(group ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replaceAll("-", "_")
    .replace(/\s+/g, "_");

  if (raw === "direction") return "direction";
  if (raw === "affichage") return "affichage";
  return "employe";
}

function keyNoLabel(ref) {
  const keyNo = String(ref?.key_no ?? "").trim();
  if (keyNo) return keyNo;
  return String(ref?.id ?? "?");
}

function formatKeyTarget(ref) {
  const cab = toIntOrNull(ref?.cabinet_id);
  const hook = toIntOrNull(ref?.hook_no);
  const keyNo = keyNoLabel(ref);
  return `key:${cab ?? "?"}/${hook ?? "?"}/${keyNo}`;
}

function formatHookTarget(ref) {
  const cab = toIntOrNull(ref?.cabinet_id);
  const hook = toIntOrNull(ref?.hook_no);
  return `hook:${cab ?? "?"}/${hook ?? "?"}`;
}

function formatKeyringTarget(ref) {
  const cab = toIntOrNull(ref?.cabinet_id);
  const hook = toIntOrNull(ref?.hook_no);
  const code = String(ref?.ring_code ?? "").trim().toUpperCase() || "?";
  return `keyring:${cab ?? "?"}/${hook ?? "?"}/${code}`;
}

async function getKeyRefById(keyId) {
  const id = toIntOrNull(keyId);
  if (id == null) return null;
  const { data } = await supa
    .from("keys")
    .select("id,cabinet_id,hook_no,key_no")
    .eq("id", id)
    .maybeSingle();
  return data ?? null;
}

async function getLoanRefById(loanId) {
  const id = toIntOrNull(loanId);
  if (id == null) return null;
  const { data } = await supa
    .from("loans")
    .select("id,key_id")
    .eq("id", id)
    .maybeSingle();
  return data ?? null;
}
async function callFunctionRaw(name, body) {
  const { data: sessData, error: sessErr } = await supa.auth.getSession();
  if (sessErr) {
    safeAudit({
      event_type: "system_comm_error",
      action: name,
      target: "auth.getSession",
      details: sessErr.message || String(sessErr),
      status: "error",
      source: "frontend",
    });
    throw sessErr;
  }
  const token = sessData?.session?.access_token;
  if (!token) {
    safeAudit({
      event_type: "system_comm_error",
      action: name,
      target: "auth.access_token",
      details: "Pas de session (access_token manquant).",
      status: "error",
      source: "frontend",
    });
    throw new Error("Pas de session (access_token manquant).");
  }

  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${token}`,
      "apikey": SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }

  if (!res.ok) {
    const msg = (payload && typeof payload === "object")
      ? (payload.error || payload.message || JSON.stringify(payload))
      : (String(payload || text || "").trim() || `HTTP ${res.status}`);
    console.error(`[${name}] FAILED`, res.status, payload ?? text);
    safeAudit({
      event_type: "system_comm_error",
      action: name,
      target: "edge_function",
      details: msg,
      status: "error",
      http_status: res.status,
      source: "frontend",
    });
    const err = new Error(`${name}: ${msg}`);
    err.payload = payload; // <-- on attache les dÃƒÂ©tails
    throw err;
  }

  console.log(`[${name}] OK`, payload);
  return payload;
}


/* -------------------- LISTES -------------------- */

export async function listCabinets(options = {}) {
  const includeInactive = !!options?.includeInactive;
  const selects = [
    "id,name,location,is_active,max_hooks,pavilion_id,user_group",
    "id,name,location,is_active,max_hooks,user_group",
    "id,name,location,is_active,user_group",
    "id,name,location,is_active,max_hooks,pavilion_id",
    "id,name,location,is_active,max_hooks",
    "id,name,location,is_active",
  ];
  let lastError = null;
  for (const sel of selects) {
    let query = supa
      .from("cabinets")
      .select(sel)
      .order("name", { ascending: true });
    if (!includeInactive) query = query.eq("is_active", true);
    const { data, error } = await query;
    if (!error) {
      return (data ?? []).map((c) => ({
        ...c,
        max_hooks: c?.max_hooks ?? null,
        pavilion_id: c?.pavilion_id ?? null,
        user_group: normalizeGroup(c?.user_group ?? "employe"),
      }));
    }
    lastError = error;
  }
  throw lastError ?? new Error("Impossible de charger les armoires.");
}

export async function createCabinet(payload) {
  const name = String(payload?.name ?? "").trim();
  const location = payload?.location != null ? String(payload.location).trim() : null;
  const maxHooksRaw = Number(payload?.max_hooks);
  const pavilionRaw = payload?.pavilion_id;
  const pavilion_id = pavilionRaw == null || String(pavilionRaw).trim() === ""
    ? null
    : Number(pavilionRaw);
  const user_group = normalizeGroup(payload?.user_group ?? "employe");
  const max_hooks = Number.isFinite(maxHooksRaw) && maxHooksRaw > 0 ? Math.trunc(maxHooksRaw) : null;
  if (!name) throw new Error("Nom d'armoire requis.");
  if (!max_hooks) throw new Error("Maximum de crochets invalide.");
  if (pavilion_id != null && !Number.isFinite(pavilion_id)) throw new Error("Pavillon invalide.");

  let result = await supa
    .from("cabinets")
    .insert({
      name,
      location,
      max_hooks,
      pavilion_id,
      user_group,
      is_active: true,
    })
    .select("id,name,location,is_active,max_hooks,pavilion_id,user_group")
    .single();

  if (result.error && /user_group/i.test(String(result.error?.message ?? ""))) {
    result = await supa
      .from("cabinets")
      .insert({
        name,
        location,
        max_hooks,
        pavilion_id,
        is_active: true,
      })
      .select("id,name,location,is_active,max_hooks,pavilion_id")
      .single();
  }

  const { data, error } = result;

  if (!error) {
    safeAudit({
      event_type: "cabinet_create",
      action: "cabinet_create",
      target: data?.name || `cabinet:${data?.id ?? "?"}`,
      details: `cabinet_id=${data?.id ?? "?"}`,
      status: "ok",
      source: "frontend",
    });
    return {
      ...data,
      user_group: normalizeGroup(data?.user_group ?? user_group),
    };
  }

  const viaFn = await callFunctionRaw("cabinets-create", {
    name,
    location,
    max_hooks,
    pavilion_id,
    user_group,
  });
  const created = viaFn?.cabinet ?? viaFn;
  safeAudit({
    event_type: "cabinet_create",
    action: "cabinet_create",
    target: created?.name || `cabinet:${created?.id ?? "?"}`,
    details: `cabinet_id=${created?.id ?? "?"}`,
    status: "ok",
    source: "frontend",
  });
  return {
    ...created,
    user_group: normalizeGroup(created?.user_group ?? user_group),
  };
}

export async function updateCabinet(cabinetId, patch) {
  const id = Number(cabinetId);
  if (!Number.isFinite(id)) throw new Error("cabinet_id invalide.");

  let beforeRow = null;
  let beforeErr = null;
  for (const selectClause of [
    "id,name,location,is_active,max_hooks,pavilion_id,user_group",
    "id,name,location,is_active,max_hooks,pavilion_id",
    "id,name,location,is_active,max_hooks",
  ]) {
    const result = await supa
      .from("cabinets")
      .select(selectClause)
      .eq("id", id)
      .maybeSingle();
    if (!result.error) {
      beforeRow = result.data;
      beforeErr = null;
      break;
    }
    beforeErr = result.error;
    if (!/user_group|pavilion_id/i.test(String(result.error?.message ?? ""))) break;
  }
  if (beforeErr) throw beforeErr;
  if (!beforeRow) throw new Error("Armoire introuvable.");

  const updates = {};
  if (patch?.name != null) {
    const name = String(patch.name).trim();
    if (!name) throw new Error("Nom d'armoire requis.");
    updates.name = name;
  }
  if (patch?.location !== undefined) {
    const location = patch.location == null ? null : String(patch.location).trim();
    updates.location = location || null;
  }
  if (patch?.is_active !== undefined) {
    updates.is_active = !!patch.is_active;
  }
  if (patch?.max_hooks !== undefined) {
    const max = Number(patch.max_hooks);
    if (!Number.isFinite(max) || max <= 0) throw new Error("Maximum de crochets invalide.");
    updates.max_hooks = Math.trunc(max);
  }
  if (patch?.pavilion_id !== undefined) {
    if (patch.pavilion_id == null || String(patch.pavilion_id).trim() === "") {
      updates.pavilion_id = null;
    } else {
      const pavilion = Number(patch.pavilion_id);
      if (!Number.isFinite(pavilion)) throw new Error("Pavillon invalide.");
      updates.pavilion_id = Math.trunc(pavilion);
    }
  }
  if (patch?.user_group !== undefined) {
    updates.user_group = normalizeGroup(patch.user_group);
  }

  const changed = {};
  for (const [k, v] of Object.entries(updates)) {
    const prev = beforeRow[k];
    if (prev !== v) changed[k] = v;
  }
  if (!Object.keys(changed).length) {
    return {
      ...beforeRow,
      pavilion_id: beforeRow?.pavilion_id ?? null,
      user_group: normalizeGroup(beforeRow?.user_group ?? "employe"),
    };
  }

  let writeUpdates = { ...changed };
  let result = await supa
    .from("cabinets")
    .update(writeUpdates)
    .eq("id", id)
    .select("id,name,location,is_active,max_hooks,pavilion_id,user_group")
    .single();

  if (result.error && /pavilion_id/i.test(String(result.error.message ?? "")) && "pavilion_id" in writeUpdates) {
    delete writeUpdates.pavilion_id;
    result = await supa
      .from("cabinets")
      .update(writeUpdates)
      .eq("id", id)
      .select("id,name,location,is_active,max_hooks")
      .single();
  }

  if (result.error && /user_group/i.test(String(result.error.message ?? "")) && "user_group" in writeUpdates) {
    delete writeUpdates.user_group;
    if (!Object.keys(writeUpdates).length) {
      return {
        ...beforeRow,
        pavilion_id: beforeRow?.pavilion_id ?? null,
        user_group: normalizeGroup(beforeRow?.user_group ?? "employe"),
      };
    }
    result = await supa
      .from("cabinets")
      .update(writeUpdates)
      .eq("id", id)
      .select("id,name,location,is_active,max_hooks,pavilion_id")
      .single();
  }

  const { data, error } = result;

  if (error) throw error;
  safeAudit({
    event_type: "cabinet_update",
    action: "cabinet_update",
    target: data?.name || `cabinet:${id}`,
    details: Object.entries(changed).map(([k, v]) => `${k}: ${String(v ?? "null")}`).join("; "),
    status: "ok",
    source: "frontend",
  });
  return {
    ...data,
    pavilion_id: data?.pavilion_id ?? null,
    user_group: normalizeGroup(data?.user_group ?? beforeRow?.user_group ?? "employe"),
  };
}

export async function getCabinetUsage(cabinetId) {
  const id = Number(cabinetId);
  if (!Number.isFinite(id)) throw new Error("cabinet_id invalide.");
  const [keysRes, keyringsRes] = await Promise.all([
    supa.from("keys").select("id", { count: "exact", head: true }).eq("cabinet_id", id),
    supa.from("keyrings").select("id", { count: "exact", head: true }).eq("cabinet_id", id),
  ]);
  if (keysRes.error) throw keysRes.error;
  if (keyringsRes.error) throw keyringsRes.error;
  return {
    keys: keysRes.count ?? 0,
    keyrings: keyringsRes.count ?? 0,
  };
}

export async function deleteCabinet(cabinetId) {
  const id = Number(cabinetId);
  if (!Number.isFinite(id)) throw new Error("cabinet_id invalide.");
  const { error } = await supa
    .from("cabinets")
    .delete()
    .eq("id", id);
  if (error) throw error;
  safeAudit({
    event_type: "cabinet_delete",
    action: "cabinet_delete",
    target: `cabinet:${id}`,
    details: "Suppression de l'armoire",
    status: "ok",
    source: "frontend",
  });
  return { ok: true, id };
}

export async function listPavilions() {
  const { data, error } = await supa
    .from("pavilions")
    .select("id,code,nom,campus,actif")
    .eq("actif", true)
    .order("campus", { ascending: true, nullsFirst: true })
    .order("code", { ascending: true, nullsFirst: true })
    .order("nom", { ascending: true, nullsFirst: true });

  if (error) throw error;
  return data ?? [];
}

export async function listKeysByCabinet(cabinetId) {
  const { data, error } = await supa
    .from("keys")
    .select("id,cabinet_id,hook_no,key_no,key_code,local,label,utilisation,remarque,pavillon,pavilion_id,departement,is_missing,updated_at,keyring_id")
    .eq("cabinet_id", cabinetId)
    .order("hook_no", { ascending: true });

  if (error) throw error;
  return data ?? [];
}


export async function listKeyringsByCabinet(cabinetId) {
  const { data, error } = await supa
    .from("keyrings")
    .select("id, cabinet_id, hook_no, ring_code, name, note")
    .eq("cabinet_id", cabinetId)
    .order("hook_no", { ascending: true })
    .order("ring_code", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

export async function listOpenLoansByKeyIds(keyIds) {
  if (!keyIds.length) return [];
  const { data, error } = await supa
    .from("loans")
    .select("id,key_id,borrower_id,loaned_at,returned_at,note")
    .in("key_id", keyIds)
    .is("returned_at", null);
  if (error) throw error;
  return data ?? [];
}

export async function listProfilesByIds(ids) {
  if (!ids.length) return [];
  let data = null;
  let error = null;
  for (const selectClause of ["id,display_name,role,user_group", "id,display_name,role"]) {
    const result = await supa
      .from("user_profiles")
      .select(selectClause)
      .in("id", ids);
    if (!result.error) {
      data = result.data;
      error = null;
      break;
    }
    error = result.error;
    if (!/user_group/i.test(String(result.error?.message ?? ""))) break;
  }
  if (error) throw error;
  return (data ?? []).map((row) => ({
    ...row,
    user_group: normalizeGroup(row?.user_group ?? "employe"),
  }));
}

export async function listUserProfiles() {
  let data = null;
  let error = null;
  for (const selectClause of ["id,display_name,role,user_group", "id,display_name,role"]) {
    const result = await supa
      .from("user_profiles")
      .select(selectClause)
      .order("display_name", { ascending: true });
    if (!result.error) {
      data = result.data;
      error = null;
      break;
    }
    error = result.error;
    if (!/user_group/i.test(String(result.error?.message ?? ""))) break;
  }
  if (error) throw error;
  return (data ?? []).map((row) => ({
    ...row,
    user_group: normalizeGroup(row?.user_group ?? "employe"),
  }));
}

export async function countPendingUsers() {
  const { count, error } = await supa
    .from("user_profiles")
    .select("id", { count: "exact", head: true })
    .eq("role", "new_user");
  if (error) throw error;
  return Number(count) || 0;
}

export async function updateUserProfileAccess(userId, role, userGroup) {
  let result = await supa
    .from("user_profiles")
    .update({ role, user_group: normalizeGroup(userGroup ?? "employe") })
    .eq("id", userId)
    .select("id,display_name,role,user_group")
    .single();

  if (result.error && /user_group/i.test(String(result.error?.message ?? ""))) {
    result = await supa
      .from("user_profiles")
      .update({ role })
      .eq("id", userId)
      .select("id,display_name,role")
      .single();
  }

  const { data, error } = result;
  if (error) throw error;
  safeAudit({
    event_type: "role_update",
    action: "role_update",
    target: data?.display_name || String(userId),
    details: `role -> ${role}; group -> ${normalizeGroup(data?.user_group ?? userGroup ?? "employe")}`,
    status: "ok",
    source: "frontend",
  });
  return {
    ...data,
    user_group: normalizeGroup(data?.user_group ?? userGroup ?? "employe"),
  };
}

export async function listMissingByKeyIds(keyIds) {
  if (!keyIds.length) return [];
  const { data, error } = await supa
    .from("keys_missing")
    .select("key_id,reported_at,reported_by")
    .in("key_id", keyIds)
    .is("found_at", null);
  if (error) throw error;
  return data ?? [];
}

export async function listLoansAll() {
  const { data, error } = await supa
    .from("loans")
    .select("id,key_id,borrower_id,loaned_at,returned_at,note")
    .order("loaned_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function listLoansByBorrower(borrowerId) {
  const { data, error } = await supa
    .from("loans")
    .select("id,key_id,borrower_id,loaned_at,returned_at,note")
    .eq("borrower_id", borrowerId)
    .order("loaned_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function listKeysByIds(ids) {
  if (!ids.length) return [];
  const { data, error } = await supa
    .from("keys")
    .select("id,cabinet_id,hook_no,key_no,local,label,utilisation,remarque,pavillon,pavilion_id,departement,is_missing,keyring_id")
    .in("id", ids);
  if (error) throw error;
  return data ?? [];
}


/* -------------------- EDGES (clÃƒÂ©s) -------------------- */

export async function fnLoanCreate(key_id, note = null) {
  const out = await callFunctionRaw("loan-create", { key_id, note });
  const ref = await getKeyRefById(key_id);
  safeAudit({
    event_type: "loan_create",
    action: "loan_create",
    target: ref ? formatKeyTarget(ref) : `key:?/?/${key_id}`,
    details: "Emprunt",
    status: "ok",
    source: "frontend",
  });
  return out;
}

export async function fnLoanReturn(loan_id) {
  const out = await callFunctionRaw("loan-return", { loan_id });
  const loanRef = await getLoanRefById(loan_id);
  const keyRef = loanRef?.key_id ? await getKeyRefById(loanRef.key_id) : null;
  safeAudit({
    event_type: "loan_return",
    action: "loan_return",
    target: keyRef ? formatKeyTarget(keyRef) : `loan:${loan_id}`,
    details: "Retour",
    status: "ok",
    source: "frontend",
  });
  return out;
}

export async function fnLoanReturnByKey(key_id) {
  const out = await callFunctionRaw("loan-return", { key_id });
  const ref = await getKeyRefById(key_id);
  safeAudit({
    event_type: "loan_return",
    action: "loan_return",
    target: ref ? formatKeyTarget(ref) : `key:?/?/${key_id}`,
    details: "Retour",
    status: "ok",
    source: "frontend",
  });
  return out;
}

export async function fnReportMissing(key_id) {
  const out = await callFunctionRaw("key-report-missing", { key_id });
  const ref = await getKeyRefById(key_id);
  safeAudit({
    event_type: "key_report_missing",
    action: "key_report_missing",
    target: ref ? formatKeyTarget(ref) : `key:?/?/${key_id}`,
    details: "",
    status: "ok",
    source: "frontend",
  });
  return out;
}

export async function fnReportFound(key_id) {
  const out = await callFunctionRaw("key-report-found", { key_id });
  const ref = await getKeyRefById(key_id);
  safeAudit({
    event_type: "key_report_found",
    action: "key_report_found",
    target: ref ? formatKeyTarget(ref) : `key:?/?/${key_id}`,
    details: "",
    status: "ok",
    source: "frontend",
  });
  return out;
}


/* -------------------- EDGES (trousseaux) -------------------- */

export async function fnLoanCreateKeyring(cabinet_id, hook_no, ring_code, note = null) {
  const out = await callFunctionRaw("loan-create-keyring", { cabinet_id, hook_no, ring_code, note });
  safeAudit({
    event_type: "loan_create",
    action: "loan_create",
    target: formatKeyringTarget({ cabinet_id, hook_no, ring_code }),
    details: "Emprunt",
    status: "ok",
    source: "frontend",
  });
  return out;
}

export async function fnLoanReturnKeyring(cabinet_id, hook_no, ring_code) {
  const out = await callFunctionRaw("loan-return-keyring", { cabinet_id, hook_no, ring_code });
  safeAudit({
    event_type: "loan_return",
    action: "loan_return",
    target: formatKeyringTarget({ cabinet_id, hook_no, ring_code }),
    details: "Retour",
    status: "ok",
    source: "frontend",
  });
  return out;
}

export async function createKeySuggestion(payload) {
  const { data, error } = await supa
    .from("key_suggestions")
    .insert(payload)
    .select("id")
    .single();
  if (error) throw error;
  const keyRef = payload?.key_id ? await getKeyRefById(payload.key_id) : null;
  safeAudit({
    event_type: "suggestion_create",
    action: "suggestion_create",
    target: keyRef
      ? formatKeyTarget(keyRef)
      : (payload?.hook_no ? formatHookTarget({ cabinet_id: payload?.cabinet_id, hook_no: payload?.hook_no }) : "general"),
    details: payload?.message || "",
    status: "ok",
    source: "frontend",
  });
  return data;
}

export async function listKeySuggestions() {
  const { data, error } = await supa
    .from("key_suggestions")
    .select("id,cabinet_id,hook_no,key_id,keyring_id,is_general,message,created_by,created_at,status,admin_note")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function countOpenSuggestions() {
  const { count, error } = await supa
    .from("key_suggestions")
    .select("id", { count: "exact", head: true })
    .in("status", ["open", "triaged"]);
  if (error) throw error;
  return count ?? 0;
}

export async function countOpenLoansByBorrower(borrowerId) {
  if (!borrowerId) return 0;
  const { count, error } = await supa
    .from("loans")
    .select("id", { count: "exact", head: true })
    .eq("borrower_id", borrowerId)
    .is("returned_at", null);
  if (error) throw error;
  return count ?? 0;
}

export async function updateKeySuggestion(id, patch) {
  const { data, error } = await supa
    .from("key_suggestions")
    .update(patch)
    .eq("id", id)
    .select("id,status,admin_note")
    .single();
  if (error) throw error;
  return data;
}

export async function listKeyringsByIds(ids) {
  if (!ids?.length) return [];
  const { data, error } = await supa
    .from("keyrings")
    .select("id,cabinet_id,hook_no,ring_code,name")
    .in("id", ids);
  if (error) throw error;
  return data ?? [];
}

export async function fnImportKeysCsv(cabinet_id, rows) {
  const out = await callFunctionRaw("keys-import-csv", {
    cabinet_id: Number(cabinet_id),
    rows,
  });
  const first = rows?.[0] ?? {};
  const firstHook = Number(first?.tag);
  const target = Number.isFinite(firstHook)
    ? formatHookTarget({ cabinet_id, hook_no: firstHook })
    : `cabinet:${cabinet_id}`;
  safeAudit({
    event_type: "key_create",
    action: "key_create",
    target,
    details: [
      `rows=${rows?.length ?? 0}`,
      `key_no=${first?.key_no ?? "-"}`,
      `local=${first?.local ?? "-"}`,
      `utilisation=${first?.utilisation ?? "-"}`,
      `remarque=${first?.remarque ?? "-"}`,
      `pavillon=${first?.pavillon ?? "-"}`,
    ].join("; "),
    status: "ok",
    source: "frontend",
  });
  return out;
}




