import {
  signIn,
  signUp,
  getSession,
  getMyProfile,
  redirectToRoleHome,
  signOutSilently,
  getReturnToFromUrl,
  getPendingQrCabinetId,
  clearPendingQrCabinetId,
} from "./auth.js?v=20260415g";
import { ensureAuditSyncStarted, installGlobalAuditErrorHooks } from "./audit.js";
import { APP_LOGIN_URL } from "./supabaseClient.js";

const $ = (id) => document.getElementById(id);
const setMessage = (value) => {
  $("msg").textContent = value;
};

function setSignupPanelOpen(open) {
  $("signupPanel").hidden = !open;
  $("btnShowSignup").hidden = !!open;
  if (open) $("signupDisplayName")?.focus();
}

(() => {
  ensureAuditSyncStarted();
  installGlobalAuditErrorHooks();
  const t = localStorage.getItem("sav_theme") === "light" ? "light" : "dark";
  document.body.dataset.theme = t;
})();

function parseCabinetId(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const cabinetId = Number(raw);
  return Number.isFinite(cabinetId) ? cabinetId : null;
}

function getDirectQrTarget() {
  const params = new URLSearchParams(window.location.search);
  const mode = (params.get("mode") || "").toLowerCase();
  const cabinetFromQuery = parseCabinetId(params.get("cabinet"));
  const cabinetId = cabinetFromQuery ?? getPendingQrCabinetId();
  if (mode !== "qr" && cabinetFromQuery == null && cabinetId == null) return "";
  return cabinetId != null ? `./index.html?mode=qr&cabinet=${cabinetId}` : "";
}

function redirectAfterLogin(role) {
  const qrTarget = getDirectQrTarget();
  if (qrTarget && String(role ?? "").toLowerCase() !== "new_user") {
    clearPendingQrCabinetId();
    window.location.href = qrTarget;
    return;
  }
  redirectToRoleHome(role, getReturnToFromUrl());
}

(async () => {
  const s = await getSession();
  if (!s) return;
  const profile = await getMyProfile();
  redirectAfterLogin(profile?.role ?? "new_user");
})();

async function redirectCurrentUserHome() {
  const profile = await getMyProfile();
  redirectAfterLogin(profile?.role ?? "new_user");
}

async function doLogin() {
  setMessage("Connexion...");
  try {
    const email = $("email").value.trim();
    const password = $("password").value;
    const { error } = await signIn(email, password);
    if (error) throw error;
    await redirectCurrentUserHome();
  } catch (e) {
    setMessage(e?.message ?? String(e));
  }
}

async function doSignup() {
  setMessage("Création du compte...");
  try {
    const displayName = $("signupDisplayName").value.trim();
    const email = $("signupEmail").value.trim();
    const password = $("signupPassword").value;
    const emailRedirectTo = APP_LOGIN_URL;

    if (!displayName) throw new Error("Le nom est requis.");
    if (!email) throw new Error("Le courriel est requis.");
    if (!password) throw new Error("Le mot de passe est requis.");
    if (password.length < 8) throw new Error("Le mot de passe doit contenir au moins 8 caractères.");

    const { data, error } = await signUp(displayName, email, password, emailRedirectTo);
    if (error) throw error;

    if (data?.session) await signOutSilently();
    window.location.href = "./signup-success.html";
  } catch (e) {
    setMessage(e?.message ?? String(e));
  }
}

$("btnLogin").addEventListener("click", doLogin);
$("btnShowSignup").addEventListener("click", () => {
  setMessage("");
  setSignupPanelOpen(true);
});
$("btnSignup").addEventListener("click", doSignup);
$("btnCancelSignup").addEventListener("click", () => {
  $("signupDisplayName").value = "";
  $("signupEmail").value = "";
  $("signupPassword").value = "";
  setMessage("");
  setSignupPanelOpen(false);
});

["email", "password"].forEach((id) => {
  $(id).addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    doLogin();
  });
});

["signupDisplayName", "signupEmail", "signupPassword"].forEach((id) => {
  $(id).addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    doSignup();
  });
});

function bindPasswordToggle(buttonId, inputId) {
  const input = $(inputId);
  const button = $(buttonId);
  button?.addEventListener("click", () => {
    const reveal = input.type === "password";
    input.type = reveal ? "text" : "password";
    button.classList.toggle("is-visible", reveal);
    button.setAttribute(
      "aria-label",
      reveal ? "Masquer le mot de passe" : "Afficher le mot de passe",
    );
  });
}

bindPasswordToggle("togglePassword", "password");
bindPasswordToggle("toggleSignupPassword", "signupPassword");
