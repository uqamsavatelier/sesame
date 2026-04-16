import {
  getSession,
  getMyProfile,
  isPendingApprovalRole,
  buildQrEntryRoute,
  buildWaitingRoute,
  rememberQrCabinet,
} from "./auth.js?v=20260416e";
import { ensureAuditSyncStarted, installGlobalAuditErrorHooks } from "./audit.js";

const $ = (id) => document.getElementById(id);

function parseCabinetId(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const cabinetId = Number(raw);
  return Number.isFinite(cabinetId) ? cabinetId : null;
}

function setStatus(title, text, message = "") {
  $("qrEntryTitle").textContent = title;
  $("qrEntryText").textContent = text;
  $("qrEntryMsg").textContent = message;
}

function setRetryVisible(visible) {
  $("qrEntryRetry").hidden = !visible;
}

function buildLoginRoute(cabinetId) {
  const loginUrl = new URL("./login.html", window.location.href);
  loginUrl.searchParams.set("mode", "qr");
  loginUrl.searchParams.set("cabinet", String(cabinetId));
  loginUrl.searchParams.set("returnTo", buildQrEntryRoute(cabinetId));
  return loginUrl.toString();
}

async function routeQrEntry() {
  const cabinetId = parseCabinetId(new URLSearchParams(window.location.search).get("cabinet"));
  if (cabinetId == null) {
    setRetryVisible(false);
    setStatus(
      "Armoire introuvable",
      "Le code QR est incomplet.",
      "Ajoute ?cabinet=# au lien du QR ou rescane l'étiquette.",
    );
    return;
  }

  rememberQrCabinet(cabinetId);
  setRetryVisible(false);
  setStatus(
    "Armoire détectée",
    `Préparation de l'accès à l'armoire ${cabinetId}.`,
    "",
  );

  const session = await getSession();
  if (!session) {
    setStatus(
      "Connexion requise",
      "Redirection vers la page de connexion.",
      "",
    );
    window.location.replace(buildLoginRoute(cabinetId));
    return;
  }

  const profile = await getMyProfile();
  const role = profile?.role ?? "new_user";

  if (isPendingApprovalRole(role)) {
    setStatus(
      "Validation en attente",
      "Redirection vers la salle d'attente.",
      "",
    );
    window.location.replace(buildWaitingRoute(cabinetId));
    return;
  }

  setStatus(
    "Ouverture de l'armoire",
    "Redirection vers l'armoire scannée.",
    "",
  );
  window.location.replace(buildQrEntryRoute(cabinetId));
}

(() => {
  ensureAuditSyncStarted();
  installGlobalAuditErrorHooks();
  const t = localStorage.getItem("sav_theme") === "light" ? "light" : "dark";
  document.body.dataset.theme = t;
})();

$("qrEntryRetry").addEventListener("click", () => {
  routeQrEntry().catch((e) => {
    setRetryVisible(true);
    setStatus("Impossible de continuer", "La redirection a échoué.", e?.message ?? String(e));
  });
});

routeQrEntry().catch((e) => {
  setRetryVisible(true);
  setStatus("Impossible de continuer", "La redirection a échoué.", e?.message ?? String(e));
});
