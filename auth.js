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

export function getHomeRouteForRole(role) {
  return isPendingApprovalRole(role) ? "./waiting.html" : "./index.html";
}

export function redirectToRoleHome(role) {
  window.location.href = getHomeRouteForRole(role);
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
  if (!s) window.location.href = "./login.html";
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
  window.location.href = "./login.html";
}

export async function signOutSilently() {
  await supa.auth.signOut();
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
