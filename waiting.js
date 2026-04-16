import {
  getSession,
  getMyProfile,
  isPendingApprovalRole,
  redirectToRoleHome,
  buildQrEntryRoute,
  requireSessionOrRedirect,
  signOut,
} from "./auth.js?v=20260416b";
import { ensureAuditSyncStarted, installGlobalAuditErrorHooks } from "./audit.js";

const $ = (id) => document.getElementById(id);

function setMessage(value) {
  $("waitingMsg").textContent = value ?? "";
}

function applyTheme() {
  const t = localStorage.getItem("sav_theme") === "light" ? "light" : "dark";
  document.body.dataset.theme = t;
}

function parseCabinetId(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const cabinetId = Number(raw);
  return Number.isFinite(cabinetId) ? cabinetId : null;
}

async function refreshWaitingStatus(showPendingMessage = false) {
  setMessage("Vérification des accès...");
  await requireSessionOrRedirect();

  const [session, profile] = await Promise.all([
    getSession(),
    getMyProfile(),
  ]);

  const role = profile?.role ?? "new_user";
  if (!isPendingApprovalRole(role)) {
    const params = new URLSearchParams(window.location.search);
    const mode = (params.get("mode") || "").toLowerCase();
    const cabinetId = parseCabinetId(params.get("cabinet"));
    if (mode === "qr" && cabinetId != null) {
      window.location.href = buildQrEntryRoute(cabinetId);
      return;
    }
    redirectToRoleHome(role);
    return;
  }

  $("waitingName").textContent = profile?.display_name || session?.user?.email || "Nouvel utilisateur";
  $("waitingEmail").textContent = session?.user?.email || "-";
  setMessage(showPendingMessage ? "Toujours en attente de validation." : "");
}

(() => {
  ensureAuditSyncStarted();
  installGlobalAuditErrorHooks();
  applyTheme();
})();

$("btnRefreshWaiting").addEventListener("click", async () => {
  try {
    await refreshWaitingStatus(true);
  } catch (e) {
    setMessage(e?.message ?? String(e));
  }
});

$("btnSignOutWaiting").addEventListener("click", async () => {
  await signOut();
});

refreshWaitingStatus().catch((e) => {
  setMessage(e?.message ?? String(e));
});
