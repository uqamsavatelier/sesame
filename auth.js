import { supa } from "./supabaseClient.js";
import { SSO_DOMAIN, SSO_PROVIDER_ID } from "./supabaseClient.js";

function normalizeRole(role) {
  const raw = String(role ?? "")
    .trim()
    .toLowerCase()
    .replaceAll("-", "_")
    .replace(/\s+/g, "_");

  if (raw === "super_admin" || raw === "superadmin") return "super_admin";
  if (raw === "admin" || raw === "user" || raw === "consultant" || raw === "new_user") return raw;
  return "new_user";
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

function defaultDisplayNameForUser(user) {
  const metadataName = String(user?.user_metadata?.display_name ?? "").trim();
  if (metadataName) return metadataName;
  const email = String(user?.email ?? "").trim();
  const fallback = email.includes("@") ? email.split("@")[0] : email;
  return fallback || "Nouvel utilisateur";
}

function buildProfileFromUser(user, profile = null) {
  return {
    id: profile?.id ?? user?.id ?? null,
    display_name: profile?.display_name ?? defaultDisplayNameForUser(user),
    role: normalizeRole(profile?.role ?? user?.user_metadata?.role ?? "new_user"),
    user_group: normalizeGroup(profile?.user_group ?? user?.user_metadata?.user_group ?? "employe"),
  };
}

export function isPendingApprovalRole(role) {
  return normalizeRole(role) === "new_user";
}

function normalizeSafeAppRoute(target) {
  const raw = String(target ?? "").trim();
  if (!raw) return "";

  try {
    const resolved = new URL(raw, window.location.href);
    if (resolved.origin !== window.location.origin) return "";
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return "";
  }
}

function parseCabinetId(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const cabinetId = Number(raw);
  return Number.isFinite(cabinetId) ? cabinetId : null;
}

export function buildQrEntryRoute(cabinetId) {
  const parsed = parseCabinetId(cabinetId);
  // Nom historique conserve pour compatibilite; la route QR canonique pointe maintenant vers index.html.
  return parsed == null ? "./index.html" : `./index.html?mode=qr&cabinet=${parsed}`;
}

const RETURN_TO_STORAGE_KEY = "sav_return_to_after_login";
const RETURN_TO_FALLBACK_STORAGE_KEY = "sav_return_to_after_login_persist";
const QR_LOGIN_CABINET_STORAGE_KEY = "sav_qr_login_cabinet";

function extractQrRoute(target) {
  const safeTarget = normalizeSafeAppRoute(target);
  if (!safeTarget) return "";

  try {
    const resolved = new URL(safeTarget, window.location.origin);
    const pathname = resolved.pathname.toLowerCase();
    const mode = (resolved.searchParams.get("mode") || "").toLowerCase();
    const cabinetId = parseCabinetId(resolved.searchParams.get("cabinet"));
    const isQrTarget = mode === "qr" || pathname.endsWith("/qr-entry.html") || pathname.endsWith("qr-entry.html");
    if (!isQrTarget || cabinetId == null) return "";
    return normalizeSafeAppRoute(buildQrEntryRoute(cabinetId));
  } catch {
    return "";
  }
}

function savePendingQrCabinetFromTarget(target) {
  const qrRoute = extractQrRoute(target);
  if (!qrRoute) return null;
  try {
    const qrUrl = new URL(qrRoute, window.location.origin);
    const cabinetId = parseCabinetId(qrUrl.searchParams.get("cabinet"));
    if (cabinetId == null) return null;
    localStorage.setItem(QR_LOGIN_CABINET_STORAGE_KEY, String(cabinetId));
    return cabinetId;
  } catch {
    return null;
  }
}

export function getPendingQrCabinetId() {
  try {
    return parseCabinetId(localStorage.getItem(QR_LOGIN_CABINET_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function rememberQrCabinet(cabinetId) {
  const parsed = parseCabinetId(cabinetId);
  if (parsed == null) return "";
  const qrRoute = normalizeSafeAppRoute(buildQrEntryRoute(parsed));
  if (!qrRoute) return "";
  savePendingReturnTo(qrRoute);
  try {
    localStorage.setItem(QR_LOGIN_CABINET_STORAGE_KEY, String(parsed));
  } catch {}
  return qrRoute;
}

export function clearPendingQrCabinetId() {
  try {
    localStorage.removeItem(QR_LOGIN_CABINET_STORAGE_KEY);
  } catch {}
}

function savePendingReturnTo(target) {
  const safeTarget = normalizeSafeAppRoute(target);
  if (!safeTarget) return "";
  try {
    sessionStorage.setItem(RETURN_TO_STORAGE_KEY, safeTarget);
  } catch {}
  try {
    localStorage.setItem(RETURN_TO_FALLBACK_STORAGE_KEY, safeTarget);
  } catch {}
  return safeTarget;
}

function readPendingReturnTo() {
  try {
    const fromSession = normalizeSafeAppRoute(sessionStorage.getItem(RETURN_TO_STORAGE_KEY));
    if (fromSession) return fromSession;
  } catch {}
  try {
    return normalizeSafeAppRoute(localStorage.getItem(RETURN_TO_FALLBACK_STORAGE_KEY));
  } catch {
    return "";
  }
}

function clearPendingReturnTo() {
  try {
    sessionStorage.removeItem(RETURN_TO_STORAGE_KEY);
  } catch {}
  try {
    localStorage.removeItem(RETURN_TO_FALLBACK_STORAGE_KEY);
  } catch {}
}

function buildLoginRoute(returnTo = "") {
  const loginUrl = new URL("./login.html", window.location.href);
  const safeReturnTo = savePendingReturnTo(returnTo);
  const qrCabinetId = savePendingQrCabinetFromTarget(safeReturnTo);
  if (safeReturnTo) loginUrl.searchParams.set("returnTo", safeReturnTo);
  if (qrCabinetId != null) {
    loginUrl.searchParams.set("mode", "qr");
    loginUrl.searchParams.set("cabinet", String(qrCabinetId));
  }
  return loginUrl.toString();
}

export function getHomeRouteForRole(role) {
  return isPendingApprovalRole(role) ? "./waiting.html" : "./index.html";
}

export function buildWaitingRoute(cabinetId = null) {
  const parsed = parseCabinetId(cabinetId);
  return parsed == null ? "./waiting.html" : `./waiting.html?mode=qr&cabinet=${parsed}`;
}

export function getReturnToFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = normalizeSafeAppRoute(params.get("returnTo"));
  if (fromQuery) {
    savePendingReturnTo(fromQuery);
    return fromQuery;
  }
  const qrMode = (params.get("mode") || "").toLowerCase();
  const qrCabinetId = parseCabinetId(params.get("cabinet"));
  if (qrMode === "qr" && qrCabinetId != null) {
    const qrRoute = rememberQrCabinet(qrCabinetId);
    if (qrRoute) {
      return qrRoute;
    }
  }
  return readPendingReturnTo();
}

export function getDirectQrTarget() {
  const params = new URLSearchParams(window.location.search);
  const mode = (params.get("mode") || "").toLowerCase();
  const cabinetFromQuery = parseCabinetId(params.get("cabinet"));
  if (cabinetFromQuery != null) {
    return rememberQrCabinet(cabinetFromQuery) || buildQrEntryRoute(cabinetFromQuery);
  }

  const returnTo = getReturnToFromUrl();
  const qrRouteFromReturnTo = extractQrRoute(returnTo);
  if (qrRouteFromReturnTo) {
    savePendingQrCabinetFromTarget(qrRouteFromReturnTo);
    return qrRouteFromReturnTo;
  }

  const pendingCabinetId = getPendingQrCabinetId();
  if (pendingCabinetId != null && (mode === "qr" || !!returnTo)) {
    return rememberQrCabinet(pendingCabinetId) || buildQrEntryRoute(pendingCabinetId);
  }

  return "";
}

export function redirectToRoleHome(role, returnTo = "") {
  const fallback = getHomeRouteForRole(role);
  const safeReturnTo = normalizeSafeAppRoute(returnTo) || readPendingReturnTo();
  const qrCabinetId = getPendingQrCabinetId();
  const qrFallback = qrCabinetId != null
    ? normalizeSafeAppRoute(buildQrEntryRoute(qrCabinetId))
    : "";
  const waitingQrFallback = qrCabinetId != null
    ? normalizeSafeAppRoute(buildWaitingRoute(qrCabinetId))
    : "";
  const target = isPendingApprovalRole(role)
    ? (waitingQrFallback || fallback)
    : (safeReturnTo || qrFallback || fallback);
  if (!isPendingApprovalRole(role)) {
    clearPendingReturnTo();
    clearPendingQrCabinetId();
  }
  window.location.href = target;
}

function inferDomainFromEmail(email) {
  const value = String(email ?? "").trim().toLowerCase();
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) return "";
  return value.slice(at + 1);
}

export async function getSession() {
  const { data } = await supa.auth.getSession();
  return data?.session ?? null;
}

export async function requireSessionOrRedirect() {
  const s = await getSession();
  if (!s) window.location.href = buildLoginRoute(window.location.pathname + window.location.search + window.location.hash);
  return s;
}

export async function signIn(email, password) {
  return await supa.auth.signInWithPassword({ email, password });
}

export async function signUp(displayName, email, password, emailRedirectTo = "") {
  return await supa.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: String(emailRedirectTo ?? "").trim() || undefined,
      data: {
        display_name: String(displayName ?? "").trim(),
        role: "new_user",
        user_group: "employe",
      },
    },
  });
}

export async function signInWithCompanySSO({ email, redirectTo } = {}) {
  const providerId = String(SSO_PROVIDER_ID ?? "").trim();
  const configuredDomain = String(SSO_DOMAIN ?? "").trim().toLowerCase();
  const emailDomain = inferDomainFromEmail(email);
  const domain = configuredDomain || emailDomain;

  if (!providerId && !domain) {
    throw new Error("SSO non configur\u00e9: renseigne SSO_PROVIDER_ID ou SSO_DOMAIN dans supabaseClient.js");
  }

  const payload = {
    options: {
      redirectTo: redirectTo || new URL("./index.html", window.location.href).toString(),
    },
  };

  if (providerId) payload.providerId = providerId;
  else payload.domain = domain;

  return await supa.auth.signInWithSSO(payload);
}

export async function signOut() {
  await supa.auth.signOut();
  clearPendingReturnTo();
  clearPendingQrCabinetId();
  window.location.href = "./login.html";
}

export async function signOutSilently() {
  await supa.auth.signOut();
  clearPendingReturnTo();
  clearPendingQrCabinetId();
}

const PENDING_USERS_ALERT_KEY = "sav_pending_users_last_seen";

export function notifyAdminAboutPendingUsers(count) {
  const next = Math.max(0, Number(count) || 0);
  const previous = Math.max(0, Number(localStorage.getItem(PENDING_USERS_ALERT_KEY) || "0"));

  if (next > previous) {
    const delta = next - previous;
    const suffix = delta > 1 ? "s" : "";
    const totalSuffix = next > 1 ? "s" : "";
    window.alert(
      `${delta} nouveau${suffix} compte${suffix} en attente.\n\n` +
      `Il y a maintenant ${next} utilisateur${totalSuffix} avec le rôle new_user à traiter dans Configuration > Utilisateurs.`
    );
  }

  localStorage.setItem(PENDING_USERS_ALERT_KEY, String(next));
}

export async function getMyProfile() {
  const s = await getSession();
  if (!s?.user?.id) return null;

  let data = null;
  let error = null;
  for (const selectClause of ["id, display_name, role, user_group", "id, display_name, role"]) {
    const result = await supa
      .from("user_profiles")
      .select(selectClause)
      .eq("id", s.user.id)
      .maybeSingle();
    if (!result.error) {
      data = result.data;
      error = null;
      break;
    }
    error = result.error;
    if (!/user_group/i.test(String(result.error?.message ?? ""))) break;
  }

  if (error) throw error;
  if (data) return buildProfileFromUser(s.user, data);

  const fallbackProfile = buildProfileFromUser(s.user);
  try {
    let result = await supa
      .from("user_profiles")
      .upsert({
        id: s.user.id,
        display_name: fallbackProfile.display_name,
        role: "new_user",
        user_group: fallbackProfile.user_group,
      }, { onConflict: "id" })
      .select("id, display_name, role, user_group")
      .single();

    if (result.error && /user_group/i.test(String(result.error?.message ?? ""))) {
      result = await supa
        .from("user_profiles")
        .upsert({
          id: s.user.id,
          display_name: fallbackProfile.display_name,
          role: "new_user",
        }, { onConflict: "id" })
        .select("id, display_name, role")
        .single();
    }

    const { data: created, error: createError } = result;

    if (createError) throw createError;
    return buildProfileFromUser(s.user, created);
  } catch {
    return fallbackProfile;
  }
}
