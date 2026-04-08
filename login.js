import { signIn, signUp, getSession, getMyProfile, redirectToRoleHome } from "./auth.js";
import { ensureAuditSyncStarted, installGlobalAuditErrorHooks } from "./audit.js";

const $ = (id) => document.getElementById(id);
const setMessage = (value) => {
  $("msg").textContent = value;
};

(() => {
  ensureAuditSyncStarted();
  installGlobalAuditErrorHooks();
  const t = localStorage.getItem("sav_theme") === "light" ? "light" : "dark";
  document.body.dataset.theme = t;
})();

(async () => {
  const s = await getSession();
  if (!s) return;
  const profile = await getMyProfile();
  redirectToRoleHome(profile?.role ?? "new_user");
})();

async function redirectCurrentUserHome() {
  const profile = await getMyProfile();
  redirectToRoleHome(profile?.role ?? "new_user");
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

    if (!displayName) throw new Error("Le nom est requis.");
    if (!email) throw new Error("Le courriel est requis.");
    if (!password) throw new Error("Le mot de passe est requis.");
    if (password.length < 8) throw new Error("Le mot de passe doit contenir au moins 8 caractères.");

    const { data, error } = await signUp(displayName, email, password);
    if (error) throw error;

    $("email").value = email;
    $("signupPassword").value = "";

    if (data?.session) {
      await redirectCurrentUserHome();
      return;
    }

    setMessage("Compte créé. Vérifie ton courriel, puis connecte-toi. L'accès sera débloqué par un administrateur.");
  } catch (e) {
    setMessage(e?.message ?? String(e));
  }
}

$("btnLogin").addEventListener("click", doLogin);
$("btnSignup").addEventListener("click", doSignup);

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
