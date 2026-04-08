import { signIn, signInWithCompanySSO, getSession } from "./auth.js";
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
  if (s) window.location.href = "./index.html";
})();

async function doLogin() {
  setMessage("Connexion...");
  try {
    const email = $("email").value.trim();
    const password = $("password").value;
    const { error } = await signIn(email, password);
    if (error) throw error;
    window.location.href = "./index.html";
  } catch (e) {
    setMessage(e?.message ?? String(e));
  }
}

$("btnLogin").addEventListener("click", doLogin);

$("btnSso").addEventListener("click", async () => {
  setMessage("Redirection SSO...");
  try {
    const email = $("email").value.trim();
    const redirectTo = new URL("./index.html", window.location.href).toString();
    const { error } = await signInWithCompanySSO({ email, redirectTo });
    if (error) throw error;
  } catch (e) {
    setMessage(e?.message ?? String(e));
  }
});

["email", "password"].forEach((id) => {
  $(id).addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    doLogin();
  });
});

const passwordInput = $("password");
const togglePassword = $("togglePassword");
togglePassword?.addEventListener("click", () => {
  const reveal = passwordInput.type === "password";
  passwordInput.type = reveal ? "text" : "password";
  togglePassword.classList.toggle("is-visible", reveal);
  togglePassword.setAttribute(
    "aria-label",
    reveal ? "Masquer le mot de passe" : "Afficher le mot de passe",
  );
});
