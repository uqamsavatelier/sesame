import {
  getSession,
  getMyProfile,
  isPendingApprovalRole,
  redirectToRoleHome,
  getDirectQrTarget,
  getReturnToFromUrl,
  requireSessionOrRedirect,
  signOut,
} from "./auth.js?v=20260416f";
import { ensureAuditSyncStarted, installGlobalAuditErrorHooks } from "./audit.js";

const $ = (id) => document.getElementById(id);

function setMessage(value) {
  $("waitingMsg").textContent = value ?? "";
}

function applyTheme() {
  const t = localStorage.getItem("sav_theme") === "light" ? "light" : "dark";
  document.body.dataset.theme = t;
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
    const qrTarget = getDirectQrTarget();
    if (qrTarget) {
      window.location.replace(qrTarget);
      return;
    }
    redirectToRoleHome(role, getReturnToFromUrl());
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
