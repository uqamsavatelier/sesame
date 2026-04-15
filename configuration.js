import { supa } from "./supabaseClient.js";
import { requireSessionOrRedirect, getMyProfile, signOut, isPendingApprovalRole, redirectToRoleHome, notifyAdminAboutPendingUsers } from "./auth.js";
import {
  listUserProfiles,
  updateUserProfileAccess,
  countOpenSuggestions,
  countOpenLoansByBorrower,
  countPendingUsers,
} from "./api.js";
import {
  getAllAuditTypes,
  listAuditEvents,
  formatAuditDateTimeQuebec,
  getQuebecDateToken,
  ensureAuditSyncStarted,
  installGlobalAuditErrorHooks,
} from "./audit.js";

const $ = (id) => document.getElementById(id);

const ROLE_OPTIONS = ["new_user", "user", "consultant", "admin"];
const KNOWN_ROLES = ["super_admin", ...ROLE_OPTIONS];
const GROUP_OPTIONS = ["employe", "direction", "affichage"];
const MATRIX_ROLES = ["new_user", "user", "consultant", "admin"];
const MATRIX_ACTION_KEYS = [
  "consultation",
  "signalement",
  "suggestion",
  "emprunt",
  "retour",
  "edition",
  "deplacement",
  "creation",
  "suppression",
];
const MATRIX_ROWS = [
  { label: "Consultation", keys: ["consultation"] },
  { label: "Signalements et suggestions", keys: ["signalement", "suggestion"] },
  { label: "Emprunts et retours", keys: ["emprunt", "retour"] },
  { label: "Édition et déplacement", keys: ["edition", "deplacement"] },
  { label: "Création et suppression", keys: ["creation", "suppression"] },
];

const AUDIT_GROUPS_BASE = [
  { id: "role_updates", label: "Mise à jour des rôles", types: ["role_update"] },
  { id: "loans", label: "Prêts", types: ["loan_create", "loan_return"] },
  { id: "reports", label: "Signalement", types: ["key_report_missing", "key_report_found"] },
  { id: "moves", label: "Déplacements", types: ["key_move", "keyring_move"] },
  { id: "creates", label: "Création", types: ["key_create", "keyring_create", "cabinet_create"] },
  { id: "deletes", label: "Suppressions", types: ["key_delete", "keyring_delete", "cabinet_delete"] },
  { id: "updates", label: "Modifications", types: ["key_update", "keyring_update", "cabinet_update"] },
  { id: "suggestions", label: "Suggestions", types: ["suggestion_create", "suggestion_update"] },
  { id: "errors", label: "Erreurs", types: ["system_comm_error"] },
];

const DEFAULT_MATRIX = {
  new_user: {
    consultation: false,
    emprunt: false,
    retour: false,
    signalement: false,
    suggestion: false,
    edition: false,
    suppression: false,
    deplacement: false,
    creation: false,
  },
  admin: {
    consultation: true,
    emprunt: true,
    retour: true,
    signalement: true,
    suggestion: true,
    edition: true,
    suppression: true,
    deplacement: true,
    creation: true,
  },
  user: {
    consultation: true,
    emprunt: true,
    retour: true,
    signalement: true,
    suggestion: true,
    edition: false,
    suppression: false,
    deplacement: false,
    creation: false,
  },
  consultant: {
    consultation: true,
    emprunt: false,
    retour: false,
    signalement: true,
    suggestion: true,
    edition: false,
    suppression: false,
    deplacement: false,
    creation: false,
  },
};

function cloneDefaultMatrix() {
  return JSON.parse(JSON.stringify(DEFAULT_MATRIX));
}

const state = {
  profile: null,
  role: "new_user",
  suggestionCount: 0,
  pendingUserCount: 0,
  myOpenLoanCount: 0,
  users: [],
  editingUserId: null,
  usersFilter: "",
  roleMatrix: cloneDefaultMatrix(),
  roleMatrixInitial: cloneDefaultMatrix(),
  roleMatrixDirty: false,
  roleMatrixAvailable: true,
  auditEvents: [],
  auditTypes: getAllAuditTypes(),
  auditGroups: [],
  auditSelectedGroups: new Set(),
  auditArchiveFiles: [],
};

const statusTimers = new Map();

function setStatus(id, message, clearAfterMs = 0) {
  const el = $(id);
  if (!el) return;
  el.textContent = message ?? "";

  const existing = statusTimers.get(id);
  if (existing) clearTimeout(existing);
  statusTimers.delete(id);

  if (clearAfterMs > 0 && message) {
    const timer = setTimeout(() => {
      const target = $(id);
      if (target && target.textContent === message) target.textContent = "";
      statusTimers.delete(id);
    }, clearAfterMs);
    statusTimers.set(id, timer);
  }
}

function normalizeRole(role) {
  const r = String(role ?? "").trim().toLowerCase();
  if (KNOWN_ROLES.includes(r)) return r;
  return "new_user";
}

function normalizeGroup(group) {
  const value = String(group ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replaceAll("-", "_")
    .replace(/\s+/g, "_");
  if (value === "direction") return "direction";
  if (value === "affichage") return "affichage";
  return "employe";
}

function isAdminRole(role) {
  const r = normalizeRole(role);
  return r === "admin" || r === "super_admin";
}

function roleLabel(role) {
  return role === "super_admin" ? "Super-admin"
    : role === "admin" ? "Administrateur"
    : role === "consultant" ? "Consultant"
    : role === "new_user" ? "Salle d'attente"
    : "Utilisateur";
}

function groupLabel(group) {
  const g = normalizeGroup(group);
  return g === "direction" ? "Direction"
    : g === "affichage" ? "Affichage"
    : "Employé";
}

function canEditUserAccess(user) {
  if (state.role === "super_admin") return true;
  if (!isAdminRole(state.role)) return false;
  const sameGroup = normalizeGroup(user?.user_group) === normalizeGroup(state.profile?.user_group);
  return sameGroup || normalizeRole(user?.role) === "new_user";
}

function buildRoleOptions(currentRole) {
  return ROLE_OPTIONS.map((role) => {
    const selected = role === normalizeRole(currentRole) ? " selected" : "";
    return `<option value="${role}"${selected}>${escapeHtml(roleLabel(role))}</option>`;
  }).join("");
}

function buildGroupOptions(currentGroup, { allowAllGroups = false } = {}) {
  const allowedGroups = allowAllGroups ? GROUP_OPTIONS : [normalizeGroup(state.profile?.user_group)];
  return allowedGroups.map((group) => {
    const selected = group === normalizeGroup(currentGroup) ? " selected" : "";
    return `<option value="${group}"${selected}>${escapeHtml(groupLabel(group))}</option>`;
  }).join("");
}

function visibleUsersForCurrentAdmin() {
  return state.users.filter((user) => {
    if (normalizeRole(user.role) === "super_admin") return false;
    if (state.role === "super_admin") return true;
    if (!isAdminRole(state.role)) return false;
    return normalizeGroup(user.user_group) === normalizeGroup(state.profile?.user_group)
      || normalizeRole(user.role) === "new_user";
  });
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toPositiveInt(value) {
  const n = Number(String(value ?? "").trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

function cloneRoleMatrix(matrix) {
  return JSON.parse(JSON.stringify(matrix ?? cloneDefaultMatrix()));
}

function isSameRoleMatrix(a, b) {
  for (const role of MATRIX_ROLES) {
    for (const action of MATRIX_ACTION_KEYS) {
      const av = !!a?.[role]?.[action];
      const bv = !!b?.[role]?.[action];
      if (av !== bv) return false;
    }
  }
  return true;
}

function updateRoleMatrixActionsState() {
  const saveBtn = $("saveRoleMatrix");
  const cancelBtn = $("cancelRoleMatrix");
  const canInteract = !!state.roleMatrixAvailable;
  const hasChanges = !!state.roleMatrixDirty;
  if (saveBtn) saveBtn.disabled = !canInteract || !hasChanges;
  if (cancelBtn) cancelBtn.disabled = !canInteract || !hasChanges;
}

function refreshRoleMatrixDirtyState() {
  state.roleMatrixDirty = !isSameRoleMatrix(state.roleMatrix, state.roleMatrixInitial);
  updateRoleMatrixActionsState();
}

function applyTheme() {
  const t = localStorage.getItem("sav_theme");
  document.body.dataset.theme = t === "light" ? "light" : "dark";
}

let themeBound = false;
function bindThemeToggle() {
  if (themeBound) return;
  themeBound = true;
  const seg = $("themeSeg");
  if (!seg) return;
  seg.addEventListener("click", (e) => {
    const btn = e.target.closest("button.seg-btn");
    if (!btn) return;
    const current = seg.dataset.theme === "light" ? "light" : "dark";
    const theme = current === "light" ? "dark" : "light";
    localStorage.setItem("sav_theme", theme);
    applyTheme();
    seg.dataset.theme = theme;
  });
}

function buildNavLinks(role) {
  if (role === "super_admin") {
    return [
      { label: "Clés", href: "./index.html" },
      { label: "Emprunts", href: "./loans.html" },
      { label: "Suggestions", href: "./suggestions.html", badge: Number(state.suggestionCount) || 0 },
      { label: "Configuration", href: "./configuration.html" },
      { label: "Déconnexion", action: "logout", danger: true },
    ];
  }
  if (isAdminRole(role)) {
    return [
      { label: "Clés", href: "./index.html" },
      { label: "Emprunts", href: "./loans.html" },
      { label: "Suggestions", href: "./suggestions.html", badge: Number(state.suggestionCount) || 0 },
      { label: "Journal d'audit", href: "./configuration.html" },
      { label: "Déconnexion", action: "logout", danger: true },
    ];
  }
  if (role === "new_user") {
    return [
      { label: "Salle d'attente", href: "./waiting.html" },
      { label: "Déconnexion", action: "logout", danger: true },
    ];
  }
  if (role === "consultant") {
    return [
      { label: "Liste des clés", href: "./index.html" },
      { label: "Déconnexion", action: "logout", danger: true },
    ];
  }
  return [
    { label: "Liste des clés", href: "./index.html?mode=browse" },
    { label: `Mes emprunts (${Number(state.myOpenLoanCount) || 0})`, href: "./my-loans.html" },
    { label: "Déconnexion", action: "logout", danger: true },
  ];
}

function openDrawer() {
  $("navOverlay").hidden = false;
  $("navDrawer").classList.add("open");
  $("btnBurger").setAttribute("aria-expanded", "true");
  $("navDrawer").setAttribute("aria-hidden", "false");
}

function closeDrawer() {
  $("navOverlay").hidden = true;
  $("navDrawer").classList.remove("open");
  $("btnBurger").setAttribute("aria-expanded", "false");
  $("navDrawer").setAttribute("aria-hidden", "true");
}

function renderNav() {
  $("navHello").textContent = `Bonjour ${state.profile?.display_name ?? ""}`.trim();
  $("navRole").textContent = roleLabel(state.role);

  const links = buildNavLinks(state.role);
  const top = links.filter((l) => l.action !== "logout");
  const bottom = links.filter((l) => l.action === "logout");

  $("navLinksTop").innerHTML = top.map((it) => {
    const cls = `nav-link${it.danger ? " danger" : ""}`;
    const badge = it.badge > 0 ? `<span class="nav-badge">${it.badge}</span>` : "";
    const href = it.href ?? "#";
    const action = it.action ?? "";
    return `<a class="${cls}" href="${href}" data-action="${action}">${it.label}${badge}</a>`;
  }).join("");

  $("navLinksBottom").innerHTML = bottom.map((it) => {
    const cls = `nav-link${it.danger ? " danger" : ""}`;
    const href = it.href ?? "#";
    const action = it.action ?? "";
    return `<a class="${cls}" href="${href}" data-action="${action}">${it.label}</a>`;
  }).join("");
}

function formatDateFr(d) {
  try {
    return new Date(d).toLocaleDateString("fr-CA");
  } catch {
    return String(d ?? "");
  }
}

function setActiveTab(tab) {
  const tabs = ["roles", "users", "audit"];
  for (const t of tabs) {
    const btn = $(`tab${t.charAt(0).toUpperCase() + t.slice(1)}Btn`);
    const panel = $(`tab${t.charAt(0).toUpperCase() + t.slice(1)}`);
    if (btn) btn.classList.toggle("active", t === tab);
    if (panel) panel.style.display = t === tab ? "" : "none";
  }
}

function applyRoleBasedConfigView() {
  const isSuperAdmin = state.role === "super_admin";
  const topbarTitle = $("topbarTitle");
  const pageCardTitle = $("pageCardTitle");
  const pageSub = $("pageSub");
  const tabs = $("configTabs");
  const tabRolesBtn = $("tabRolesBtn");
  const tabUsersBtn = $("tabUsersBtn");
  const tabAuditBtn = $("tabAuditBtn");

  if (isSuperAdmin) {
    document.title = "Gestion clés - Configuration";
    if (topbarTitle) topbarTitle.textContent = "Configuration";
    if (pageCardTitle) pageCardTitle.textContent = "Configuration";
    if (pageSub) pageSub.textContent = "Rôles et utilisateurs";
    if (tabs) tabs.style.display = "";
    if (tabRolesBtn) tabRolesBtn.style.display = "";
    if (tabUsersBtn) tabUsersBtn.style.display = "";
    if (tabAuditBtn) tabAuditBtn.style.display = "";
    setActiveTab("roles");
    return;
  }

  document.title = "Gestion clés - Utilisateurs et audit";
  if (topbarTitle) topbarTitle.textContent = "Utilisateurs et audit";
  if (pageCardTitle) pageCardTitle.textContent = "Utilisateurs et audit";
  if (pageSub) pageSub.textContent = "Gestion des comptes en attente et journal";
  if (tabs) tabs.style.display = "";
  if (tabRolesBtn) tabRolesBtn.style.display = "none";
  if (tabUsersBtn) tabUsersBtn.style.display = "";
  if (tabAuditBtn) tabAuditBtn.style.display = "";
  setActiveTab("users");
}

function refreshPendingUsersUi() {
  const usersTab = $("tabUsersBtn");
  const notice = $("pendingUsersNotice");
  const count = Number(state.pendingUserCount) || 0;
  if (usersTab) {
    usersTab.textContent = count > 0 ? `Utilisateurs (${count} en attente)` : "Utilisateurs";
  }
  if (notice) {
    notice.textContent = count > 0
      ? `${count} nouveau(x) compte(s) en attente. Ouvre l'onglet Utilisateurs pour attribuer un rôle et un groupe.`
      : "";
  }
}

function renderRoleMatrix() {
  $("roleMatrixHead").innerHTML = `
    <tr>
      <th>Action</th>
      ${MATRIX_ROLES.map((r) => `<th style="text-align:center;">${escapeHtml(roleLabel(r))}</th>`).join("")}
    </tr>
  `;

  $("roleMatrixBody").innerHTML = MATRIX_ROWS.map((row) => {
    const cols = MATRIX_ROLES.map((role) => {
      const values = row.keys.map((k) => !!state.roleMatrix?.[role]?.[k]);
      const allChecked = values.every(Boolean);
      const someChecked = values.some(Boolean);
      const checked = allChecked ? "checked" : "";
      const indeterminate = !allChecked && someChecked ? "data-indeterminate=\"1\"" : "";
      return `
        <td style="text-align:center;">
          <input type="checkbox" data-role="${role}" data-actions="${row.keys.join(",")}" ${checked} ${indeterminate} />
        </td>
      `;
    }).join("");
    return `<tr><td>${escapeHtml(row.label)}</td>${cols}</tr>`;
  }).join("");

  $("roleMatrixBody")
    .querySelectorAll("input[type='checkbox'][data-indeterminate='1']")
    .forEach((cb) => {
      cb.indeterminate = true;
    });
}

async function loadRoleMatrix() {
  state.roleMatrix = cloneDefaultMatrix();
  try {
    const { data, error } = await supa.from("role_permissions").select("role,action,allowed");
    if (error) throw error;
    const seenByRole = new Map();
    if (data?.length) {
      for (const row of data) {
        const role = normalizeRole(row.role);
        const action = String(row.action ?? "");
        if (!MATRIX_ACTION_KEYS.includes(action)) continue;
        if (!state.roleMatrix[role]) state.roleMatrix[role] = {};
        state.roleMatrix[role][action] = !!row.allowed;
        if (!seenByRole.has(role)) seenByRole.set(role, new Set());
        seenByRole.get(role).add(action);
      }
      for (const role of MATRIX_ROLES) {
        const seen = seenByRole.get(role) ?? new Set();
        if (!seen.has("suggestion") && seen.has("signalement")) {
          state.roleMatrix[role].suggestion = !!state.roleMatrix[role].signalement;
        }
      }
    }
    state.roleMatrixAvailable = true;
    setStatus("roleMatrixStatus", "");
  } catch (e) {
    state.roleMatrixAvailable = false;
    setStatus("roleMatrixStatus", "Table role_permissions absente : matrice en mode local.");
  }
  state.roleMatrixInitial = cloneRoleMatrix(state.roleMatrix);
  state.roleMatrixDirty = false;
  renderRoleMatrix();
  updateRoleMatrixActionsState();
}

async function saveRoleMatrix() {
  if (!state.roleMatrixAvailable) {
    setStatus("roleMatrixStatus", "Impossible d'enregistrer sans table role_permissions.", 5000);
    return;
  }
  if (!state.roleMatrixDirty) {
    setStatus("roleMatrixStatus", "Aucune modification.", 5000);
    updateRoleMatrixActionsState();
    return;
  }
  try {
    $("saveRoleMatrix").disabled = true;
    $("cancelRoleMatrix").disabled = true;
    setStatus("roleMatrixStatus", "Enregistrement...");
    const rows = [];
    for (const role of MATRIX_ROLES) {
      for (const action of MATRIX_ACTION_KEYS) {
        rows.push({
          role,
          action,
          allowed: !!state.roleMatrix?.[role]?.[action],
        });
      }
    }
    const { error } = await supa.from("role_permissions").upsert(rows, { onConflict: "role,action" });
    if (error) throw error;
    state.roleMatrixInitial = cloneRoleMatrix(state.roleMatrix);
    state.roleMatrixDirty = false;
    setStatus("roleMatrixStatus", "Enregistré.", 5000);
  } catch (e) {
    setStatus("roleMatrixStatus", `Erreur: ${e?.message ?? e}`, 5000);
  } finally {
    updateRoleMatrixActionsState();
  }
}

function cancelRoleMatrixChanges() {
  state.roleMatrix = cloneRoleMatrix(state.roleMatrixInitial);
  state.roleMatrixDirty = false;
  renderRoleMatrix();
  setStatus("roleMatrixStatus", "Modifications annulées.", 5000);
  updateRoleMatrixActionsState();
}

function renderUsers() {
  const q = String(state.usersFilter ?? "").trim().toLowerCase();
  const users = visibleUsersForCurrentAdmin().filter((u) => {
    if (!q) return true;
    const hay = `${u.display_name ?? ""} ${u.id ?? ""} ${normalizeRole(u.role)} ${normalizeGroup(u.user_group)}`.toLowerCase();
    return hay.includes(q);
  }).sort((a, b) => {
    const aPending = normalizeRole(a.role) === "new_user" ? 0 : 1;
    const bPending = normalizeRole(b.role) === "new_user" ? 0 : 1;
    if (aPending !== bPending) return aPending - bPending;
    return String(a.display_name ?? "").localeCompare(String(b.display_name ?? ""), "fr-CA");
  });
  $("usersTableBody").innerHTML = users.map((u) => {
    const currentRole = normalizeRole(u.role);
    const currentGroup = normalizeGroup(u.user_group);
    const isEditing = String(state.editingUserId ?? "") === String(u.id);
    const canEdit = canEditUserAccess(u);
    const allowAllGroups = state.role === "super_admin";
    const roleCell = isEditing
      ? `<select class="select user-role-select">${buildRoleOptions(currentRole)}</select>`
      : escapeHtml(roleLabel(currentRole));
    const groupCell = isEditing
      ? `<select class="select user-group-select"${allowAllGroups ? "" : " disabled"}>${buildGroupOptions(currentGroup, { allowAllGroups })}</select>`
      : escapeHtml(groupLabel(currentGroup));
    const actionCell = !canEdit
      ? ""
      : isEditing
        ? `
          <div class="row" style="gap:8px; justify-content:flex-end;">
            <button class="btn reactive user-access-save">Enregistrer</button>
            <button class="btn secondary reactive user-access-cancel">Annuler</button>
          </div>
        `
        : `<button class="btn secondary icon-btn reactive user-edit-toggle" aria-label="Modifier l'utilisateur" title="Modifier">✎</button>`;
    return `
      <tr data-user-id="${u.id}">
        <td>${escapeHtml(u.display_name || "Sans nom")}</td>
        <td><code>${escapeHtml(u.id)}</code></td>
        <td>${roleCell}</td>
        <td>${groupCell}</td>
        <td style="text-align:right;">${actionCell}</td>
      </tr>
    `;
  }).join("");
  if (!users.length) {
    $("usersTableBody").innerHTML = `<tr><td colspan="5" class="muted">Aucun utilisateur.</td></tr>`;
  }
}

async function loadUsers() {
  state.users = await listUserProfiles();
  state.editingUserId = null;
  state.pendingUserCount = state.users.filter((u) => normalizeRole(u.role) === "new_user").length;
  refreshPendingUsersUi();
  renderUsers();
}

function formatAuditDateTime(iso) {
  return formatAuditDateTimeQuebec(iso);
}

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "-";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function formatAuditExportLine(ev) {
  const ts = formatAuditDateTime(ev?.created_at);
  const actor = String(ev?.actor_name || "System");
  const action = String(ev?.event_type || ev?.action || "unknown");
  const target = String(ev?.target || "-");
  const details = String(ev?.details || "");
  return `${ts} / ${actor} / ${action} / ${target} / ${details}`;
}

function computeAuditGroups() {
  const known = new Set();
  for (const g of AUDIT_GROUPS_BASE) {
    for (const t of g.types) known.add(t);
  }
  const extraTypes = state.auditTypes.filter((t) => !known.has(t));
  const groups = [...AUDIT_GROUPS_BASE];
  if (extraTypes.length) groups.push({ id: "others", label: "Autres", types: extraTypes });
  return groups;
}

function getSelectedAuditTypesFromGroups() {
  const selected = new Set();
  for (const group of state.auditGroups) {
    if (!state.auditSelectedGroups.has(group.id)) continue;
    for (const type of group.types) selected.add(type);
  }
  return [...selected];
}

function renderAuditTypeFilters() {
  const root = $("auditTypeFilters");
  if (!root) return;
  root.style.display = "grid";
  root.style.flex = "1 1 auto";
  root.style.minWidth = "0";
  root.style.gridTemplateColumns = "repeat(auto-fit, minmax(220px, 1fr))";
  root.style.gap = "6px 16px";
  root.style.alignItems = "start";
  root.innerHTML = state.auditGroups.map((group) => {
    const checked = state.auditSelectedGroups.has(group.id) ? "checked" : "";
    return `
      <label style="display:flex; gap:6px; align-items:center; font:inherit;">
        <input type="checkbox" data-audit-group="${escapeHtml(group.id)}" ${checked} />
        <span>${escapeHtml(group.label)}</span>
      </label>
    `;
  }).join("");
}

function renderAuditTable() {
  const body = $("auditTableBody");
  if (!body) return;
  if (!state.auditEvents.length) {
    body.innerHTML = `<tr><td colspan="5" class="muted">Aucun événement.</td></tr>`;
    return;
  }
  body.innerHTML = state.auditEvents.map((ev) => {
    const details = ev?.details ? ev.details : "-";
    const ts = formatAuditDateTime(ev.created_at);
    const actor = String(ev.actor_name || "System");
    const action = String(ev.event_type || ev.action || "unknown");
    const target = String(ev.target || "-");
    const evDetails = String(details);
    return `
      <tr class="audit-row-clickable" data-audit-id="${escapeHtml(String(ev.id ?? ""))}">
        <td title="${escapeHtml(ts)}"><span class="audit-ellipsis">${escapeHtml(ts)}</span></td>
        <td title="${escapeHtml(actor)}"><span class="audit-ellipsis">${escapeHtml(actor)}</span></td>
        <td title="${escapeHtml(action)}"><span class="audit-ellipsis"><code>${escapeHtml(action)}</code></span></td>
        <td title="${escapeHtml(target)}"><span class="audit-ellipsis">${escapeHtml(target)}</span></td>
        <td title="${escapeHtml(evDetails)}"><span class="audit-ellipsis">${escapeHtml(evDetails)}</span></td>
      </tr>
    `;
  }).join("");
}

function setAuditDetailModalOpen(open) {
  const overlay = $("auditDetailOverlay");
  const modal = $("auditDetailModal");
  if (!overlay || !modal) return;
  overlay.hidden = !open;
  modal.hidden = !open;
  modal.setAttribute("aria-hidden", open ? "false" : "true");
  document.body.classList.toggle("modal-open", open);
}

function closeAuditDetailModal() {
  setAuditDetailModalOpen(false);
}

function openAuditDetailModalById(auditId) {
  const ev = state.auditEvents.find((x) => String(x.id ?? "") === String(auditId));
  if (!ev) return;
  $("auditDetailTs").textContent = formatAuditDateTime(ev.created_at);
  $("auditDetailUser").textContent = String(ev.actor_name || "System");
  $("auditDetailAction").textContent = String(ev.event_type || ev.action || "unknown");
  $("auditDetailTarget").textContent = String(ev.target || "-");
  $("auditDetailText").textContent = String(ev.details || "-");
  setAuditDetailModalOpen(true);
}

async function loadAudit() {
  try {
    setStatus("auditStatus", "Chargement...");
    const selectedTypes = getSelectedAuditTypesFromGroups();
    const displayRange = $("auditDisplayRange")?.value || "1h";
    const from = resolveRangeStart(displayRange).toISOString();
    const to = new Date().toISOString();
    const events = await listAuditEvents({ types: selectedTypes, from, to, limit: 5000 });
    state.auditEvents = events
      .slice()
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    renderAuditTable();
    setStatus("auditStatus", `${state.auditEvents.length} événement(s) (${labelForRange(displayRange)}).`);
  } catch (e) {
    setStatus("auditStatus", `Erreur: ${e?.message ?? e}`, 8000);
  }
}

function resolveRangeStart(rangeValue) {
  const now = Date.now();
  if (rangeValue === "1h") return new Date(now - 1 * 60 * 60 * 1000);
  if (rangeValue === "24h") return new Date(now - 24 * 60 * 60 * 1000);
  if (rangeValue === "3d") return new Date(now - 3 * 24 * 60 * 60 * 1000);
  return new Date(now - 7 * 24 * 60 * 60 * 1000);
}

function labelForRange(rangeValue) {
  if (rangeValue === "1h") return "Dernière heure";
  if (rangeValue === "24h") return "Dernières 24h";
  if (rangeValue === "3d") return "Derniers 3 jours";
  return "Dernière semaine";
}

async function exportAuditRange() {
  const range = $("auditDisplayRange")?.value || "1h";
  try {
    setStatus("auditExportStatus", "Préparation export de la vue...");
    const ordered = state.auditEvents
      .slice()
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const lines = ordered.map((ev) => formatAuditExportLine(ev));
    const content = `${lines.join("\n")}${lines.length ? "\n" : ""}`;
    const fileDate = getQuebecDateToken(new Date());
    const filename = `Sesame_audit-logs_vue-actuelle_${fileDate}_${range}.txt`;
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    saveBlob(blob, filename);
    setStatus("auditExportStatus", `${ordered.length} événement(s) exporté(s) depuis la vue actuelle.`, 6000);
  } catch (e) {
    setStatus("auditExportStatus", `Erreur export: ${e?.message ?? e}`, 8000);
  }
}

function renderAuditArchives() {
  const body = $("auditArchiveBody");
  if (!body) return;
  if (!state.auditArchiveFiles.length) {
    body.innerHTML = `<tr><td colspan="4" class="muted">Aucun fichier d'archive.</td></tr>`;
    return;
  }
  const downloadIcon = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M12 3a1 1 0 0 1 1 1v8.59l2.3-2.3a1 1 0 1 1 1.4 1.42l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.42L11 12.6V4a1 1 0 0 1 1-1Zm-7 14a1 1 0 0 1 1 1v1h12v-1a1 1 0 1 1 2 0v2a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1Z"/>
    </svg>
  `;
  const previewIcon = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M12 5c5.5 0 9.27 4.95 10.59 6.97a1 1 0 0 1 0 1.06C21.27 15.05 17.5 20 12 20s-9.27-4.95-10.59-6.97a1 1 0 0 1 0-1.06C2.73 9.95 6.5 5 12 5Zm0 2c-4.23 0-7.39 3.58-8.55 5 1.16 1.42 4.32 5 8.55 5s7.39-3.58 8.55-5c-1.16-1.42-4.32-5-8.55-5Zm0 2.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z"/>
    </svg>
  `;
  body.innerHTML = state.auditArchiveFiles.map((f) => `
    <tr>
      <td><code>${escapeHtml(f.name)}</code></td>
      <td>${escapeHtml(f.day)}</td>
      <td>${escapeHtml(formatBytes(f.metadata?.size))}</td>
      <td>
        <div class="archive-actions">
          <button class="btn secondary reactive archive-icon-btn" data-audit-preview="${escapeHtml(f.name)}" title="Aperçu" aria-label="Aperçu">${previewIcon}</button>
          <button class="btn secondary reactive archive-icon-btn" data-audit-download="${escapeHtml(f.name)}" title="Télécharger" aria-label="Télécharger">${downloadIcon}</button>
        </div>
      </td>
    </tr>
  `).join("");
}

async function loadAuditArchives() {
  try {
    const { data, error } = await supa.storage
      .from("logs")
      .list("", {
        limit: 1000,
        offset: 0,
        sortBy: { column: "name", order: "desc" },
      });
    if (error) throw error;
    const rows = (data ?? [])
      .map((item) => {
        const m = /^Sesame_audit-logs_(\d{4})(\d{2})(\d{2})\.txt$/i.exec(String(item?.name || ""));
        if (!m) return null;
        return {
          ...item,
          day: `${m[1]}-${m[2]}-${m[3]}`,
        };
      })
      .filter(Boolean);
    state.auditArchiveFiles = rows;
    renderAuditArchives();
  } catch {
    state.auditArchiveFiles = [];
    renderAuditArchives();
  }
}

async function downloadAuditArchive(filename) {
  try {
    setStatus("auditExportStatus", "Téléchargement archive...");
    const { data, error } = await supa.storage.from("logs").download(filename);
    if (error) throw error;
    if (!data) throw new Error("Fichier introuvable.");
    saveBlob(data, filename);
    setStatus("auditExportStatus", "Archive téléchargée.", 5000);
  } catch (e) {
    setStatus("auditExportStatus", `Erreur téléchargement: ${e?.message ?? e}`, 8000);
  }
}

function setAuditArchivePreviewModalOpen(open) {
  const overlay = $("auditArchivePreviewOverlay");
  const modal = $("auditArchivePreviewModal");
  if (!overlay || !modal) return;
  overlay.hidden = !open;
  modal.hidden = !open;
  modal.setAttribute("aria-hidden", open ? "false" : "true");
  document.body.classList.toggle("modal-open", open);
}

function closeAuditArchivePreviewModal() {
  setAuditArchivePreviewModalOpen(false);
}

function parseArchiveLine(line) {
  const raw = String(line ?? "").replace(/^\uFEFF/, "");
  const value = raw.trim();
  if (!value) return null;
  if (value.startsWith("HORODATAGE") || /^-+$/.test(value)) return null;
  if (value.startsWith("{") && value.endsWith("}")) {
    try {
      const obj = JSON.parse(value);
      return {
        ts: String(obj?.created_at ?? obj?.ts ?? "-"),
        actor: String(obj?.actor_name ?? obj?.actor ?? "System"),
        action: String(obj?.event_type ?? obj?.action ?? "unknown"),
        target: String(obj?.target ?? "-"),
        details: String(obj?.details ?? ""),
      };
    } catch {
      // fallback format texte
    }
  }
  // Format archives TXT: colonnes fixes
  if (raw.length >= 40) {
    const ts = raw.slice(0, 21).trim();
    const actor = raw.slice(23, 47).trim();
    const action = raw.slice(49, 67).trim();
    const target = raw.slice(69, 95).trim();
    const details = raw.length > 97 ? raw.slice(97).trim() : "";
    if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(ts)) {
      return {
        ts,
        actor: actor || "System",
        action: action || "unknown",
        target: target || "-",
        details,
      };
    }
  }
  const sep = " / ";
  const p1 = value.indexOf(sep);
  if (p1 < 0) return { ts: "-", actor: "-", action: "-", target: "-", details: value };
  const p2 = value.indexOf(sep, p1 + sep.length);
  if (p2 < 0) return { ts: value.slice(0, p1), actor: "-", action: "-", target: "-", details: value.slice(p1 + sep.length) };
  const p3 = value.indexOf(sep, p2 + sep.length);
  if (p3 < 0) return { ts: value.slice(0, p1), actor: value.slice(p1 + sep.length, p2), action: "-", target: "-", details: value.slice(p2 + sep.length) };
  const p4 = value.indexOf(sep, p3 + sep.length);
  if (p4 < 0) return {
    ts: value.slice(0, p1),
    actor: value.slice(p1 + sep.length, p2),
    action: value.slice(p2 + sep.length, p3),
    target: "-",
    details: value.slice(p3 + sep.length),
  };
  return {
    ts: value.slice(0, p1),
    actor: value.slice(p1 + sep.length, p2),
    action: value.slice(p2 + sep.length, p3),
    target: value.slice(p3 + sep.length, p4),
    details: value.slice(p4 + sep.length),
  };
}

function renderAuditArchivePreviewRows(lines) {
  const body = $("auditArchivePreviewBody");
  if (!body) return;
  const rows = lines
    .map(parseArchiveLine)
    .filter(Boolean);
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="5" class="muted">Aucun log dans ce fichier.</td></tr>`;
    return;
  }
  body.innerHTML = rows.map((row) => `
    <tr>
      <td title="${escapeHtml(row.ts)}"><span class="audit-ellipsis">${escapeHtml(row.ts)}</span></td>
      <td title="${escapeHtml(row.actor)}"><span class="audit-ellipsis">${escapeHtml(row.actor)}</span></td>
      <td title="${escapeHtml(row.action)}"><span class="audit-ellipsis"><code>${escapeHtml(row.action)}</code></span></td>
      <td title="${escapeHtml(row.target)}"><span class="audit-ellipsis">${escapeHtml(row.target)}</span></td>
      <td title="${escapeHtml(row.details)}"><span class="audit-ellipsis">${escapeHtml(row.details)}</span></td>
    </tr>
  `).join("");
}

async function previewAuditArchive(filename) {
  try {
    setStatus("auditExportStatus", "Chargement aperçu...");
    $("auditArchivePreviewName").textContent = filename;
    $("auditArchivePreviewStatus").textContent = "Lecture...";
    $("auditArchivePreviewBody").innerHTML = `<tr><td colspan="5" class="muted">Chargement...</td></tr>`;
    setAuditArchivePreviewModalOpen(true);
    const { data, error } = await supa.storage.from("logs").download(filename);
    if (error) throw error;
    if (!data) throw new Error("Fichier introuvable.");
    const content = await data.text();
    const lines = content
      .split(/\r?\n/)
      .filter((l) => String(l ?? "").trim().length > 0);
    renderAuditArchivePreviewRows(lines);
    $("auditArchivePreviewStatus").textContent = `${lines.length} ligne(s).`;
    setStatus("auditExportStatus", "");
  } catch (e) {
    $("auditArchivePreviewBody").innerHTML = `<tr><td colspan="5" class="muted">Erreur de lecture.</td></tr>`;
    $("auditArchivePreviewStatus").textContent = `Erreur: ${e?.message ?? e}`;
    setStatus("auditExportStatus", `Erreur aperçu: ${e?.message ?? e}`, 8000);
  }
}

function getSuperAdminCount() {
  return state.users.filter((u) => normalizeRole(u.role) === "super_admin").length;
}

async function updateUserAccess(userId, nextRole, nextGroup) {
  const row = state.users.find((u) => String(u.id) === String(userId));
  if (!row) throw new Error("Utilisateur introuvable.");
  if (!canEditUserAccess(row)) throw new Error("Cet utilisateur n'appartient pas à ton groupe.");
  const currentRole = normalizeRole(row.role);
  const targetRole = normalizeRole(nextRole);
  const targetGroup = state.role === "super_admin"
    ? normalizeGroup(nextGroup)
    : normalizeGroup(state.profile?.user_group);
  if (targetRole === "super_admin") {
    throw new Error("Le rôle super-admin n'est pas assignable depuis cette page.");
  }

  if (String(userId) === String(state.profile?.id) && currentRole === "super_admin" && targetRole !== "super_admin") {
    throw new Error("Tu ne peux pas retirer ton propre role super-admin.");
  }

  if (currentRole === "super_admin" && targetRole !== "super_admin" && getSuperAdminCount() <= 1) {
    throw new Error("Impossible de retirer le dernier super-admin.");
  }

  const updated = await updateUserProfileAccess(userId, targetRole, targetGroup);
  row.role = normalizeRole(updated?.role ?? targetRole);
  row.user_group = normalizeGroup(updated?.user_group ?? targetGroup);
  state.editingUserId = null;
  state.pendingUserCount = state.users.filter((u) => normalizeRole(u.role) === "new_user").length;
  refreshPendingUsersUi();
}


function bind() {
  $("btnBurger").addEventListener("click", () => {
    const isOpen = $("navDrawer").classList.contains("open");
    if (isOpen) closeDrawer();
    else openDrawer();
  });
  $("navOverlay").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDrawer();
  });
  $("navLinksTop").addEventListener("click", (e) => {
    const a = e.target.closest("a.nav-link");
    if (!a) return;
    if (a.dataset.action === "logout") {
      e.preventDefault();
      closeDrawer();
      signOut();
      return;
    }
    closeDrawer();
  });
  $("navLinksBottom").addEventListener("click", (e) => {
    const a = e.target.closest("a.nav-link");
    if (!a) return;
    if (a.dataset.action === "logout") {
      e.preventDefault();
      closeDrawer();
      signOut();
      return;
    }
    closeDrawer();
  });

  document.querySelectorAll(".tab[data-tab]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      setActiveTab(btn.dataset.tab);
      if (btn.dataset.tab === "audit") {
        await loadAudit();
        await loadAuditArchives();
      }
    });
  });

  $("roleMatrixBody").addEventListener("change", (e) => {
    const cb = e.target.closest("input[type='checkbox'][data-role][data-actions]");
    if (!cb) return;
    const role = normalizeRole(cb.dataset.role);
    const actions = String(cb.dataset.actions ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    if (!state.roleMatrix[role]) state.roleMatrix[role] = {};
    for (const action of actions) {
      state.roleMatrix[role][action] = !!cb.checked;
    }
    cb.indeterminate = false;
    refreshRoleMatrixDirtyState();
  });
  $("saveRoleMatrix").addEventListener("click", saveRoleMatrix);
  $("cancelRoleMatrix").addEventListener("click", cancelRoleMatrixChanges);

  $("usersQ").addEventListener("input", (e) => {
    state.usersFilter = e.target.value ?? "";
    renderUsers();
  });
  $("refreshUsers").addEventListener("click", async () => {
    try {
      $("refreshUsers").disabled = true;
      $("usersStatus").textContent = "Chargement...";
      await loadUsers();
      $("usersStatus").textContent = "";
    } catch (e) {
      $("usersStatus").textContent = `Erreur: ${e?.message ?? e}`;
    } finally {
      $("refreshUsers").disabled = false;
    }
  });
  $("usersTableBody").addEventListener("click", async (e) => {
    const editBtn = e.target.closest("button.user-edit-toggle");
    if (editBtn) {
      const row = editBtn.closest("tr[data-user-id]");
      if (!row) return;
      state.editingUserId = row.dataset.userId;
      renderUsers();
      return;
    }

    const cancelBtn = e.target.closest("button.user-access-cancel");
    if (cancelBtn) {
      state.editingUserId = null;
      renderUsers();
      return;
    }

    const saveBtn = e.target.closest("button.user-access-save");
    if (!saveBtn) return;
    const row = saveBtn.closest("tr[data-user-id]");
    if (!row) return;
    const userId = row.dataset.userId;
    const roleSelect = row.querySelector("select.user-role-select");
    const groupSelect = row.querySelector("select.user-group-select");
    if (!roleSelect) return;
    const nextRole = normalizeRole(roleSelect.value);
    const nextGroup = normalizeGroup(groupSelect?.value ?? state.profile?.user_group);
    try {
      saveBtn.disabled = true;
      setStatus("usersStatus", "Mise à jour...");
      await updateUserAccess(userId, nextRole, nextGroup);
      renderUsers();
      setStatus("usersStatus", "Rôle et groupe mis à jour.", 5000);
    } catch (err) {
      setStatus("usersStatus", `Erreur: ${err?.message ?? err}`, 5000);
    } finally {
      saveBtn.disabled = false;
    }
  });

  $("auditTypeFilters").addEventListener("change", async (e) => {
    const cb = e.target.closest("input[type='checkbox'][data-audit-group]");
    if (!cb) return;
    const groupId = String(cb.dataset.auditGroup || "");
    if (!groupId) return;
    if (cb.checked) state.auditSelectedGroups.add(groupId);
    else state.auditSelectedGroups.delete(groupId);
    await loadAudit();
  });

  $("refreshAudit").addEventListener("click", async () => {
    await loadAudit();
  });
  $("auditDisplayRange").addEventListener("change", async () => {
    await loadAudit();
  });
  $("exportAuditBtn").addEventListener("click", async () => {
    await exportAuditRange();
  });
  $("refreshAuditArchive").addEventListener("click", async () => {
    await loadAuditArchives();
  });
  $("auditArchiveBody").addEventListener("click", async (e) => {
    const dl = e.target.closest("button[data-audit-download]");
    if (dl) {
      const filename = String(dl.dataset.auditDownload || "");
      if (!filename) return;
      await downloadAuditArchive(filename);
      return;
    }
    const pv = e.target.closest("button[data-audit-preview]");
    if (!pv) return;
    const filename = String(pv.dataset.auditPreview || "");
    if (!filename) return;
    await previewAuditArchive(filename);
  });
  $("auditTableBody").addEventListener("click", (e) => {
    const row = e.target.closest("tr[data-audit-id]");
    if (!row) return;
    const id = String(row.dataset.auditId || "");
    if (!id) return;
    openAuditDetailModalById(id);
  });
  $("auditDetailClose").addEventListener("click", closeAuditDetailModal);
  $("auditDetailOverlay").addEventListener("click", closeAuditDetailModal);
  $("auditArchivePreviewClose").addEventListener("click", closeAuditArchivePreviewModal);
  $("auditArchivePreviewOverlay").addEventListener("click", closeAuditArchivePreviewModal);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("auditDetailModal")?.hidden) closeAuditDetailModal();
    if (e.key === "Escape" && !$("auditArchivePreviewModal")?.hidden) closeAuditArchivePreviewModal();
  });

}

async function boot() {
  applyTheme();
  ensureAuditSyncStarted();
  installGlobalAuditErrorHooks();
  await requireSessionOrRedirect();
  state.profile = await getMyProfile();
  state.role = normalizeRole(state.profile?.role);
  if (isPendingApprovalRole(state.role)) {
    redirectToRoleHome(state.role);
    return;
  }

  if (!isAdminRole(state.role)) {
    redirectToRoleHome(state.role);
    return;
  }

  try {
    state.myOpenLoanCount = await countOpenLoansByBorrower(state.profile?.id);
  } catch {
    state.myOpenLoanCount = 0;
  }
  try {
    state.suggestionCount = await countOpenSuggestions();
    const badge = $("burgerBadge");
    if (badge) {
      badge.textContent = String(state.suggestionCount);
      badge.hidden = state.suggestionCount === 0;
    }
  } catch {
    state.suggestionCount = 0;
    const badge = $("burgerBadge");
    if (badge) badge.hidden = true;
  }

  try {
    state.pendingUserCount = await countPendingUsers();
    notifyAdminAboutPendingUsers(state.pendingUserCount);
  } catch {
    state.pendingUserCount = 0;
  }

  renderNav();
  applyRoleBasedConfigView();
  refreshPendingUsersUi();
  state.auditGroups = computeAuditGroups();
  state.auditSelectedGroups = new Set(state.auditGroups.map((g) => g.id));
  renderAuditTypeFilters();
  renderAuditTable();
  bindThemeToggle();
  bind();

  $("configStatus").textContent = "Chargement...";
  const loadTasks = [loadAudit(), loadAuditArchives()];
  if (isAdminRole(state.role)) {
    loadTasks.unshift(loadUsers());
  }
  if (state.role === "super_admin") {
    loadTasks.unshift(loadRoleMatrix());
  }
  await Promise.all(loadTasks);
  $("configStatus").textContent = "";
}

boot().catch((e) => {
  $("configStatus").textContent = `Erreur: ${e?.message ?? e}`;
  // eslint-disable-next-line no-console
  console.error(e);
});




