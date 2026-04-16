import { getSession, getReturnToFromUrl, redirectToRoleHome } from "./auth.js?v=20260416g";

const $ = (id) => document.getElementById(id);

(() => {
  const t = localStorage.getItem("sav_theme") === "light" ? "light" : "dark";
  document.body.dataset.theme = t;
})();

async function resolveNextTarget() {
  const session = await getSession();
  if (session) {
    return {
      label: "Redirection vers la salle d'attente dans",
      go() {
        redirectToRoleHome("new_user", getReturnToFromUrl());
      },
    };
  }

  return {
    label: "Retour a la page de connexion dans",
    go() {
      window.location.href = "./login.html";
    },
  };
}

let remaining = 10;
const countdownEl = $("countdownValue");
const countdownLabelEl = $("countdownLabel");

resolveNextTarget().then((target) => {
  if (countdownLabelEl) countdownLabelEl.textContent = target.label;

  const timer = setInterval(() => {
    remaining -= 1;
    if (countdownEl) countdownEl.textContent = String(Math.max(remaining, 0));
    if (remaining > 0) return;
    clearInterval(timer);
    target.go();
  }, 1000);
}).catch(() => {
  const timer = setInterval(() => {
    remaining -= 1;
    if (countdownEl) countdownEl.textContent = String(Math.max(remaining, 0));
    if (remaining > 0) return;
    clearInterval(timer);
    window.location.href = "./login.html";
  }, 1000);
});
