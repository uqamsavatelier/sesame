import { supa } from "./supabaseClient.js";
import { SSO_DOMAIN, SSO_PROVIDER_ID } from "./supabaseClient.js";

function normalizeRole(role) {
  const raw = String(role ?? "")
    .trim()
    .toLowerCase()
    .replaceAll("-", "_")
    .replace(/\s+/g, "_");

  if (raw === "super_admin" || raw === "superadmin") return "super_admin";
  if (raw === "admin" || raw === "user" || raw === "consultant") return raw;
  return "user";
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

export async function getMyProfile() {
  const s = await getSession();
  if (!s?.user?.id) return null;

  const { data, error } = await supa
    .from("user_profiles")
    .select("id, display_name, role")
    .eq("id", s.user.id)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return {
    ...data,
    role: normalizeRole(data.role),
  };
}
