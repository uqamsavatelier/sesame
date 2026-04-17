import {
  signIn,
  signUp,
  getSession,
  getMyProfile,
  redirectToRoleHome,
  getReturnToFromUrl,
  getDirectQrTarget,
} from "./auth.js?v=20260416g";
import { ensureAuditSyncStarted, installGlobalAuditErrorHooks } from "./audit.js";
import { APP_LOGIN_URL } from "./supabaseClient.js";

const $ = (id) => document.getElementById(id);
const setMessage = (value) => {
  $("msg").textContent = value;
};
const LOGIN_TUTORIAL_BASE_PATHS = ["./Démo", "./ressources/Démo"];
const LOGIN_TUTORIAL_FOLDER = "Creer-compte";
const LOGIN_TUTORIAL_STEP_COUNT = 11;
let loginTutorialSlides = [];
let loginTutorialIndex = 0;

function setLoginTutorialOpen(open) {
  $("loginTutorialOverlay").hidden = !open;
  $("loginTutorialModal").hidden = !open;
  $("loginTutorialModal").setAttribute("aria-hidden", open ? "false" : "true");
  document.body.classList.toggle("tutorial-open", open);
}

function probeImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = encodeURI(url);
  });
}

async function resolveLoginTutorialBasePath() {
  for (const basePath of LOGIN_TUTORIAL_BASE_PATHS) {
    if (await probeImage(`${basePath}/${LOGIN_TUTORIAL_FOLDER}/step1.jpg`)) return basePath;
  }
  return LOGIN_TUTORIAL_BASE_PATHS[0];
}

async function buildLoginTutorialSlides() {
  const basePath = await resolveLoginTutorialBasePath();
  const slides = [];
  for (let stepNo = 1; stepNo <= LOGIN_TUTORIAL_STEP_COUNT; stepNo += 1) {
    const baseImage = `${basePath}/${LOGIN_TUTORIAL_FOLDER}/step${stepNo}.jpg`;
    if (await probeImage(baseImage)) slides.push(baseImage);
    for (let variant = 1; variant <= 12; variant += 1) {
      const variantImage = `${basePath}/${LOGIN_TUTORIAL_FOLDER}/step${stepNo}-tx${variant}.jpg`;
      if (!(await probeImage(variantImage))) break;
      slides.push(variantImage);
    }
  }
  return slides;
}

function renderLoginTutorial() {
  const image = $("loginTutorialImage");
  const nextBtn = $("loginTutorialNext");
  if (!image || !nextBtn) return;
  const current = loginTutorialSlides[loginTutorialIndex];
  if (!current) {
    image.hidden = true;
    image.removeAttribute("src");
    image.alt = "";
    nextBtn.hidden = true;
    return;
  }
  image.hidden = false;
  image.src = encodeURI(current);
  image.alt = `Créer un compte — image ${loginTutorialIndex + 1}`;
  nextBtn.hidden = false;
  nextBtn.textContent = loginTutorialIndex >= loginTutorialSlides.length - 1 ? "Fermer" : "Suivant";
}

async function openLoginTutorial() {
  setMessage("");
  loginTutorialSlides = [];
  loginTutorialIndex = 0;
  setLoginTutorialOpen(true);
  renderLoginTutorial();
  loginTutorialSlides = await buildLoginTutorialSlides();
  loginTutorialIndex = 0;
  renderLoginTutorial();
}

function closeLoginTutorial() {
  loginTutorialSlides = [];
  loginTutorialIndex = 0;
  setLoginTutorialOpen(false);
  const image = $("loginTutorialImage");
  if (image) {
    image.removeAttribute("src");
    image.alt = "";
    image.hidden = true;
  }
}

function nextLoginTutorialSlide() {
  if (!loginTutorialSlides.length) {
    closeLoginTutorial();
    return;
  }
  if (loginTutorialIndex >= loginTutorialSlides.length - 1) {
    closeLoginTutorial();
    return;
  }
  loginTutorialIndex += 1;
  renderLoginTutorial();
}

function setSignupPanelOpen(open) {
  $("signupPanel").hidden = !open;
  $("btnShowSignup").hidden = !!open;
  $("btnSignupHelp").hidden = !!open;
  if (open) $("signupDisplayName")?.focus();
}

(() => {
  ensureAuditSyncStarted();
  installGlobalAuditErrorHooks();
  const t = localStorage.getItem("sav_theme") === "light" ? "light" : "dark";
  document.body.dataset.theme = t;
})();

function redirectAfterLogin(role) {
  const qrTarget = getDirectQrTarget();
  if (qrTarget && String(role ?? "").toLowerCase() !== "new_user") {
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

async function waitForSession(maxAttempts = 10, delayMs = 150) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const session = await getSession();
    if (session) return session;
    await new Promise((resolve) => window.setTimeout(resolve, delayMs));
  }
  return null;
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

    let session = data?.session ?? await waitForSession();
    if (!session) {
      const { error: signInError } = await signIn(email, password);
      if (!signInError) session = await waitForSession(12, 200);
    }

    window.location.href = session
      ? "./signup-success.html?next=waiting"
      : "./signup-success.html?next=login";
  } catch (e) {
    setMessage(e?.message ?? String(e));
  }
}

$("btnLogin").addEventListener("click", doLogin);
$("btnShowSignup").addEventListener("click", () => {
  setMessage("");
  setSignupPanelOpen(true);
});
$("btnSignupHelp").addEventListener("click", () => {
  void openLoginTutorial();
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

$("loginTutorialClose").addEventListener("click", closeLoginTutorial);
$("loginTutorialOverlay").addEventListener("click", closeLoginTutorial);
$("loginTutorialNext").addEventListener("click", nextLoginTutorialSlide);

document.addEventListener("keydown", (event) => {
  if ($("loginTutorialModal").hidden) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeLoginTutorial();
    return;
  }
  if (event.key === "ArrowRight") {
    event.preventDefault();
    nextLoginTutorialSlide();
  }
});
