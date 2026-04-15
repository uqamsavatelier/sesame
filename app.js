import { supa } from "./supabaseClient.js";

import { requireSessionOrRedirect, getMyProfile, signOut, isPendingApprovalRole, redirectToRoleHome, notifyAdminAboutPendingUsers } from "./auth.js?v=20260415g";
import { groupByHook, renderHookCard } from "./ui.js";
import {
  listCabinets,
  listPavilions,
  listKeysByCabinet,
  listKeyringsByCabinet,
  listOpenLoansByKeyIds,
  listProfilesByIds,
  listUserProfiles,
  listMissingByKeyIds,
  fnLoanCreateKeyring,
  fnLoanReturnKeyring,
  fnLoanCreate,
  fnLoanReturn,
  fnReportMissing,
  fnReportFound,
  fnImportKeysCsv,
  createKeySuggestion,
  createCabinet,
  updateCabinet,
  getCabinetUsage,
  deleteCabinet,
  countOpenSuggestions,
  countPendingUsers,
  countOpenLoansByBorrower,
  rpcAdminCreateLoan,
  rpcAdminCreateKeyringLoan,
} from "./api.js";
import { ensureAuditSyncStarted, installGlobalAuditErrorHooks, logAuditEvent } from "./audit.js";


const $ = (id) => document.getElementById(id);

function setPageTitle(text) {
  const value = String(text ?? "");
  const top = $("pageTitle");
  const center = $("pageTitleCenter");
  if (top) top.textContent = value;
  if (center) center.textContent = value;
}

function setSessionInfo(text) {
  const value = String(text ?? "");
  const top = $("sessionInfo");
  const center = $("sessionInfoCenter");
  if (top) top.textContent = value;
  if (center) center.textContent = value;
}

// ===== THEME (dark/light) =====
const THEME_KEY = "sav_theme"; // clé localStorage

function getSavedTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  return saved === "light" ? "light" : "dark";
}

function setSavedTheme(theme) {
  const t = theme === "light" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, t);
}

function applyTheme(theme) {
  const t = theme === "light" ? "light" : "dark";
  document.body.dataset.theme = t;

  const seg = $("themeSeg");
  if (seg) seg.dataset.theme = t; // déplace l'indicateur via CSS

  // optionnel: accessibilité / état
  const btn = document.querySelector("#themeSeg .seg-btn");
  if (btn) btn.setAttribute("aria-pressed", t === "light" ? "true" : "false");
}

function initTheme() {
  applyTheme(getSavedTheme());
}

let themeBound = false;
function bindThemeToggle() {
  if (themeBound) return;
  themeBound = true;

  const seg = $("themeSeg");
  if (!seg) return; // si une page n'a pas le toggle

  seg.addEventListener("click", (e) => {
    const btn = e.target.closest("button.seg-btn");
    if (!btn) return;

    const current = seg.dataset.theme === "light" ? "light" : "dark";
    const theme = current === "light" ? "dark" : "light";
    localStorage.setItem(THEME_KEY, theme);
    applyTheme(theme);
  });
}




function roleLabel(role) {
  const r = normalizeRole(role);
  return r === "super_admin" ? "Super-admin"
    : r === "admin" ? "Administrateur"
    : r === "consultant" ? "Consultant"
    : r === "new_user" ? "Salle d'attente"
    : "Utilisateur";
}

function normalizeRole(role) {
  const r = String(role ?? "")
    .trim()
    .toLowerCase()
    .replaceAll("-", "_")
    .replace(/\s+/g, "_");
  if (r === "super_admin" || r === "superadmin") return "super_admin";
  if (r === "admin" || r === "consultant" || r === "user" || r === "new_user") return r;
  return "new_user";
}

function isAdminRole(role) {
  const r = normalizeRole(role);
  return r === "admin" || r === "super_admin";
}

const GROUP_OPTIONS = ["employe", "direction", "affichage"];

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

function groupLabel(group) {
  const current = normalizeGroup(group);
  return current === "direction" ? "Direction"
    : current === "affichage" ? "Affichage"
    : "Employé";
}

function isSuperAdminRole(role) {
  return normalizeRole(role) === "super_admin";
}

function getCurrentUserGroup() {
  return normalizeGroup(state.profile?.user_group ?? "employe");
}

function canAdministrateCabinet(cabinetOrId) {
  const cabinet = typeof cabinetOrId === "object" && cabinetOrId
    ? cabinetOrId
    : state.cabinets.find((row) => Number(row.id) === Number(cabinetOrId));
  if (!cabinet) return false;
  if (isSuperAdminRole(state.role)) return true;
  if (!isAdminRole(state.role)) return false;
  return normalizeGroup(cabinet.user_group) === getCurrentUserGroup();
}

function canAdministrateCurrentCabinet() {
  return canAdministrateCabinet(state.cabinetId);
}

function getCabinetPolicy(cabinetOrId = state.cabinetId) {
  const cabinet = typeof cabinetOrId === "object" && cabinetOrId
    ? cabinetOrId
    : state.cabinets.find((row) => Number(row.id) === Number(cabinetOrId));
  return {
    allow_consultation: cabinet?.allow_consultation !== false,
    allow_self_borrow: cabinet?.allow_self_borrow !== false,
    allow_admin_lending: cabinet?.allow_admin_lending === true,
  };
}

function canConsultCabinet(cabinetOrId) {
  if (canAdministrateCabinet(cabinetOrId)) return true;
  return getCabinetPolicy(cabinetOrId).allow_consultation;
}

function canAdminLendCabinet(cabinetOrId = state.cabinetId) {
  return canAdministrateCabinet(cabinetOrId)
    && getCabinetPolicy(cabinetOrId).allow_admin_lending
    && canRole("emprunt");
}

function canSelfBorrowCabinet(cabinetOrId = state.cabinetId) {
  return getCabinetPolicy(cabinetOrId).allow_self_borrow && canRole("emprunt");
}

function filterCabinetsForCurrentUser(cabinets) {
  const rows = Array.isArray(cabinets) ? cabinets : [];
  const restrictedCabinetId = getRestrictedCabinetIdFromUrl();
  let filtered = rows;
  if (isSuperAdminRole(state.role)) {
    filtered = rows;
  } else if (isAdminRole(state.role)) {
    const currentGroup = getCurrentUserGroup();
    filtered = rows.filter((cabinet) => normalizeGroup(cabinet.user_group) === currentGroup);
  } else {
    filtered = rows.filter((cabinet) => {
      if (canConsultCabinet(cabinet)) return true;
      return Number.isFinite(restrictedCabinetId) && Number(cabinet.id) === Number(restrictedCabinetId);
    });
  }
  if (Number.isFinite(restrictedCabinetId)) {
    return filtered.filter((cabinet) => Number(cabinet.id) === Number(restrictedCabinetId));
  }
  return filtered;
}

function buildCabinetGroupOptionsHtml(selectedGroup = "employe") {
  const normalized = normalizeGroup(selectedGroup);
  return GROUP_OPTIONS.map((group) => {
    const selected = group === normalized ? " selected" : "";
    return `<option value="${group}"${selected}>${groupLabel(group)}</option>`;
  }).join("");
}

function syncCabinetGroupInputs(selectedGroup = "employe") {
  const forcedGroup = isSuperAdminRole(state.role) ? normalizeGroup(selectedGroup) : getCurrentUserGroup();
  const createSelect = $("cab_create_user_group");
  const editSelect = $("cab_edit_user_group");
  for (const select of [createSelect, editSelect]) {
    if (!select) continue;
    select.innerHTML = buildCabinetGroupOptionsHtml(forcedGroup);
    select.value = forcedGroup;
    select.disabled = !isSuperAdminRole(state.role);
  }
}

function syncCabinetAvailabilityInputs(options = {}) {
  const values = {
    allow_consultation: options?.allow_consultation !== false,
    allow_self_borrow: options?.allow_self_borrow !== false,
    allow_admin_lending: options?.allow_admin_lending === true,
  };
  const isEditable = isSuperAdminRole(state.role);
  const pairs = [
    ["cab_create_allow_consultation", values.allow_consultation],
    ["cab_create_allow_self_borrow", values.allow_self_borrow],
    ["cab_create_allow_admin_lending", values.allow_admin_lending],
    ["cab_edit_allow_consultation", values.allow_consultation],
    ["cab_edit_allow_self_borrow", values.allow_self_borrow],
    ["cab_edit_allow_admin_lending", values.allow_admin_lending],
  ];
  for (const [id, checked] of pairs) {
    const input = $(id);
    if (!input) continue;
    input.checked = !!checked;
    input.disabled = !isEditable;
  }
}

function loanBorrowerLabel(loan) {
  if (!loan) return "—";
  return state.borrowersById?.get(loan.borrower_id) || loan.borrower_name || loan.borrower_id || "—";
}

const ROLE_ACTION_KEYS = [
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

const DEFAULT_ROLE_PERMISSIONS = {
  admin: {
    consultation: true,
    signalement: true,
    suggestion: true,
    emprunt: true,
    retour: true,
    edition: true,
    deplacement: true,
    creation: true,
    suppression: true,
  },
  user: {
    consultation: true,
    signalement: true,
    suggestion: true,
    emprunt: true,
    retour: true,
    edition: false,
    deplacement: false,
    creation: false,
    suppression: false,
  },
  consultant: {
    consultation: true,
    signalement: true,
    suggestion: true,
    emprunt: false,
    retour: false,
    edition: false,
    deplacement: false,
    creation: false,
    suppression: false,
  },
  new_user: {
    consultation: false,
    signalement: false,
    suggestion: false,
    emprunt: false,
    retour: false,
    edition: false,
    deplacement: false,
    creation: false,
    suppression: false,
  },
};

function defaultPermissionsForRole(role) {
  const r = normalizeRole(role);
  if (r === "super_admin") {
    return Object.fromEntries(ROLE_ACTION_KEYS.map((k) => [k, true]));
  }
  const base = DEFAULT_ROLE_PERMISSIONS[r] ?? DEFAULT_ROLE_PERMISSIONS.new_user;
  return { ...base };
}

async function loadRolePermissionsForCurrentRole() {
  const fallback = defaultPermissionsForRole(state.role);
  if (normalizeRole(state.role) === "super_admin") return fallback;
  try {
    const { data, error } = await supa
      .from("role_permissions")
      .select("action,allowed")
      .eq("role", normalizeRole(state.role));
    if (error) throw error;
    if (!Array.isArray(data) || !data.length) return fallback;
    const out = { ...fallback };
    const seenActions = new Set();
    for (const row of data) {
      const action = String(row?.action ?? "").trim();
      if (!ROLE_ACTION_KEYS.includes(action)) continue;
      out[action] = !!row?.allowed;
      seenActions.add(action);
    }
    if (!seenActions.has("suggestion") && seenActions.has("signalement")) {
      out.suggestion = !!out.signalement;
    }
    return out;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[role_permissions] lecture impossible, fallback local utilisé.", e?.message ?? e);
    return fallback;
  }
}

function canRole(action) {
  const key = String(action ?? "").trim();
  if (!key) return false;
  if (normalizeRole(state.role) === "super_admin") return true;
  return !!state.rolePermissions?.[key];
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

function buildQrCabinetHref(cabinetId) {
  return Number.isFinite(cabinetId)
    ? `./index.html?mode=qr&cabinet=${cabinetId}`
    : "./index.html?mode=qr";
}

function buildQrLoansHref(cabinetId) {
  return Number.isFinite(cabinetId)
    ? `./my-loans.html?mode=qr&cabinet=${cabinetId}`
    : "./my-loans.html?mode=qr";
}

function syncTopbarLogoLink() {
  const logo = document.querySelector(".topbar-logo");
  if (!logo) return;
  const mode = getModeFromUrl();
  if (mode === "qr") {
    logo.setAttribute("href", buildQrCabinetHref(getRestrictedCabinetIdFromUrl()));
    logo.setAttribute("aria-label", "Retour à l'armoire scannée");
    return;
  }
  logo.setAttribute("href", "./index.html");
  logo.setAttribute("aria-label", "Accueil");
}

let navEventsBound = false;

function bindNavEvents() {
  if (navEventsBound) return;
  navEventsBound = true;

  $("btnBurger").addEventListener("click", () => {
    const isOpen = $("navDrawer").classList.contains("open");
    isOpen ? closeDrawer() : openDrawer();
  });

  $("navOverlay").addEventListener("click", closeDrawer);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDrawer();
  });

  function handleNavClick(e) {
    const a = e.target.closest("a.nav-link");
    if (!a) return;

    const action = a.dataset.action || "";
    if (action === "logout") {
      e.preventDefault();
      closeDrawer();
      signOut();
      return;
    }
    closeDrawer();
  }

  $("navLinksTop").addEventListener("click", handleNavClick);
  $("navLinksBottom").addEventListener("click", handleNavClick);
}

function buildNavLinks(role) {
  const normalizedRole = normalizeRole(role);
  const mode = getModeFromUrl();
  if (mode === "qr" && !isAdminRole(normalizedRole)) {
    const cabinetId = getRestrictedCabinetIdFromUrl();
    const cabinet = state.cabinets.find((row) => Number(row.id) === Number(cabinetId));
    const cabinetLabel = cabinet
      ? (cabinet.location ? `${cabinet.name} - ${cabinet.location}` : cabinet.name)
      : "Armoire scannée";
    return [
      { label: cabinetLabel, href: buildQrCabinetHref(cabinetId) },
      { label: "Mes emprunts", href: buildQrLoansHref(cabinetId) },
      { label: "Déconnexion", action: "logout", danger: true },
    ];
  }
  // Tu peux changer les routes plus tard. Pour l'instant: placeholders propres.
  if (isAdminRole(normalizedRole)) {
    const links = [
      { label: "Clés", href: "./index.html" },
      { label: "Emprunts", href: "./loans.html" },
      { label: "Suggestions", href: "./suggestions.html", badge: Number(state.suggestionCount) || 0 },
    ];
    links.push({
      label: normalizedRole === "super_admin" ? "Configuration" : "Utilisateurs et audit",
      href: "./configuration.html",
      badge: Number(state.pendingUserCount) || 0,
    });
    links.push({ label: "Déconnexion", action: "logout", danger: true });
    return links;
  }
  if (normalizedRole === "new_user") {
    return [
      { label: "Salle d'attente", href: "./waiting.html" },
      { label: "Déconnexion", action: "logout", danger: true },
    ];
  }
  if (normalizedRole === "consultant") {
    return [
      { label: "Liste des clés", href: "./index.html" },
      { label: "Déconnexion", action: "logout", danger: true },
    ];
  }
  // user
  return [
    { label: "Liste des clés", href: "./index.html?mode=browse" },
    { label: `Mes emprunts (${Number(state.myOpenLoanCount) || 0})`, href: "./my-loans.html" },
    { label: "Déconnexion", action: "logout", danger: true },
  ];
}
function getHookSnapshot(hookNo) {
  const keys = state.keys.filter(k => Number(k.hook_no) === Number(hookNo));
  const rings = state.keyrings.filter(kr => Number(kr.hook_no) === Number(hookNo));
  return { keys, rings };
}

function renderHookContext(hookNo) {
  const box = $("hookContext");
  if (!box) return;

  const { keys, rings } = getHookSnapshot(hookNo);

  if (!keys.length && !rings.length) {
    box.style.display = "none";
    box.innerHTML = "";
    return;
  }

  box.style.display = "";
  const keyPills = keys.slice(0, 12).map(k => `<span class="kpill">${escapeHtml(formatKeyTag(k))}</span>`).join("");
  const ringBadges = rings.map(r => `<span class="badge warn">?? ${escapeHtml(r.ring_code ?? "A")} — ${escapeHtml(r.name ?? "")}</span>`).join("");

  box.innerHTML = `
    <div class="hc-title">Crochet #${hookNo} déjà occupé</div>
    <div class="muted" style="margin-bottom:8px;">Clés existantes :</div>
    <div class="hc-grid">${keyPills || `<span class="muted">—</span>`}</div>
    ${rings.length ? `<div class="muted" style="margin-top:10px;margin-bottom:6px;">Trousseaux existants :</div>
      <div class="hc-grid">${ringBadges}</div>` : ""}
  `;
}


function renderHookExistingDetails(hookNo) {
  const box = $("hookExistingDetails");
  if (!box) return;

  const n = Number(hookNo);
  if (!Number.isFinite(n) || n <= 0) {
    box.style.display = "none";
    box.innerHTML = "";
    return;
  }

  const keys = state.keys
    .filter(k => Number(k.hook_no) === n)
    .sort(sortKeysByNo);

  if (!keys.length) {
    box.style.display = "none";
    box.innerHTML = "";
    return;
  }

  const rows = keys.map((k) => {
    const loan = state.loansByKey?.get(k.id);
    const borrowerName = loan ? loanBorrowerLabel(loan) : "";
    const loanText = loan ? `Empruntée (${borrowerName})` : "Disponible";
    const stateText = k.is_missing ? "Disparue" : loanText;
    return `
      <tr>
        <td>${escapeHtml(k.key_no ?? "—")}</td>
        <td>${escapeHtml(k.local ?? "—")}</td>
        <td>${escapeHtml(getPavilionDisplayForKey(k) || "—")}</td>
        <td>${escapeHtml(k.utilisation ?? "—")}</td>
        <td>${escapeHtml(k.remarque ?? "—")}</td>
        <td>${escapeHtml(stateText)}</td>
      </tr>
    `;
  }).join("");

  box.style.display = "";
  box.innerHTML = `
    <div class="hc-title">Clés déjà présentes sur le crochet #${n}</div>
    <div class="hook-existing-table-wrap">
      <table class="hook-existing-table">
        <thead>
          <tr>
            <th>No clé</th>
            <th>Local</th>
            <th>Pavillon</th>
            <th>Utilisation</th>
            <th>Remarque</th>
            <th>État</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}
function renderNav(profile, role) {
  $("navHello").textContent = `Bonjour ${profile?.display_name ?? ""}`.trim();
  $("navRole").textContent = roleLabel(role);

  const links = buildNavLinks(role);

  // exemple: tout sauf Déconnexion en haut, Déconnexion en bas
  const top = links.filter(l => l.action !== "logout");
  const bottom = links.filter(l => l.action === "logout");

  $("navLinksTop").innerHTML = top.map((it) => {
    const cls = `nav-link${it.danger ? " danger" : ""}`;
    const hint = it.hint ? `<span class="hint">${it.hint}</span>` : "";
    const badge = it.badge > 0 ? `<span class="nav-badge">${it.badge}</span>` : "";
    const href = it.href ?? "#";
    const action = it.action ?? "";
    return `<a class="${cls}" href="${href}" data-action="${action}">${it.label}${hint}${badge}</a>`;
  }).join("");

  $("navLinksBottom").innerHTML = bottom.map((it) => {
    const cls = `nav-link${it.danger ? " danger" : ""}`;
    const href = it.href ?? "#";
    const action = it.action ?? "";
    return `<a class="${cls}" href="${href}" data-action="${action}">${it.label}</a>`;
  }).join("");
  syncTopbarLogoLink();
  bindNavEvents();
}


function suggestNextEmptyHook() {
  // trouve le plus petit crochet absent, en respectant le max du cabinet
  const used = new Set(
    [...state.keys, ...state.keyrings]
      .map((x) => Number(x.hook_no))
      .filter((n) => Number.isFinite(n) && n > 0),
  );
  const maxHooks = getCabinetMaxHooks(state.cabinetId);
  const upper = maxHooks ?? 4999;
  for (let n = 1; n <= upper; n++) {
    if (!used.has(n)) return n;
  }
  return maxHooks ?? 1;
}

function getCabinetMaxHooks(cabinetId = state.cabinetId) {
  const cab = state.cabinets.find((c) => Number(c.id) === Number(cabinetId));
  const max = Number(cab?.max_hooks);
  if (!Number.isFinite(max) || max <= 0) return null;
  return Math.trunc(max);
}

function assertHookWithinCabinetLimit(hookNo, cabinetId = state.cabinetId) {
  const n = Number(hookNo);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error("No de crochet invalide.");
  }
  const maxHooks = getCabinetMaxHooks(cabinetId);
  if (maxHooks != null && n > maxHooks) {
    throw new Error(`Ce cabinet permet un maximum de ${maxHooks} crochets.`);
  }
  return Math.trunc(n);
}

function alphaCode(idx) {
  // 0 -> A, 1 -> B, ... 25 -> Z, 26 -> AA, etc.
  let n = idx;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

function nextRingCodeForHook(hookNo) {
  const rings = state.keyrings.filter(kr => Number(kr.hook_no) === Number(hookNo));
  return alphaCode(rings.length);
}

async function createKeyringForImport({ cabinetId, hookNo, rows, sinceIso }) {
  const keyNoSet = new Set(rows.map(r => (r.key_no ?? "").trim()).filter(Boolean));
  const localSet = new Set(rows.map(r => (r.local ?? "").trim()).filter(Boolean));

  const { data: keys, error: keysErr } = await supa
    .from("keys")
    .select("id,key_no,local,updated_at")
    .eq("cabinet_id", cabinetId)
    .eq("hook_no", hookNo)
    .gte("updated_at", sinceIso);
  if (keysErr) throw keysErr;

  let picked = keys ?? [];
  if (keyNoSet.size || localSet.size) {
    picked = (keys ?? []).filter(k => {
      const keyNo = String(k.key_no ?? "").trim();
      const local = String(k.local ?? "").trim();
      return (keyNoSet.size && keyNoSet.has(keyNo)) || (localSet.size && localSet.has(local));
    });
  }

  if (!picked.length) return { created: false, keyIds: [] };

  const ringCode = nextRingCodeForHook(hookNo);
  const { data: ring, error: ringErr } = await supa
    .from("keyrings")
    .insert({
      cabinet_id: cabinetId,
      hook_no: hookNo,
      ring_code: ringCode,
      name: `Trousseau ${ringCode}`,
      note: null,
    })
    .select("id, ring_code")
    .single();
  if (ringErr) throw ringErr;

  const { error: itemsErr } = await supa
    .from("keys")
    .update({ keyring_id: ring.id })
    .in("id", picked.map(k => k.id));
  if (itemsErr) throw itemsErr;

  return { created: true, keyIds: picked.map(k => k.id), ringCode: ring.ring_code };
}



function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatPavilionOptionLabel(p) {
  const code = String(p?.code ?? "").trim();
  const nom = String(p?.nom ?? "").trim();
  const campus = String(p?.campus ?? "").trim();
  if (code && nom) return `(${code}) ${nom}`;
  if (code && campus) return `(${code}) ${campus}`;
  if (nom) return nom;
  if (campus) return campus;
  return "Sans libelle";
}

function getPavilionLegacyTextById(pavilionId) {
  const id = Number(pavilionId);
  if (!Number.isFinite(id)) return "";
  const p = state.pavilions.find(x => Number(x.id) === id);
  if (!p) return "";
  const code = String(p.code ?? "").trim();
  const nom = String(p.nom ?? "").trim();
  const campus = String(p.campus ?? "").trim();
  if (code && nom) return `(${code}) ${nom}`;
  if (code && campus) return `(${code}) ${campus}`;
  if (nom) return nom;
  if (campus) return campus;
  return "";
}

function getPavilionDisplayForKey(k) {
  const byId = getPavilionLegacyTextById(k?.pavilion_id);
  if (byId) return byId;
  return String(k?.pavillon ?? "").trim();
}

function resolvePavilionIdFromText(rawText) {
  const text = String(rawText ?? "").trim();
  if (!text) return null;

  const codeMatch = text.match(/\(([A-Za-z0-9]+)\)/);
  if (codeMatch?.[1]) {
    const code = normalizeText(codeMatch[1]);
    const byCode = state.pavilions.find(p => normalizeText(p.code ?? "") === code);
    if (byCode) return Number(byCode.id);
  }

  const norm = normalizeText(text).replace(/\s+/g, " ").trim();
  for (const p of state.pavilions) {
    const variants = [
      String(p.code ?? "").trim(),
      String(p.nom ?? "").trim(),
      String(p.campus ?? "").trim(),
      formatPavilionOptionLabel(p),
      getPavilionLegacyTextById(p.id),
    ].filter(Boolean);
    if (variants.some(v => normalizeText(v).replace(/\s+/g, " ").trim() === norm)) {
      return Number(p.id);
    }
  }
  return null;
}

function buildPavilionOptionsHtml(selectedId = null) {
  const selected = selectedId == null ? "" : String(selectedId);
  const options = [`<option value="">-- Aucun --</option>`];
  for (const p of state.pavilions) {
    const id = String(p.id);
    const sel = id === selected ? " selected" : "";
    options.push(`<option value="${escapeHtml(id)}"${sel}>${escapeHtml(formatPavilionOptionLabel(p))}</option>`);
  }
  return options.join("");
}

function renderPavilionSelects() {
  const manual = $("m_pavilion_id");
  if (manual) manual.innerHTML = buildPavilionOptionsHtml();
  const edit = $("edit_pavilion_id");
  if (edit) edit.innerHTML = buildPavilionOptionsHtml();
}


function setStatus(msg) {
  const el = document.getElementById("pageStatus");
  if (el) el.textContent = msg;
  console.log("[BOOT]", msg);
}


const PAGE_SIZE = 50;
let state = {
  role: "new_user",
  profile: null,
  cabinets: [],
  cabinetId: null,
  pavilions: [],
  keys: [],
  keyrings: [],
  loansByKey: new Map(),
  borrowersById: new Map(),
  missingByKey: new Map(),
  q: "",
  page: 0,
  hookModal: {
    open: false,
    hookNo: null,
    selectedKeyIds: new Set(),
    selectMode: false,
    pendingCreateKeyring: null,
    returnToCreateKeyring: false,
  },
  editModal: {
    open: false,
    keyId: null,
  },
  keyringEditModal: {
    open: false,
    keyringId: null,
  },
  keyringCreateModal: {
    open: false,
    hookNo: null,
    selectedKeyIds: new Set(),
  },
  keyringPickModal: {
    open: false,
    hookNo: null,
  },
  keyInRingModal: {
    open: false,
    keyId: null,
  },
  deleteKeyModal: {
    open: false,
    keyId: null,
  },
  missingPrompt: {
    open: false,
    keyId: null,
    mode: null, // "key" | "ring"
    keyringId: null,
    loanId: null,
  },
  proposalModal: {
    open: false,
    hookNo: null,
  },
  returnPrompt: {
    open: false,
    keyId: null,
    loanId: null,
    borrowerName: "",
    loanedAt: null,
    step: 1, // 1 = question retour, 2 = choisir retour/emprunt
  },
  adminLoanModal: {
    open: false,
    mode: "key",
    keyId: null,
    keyringId: null,
  },
  adminLoanUsers: [],
  openTargetHandled: false,
  suggestionCount: 0,
  pendingUserCount: 0,
  myOpenLoanCount: 0,
  cabinetEditModal: {
    open: false,
    cabinetId: null,
  },
  rolePermissions: defaultPermissionsForRole("new_user"),
};

function getCabinetFromUrl() {
  const p = new URLSearchParams(location.search);
  const v = p.get("cabinet");
  const n = v ? Number(v) : null;
  return Number.isFinite(n) ? n : null;
}

function getModeFromUrl() {
  const p = new URLSearchParams(location.search);
  const m = (p.get("mode") || "").toLowerCase();
  const cabinetValue = p.get("cabinet");
  const hasCabinet = cabinetValue != null && String(cabinetValue).trim() !== "" && Number.isFinite(Number(cabinetValue));
  if (m === "qr" && hasCabinet) return "qr";
  return m === "scan" || m === "browse" ? m : "";
}

function getRestrictedCabinetIdFromUrl() {
  if (getModeFromUrl() !== "qr") return null;
  return getCabinetFromUrl();
}

function getOpenTargetFromUrl() {
  const p = new URLSearchParams(location.search);
  const keyId = Number(p.get("open_key_id"));
  const keyringId = Number(p.get("open_keyring_id"));
  const hookNo = Number(p.get("open_hook_no"));
  return {
    keyId: Number.isFinite(keyId) ? keyId : null,
    keyringId: Number.isFinite(keyringId) ? keyringId : null,
    hookNo: Number.isFinite(hookNo) ? hookNo : null,
  };
}

function normalizeText(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function highlightText(value, query) {
  const text = String(value ?? "");
  const q = normalizeText(query);
  if (!q || !text) return escapeHtml(text);
  const normText = normalizeText(text);
  const idx = normText.indexOf(q);
  if (idx === -1) return escapeHtml(text);

  const map = [];
  for (let i = 0; i < text.length; i += 1) {
    const n = text[i].normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    for (let j = 0; j < n.length; j += 1) map.push(i);
  }
  const start = map[idx];
  const end = map[idx + q.length - 1];
  if (start == null || end == null) return escapeHtml(text);
  const before = escapeHtml(text.slice(0, start));
  const mid = escapeHtml(text.slice(start, end + 1));
  const after = escapeHtml(text.slice(end + 1));
  return `${before}<mark class="hl">${mid}</mark>${after}`;
}

function buildSearchDetailsForKey(k, query) {
  const q = normalizeText(query);
  if (!q) return [];
  const details = [];
  const fields = [
    { label: "Local", value: k.local },
    { label: "Département", value: k.departement },
    { label: "Utilisation", value: k.utilisation },
    { label: "Remarque", value: k.remarque },
  ];
  for (const f of fields) {
    const val = String(f.value ?? "");
    if (!val) continue;
    if (normalizeText(val).includes(q)) {
      details.push(`${f.label}: ${highlightText(val, query)}`);
    }
  }
  return details;
}

function buildKeyTicketLines(k, query = "") {
  const formatPart = (value) => {
    const text = String(value ?? "").trim();
    if (!text) return "";
    return query ? highlightText(text, query) : escapeHtml(text);
  };

  const line1 = [
    getPavilionDisplayForKey(k),
    k.local,
    k.departement,
  ]
    .map(formatPart)
    .filter(Boolean)
    .join(" • ");

  const line2Parts = [];
  const utilisation = formatPart(k.utilisation);
  if (utilisation) line2Parts.push(`Utilisation: ${utilisation}`);
  const remarque = formatPart(k.remarque);
  if (remarque) line2Parts.push(`Remarque: ${remarque}`);

  return {
    line1,
    line2: line2Parts.join(" • "),
  };
}

function setCabinetInUrl(cabinetId) {
  const u = new URL(location.href);
  u.searchParams.set("cabinet", String(cabinetId));
  history.pushState({}, "", u.toString());
  localStorage.setItem("sav_last_cabinet", String(cabinetId));
}


function formatKey(k) {
  // Si local ou key_no manquent, on affiche ce qu'on a
  const a = k.local ? `${k.local}` : "";
  const b = k.key_no ? `#${k.key_no}` : "";
  const text = [a, b].filter(Boolean).join(" ");
  return text.trim() || `Clé ${k.id}`;
}

function formatKeyTag(k) {
  const b = k.key_no ? `#${k.key_no}` : "";
  return b || `Clé ${k.id}`;
}

function hookTarget(cabinetId, hookNo) {
  const cab = Number.isFinite(Number(cabinetId)) ? Math.trunc(Number(cabinetId)) : "?";
  const hook = Number.isFinite(Number(hookNo)) ? Math.trunc(Number(hookNo)) : "?";
  return `hook:${cab}/${hook}`;
}

function keyTargetFromKey(k, fallbackKeyId = null) {
  const cab = Number.isFinite(Number(k?.cabinet_id ?? state.cabinetId)) ? Math.trunc(Number(k?.cabinet_id ?? state.cabinetId)) : "?";
  const hook = Number.isFinite(Number(k?.hook_no ?? state.hookModal?.hookNo)) ? Math.trunc(Number(k?.hook_no ?? state.hookModal?.hookNo)) : "?";
  const keyNo = String(k?.key_no ?? "").trim() || String(fallbackKeyId ?? k?.id ?? "?");
  return `key:${cab}/${hook}/${keyNo}`;
}

function keyringTargetFromRing(kr, fallback = {}) {
  const cab = Number.isFinite(Number(kr?.cabinet_id ?? fallback?.cabinet_id ?? state.cabinetId))
    ? Math.trunc(Number(kr?.cabinet_id ?? fallback?.cabinet_id ?? state.cabinetId))
    : "?";
  const hook = Number.isFinite(Number(kr?.hook_no ?? fallback?.hook_no))
    ? Math.trunc(Number(kr?.hook_no ?? fallback?.hook_no))
    : "?";
  const code = String(kr?.ring_code ?? fallback?.ring_code ?? "").trim().toUpperCase() || "?";
  return `keyring:${cab}/${hook}/${code}`;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return { header: [], rows: [] };

  const delim = (lines[0].includes(";") && !lines[0].includes(",")) ? ";" : ",";

  const header = lines[0].split(delim).map(h => h.trim());
  const rows = lines.slice(1).map(line => {
    const cols = line.split(delim);
    const obj = {};
    header.forEach((h, i) => obj[h] = (cols[i] ?? "").trim());
    return obj;
  });

  return { header, rows };
}

function isExcelFile(file) {
  const name = String(file?.name ?? "").toLowerCase();
  return name.endsWith(".xlsx") || name.endsWith(".xls");
}

async function parseExcelFile(file) {
  if (!window.XLSX) {
    throw new Error("Le module Excel n'est pas chargé. Recharge la page et réessaie.");
  }

  const buffer = await file.arrayBuffer();
  const workbook = window.XLSX.read(buffer, { type: "array" });
  const firstSheetName = workbook.SheetNames.find((name) => !!workbook.Sheets?.[name]);
  if (!firstSheetName) {
    return { header: [], rows: [], sourceLabel: "Excel" };
  }

  const sheet = workbook.Sheets[firstSheetName];
  const rows = window.XLSX.utils.sheet_to_json(sheet, {
    defval: "",
    raw: false,
  });
  const header = rows.length ? Object.keys(rows[0]) : [];
  return {
    header,
    rows: rows.map((row) => Object.fromEntries(
      Object.entries(row).map(([key, value]) => [String(key).trim(), String(value ?? "").trim()])
    )),
    sourceLabel: `Excel (${firstSheetName})`,
  };
}

async function parseImportFile(file) {
  if (isExcelFile(file)) return await parseExcelFile(file);
  const text = await file.text();
  const parsed = parseCsv(text);
  return {
    ...parsed,
    sourceLabel: "CSV",
  };
}


function renderPreview(container, rows, max = 25) {
  const shown = rows.slice(0, max);
  if (!shown.length) {
    container.innerHTML = `<div class="muted">Aucune ligne.</div>`;
    return;
  }

  const cols = Object.keys(shown[0]);
  container.innerHTML = `
    <div class="muted">Aperçu: ${rows.length} lignes (affichage ${shown.length})</div>
    <div style="overflow:auto; max-height:320px; border:1px solid #ddd; border-radius:10px; margin-top:8px;">
      <table style="width:100%; border-collapse:collapse; font-size:14px;">
        <thead>
          <tr>
            ${cols.map(c => `<th style="text-align:left; padding:8px; border-bottom:1px solid #eee;">${c}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          ${shown.map(r => `
            <tr>
              ${cols.map(c => `<td style="padding:8px; border-bottom:1px solid #f2f2f2;">${String(r[c] ?? "")}</td>`).join("")}
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}
function renderCabinetGrid() {
  const grid = $("cabinetGrid");
  const canSeeInactive = isAdminRole(state.role);
  const cards = canSeeInactive
    ? state.cabinets
    : state.cabinets.filter((c) => c.is_active !== false);
  grid.innerHTML = cards.map((c) => {
    const canEditCabinet = canAdministrateCabinet(c);
    const metaParts = [];
    if (c.is_active === false) metaParts.push("Hors fonction");
    if (c.location) metaParts.push(c.location);
    if (Number.isFinite(Number(c.max_hooks)) && Number(c.max_hooks) > 0) {
      metaParts.push(`max ${Math.trunc(Number(c.max_hooks))} crochets`);
    }
    metaParts.push(`Groupe ${groupLabel(c.user_group)}`);
    if (c.allow_consultation !== false) metaParts.push("Consultation");
    if (c.allow_self_borrow !== false) metaParts.push("Emprunts");
    if (c.allow_admin_lending === true) metaParts.push("Prêts admin");
    return `
      <div class="cabinet-card ${c.is_active === false ? "inactive" : ""}" data-cabinet-id="${c.id}">
        <div class="cabinet-card-head">
          <div class="cabinet-name">${c.name}</div>
          ${canEditCabinet
      ? (c.is_active === false
        ? `<button class="btn secondary reactive cabinet-reactivate-btn" data-cabinet-id="${c.id}" type="button">Remettre en fonction</button>`
        : `<button class="btn secondary icon-btn btn-edit cabinet-edit-btn" data-cabinet-id="${c.id}" type="button" aria-label="Éditer l'armoire">✎</button>`)
      : ""}
        </div>
        <div class="cabinet-meta">${metaParts.join(" • ")}</div>
      </div>
    `;
  }).join("");

  if (!grid.dataset.boundClicks) {
    grid.dataset.boundClicks = "1";
    grid.addEventListener("click", async (e) => {
        const reactivateBtn = e.target.closest("button.cabinet-reactivate-btn[data-cabinet-id]");
        if (reactivateBtn) {
          e.preventDefault();
          e.stopPropagation();
          const id = Number(reactivateBtn.dataset.cabinetId);
          const cabinet = state.cabinets.find((row) => Number(row.id) === id);
          if (!canAdministrateCabinet(cabinet)) return;
          if (!Number.isFinite(id)) return;
          const ok = confirm("Voulez vous remettre en fonction cette armoire ?");
          if (!ok) return;
        await updateCabinet(id, { is_active: true });
        await loadCabinets();
        renderCabinetGrid();
        return;
      }
      const editBtn = e.target.closest("button.cabinet-edit-btn[data-cabinet-id]");
      if (editBtn) {
        e.preventDefault();
        e.stopPropagation();
        const editId = Number(editBtn.dataset.cabinetId);
        const cabinet = state.cabinets.find((row) => Number(row.id) === editId);
        if (!canAdministrateCabinet(cabinet)) return;
        if (Number.isFinite(editId)) await openCabinetEditModal(editId);
        return;
      }

      const card = e.target.closest(".cabinet-card");
      if (!card) return;
      const id = Number(card.dataset.cabinetId);
      if (!Number.isFinite(id)) return;
      const cab = state.cabinets.find((c) => Number(c.id) === id);
      if (!cab || cab.is_active === false) return;

      state.cabinetId = id;
      setCabinetInUrl(id);

      $("homeView").style.display = "none";
      $("keysView").style.display = "";
      setPageTitle("Liste des clés");
      updateSessionInfoCabinet();

      $("cabinetSelect").value = String(id);

      await loadDataForCabinet();
      state.page = 0;
      render();
    });
  }
}

async function openCabinetEditModal(cabinetId) {
  const cab = state.cabinets.find((c) => Number(c.id) === Number(cabinetId));
  if (!cab || !canAdministrateCabinet(cab)) return;
  if (!state.pavilions?.length) {
    try {
      state.pavilions = await listPavilions();
    } catch {
      state.pavilions = [];
    }
  }
  state.cabinetEditModal.open = true;
  state.cabinetEditModal.cabinetId = Number(cab.id);
  $("cab_edit_name").value = String(cab.name ?? "");
  $("cab_edit_location").value = String(cab.location ?? "");
  $("cab_edit_max_hooks").value = Number.isFinite(Number(cab.max_hooks)) && Number(cab.max_hooks) > 0
    ? String(Math.trunc(Number(cab.max_hooks)))
    : "";
  $("cab_edit_pavilion_id").innerHTML = buildPavilionOptionsHtml(cab.pavilion_id ?? null);
  syncCabinetGroupInputs(cab.user_group);
  syncCabinetAvailabilityInputs(cab);
  $("cab_edit_user_group").value = normalizeGroup(cab.user_group);
  $("cab_edit_allow_consultation").checked = cab.allow_consultation !== false;
  $("cab_edit_allow_self_borrow").checked = cab.allow_self_borrow !== false;
  $("cab_edit_allow_admin_lending").checked = cab.allow_admin_lending === true;
  $("cab_edit_is_active").value = cab.is_active === false ? "false" : "true";
  $("cabEditStatus").textContent = "";
  $("cabinetEditOverlay").hidden = false;
  $("cabinetEditModal").hidden = false;
  $("cabinetEditModal").setAttribute("aria-hidden", "false");
}

function closeCabinetEditModal() {
  state.cabinetEditModal.open = false;
  state.cabinetEditModal.cabinetId = null;
  $("cabinetEditOverlay").hidden = true;
  $("cabinetEditModal").hidden = true;
  $("cabinetEditModal").setAttribute("aria-hidden", "true");
  $("cabEditStatus").textContent = "";
}

function openCabinetCreateModal() {
  if (!isAdminRole(state.role) || !canRole("creation")) return;
  $("cab_create_name").value = "";
  $("cab_create_location").value = "";
  $("cab_create_max_hooks").value = "";
  $("cab_create_pavilion_id").innerHTML = buildPavilionOptionsHtml(null);
  syncCabinetGroupInputs(getCurrentUserGroup());
  syncCabinetAvailabilityInputs({
    allow_consultation: true,
    allow_self_borrow: true,
    allow_admin_lending: false,
  });
  $("cab_create_user_group").value = getCurrentUserGroup();
  $("cabCreateStatus").textContent = "";
  $("cabinetCreateOverlay").hidden = false;
  $("cabinetCreateModal").hidden = false;
  $("cabinetCreateModal").setAttribute("aria-hidden", "false");
}

function closeCabinetCreateModal() {
  $("cabinetCreateOverlay").hidden = true;
  $("cabinetCreateModal").hidden = true;
  $("cabinetCreateModal").setAttribute("aria-hidden", "true");
  $("cabCreateStatus").textContent = "";
}


function validateCsvHeader(header) {
  const required = ["tag","key_no","pavillon","local","utilisation","departement","quantite","remarque"];
  const set = new Set(header.map(h => h.trim()));
  const missing = required.filter(r => !set.has(r));
  return missing;
}


function filterHook(hookNo, keysForHook, keyringsForHook, q) {
  if (!q) return true;
  const s = normalizeText(q);

  if (normalizeText(hookNo).includes(s)) return true;

  for (const k of keysForHook) {
    const t = normalizeText(`${k.local ?? ""} ${k.key_no ?? ""} ${k.remarque ?? ""} ${k.utilisation ?? ""} ${getPavilionDisplayForKey(k)} ${k.departement ?? ""} ${k.hook_no ?? ""}`);
    if (t.includes(s)) return true;
  }
  for (const kr of keyringsForHook) {
    if (normalizeText(kr.name ?? "").includes(s)) return true;
  }
  return false;
}

async function loadCabinets() {
  const cabinets = await listCabinets({ includeInactive: isAdminRole(state.role) });
  state.cabinets = filterCabinetsForCurrentUser(cabinets);
  const activeCabinets = state.cabinets.filter((c) => c.is_active !== false);
  const sel = $("cabinetSelect");
  sel.innerHTML = activeCabinets
    .map((c) => `<option value="${c.id}">${c.name}${c.location ? " — " + c.location : ""}</option>`)
    .join("");

  const currentCabinetId = Number(state.cabinetId);
  const stillAvailable = activeCabinets.find((c) => Number(c.id) === currentCabinetId);
  state.cabinetId = stillAvailable?.id ?? activeCabinets[0]?.id ?? null;
  if (state.cabinetId != null) sel.value = String(state.cabinetId);
}

async function loadDataForCabinet() {
  const cid = state.cabinetId; // bigint (id numerique) selon ta DB actuelle
  state.pavilions = await listPavilions();
  renderPavilionSelects();
  state.keys = await listKeysByCabinet(cid);
  state.keyrings = await listKeyringsByCabinet(cid);

  await loadLoansForKeys();
  await loadMissingForKeys();
}

function updateSessionInfoCabinet() {
  const cab = state.cabinets.find(c => Number(c.id) === Number(state.cabinetId));
  if (cab) {
    setSessionInfo(cab.location ? `${cab.name} — ${cab.location}` : cab.name);
  }
}

function getCurrentCabinetLabel() {
  const cab = state.cabinets.find(c => Number(c.id) === Number(state.cabinetId));
  if (!cab) return "";
  return cab.location ? `${cab.name} - ${cab.location}` : cab.name;
}

function applyCabinetMobileLayout(mode) {
  const compact = mode === "scan" || mode === "browse" || mode === "qr";
  document.body.classList.toggle("scan-cabinet-view", compact);
}

function updateCabinetHeaderForMode(mode) {
  updateSessionInfoCabinet();
  const label = getCurrentCabinetLabel();
  if (!label) return;
  if (mode === "scan" || mode === "browse" || mode === "qr") {
    setPageTitle(label);
    return;
  }
  setPageTitle("Liste des clés");
}

async function loadLoansForKeys() {
  const keyIds = state.keys.map(k => k.id);
  if (!keyIds.length) {
    state.loansByKey = new Map();
    state.borrowersById = new Map();
    return;
  }

  const loans = await listOpenLoansByKeyIds(keyIds);
  const loansByKey = new Map();
  const borrowerIds = new Set();
  for (const l of loans) {
    loansByKey.set(l.key_id, l);
    if (l.borrower_id) borrowerIds.add(l.borrower_id);
  }

  const profiles = await listProfilesByIds([...borrowerIds]);
  const borrowersById = new Map(profiles.map(p => [p.id, p.display_name ?? ""]));

  state.loansByKey = loansByKey;
  state.borrowersById = borrowersById;
}

async function loadMissingForKeys() {
  const keyIds = state.keys.map(k => k.id);
  if (!keyIds.length) {
    state.missingByKey = new Map();
    return;
  }
  const rows = await listMissingByKeyIds(keyIds);
  const reporterIds = [...new Set(rows.map(r => r.reported_by).filter(Boolean))];
  const reporterProfiles = await listProfilesByIds(reporterIds);
  const reportersById = new Map(reporterProfiles.map(p => [p.id, p.display_name ?? ""]));
  const missingByKey = new Map();
  for (const r of rows) {
    const name = reportersById.get(r.reported_by) ?? "";
    missingByKey.set(r.key_id, {
      reported_at: r.reported_at,
      reported_by: r.reported_by,
      reported_by_name: name,
    });
  }
  state.missingByKey = missingByKey;
}


function buildKeyringsByHook() {
  // itemsByRing: keyring_id -> [key_id]
  const keyById = new Map(state.keys.map((k) => [k.id, k]));
  const ringsByHook = new Map(); // hook_no -> [ {id, ring_code, name, keys:[]} ]
  const q = state.q;

  for (const kr of state.keyrings) {
    const kids = state.keys.filter(k => Number(k.keyring_id) === Number(kr.id)).map(k => k.id);

    const keys = kids
      .map((id) => keyById.get(id))
      .filter(Boolean)
      .sort(sortKeysByNo)
      .map((k) => ({
        key_id: k.id,
        text: formatKeyTag(k),
        details: buildSearchDetailsForKey(k, q),
        state: k.is_missing ? "missing" : (state.loansByKey?.has(k.id) ? "onloan" : "ok"),
      }));

    if (!ringsByHook.has(kr.hook_no)) ringsByHook.set(kr.hook_no, []);
    ringsByHook.get(kr.hook_no).push({
      id: kr.id,
      ring_code: kr.ring_code ?? "A",
      name: kr.name ?? "",
      keys,
    });
  }

  return ringsByHook;
}

function formatDateFr(d) {
  try {
    return new Date(d).toLocaleDateString("fr-CA");
  } catch {
    return String(d ?? "");
  }
}

function compareKeyNo(a, b) {
  const sa = String(a?.key_no ?? "").toUpperCase();
  const sb = String(b?.key_no ?? "").toUpperCase();
  if (!sa && !sb) return 0;
  if (!sa) return 1;
  if (!sb) return -1;
  return sa.localeCompare(sb, "fr", { numeric: true, sensitivity: "base" });
}

function sortKeysByNo(a, b) {
  const ma = a?.is_missing ? 1 : 0;
  const mb = b?.is_missing ? 1 : 0;
  if (ma !== mb) return ma - mb;
  return compareKeyNo(a, b);
}

function isForbiddenError(err) {
  const payload = err?.payload;
  const msg = payload?.error || err?.message || String(err);
  return String(msg).toLowerCase().includes("forbidden");
}

async function fnLoanReturnByKeyLocal(key_id) {
  const { data, error } = await supa.functions.invoke("loan-return", { body: { key_id } });
  if (error) throw error;
  const key = state.keys.find((k) => Number(k.id) === Number(key_id));
  await logAuditEvent({
    event_type: "loan_return",
    action: "loan_return",
    target: keyTargetFromKey(key, key_id),
    details: "Retour",
    source: "frontend",
  });
  return data;
}

async function fnLoanReturnAny({ loan_id, key_id }) {
  const body = {};
  if (Number.isFinite(loan_id)) body.loan_id = loan_id;
  if (Number.isFinite(key_id)) body.key_id = key_id;
  const { data, error } = await supa.functions.invoke("loan-return-any", { body });
  if (error) throw error;
  const key = Number.isFinite(key_id) ? state.keys.find((k) => Number(k.id) === Number(key_id)) : null;
  await logAuditEvent({
    event_type: "loan_return",
    action: "loan_return",
    target: key ? keyTargetFromKey(key, key_id) : (Number.isFinite(loan_id) ? `loan:${loan_id}` : `key:?/?/${key_id}`),
    details: "Retour",
    source: "frontend",
  });
  return data;
}

function getHookDetail(hookNo) {
  const keysForHook = state.keys
    .filter(k => Number(k.hook_no) === Number(hookNo))
    .sort(sortKeysByNo);
  const ringsByHook = buildKeyringsByHook();
  const keyringsForHook = ringsByHook.get(hookNo) ?? [];

  const singles = keysForHook
    .filter(k => !k.keyring_id)
    .sort(sortKeysByNo);

  return { hookNo, keyringsForHook, singles };
}

function setHookModalOpen(open) {
  const overlay = $("hookOverlay");
  const modal = $("hookModal");
  if (!overlay || !modal) return;

  overlay.hidden = !open;
  modal.hidden = !open;
  modal.setAttribute("aria-hidden", open ? "false" : "true");
  document.body.classList.toggle("modal-open", open);
}

function setHookSelectMode(on) {
  state.hookModal.selectMode = on;
  const modal = $("hookModal");
  if (modal) modal.classList.toggle("select-mode", on);
  updateSelectionUI();
}

function appendChunks(target, items, renderFn, chunkSize, onDone) {
  if (!target) return;
  if (!items.length) {
    if (onDone) onDone();
    return;
  }
  let i = 0;
  const size = chunkSize || 40;
  const step = () => {
    const end = Math.min(i + size, items.length);
    let html = "";
    for (; i < end; i += 1) html += renderFn(items[i]);
    if (html) target.insertAdjacentHTML("beforeend", html);
    if (i < items.length) requestAnimationFrame(step);
    else if (onDone) onDone();
  };
  requestAnimationFrame(step);
}

function updateSelectionUI() {
  const modal = $("hookModal");
  if (!modal) return;
  const rows = modal.querySelectorAll(".key-row[data-key-id]");
  rows.forEach((row) => {
    const keyId = Number(row.dataset.keyId);
    const selected = state.hookModal.selectedKeyIds.has(keyId);
    row.classList.toggle("selected", selected);
    const cb = row.querySelector("input.key-check[data-key-id]");
    if (cb) cb.checked = selected;
  });
  const selected = [...state.hookModal.selectedKeyIds];
  const selectedKeys = selected.map(id => state.keys.find(k => k.id === id)).filter(Boolean);
  const selectedWithout = selectedKeys.filter(k => !k.keyring_id);
  const selectedWith = selectedKeys.filter(k => k.keyring_id);
  const hookNo = state.hookModal.hookNo;
  const hasRings = state.keyrings.some(kr => Number(kr.hook_no) === Number(hookNo));

  const btnCreate = $("hookCreateKeyring");
  if (btnCreate) btnCreate.style.display = state.hookModal.selectMode && selectedWithout.length ? "" : "none";
  const btnAdd = $("hookAddToKeyring");
  if (btnAdd) btnAdd.style.display = state.hookModal.selectMode && selectedWithout.length && hasRings ? "" : "none";
  const btnRemove = $("hookRemoveFromKeyring");
  if (btnRemove) btnRemove.style.display = state.hookModal.selectMode && selectedWith.length ? "" : "none";
}

function renderHookModal(hookNo) {
  const { keyringsForHook, singles } = getHookDetail(hookNo);
  $("hookModalTitle").textContent = `Crochet #${hookNo}`;

  const canBorrow = canRole("emprunt");
  const canReturn = canRole("retour");
  const canSignal = canRole("signalement");
  const canSuggest = canRole("suggestion");
  const canEdit = canRole("edition");
  const canDelete = canRole("suppression");
  const canCreate = canRole("creation");
  const canMove = canRole("deplacement");
  const canAdminCurrentCabinet = canAdministrateCurrentCabinet();
  const canAdminLendCurrentCabinet = canAdminLendCabinet();
  const canSelfBorrowCurrentCabinet = canSelfBorrowCabinet();
  const canAdminActions = canAdminCurrentCabinet && (canCreate || canMove || canEdit || canDelete);
  $("hookModalActions").style.display = (canAdminActions || canSuggest) ? "flex" : "none";
  const btnBorrowAll = $("hookBorrowAll");
  if (btnBorrowAll) btnBorrowAll.style.display = canSelfBorrowCurrentCabinet ? "" : "none";
  const btnReturnAll = $("hookReturnAll");
  if (btnReturnAll) btnReturnAll.style.display = canReturn ? "" : "none";
  const btnAddKey = $("hookAddKey");
  if (btnAddKey) btnAddKey.style.display = canAdminCurrentCabinet && canCreate ? "" : "none";
  const btnSuggest = $("hookProposals");
  if (btnSuggest) btnSuggest.style.display = canSuggest ? "" : "none";

  const keyById = new Map(state.keys.map(k => [k.id, k]));
  const renderKeyRow = (k, { showCheck, showLoanToggle, showLoanLine }) => {
    const checked = showCheck && state.hookModal.selectedKeyIds.has(k.id) ? "checked" : "";
    const loan = state.loansByKey?.get(k.id);
    const statusClass = k.is_missing ? "kpill missing" : (loan ? "kpill onloan" : "kpill");
    const role = state.role;
    const borrowerName = loan ? loanBorrowerLabel(loan) : "";
    const loanLine = loan ? `Emprunté par: ${escapeHtml(borrowerName)} le ${escapeHtml(formatDateFr(loan.loaned_at))}` : "";
    const missInfo = state.missingByKey?.get(k.id);
    const missName = missInfo?.reported_by_name || "—";
    const missDate = missInfo?.reported_at ? formatDateFr(missInfo.reported_at) : "";
    const missLine = missInfo ? `Disparue, signalement de ${escapeHtml(missName)} le ${escapeHtml(missDate)}` : "";
    const wantsAdminLoan = !loan && canAdminLendCurrentCabinet;
    const toggleAction = loan ? "key-return" : (wantsAdminLoan ? "key-admin-loan" : "key-borrow");
    const toggleLabel = loan ? "Retourner" : (wantsAdminLoan ? "Prêter" : "Emprunter");
    const toggleDisabledReason = (!loan && k.is_missing)
      ? `Impossible de ${wantsAdminLoan ? "prêter" : "emprunter"} la clé ! Clé signalée disparue.`
      : "";
    const toggleBtnClass = `btn reactive${toggleDisabledReason ? " is-disabled" : ""}`;
    const toggleAttrs = toggleDisabledReason
      ? `aria-disabled="true" data-disabled-reason="${escapeHtml(toggleDisabledReason)}"`
      : "";
    const loanIdAttr = loan ? `data-loan-id="${loan.id}"` : "";
    const selectedClass = state.hookModal.selectedKeyIds.has(k.id) ? " selected" : "";
    const q = state.q;
    const ticketLines = buildKeyTicketLines(k, q);
    return `
      <div class="key-row${selectedClass}" data-key-id="${k.id}">
        ${!canAdminActions || !showCheck ? "" : `<input class="key-check" type="checkbox" data-key-id="${k.id}" ${checked} />`}
        <span class="${statusClass}">${escapeHtml(formatKeyTag(k))}${k.is_missing && missLine && k.keyring_id ? ` <span class="kpill-note">${missLine}</span>` : ""}</span>
        <div class="key-main">
          ${ticketLines.line1 ? `<div class="muted">${ticketLines.line1}</div>` : ""}
          ${ticketLines.line2 ? `<div class="muted">${ticketLines.line2}</div>` : ""}
          ${loan && showLoanLine ? `<div class="muted">${loanLine}</div>` : ""}
          ${k.is_missing && missLine && !k.keyring_id ? `<div class="muted">${missLine}</div>` : ""}
        </div>
        ${(canSelfBorrowCurrentCabinet || canReturn || canSignal || canAdminLendCurrentCabinet || (canAdminCurrentCabinet && (canEdit || canDelete))) ? `
          <div class="key-actions">
            ${(showLoanToggle && ((loan && canReturn) || (!loan && (canSelfBorrowCurrentCabinet || canAdminLendCurrentCabinet)))) ? `
              <button class="${toggleBtnClass} ${toggleAction === "key-return" ? "btn-return" : "btn-borrow"}" data-action="${toggleAction}" data-key-id="${k.id}" ${loanIdAttr} ${toggleAttrs}>${toggleLabel}</button>
            ` : ""}
            ${canSignal ? `<button class="btn secondary reactive btn-missing" data-action="${k.is_missing ? "key-found" : "key-missing"}" data-key-id="${k.id}">
              ${k.is_missing ? "Signalée retrouvée" : "Signaler disparue"}
            </button>` : ""}
            ${canAdminCurrentCabinet && canEdit ? `
              <button class="btn secondary icon-btn reactive btn-edit" data-action="key-edit" data-key-id="${k.id}" title="éditer">✎</button>
            ` : ""}
            ${canAdminCurrentCabinet && canDelete ? `
              <button class="btn danger icon-btn reactive btn-delete" data-action="key-delete" data-key-id="${k.id}" title="Supprimer">X</button>
            ` : ""}
          </div>
        ` : ""}
      </div>
    `;
  };

  const container = $("hookModalContent");
  container.innerHTML = `
    <div class="hook-section">
      <div class="hook-section-title">Clés / Trousseaux</div>
      <div class="hook-list" id="hookList"></div>
    </div>
  `;

  const listEl = $("hookList");
  let pending = 0;
  const done = () => {
    pending -= 1;
    if (pending <= 0) updateSelectionUI();
  };

  for (const kr of keyringsForHook) {
    const hasMissing = kr.keys.some(k => k.state === "missing");
    const hasOnLoan = kr.keys.some(k => k.state === "onloan");
    const wantsAdminLoan = !hasOnLoan && canAdminLendCurrentCabinet;
    const toggleAction = hasOnLoan ? "keyring-return" : (wantsAdminLoan ? "keyring-admin-loan" : "keyring-borrow");
    const toggleLabel = hasOnLoan ? "Retourner" : (wantsAdminLoan ? "Prêter" : "Emprunter");
    const toggleDisabledReason = (!hasOnLoan && hasMissing)
      ? `Impossible de ${wantsAdminLoan ? "prêter" : "emprunter"} le trousseau ! Une clé est signalée disparue.`
      : "";
    const toggleBtnClass = `btn reactive${toggleDisabledReason ? " is-disabled" : ""}`;
    const toggleAttrs = toggleDisabledReason
      ? `aria-disabled="true" data-disabled-reason="${escapeHtml(toggleDisabledReason)}"`
      : "";
    const role = state.role;
    const keyringKeys = kr.keys
      .map(k => keyById.get(k.key_id))
      .filter(Boolean);
    const ringLoans = keyringKeys
      .map(k => state.loansByKey?.get(k.id))
      .filter(Boolean);
    const ringBorrowers = [...new Set(ringLoans.map((loan) => loanBorrowerLabel(loan)))];
    const ringLoanLine = ringLoans.length
      ? (ringBorrowers.length === 1
          ? `Emprunté par: ${escapeHtml(ringBorrowers[0])} le ${escapeHtml(formatDateFr(ringLoans[0].loaned_at))}`
          : `Emprunté par: ${escapeHtml(ringBorrowers[0])} + ${ringBorrowers.length - 1} autre(s)`)
      : "";
    const ringPillClass = hasMissing ? "kpill missing" : (hasOnLoan ? "kpill onloan" : "kpill");
    const bodyId = `keyringBody-${kr.id}`;
    listEl.insertAdjacentHTML("beforeend", `
      <div class="keyring-card">
        <div class="keyring-header">
          <div class="keyring-info">
            <div class="keyring-title">
              <span class="${ringPillClass}">Trousseau ${escapeHtml(kr.ring_code ?? "A")}${kr.name ? ` (${escapeHtml(kr.name)})` : ""}</span>
              <span class="muted">(${keyringKeys.length} clés)</span>
            </div>
            ${ringLoanLine ? `<div class="muted keyring-loan">${ringLoanLine}</div>` : ""}
          </div>
          ${((canSelfBorrowCurrentCabinet || canReturn || canAdminLendCurrentCabinet) || (canAdminCurrentCabinet && (canEdit || canDelete))) ? `
            <div class="key-actions keyring-actions">
              ${((hasOnLoan && canReturn) || (!hasOnLoan && (canSelfBorrowCurrentCabinet || canAdminLendCurrentCabinet))) ? `
                <button class="${toggleBtnClass} ${toggleAction === "keyring-return" ? "btn-return" : "btn-borrow"}" data-action="${toggleAction}" data-keyring-id="${kr.id}" ${toggleAttrs}>${toggleLabel}</button>
              ` : ""}
              ${canAdminCurrentCabinet && canEdit ? `
                <button class="btn secondary icon-btn reactive btn-edit" data-action="keyring-edit" data-keyring-id="${kr.id}" title="éditer">✎</button>
              ` : ""}
              ${canAdminCurrentCabinet && canDelete ? `
                <button class="btn danger icon-btn reactive btn-delete" data-action="keyring-delete" data-keyring-id="${kr.id}" title="Supprimer">X</button>
              ` : ""}
            </div>
          ` : ""}
        </div>
        <div class="keyring-body" id="${bodyId}">
          ${keyringKeys.length ? "" : `<div class="muted">Aucune clé dans ce trousseau.</div>`}
        </div>
      </div>
    `);

    if (keyringKeys.length) {
      pending += 1;
      const bodyEl = document.getElementById(bodyId);
      appendChunks(
        bodyEl,
        keyringKeys,
        (k) => renderKeyRow(k, { showCheck: true, showLoanToggle: false, showLoanLine: false }),
        30,
        done,
      );
    }
  }

  if (singles.length) {
    const singlesId = "hookSingles";
    listEl.insertAdjacentHTML("beforeend", `<div id="${singlesId}"></div>`);
    pending += 1;
    const singlesEl = document.getElementById(singlesId);
    appendChunks(
      singlesEl,
      singles,
      (k) => renderKeyRow(k, { showCheck: true, showLoanToggle: true, showLoanLine: true }),
      40,
      done,
    );
  }

  if (pending === 0) updateSelectionUI();
  setHookSelectMode(state.hookModal.selectMode);
}

function openHookModal(hookNo) {
  state.hookModal.open = true;
  state.hookModal.hookNo = hookNo;
  renderHookModal(hookNo);
  setHookModalOpen(true);
}

function closeHookModal() {
  state.hookModal.open = false;
  state.hookModal.hookNo = null;
  state.hookModal.selectedKeyIds.clear();
  state.hookModal.selectMode = false;
  setHookSelectMode(false);
  setHookModalOpen(false);
}

function setEditModalOpen(open) {
  const overlay = $("editOverlay");
  const modal = $("editModal");
  if (!overlay || !modal) return;
  overlay.hidden = !open;
  modal.hidden = !open;
  modal.setAttribute("aria-hidden", open ? "false" : "true");
}

function setKeyringEditModalOpen(open) {
  const overlay = $("keyringEditOverlay");
  const modal = $("keyringEditModal");
  if (!overlay || !modal) return;
  overlay.hidden = !open;
  modal.hidden = !open;
  modal.setAttribute("aria-hidden", open ? "false" : "true");
}

function setKeyringCreateModalOpen(open) {
  const overlay = $("keyringCreateOverlay");
  const modal = $("keyringCreateModal");
  if (!overlay || !modal) return;
  overlay.hidden = !open;
  modal.hidden = !open;
  modal.setAttribute("aria-hidden", open ? "false" : "true");
}

function setKeyringPickModalOpen(open) {
  const overlay = $("keyringPickOverlay");
  const modal = $("keyringPickModal");
  if (!overlay || !modal) return;
  overlay.hidden = !open;
  modal.hidden = !open;
  modal.setAttribute("aria-hidden", open ? "false" : "true");
}

function setKeyInRingModalOpen(open) {
  const overlay = $("keyInRingOverlay");
  const modal = $("keyInRingModal");
  if (!overlay || !modal) return;
  overlay.hidden = !open;
  modal.hidden = !open;
  modal.setAttribute("aria-hidden", open ? "false" : "true");
}

function setDeleteKeyModalOpen(open) {
  const overlay = $("deleteKeyOverlay");
  const modal = $("deleteKeyModal");
  if (!overlay || !modal) return;
  overlay.hidden = !open;
  modal.hidden = !open;
  modal.setAttribute("aria-hidden", open ? "false" : "true");
}

function setMissingPromptOpen(open) {
  const overlay = $("missingPromptOverlay");
  const modal = $("missingPromptModal");
  if (!overlay || !modal) return;
  overlay.hidden = !open;
  modal.hidden = !open;
  modal.setAttribute("aria-hidden", open ? "false" : "true");
}

function setProposalModalOpen(open) {
  const overlay = $("proposalOverlay");
  const modal = $("proposalModal");
  if (!overlay || !modal) return;
  overlay.hidden = !open;
  modal.hidden = !open;
  modal.setAttribute("aria-hidden", open ? "false" : "true");
}

function setReturnPromptOpen(open) {
  const overlay = $("returnPromptOverlay");
  const modal = $("returnPromptModal");
  if (!overlay || !modal) return;
  overlay.hidden = !open;
  modal.hidden = !open;
  modal.setAttribute("aria-hidden", open ? "false" : "true");
}

function setAdminLoanModalOpen(open) {
  const overlay = $("adminLoanOverlay");
  const modal = $("adminLoanModal");
  if (!overlay || !modal) return;
  overlay.hidden = !open;
  modal.hidden = !open;
  modal.setAttribute("aria-hidden", open ? "false" : "true");
}

function getCurrentKeyringIdForKey(keyId) {
  const key = state.keys.find(k => k.id === keyId);
  if (!key) return null;
  return key.keyring_id ?? null;
}

function renderEditModal(keyId) {
  const key = state.keys.find(k => k.id === keyId);
  if (!key) return;

  $("edit_hook_no").value = key.hook_no ?? "";
  $("edit_key_no").value = key.key_no ?? "";
  $("edit_local").value = key.local ?? "";
  $("edit_utilisation").value = key.utilisation ?? "";
  $("edit_remarque").value = key.remarque ?? "";
  $("edit_quantite").value = key.quantite ?? "1";
  const inferredPavilionId = resolvePavilionIdFromText(key.pavillon);
  $("edit_pavilion_id").innerHTML = buildPavilionOptionsHtml(key.pavilion_id ?? inferredPavilionId ?? null);
  $("editStatus").textContent = "";
  const inRing = Number.isFinite(key.keyring_id);
  $("edit_hook_no").disabled = inRing;
  if (inRing) {
    $("editStatus").textContent = "Clé dans un trousseau : retirer du trousseau pour changer de crochet.";
  }

  const hookNo = Number(key.hook_no);
  const rings = state.keyrings.filter(kr => Number(kr.hook_no) === hookNo);
  const currentRingId = getCurrentKeyringIdForKey(keyId);

  const options = [
    `<option value="">Aucun trousseau</option>`,
    ...rings.map(kr => `<option value="${kr.id}">Trousseau ${escapeHtml(kr.ring_code ?? "A")}</option>`),
  ];
  $("edit_keyring").innerHTML = options.join("");
  $("edit_keyring").value = currentRingId ? String(currentRingId) : "";
}

function openEditModal(keyId) {
  state.editModal.open = true;
  state.editModal.keyId = keyId;
  renderEditModal(keyId);
  setEditModalOpen(true);
}

function closeEditModal() {
  state.editModal.open = false;
  state.editModal.keyId = null;
  setEditModalOpen(false);
}

function renderKeyringEditModal(keyringId) {
  const kr = state.keyrings.find(k => k.id === keyringId);
  if (!kr) return;
  $("kr_edit_hook_no").value = kr.hook_no ?? "";
  $("kr_edit_ring_code").value = kr.ring_code ?? "";
  $("kr_edit_name").value = kr.name ?? "";
  $("kr_edit_note").value = kr.note ?? "";
  $("kr_edit_hook").textContent = `Crochet #${kr.hook_no ?? "—"}`;
}

function openKeyringEditModal(keyringId) {
  state.keyringEditModal.open = true;
  state.keyringEditModal.keyringId = keyringId;
  renderKeyringEditModal(keyringId);
  setKeyringEditModalOpen(true);
}

function closeKeyringEditModal() {
  state.keyringEditModal.open = false;
  state.keyringEditModal.keyringId = null;
  setKeyringEditModalOpen(false);
}

function renderKeyringCreateModal(hookNo, selectedIds) {
  $("kr_create_hook").textContent = `Crochet #${hookNo ?? "—"}`;
  $("krCreateStatus").textContent = "";
  const code = nextRingCodeForHook(hookNo);
  $("kr_create_ring_code").value = code;
  $("kr_create_name").value = "";
  $("kr_create_note").value = "";

      const keysForHook = state.keys
        .filter(k => Number(k.hook_no) === Number(hookNo))
        .sort(sortKeysByNo);
  const listHtml = keysForHook.map(k => {
    const checked = selectedIds.has(k.id) ? "checked" : "";
    const statusClass = k.is_missing ? "kpill missing" : (state.loansByKey?.has(k.id) ? "kpill onloan" : "kpill");
    const ticketLines = buildKeyTicketLines(k);
    return `
      <label class="keyring-create-item">
        <input class="keyring-create-check" type="checkbox" data-key-id="${k.id}" ${checked} />
        <span class="${statusClass}">${escapeHtml(formatKeyTag(k))}</span>
        <div>
          ${ticketLines.line1 ? `<div class="meta">${ticketLines.line1}</div>` : ""}
          ${ticketLines.line2 ? `<div class="meta">${ticketLines.line2}</div>` : ""}
        </div>
      </label>
    `;
  }).join("");
  $("krCreateList").innerHTML = listHtml || `<div class="muted">Aucune clé sur ce crochet.</div>`;
}

function openKeyringCreateModal(hookNo, selectedIds) {
  state.keyringCreateModal.open = true;
  state.keyringCreateModal.hookNo = hookNo;
  state.keyringCreateModal.selectedKeyIds = new Set(selectedIds);
  renderKeyringCreateModal(hookNo, state.keyringCreateModal.selectedKeyIds);
  setKeyringCreateModalOpen(true);
}

function closeKeyringCreateModal() {
  state.keyringCreateModal.open = false;
  state.keyringCreateModal.hookNo = null;
  state.keyringCreateModal.selectedKeyIds.clear();
  setKeyringCreateModalOpen(false);
}

function renderKeyringPickModal(hookNo) {
  $("kr_pick_hook").textContent = `Crochet #${hookNo ?? "—"}`;
  $("krPickStatus").textContent = "";
  const rings = state.keyrings.filter(kr => Number(kr.hook_no) === Number(hookNo));
  const options = rings.map(kr => {
    const label = `Trousseau ${kr.ring_code ?? "A"}${kr.name ? ` (${kr.name})` : ""}`;
    return `<option value="${kr.id}">${escapeHtml(label)}</option>`;
  });
  $("kr_pick_select").innerHTML = options.join("") || `<option value="">Aucun trousseau</option>`;
}

function openKeyringPickModal(hookNo) {
  state.keyringPickModal.open = true;
  state.keyringPickModal.hookNo = hookNo;
  renderKeyringPickModal(hookNo);
  setKeyringPickModalOpen(true);
}

function closeKeyringPickModal() {
  state.keyringPickModal.open = false;
  state.keyringPickModal.hookNo = null;
  setKeyringPickModalOpen(false);
}

function openKeyInRingModal(keyId) {
  state.keyInRingModal.open = true;
  state.keyInRingModal.keyId = keyId;
  $("keyInRingStatus").textContent = "";
  setKeyInRingModalOpen(true);
}

function closeKeyInRingModal() {
  state.keyInRingModal.open = false;
  state.keyInRingModal.keyId = null;
  setKeyInRingModalOpen(false);
}

function openDeleteKeyModal(keyId) {
  state.deleteKeyModal.open = true;
  state.deleteKeyModal.keyId = keyId;
  $("delete_key_reason").value = "";
  $("deleteKeyStatus").textContent = "";
  setDeleteKeyModalOpen(true);
}

function closeDeleteKeyModal() {
  state.deleteKeyModal.open = false;
  state.deleteKeyModal.keyId = null;
  setDeleteKeyModalOpen(false);
}

function openMissingPrompt({ keyId, mode, keyringId, loanId, text }) {
  state.missingPrompt.open = true;
  state.missingPrompt.keyId = keyId;
  state.missingPrompt.mode = mode;
  state.missingPrompt.keyringId = keyringId ?? null;
  state.missingPrompt.loanId = loanId ?? null;
  $("missingPromptText").textContent = text || "—";
  $("missingPromptStatus").textContent = "";
  setMissingPromptOpen(true);
}

function openProposalModal(hookNo) {
  state.proposalModal.open = true;
  state.proposalModal.hookNo = hookNo ?? null;
  $("proposalMessage").value = "";
  $("proposalStatus").textContent = "";

  $("proposalScopeGeneral").checked = false;
  $("proposalScopeSpecific").checked = true;

  const keysForHook = state.keys
    .filter(k => Number(k.hook_no) === Number(hookNo))
    .sort(sortKeysByNo);
  const ringsForHook = state.keyrings.filter(kr => Number(kr.hook_no) === Number(hookNo));
  const opts = [
    `<option value="hook">Crochet #${hookNo}</option>`,
    ...ringsForHook.map(kr => {
      const label = `Trousseau ${kr.ring_code ?? "A"}${kr.name ? ` (${kr.name})` : ""}`;
      return `<option value="ring:${kr.id}">${escapeHtml(label)}</option>`;
    }),
    ...keysForHook.map(k => {
      const label = `${formatKeyTag(k)}${k.local ? ` — ${k.local}` : ""}`;
      return `<option value="key:${k.id}">${escapeHtml(label)}</option>`;
    }),
  ];
  $("proposalTarget").innerHTML = opts.join("");
  $("proposalTarget").value = "hook";
  $("proposalTargetRow").style.display = "";
  setProposalModalOpen(true);
}

function closeProposalModal() {
  state.proposalModal.open = false;
  state.proposalModal.hookNo = null;
  setProposalModalOpen(false);
}

function handleOpenTargetFromUrl() {
  if (state.openTargetHandled) return;
  const { keyId, keyringId, hookNo } = getOpenTargetFromUrl();
  if (!keyId && !keyringId && !hookNo) return;

  let targetHook = hookNo;
  if (!targetHook && keyId) {
    const key = state.keys.find(k => k.id === keyId);
    targetHook = key?.hook_no ?? null;
  }
  if (!targetHook && keyringId) {
    const ring = state.keyrings.find(r => r.id === keyringId);
    targetHook = ring?.hook_no ?? null;
  }

  if (Number.isFinite(targetHook)) {
    openHookModal(targetHook);
    if (keyId) openEditModal(keyId);
    else if (keyringId) openKeyringEditModal(keyringId);
  }
  state.openTargetHandled = true;
}

function closeMissingPrompt() {
  state.missingPrompt.open = false;
  state.missingPrompt.keyId = null;
  state.missingPrompt.mode = null;
  state.missingPrompt.keyringId = null;
  state.missingPrompt.loanId = null;
  setMissingPromptOpen(false);
}

function renderReturnPromptStep() {
  const step = state.returnPrompt.step;
  const yesRow = $("returnPromptYesRow");
  const actionRow = $("returnPromptActionRow");
  const textEl = $("returnPromptText");
  if (!yesRow || !actionRow || !textEl) return;

  if (step === 1) {
    const name = state.returnPrompt.borrowerName || "—";
    const date = state.returnPrompt.loanedAt ? formatDateFr(state.returnPrompt.loanedAt) : "—";
    textEl.textContent = `Cette clé est empruntée par ${name} le ${date}. Est-elle de retour sur le crochet ?`;
    yesRow.style.display = "";
    actionRow.style.display = "none";
  } else {
    textEl.textContent = "Voulez-vous la retourner ou l'emprunter ?";
    yesRow.style.display = "none";
    actionRow.style.display = "";
  }
}

function openReturnPrompt({ keyId, loanId, borrowerName, loanedAt }) {
  state.returnPrompt.open = true;
  state.returnPrompt.keyId = keyId;
  state.returnPrompt.loanId = loanId ?? null;
  state.returnPrompt.borrowerName = borrowerName ?? "";
  state.returnPrompt.loanedAt = loanedAt ?? null;
  state.returnPrompt.step = 1;
  $("returnPromptStatus").textContent = "";
  renderReturnPromptStep();
  setReturnPromptOpen(true);
}

function closeReturnPrompt() {
  state.returnPrompt.open = false;
  state.returnPrompt.keyId = null;
  state.returnPrompt.loanId = null;
  state.returnPrompt.borrowerName = "";
  state.returnPrompt.loanedAt = null;
  state.returnPrompt.step = 1;
  setReturnPromptOpen(false);
}

function buildAdminLoanUsersOptions(cabinet = null) {
  const currentCabinet = cabinet || state.cabinets.find((row) => Number(row.id) === Number(state.cabinetId));
  const targetGroup = normalizeGroup(currentCabinet?.user_group ?? getCurrentUserGroup());
  const users = state.adminLoanUsers
    .filter((user) => normalizeRole(user.role) !== "new_user")
    .filter((user) => isSuperAdminRole(state.role) || normalizeGroup(user.user_group) === targetGroup)
    .sort((a, b) => String(a.display_name ?? "").localeCompare(String(b.display_name ?? ""), "fr-CA"));

  return [
    `<option value="">Choisir un utilisateur</option>`,
    ...users.map((user) => `<option value="${escapeHtml(String(user.id))}">${escapeHtml(`${user.display_name || "Sans nom"} — ${groupLabel(user.user_group)}`)}</option>`),
  ].join("");
}

async function ensureAdminLoanUsersLoaded() {
  if (state.adminLoanUsers.length) return;
  state.adminLoanUsers = await listUserProfiles();
}

async function openAdminLoanModal({ mode, keyId = null, keyringId = null } = {}) {
  if (!canAdminLendCabinet()) return;
  await ensureAdminLoanUsersLoaded();
  state.adminLoanModal.open = true;
  state.adminLoanModal.mode = mode === "keyring" ? "keyring" : "key";
  state.adminLoanModal.keyId = Number.isFinite(Number(keyId)) ? Number(keyId) : null;
  state.adminLoanModal.keyringId = Number.isFinite(Number(keyringId)) ? Number(keyringId) : null;

  const text = $("adminLoanText");
  if (text) {
    if (state.adminLoanModal.mode === "keyring") {
      const keyring = state.keyrings.find((row) => Number(row.id) === Number(state.adminLoanModal.keyringId));
      text.textContent = keyring
        ? `Trousseau ${keyring.ring_code ?? "A"}${keyring.name ? ` (${keyring.name})` : ""}`
        : "Prêter ce trousseau";
    } else {
      const key = state.keys.find((row) => Number(row.id) === Number(state.adminLoanModal.keyId));
      text.textContent = key
        ? `${formatKeyTag(key)}${key.local ? ` — ${key.local}` : ""}`
        : "Prêter cette clé";
    }
  }

  $("adminLoanBorrowerSelect").innerHTML = buildAdminLoanUsersOptions();
  $("adminLoanBorrowerSelect").value = "";
  $("adminLoanBorrowerCustom").value = "";
  $("adminLoanNote").value = "";
  $("adminLoanStatus").textContent = "";
  setAdminLoanModalOpen(true);
}

function closeAdminLoanModal() {
  state.adminLoanModal.open = false;
  state.adminLoanModal.mode = "key";
  state.adminLoanModal.keyId = null;
  state.adminLoanModal.keyringId = null;
  $("adminLoanStatus").textContent = "";
  setAdminLoanModalOpen(false);
}

async function refreshAfterAction() {
  await loadDataForCabinet();
  render();
  if (state.hookModal.open && state.hookModal.hookNo != null) {
    renderHookModal(state.hookModal.hookNo);
  }
}


function render() {

  const grouped = groupByHook(state.keys);
  const ringsByHook = buildKeyringsByHook();

  // Filtrer selon recherche + pagination sur crochets (pas sur clés)
  const filteredHooks = grouped.filter(([hookNo, keysForHook]) => {
    const keyringsForHook = ringsByHook.get(hookNo) ?? [];
    return filterHook(hookNo, keysForHook, keyringsForHook, state.q);
  });

  const total = filteredHooks.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  state.page = Math.max(0, Math.min(state.page, pageCount - 1));

  const start = state.page * PAGE_SIZE;
  const pageItems = filteredHooks.slice(start, start + PAGE_SIZE);
  renderPager(pageCount, total);

  $("pageInfo").textContent = `Page ${state.page + 1} / ${pageCount} — ${total} crochets`;

  const consultMode = state.role === "consultant" || (state.role === "user" && getModeFromUrl() === "browse");
  const html = pageItems
    .map(([hookNo, keysForHook]) => {
      const keyringsForHook = ringsByHook.get(hookNo) ?? [];

      // Clés "simples" (celles qui ne sont pas dans un trousseau)
      const ringKeyIds = new Set();
      for (const kr of keyringsForHook) for (const k of kr.keys) ringKeyIds.add(k.key_id);

      const singles = keysForHook
        .filter((k) => !ringKeyIds.has(k.id))
        .map((k) => ({
          key_id: k.id,
          text: formatKeyTag(k),
          details: buildSearchDetailsForKey(k, state.q),
          state: k.is_missing ? "missing" : (state.loansByKey?.has(k.id) ? "onloan" : "ok"),
        }));

      return renderHookCard({
        hookNo,
        keyLines: singles,
        keyrings: keyringsForHook,
        role: consultMode ? "consultant" : state.role,
      });
    })
    .join("");

  $("list").innerHTML = html || `<div class="muted" style="padding:12px;">Aucun résultat.</div>`;
}

function renderPager(pageCount, total) {
  const current = state.page + 1;
  const makeLink = (p, label = null, cls = "") =>
    `<button class="page-link ${cls}" data-page="${p}">${label ?? p}</button>`;

  let html = "";
  if (pageCount > 1 && current > 1) {
    html += makeLink(current - 1, "Précédent", "pager-prev");
  } else {
    html += `<button class="page-link pager-prev is-disabled" aria-disabled="true">Précédent</button>`;
  }

  const maxButtons = 4;
  let start = Math.max(1, current - 1);
  let end = Math.min(pageCount, start + maxButtons - 1);
  start = Math.max(1, end - maxButtons + 1);

  if (start > 1) {
    html += `<span class="pager-ellipsis">—</span>`;
  }

  for (let p = start; p <= end; p += 1) {
    html += makeLink(p, String(p), p === current ? "active" : "");
  }

  if (end < pageCount) {
    html += `<span class="pager-ellipsis">—</span>`;
  }

  if (pageCount > 1 && current < pageCount) {
    html += makeLink(current + 1, "Suivant", "pager-next");
  } else {
    html += `<button class="page-link pager-next is-disabled" aria-disabled="true">Suivant</button>`;
  }

  const top = $("pagerTop");
  const bottom = $("pagerBottom");
  if (top) top.innerHTML = html;
  if (bottom) bottom.innerHTML = html;
}

async function boot() {
  ensureAuditSyncStarted();
  installGlobalAuditErrorHooks();
  await requireSessionOrRedirect();
  // ---- Theme (appliquer dès le boot) ----
    applyTheme(getSavedTheme());
    initTheme();
    bindThemeToggle();


  state.profile = await getMyProfile();
  state.role = normalizeRole(state.profile?.role ?? "new_user");
  if (isPendingApprovalRole(state.role)) {
    redirectToRoleHome(state.role);
    return;
  }
  state.rolePermissions = await loadRolePermissionsForCurrentRole();

  try {
    state.myOpenLoanCount = await countOpenLoansByBorrower(state.profile?.id);
  } catch {
    state.myOpenLoanCount = 0;
  }

  setSessionInfo(
    state.profile?.display_name
      ? `${state.profile.display_name} — ${state.role}`
      : `Connecté — ${state.role}`
  );

  if (isAdminRole(state.role)) {
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
  }

  renderNav(state.profile, state.role);

  function openModal() {
  $("modalOverlay").hidden = false;
  $("addKeysModal").hidden = false;
  $("addKeysModal").setAttribute("aria-hidden", "false");
}
function closeModal() {
  $("modalOverlay").hidden = true;
  $("addKeysModal").hidden = true;
  $("addKeysModal").setAttribute("aria-hidden", "true");
}

function resetManualForm() {
  $("m_keyno").value = "";
  $("m_pavilion_id").value = "";
  $("m_local").value = "";
  $("m_utilisation").value = "";
  $("m_remarque").value = "";
  $("m_qty").value = "1";
  $("m_is_keyring").checked = false;
  $("keyringBox").style.display = "none";
  $("keyringRows").innerHTML = "";
}
function resetManualEntryFieldsKeepHook() {
  $("m_keyno").value = "";
  $("m_pavilion_id").value = "";
  $("m_local").value = "";
  $("m_utilisation").value = "";
  $("m_remarque").value = "";
  $("m_qty").value = "1";
  $("m_is_keyring").checked = false;
  $("keyringBox").style.display = "none";
  $("keyringRows").innerHTML = "";
}
let manualStatusTimer = null;
function setManualStatus(msg, clearAfterMs = 0) {
  $("manualStatus").textContent = msg;
  if (manualStatusTimer) {
    clearTimeout(manualStatusTimer);
    manualStatusTimer = null;
  }
  if (clearAfterMs > 0) {
    manualStatusTimer = setTimeout(() => {
      $("manualStatus").textContent = "";
      manualStatusTimer = null;
    }, clearAfterMs);
  }
}
function openManualAddForHook(hookNo) {
  const n = Number(hookNo);
  if (!Number.isFinite(n) || n <= 0) return;
  resetManualForm();
  $("m_hook").value = String(n);
  $("m_qty").value = "1";
  setTab("manual");
  renderHookContext(n);
  renderHookExistingDetails(n);
  closeHookModal();
  openModal();
  $("m_keyno")?.focus();
}

$("btnAddKeys").addEventListener("click", () => {
  resetManualForm();
  // proposer crochet vide par défaut
  $("m_hook").value = String(suggestNextEmptyHook());
  $("m_qty").value = "1";
  setTab("manual");
  renderHookExistingDetails(Number($("m_hook").value));
  openModal();
});
renderHookContext(Number($("m_hook").value));
renderHookExistingDetails(Number($("m_hook").value));


  $("btnCloseModal").addEventListener("click", closeModal);
  $("modalOverlay").addEventListener("click", closeModal);
  $("btnAddCabinet").addEventListener("click", async () => {
    if (!state.pavilions?.length) {
      try {
        state.pavilions = await listPavilions();
      } catch {
        state.pavilions = [];
      }
    }
    openCabinetCreateModal();
  });
  $("cabCreateClose").addEventListener("click", closeCabinetCreateModal);
  $("cabCreateCancel").addEventListener("click", closeCabinetCreateModal);
  $("cabinetCreateOverlay").addEventListener("click", closeCabinetCreateModal);
  $("cabCreateSave").addEventListener("click", async () => {
    const name = $("cab_create_name").value.trim();
    const location = $("cab_create_location").value.trim();
    const maxRaw = $("cab_create_max_hooks").value.trim();
    const maxHooks = Number(maxRaw);
    const pavilionIdRaw = $("cab_create_pavilion_id").value.trim();
    const pavilionId = pavilionIdRaw ? Number(pavilionIdRaw) : null;
    const userGroup = isSuperAdminRole(state.role)
      ? normalizeGroup($("cab_create_user_group").value)
      : getCurrentUserGroup();
    const allowConsultation = isSuperAdminRole(state.role)
      ? !!$("cab_create_allow_consultation").checked
      : true;
    const allowSelfBorrow = isSuperAdminRole(state.role)
      ? !!$("cab_create_allow_self_borrow").checked
      : true;
    const allowAdminLending = isSuperAdminRole(state.role)
      ? !!$("cab_create_allow_admin_lending").checked
      : false;

    if (!name) {
      $("cabCreateStatus").textContent = "Nom d'armoire requis.";
      return;
    }
    if (!Number.isFinite(maxHooks) || maxHooks <= 0) {
      $("cabCreateStatus").textContent = "Maximum de crochets invalide.";
      return;
    }
    if (pavilionIdRaw && !Number.isFinite(pavilionId)) {
      $("cabCreateStatus").textContent = "Pavillon invalide.";
      return;
    }

    try {
      $("cabCreateSave").disabled = true;
      $("cabCreateStatus").textContent = "Création...";
      await createCabinet({
        name,
        location: location || null,
        max_hooks: Math.trunc(maxHooks),
        pavilion_id: pavilionId,
        user_group: userGroup,
        allow_consultation: allowConsultation,
        allow_self_borrow: allowSelfBorrow,
        allow_admin_lending: allowAdminLending,
      });
      await loadCabinets();
      renderCabinetGrid();
      closeCabinetCreateModal();
    } catch (e) {
      $("cabCreateStatus").textContent = `Erreur: ${e?.message ?? e}`;
    } finally {
      $("cabCreateSave").disabled = false;
    }
  });
  $("cabEditClose").addEventListener("click", closeCabinetEditModal);
  $("cabEditCancel").addEventListener("click", closeCabinetEditModal);
  $("cabinetEditOverlay").addEventListener("click", closeCabinetEditModal);
  $("cabEditSave").addEventListener("click", async () => {
    const cabinetId = Number(state.cabinetEditModal.cabinetId);
    if (!Number.isFinite(cabinetId)) return;

    const name = $("cab_edit_name").value.trim();
    const location = $("cab_edit_location").value.trim();
    const isActive = $("cab_edit_is_active").value === "true";
    const pavilionIdRaw = $("cab_edit_pavilion_id").value.trim();
    const pavilionId = pavilionIdRaw ? Number(pavilionIdRaw) : null;
    const maxRaw = $("cab_edit_max_hooks").value.trim();
    const maxHooks = Number(maxRaw);
    const userGroup = isSuperAdminRole(state.role)
      ? normalizeGroup($("cab_edit_user_group").value)
      : getCurrentUserGroup();
    const allowConsultation = isSuperAdminRole(state.role)
      ? !!$("cab_edit_allow_consultation").checked
      : getCabinetPolicy(cabinetId).allow_consultation;
    const allowSelfBorrow = isSuperAdminRole(state.role)
      ? !!$("cab_edit_allow_self_borrow").checked
      : getCabinetPolicy(cabinetId).allow_self_borrow;
    const allowAdminLending = isSuperAdminRole(state.role)
      ? !!$("cab_edit_allow_admin_lending").checked
      : getCabinetPolicy(cabinetId).allow_admin_lending;

    if (!name) {
      $("cabEditStatus").textContent = "Nom d'armoire requis.";
      return;
    }
    if (!Number.isFinite(maxHooks) || maxHooks <= 0) {
      $("cabEditStatus").textContent = "Maximum de crochets invalide.";
      return;
    }
    if (pavilionIdRaw && !Number.isFinite(pavilionId)) {
      $("cabEditStatus").textContent = "Pavillon invalide.";
      return;
    }

    try {
      $("cabEditSave").disabled = true;
      $("cabEditStatus").textContent = "Enregistrement...";
      await updateCabinet(cabinetId, {
        name,
        location: location || null,
        is_active: isActive,
        max_hooks: Math.trunc(maxHooks),
        pavilion_id: pavilionId,
        user_group: userGroup,
        allow_consultation: allowConsultation,
        allow_self_borrow: allowSelfBorrow,
        allow_admin_lending: allowAdminLending,
      });
      await loadCabinets();
      renderCabinetGrid();
      if (state.cabinetId != null && !state.cabinets.some((c) => Number(c.id) === Number(state.cabinetId))) {
        state.cabinetId = state.cabinets[0]?.id ?? null;
      }
      closeCabinetEditModal();
    } catch (e) {
      $("cabEditStatus").textContent = `Erreur: ${e?.message ?? e}`;
    } finally {
      $("cabEditSave").disabled = false;
    }
  });
  $("cabEditDelete").addEventListener("click", async () => {
    const cabinetId = Number(state.cabinetEditModal.cabinetId);
    if (!Number.isFinite(cabinetId)) return;
    try {
      $("cabEditDelete").disabled = true;
      $("cabEditStatus").textContent = "Vérification...";
      const usage = await getCabinetUsage(cabinetId);
      if ((usage.keys ?? 0) > 0 || (usage.keyrings ?? 0) > 0) {
        $("cabEditStatus").textContent = `Suppression refusée: ${usage.keys ?? 0} clés et ${usage.keyrings ?? 0} trousseaux encore liés.`;
        return;
      }
      const ok = confirm("Confirmer la suppression définitive de cette armoire ?");
      if (!ok) {
        $("cabEditStatus").textContent = "Suppression annulée.";
        return;
      }
      const token = prompt('Tape "SUPPRIMER" pour confirmer.');
      if ((token ?? "").trim().toUpperCase() !== "SUPPRIMER") {
        $("cabEditStatus").textContent = "Confirmation invalide.";
        return;
      }
      $("cabEditStatus").textContent = "Suppression...";
      await deleteCabinet(cabinetId);
      await loadCabinets();
      renderCabinetGrid();
      if (state.cabinetId != null && !state.cabinets.some((c) => Number(c.id) === Number(state.cabinetId))) {
        state.cabinetId = state.cabinets[0]?.id ?? null;
      }
      closeCabinetEditModal();
    } catch (e) {
      $("cabEditStatus").textContent = `Erreur: ${e?.message ?? e}`;
    } finally {
      $("cabEditDelete").disabled = false;
    }
  });

function setTab(which) {
  const isCsv = which === "csv";
  $("tabCsv").classList.toggle("active", isCsv);
  $("tabManual").classList.toggle("active", !isCsv);
  $("panelCsv").style.display = isCsv ? "" : "none";
  $("panelManual").style.display = isCsv ? "none" : "";
}

$("tabCsv").addEventListener("click", () => setTab("csv"));
$("tabManual").addEventListener("click", () => setTab("manual"));



  await loadCabinets();
  renderNav(state.profile, state.role);
  // choisir cabinet depuis URL (ou dernier scan)
  const mode = getModeFromUrl();
  applyCabinetMobileLayout(mode);
  let cabId = getCabinetFromUrl();
  if (cabId == null && mode === "scan") {
    const last = Number(localStorage.getItem("sav_last_cabinet"));
    if (Number.isFinite(last)) cabId = last;
  }
  if (mode === "qr") {
    const hasCabinet = Number.isFinite(cabId);
    const cabinetAllowed = hasCabinet && state.cabinets.some((cabinet) => Number(cabinet.id) === Number(cabId));
    if (!hasCabinet || !cabinetAllowed) {
      $("homeView").style.display = "none";
      $("keysView").style.display = "none";
      setPageTitle("Armoire introuvable");
      setSessionInfo(hasCabinet ? "QR invalide ou accès refusé." : "QR incomplet.");
      document.body.classList.remove("loading");
      return;
    }
  }

  if (cabId != null) {
    state.cabinetId = cabId;
    setCabinetInUrl(cabId);
    $("cabinetSelect").value = String(cabId);
    $("homeView").style.display = "none";
    $("keysView").style.display = "";
    await loadDataForCabinet();
    updateCabinetHeaderForMode(mode);
    render();
    resetManualForm();
    closeModal();
    handleOpenTargetFromUrl();
    document.body.classList.remove("loading");
  } else if (mode === "browse") {
    state.cabinetId = state.cabinets[0]?.id ?? null;
    if (state.cabinetId != null) {
      setCabinetInUrl(state.cabinetId);
      $("cabinetSelect").value = String(state.cabinetId);
      $("homeView").style.display = "none";
      $("keysView").style.display = "";
      await loadDataForCabinet();
      updateCabinetHeaderForMode(mode);
      render();
      handleOpenTargetFromUrl();
      document.body.classList.remove("loading");
    } else {
      $("homeView").style.display = "";
      $("keysView").style.display = "none";
      setPageTitle("Liste des clés");
      document.body.classList.remove("loading");
    }
  } else {
    $("homeView").style.display = "";
    $("keysView").style.display = "none";
    setPageTitle(mode === "browse" ? "Liste des clés" : "Accueil");
    setSessionInfo(
      state.profile?.display_name
        ? `${state.profile.display_name} — ${state.role}`
        : `Connecté — ${state.role}`
    );
    renderCabinetGrid();
    document.body.classList.remove("loading");
  }


  // IMPORTANT: s'assurer que cabinetId est un Number (ta DB cabinets.id est bigint)
  if (state.cabinetId != null) state.cabinetId = Number(state.cabinetId);

  // (chargement déjà fait si une armoire est ouverte)

  // --- Admin panel (après role connu) ---
  const adminPanel = $("adminPanel");
  const modeNow = getModeFromUrl();
  $("btnAddKeys").style.display = modeNow === "qr"
    ? "none"
    : (canAdministrateCurrentCabinet() && canRole("creation") ? "" : "none");
  $("btnAddCabinet").style.display = isAdminRole(state.role) && canRole("creation") ? "" : "none";
  const isRestrictedCabinetMode = modeNow === "qr" || (state.role === "user" && modeNow === "scan");
  const cabinetSelect = $("cabinetSelect");
  if (cabinetSelect) {
    cabinetSelect.style.display = isRestrictedCabinetMode ? "none" : "";
  }


  // --- CSV handlers (une seule fois) ---
  let csvRows = null;

  $("btnPreviewCsv").addEventListener("click", async () => {
    const f = $("csvFile").files?.[0];
    if (!f) {
      $("csvStatus").textContent = "Choisis un fichier CSV ou Excel.";
      return;
    }

    const { header, rows, sourceLabel } = await parseImportFile(f);

    const missing = validateCsvHeader(header);
    if (missing.length) {
      $("csvStatus").textContent = `Header invalide. Colonnes manquantes: ${missing.join(", ")}`;
      $("csvPreview").innerHTML = "";
      $("btnImportCsv").disabled = true;
      csvRows = null;
      return;
    }

    csvRows = rows;
    $("csvStatus").textContent = `${sourceLabel} OK — ${rows.length} lignes prêtes.`;
    renderPreview($("csvPreview"), rows);
    $("btnImportCsv").disabled = rows.length === 0;
  });

  $("btnImportCsv").addEventListener("click", async () => {
    if (!csvRows?.length) return;

    try {
      $("btnImportCsv").disabled = true;
      $("csvStatus").textContent = "Import en cours...";

      const res = await fnImportKeysCsv(Number(state.cabinetId), csvRows);

      $("csvStatus").textContent =
        `Import terminé: ${res.created_keys} clés (demandées) — inserted: ${res.inserted}`;

} catch (e) {
  console.error(e);

  const payload = e?.payload;
  const baseMsg = payload?.error || e?.message || String(e);

  // Affiche message principal
  let html = `<div><b>Erreur import:</b> ${baseMsg}</div>`;

  // Affiche détails si présents
  if (payload?.errors?.length) {
    html += `<div class="muted" style="margin-top:6px;">Détails (${payload.errors.length}) :</div>`;
    html += `<div style="margin-top:6px; max-height:220px; overflow:auto; border:1px solid rgba(255,255,255,.12); border-radius:10px; padding:8px;">`;
    html += `<ol style="margin:0; padding-left:18px;">` +
      payload.errors.map(err => `<li style="margin:4px 0;">${escapeHtml(JSON.stringify(err))}</li>`).join("") +
      `</ol>`;
    html += `</div>`;
  } else {
    html += `<div class="muted" style="margin-top:6px;">(Aucun détail d'erreur reçu du backend)</div>`;
  }

  $("csvStatus").innerHTML = html;
}

 finally {
      $("btnImportCsv").disabled = false;
    }
  });

  // --- Actions trousseaux (une seule fois) ---
  $("list").addEventListener("click", async (e) => {
    const item = e.target.closest(".item[data-hook-no]");
    if (!item) return;
    if (e.target.closest("button, a, input")) return;

    const hookNo = Number(item.dataset.hookNo);
    if (!Number.isFinite(hookNo)) return;
    openHookModal(hookNo);
  });

  // --- UI events (une seule fois) ---
    $("cabinetSelect").addEventListener("change", async (e) => {
    state.cabinetId = Number(e.target.value);
    setCabinetInUrl(state.cabinetId);
    state.page = 0;
    await loadDataForCabinet();
    updateCabinetHeaderForMode(getModeFromUrl());
    render();
    resetManualForm();
    closeModal();
    });


  $("q").addEventListener("input", (e) => {
    state.q = e.target.value.trim();
    state.page = 0;
    render();
  });

  function onPagerClick(e) {
    const btn = e.target.closest("button.page-link[data-page]");
    if (!btn) return;
    const p = Number(btn.dataset.page);
    if (!Number.isFinite(p)) return;
    state.page = Math.max(0, p - 1);
    render();
  }
  const pagerTop = $("pagerTop");
  const pagerBottom = $("pagerBottom");
  if (pagerTop) pagerTop.addEventListener("click", onPagerClick);
  if (pagerBottom) pagerBottom.addEventListener("click", onPagerClick);
  function mkKeyringRow(pavilionIdDefault, locDefault) {
  const wrap = document.createElement("div");
  wrap.className = "keyring-row";
  wrap.innerHTML = `
    <div class="row">
      <input class="input kr_keyno" placeholder="No de clé (optionnel)" />
      <select class="select kr_pavilion_id">${buildPavilionOptionsHtml(pavilionIdDefault ?? null)}</select>
      <input class="input kr_loc" placeholder="Local" value="${locDefault ?? ""}" />
      <input class="input kr_use" placeholder="Utilisation" />
      <input class="input kr_rem" placeholder="Remarque" />
      <input class="input kr_qty" type="number" min="1" max="999" value="1" style="max-width:110px;" />
      <button class="btn danger kr_del" type="button">?</button>
    </div>
  `;
  wrap.querySelector(".kr_del").addEventListener("click", () => wrap.remove());
  return wrap;
}
$("m_hook").addEventListener("input", () => {
  const hook = Number($("m_hook").value.trim());
  if (Number.isFinite(hook) && hook > 0) {
    renderHookContext(hook);
    renderHookExistingDetails(hook);
  } else {
    renderHookExistingDetails(null);
  }
});


$("m_is_keyring").addEventListener("change", (e) => {
  const on = e.target.checked;
  $("keyringBox").style.display = on ? "" : "none";
  if (on && $("keyringRows").children.length === 0) {
    $("keyringRows").appendChild(mkKeyringRow($("m_pavilion_id").value, $("m_local").value));
  }
});

  $("btnAddKeyringRow").addEventListener("click", () => {
  $("keyringRows").appendChild(mkKeyringRow($("m_pavilion_id").value, $("m_local").value));
});
  $("btnManualSubmit").addEventListener("click", async () => {
  try {
    $("btnManualSubmit").disabled = true;
    setManualStatus("Ajout en cours...");

    const hook = assertHookWithinCabinetLimit($("m_hook").value.trim());

    const base = {
      tag: String(hook),
      key_no: $("m_keyno").value.trim(),
      pavillon: getPavilionLegacyTextById($("m_pavilion_id").value),
      local: $("m_local").value.trim(),
      utilisation: $("m_utilisation").value.trim(),
      departement: "", // optionnel
      quantite: $("m_qty").value.trim() || "1",
      remarque: $("m_remarque").value.trim(),
    };

    const rows = [base];

    if ($("m_is_keyring").checked) {
      const rowEls = [...$("keyringRows").querySelectorAll(".keyring-row")];
      for (const el of rowEls) {
        rows.push({
          tag: String(hook),
          key_no: el.querySelector(".kr_keyno").value.trim(),
          pavillon: getPavilionLegacyTextById(el.querySelector(".kr_pavilion_id").value),
          local: el.querySelector(".kr_loc").value.trim(),
          utilisation: el.querySelector(".kr_use").value.trim(),
          departement: "",
          quantite: el.querySelector(".kr_qty").value.trim() || "1",
          remarque: el.querySelector(".kr_rem").value.trim(),
        });
      }
    }
    const snap = getHookSnapshot(hook);
    if (snap.keys.length || snap.rings.length) {
    const ok = confirm(`Le crochet #${hook} contient déjà des clés/trousseaux.\n\nVeux-tu vraiment ajouter des clés sur ce crochet ?`);
    if (!ok) {
        setManualStatus("Ajout annulé.", 5000);
        return;
    }
    }


    const t0 = new Date().toISOString();
    const res = await fnImportKeysCsv(Number(state.cabinetId), rows);

    if ($("m_is_keyring").checked) {
      const created = await createKeyringForImport({
        cabinetId: Number(state.cabinetId),
        hookNo: hook,
        rows,
        sinceIso: t0,
      });
      if (created.created) {
        setManualStatus(`Ajout terminé — trousseau ${created.ringCode} créé`, 5000);
      } else {
        setManualStatus("Ajout terminé — trousseau non créé (clés introuvables après import)", 5000);
      }
    } else {
      setManualStatus("Ajout terminé", 5000);
    }
    await loadDataForCabinet();
    updateSessionInfoCabinet();
    render();
    resetManualEntryFieldsKeepHook();
    renderHookContext(hook);
    renderHookExistingDetails(hook);
    $("m_keyno")?.focus();
    if (state.hookModal.returnToCreateKeyring && state.hookModal.pendingCreateKeyring) {
      const { hookNo, selectedKeyIds } = state.hookModal.pendingCreateKeyring;
      state.hookModal.returnToCreateKeyring = false;
      state.hookModal.pendingCreateKeyring = null;
      state.hookModal.selectedKeyIds = new Set(selectedKeyIds);
      state.hookModal.selectMode = true;
      if (state.hookModal.open && state.hookModal.hookNo === hookNo) {
        renderHookModal(hookNo);
      } else {
        openHookModal(hookNo);
      }
      openKeyringCreateModal(hookNo, state.hookModal.selectedKeyIds);
    }
  } catch (e) {
    console.error(e);
    setManualStatus(`Erreur: ${e?.message ?? e}`, 5000);
  } finally {
    $("btnManualSubmit").disabled = false;
  }
  });

  // --- Modal Détail crochet ---
  $("hookModalClose").addEventListener("click", closeHookModal);
  $("hookOverlay").addEventListener("click", closeHookModal);

  $("hookModalContent").addEventListener("change", (e) => {
    const cb = e.target.closest("input.key-check[data-key-id]");
    if (!cb) return;
    const keyId = Number(cb.dataset.keyId);
    if (!Number.isFinite(keyId)) return;
    if (cb.checked) state.hookModal.selectedKeyIds.add(keyId);
    else state.hookModal.selectedKeyIds.delete(keyId);
    updateSelectionUI();
  });

  let longPressTimer = null;
  let longPressActivated = false;
  const LONG_PRESS_MS = 450;

  $("hookModalContent").addEventListener("pointerdown", (e) => {
    if (state.role === "consultant") return;
    const row = e.target.closest(".key-row[data-key-id]");
    if (!row) return;
    if (e.target.closest("button, a, input, label")) return;
    const keyId = Number(row.dataset.keyId);
    if (!Number.isFinite(keyId)) return;
    longPressTimer = setTimeout(() => {
      longPressActivated = true;
      state.hookModal.selectedKeyIds.add(keyId);
      setHookSelectMode(true);
      updateSelectionUI();
    }, LONG_PRESS_MS);
  });

  const clearLongPress = () => {
    if (longPressTimer) clearTimeout(longPressTimer);
    longPressTimer = null;
  };
  $("hookModalContent").addEventListener("pointerup", clearLongPress);
  $("hookModalContent").addEventListener("pointercancel", clearLongPress);
  $("hookModalContent").addEventListener("pointerleave", clearLongPress);

  $("hookModalContent").addEventListener("click", (e) => {
    if (state.role === "consultant") return;
    if (!state.hookModal.selectMode) return;
    if (longPressActivated) {
      longPressActivated = false;
      return;
    }
    if (e.target.closest("button, a, input, label")) return;
    const row = e.target.closest(".key-row[data-key-id]");
    if (!row) {
      state.hookModal.selectedKeyIds.clear();
      setHookSelectMode(false);
      updateSelectionUI();
      return;
    }
    const keyId = Number(row.dataset.keyId);
    if (!Number.isFinite(keyId)) return;
    if (state.hookModal.selectedKeyIds.has(keyId)) state.hookModal.selectedKeyIds.delete(keyId);
    else state.hookModal.selectedKeyIds.add(keyId);
    updateSelectionUI();
  });

  $("hookModalContent").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const disabledReason = btn.dataset.disabledReason;
    if (disabledReason) {
      alert(disabledReason);
      return;
    }
    const action = btn.dataset.action;
    const keyId = Number(btn.dataset.keyId);
    const keyringId = Number(btn.dataset.keyringId);
    const loanId = Number(btn.dataset.loanId);

    try {
      btn.disabled = true;

      if (action === "keyring-borrow") {
        if (!canSelfBorrowCabinet()) throw new Error("Permission refusée: emprunt.");
        const kr = state.keyrings.find(k => k.id === keyringId);
        if (!kr) throw new Error("Trousseau introuvable.");
        await fnLoanCreateKeyring(
          String(kr.cabinet_id),
          Number(kr.hook_no),
          String(kr.ring_code ?? "").toUpperCase(),
          kr.note ?? null,
        );
      } else if (action === "keyring-admin-loan") {
        if (!canAdminLendCabinet()) throw new Error("Permission refusée: prêt administrateur.");
        await openAdminLoanModal({ mode: "keyring", keyringId });
      } else if (action === "keyring-return") {
        if (!canRole("retour")) throw new Error("Permission refusée: retour.");
        const kr = state.keyrings.find(k => k.id === keyringId);
        if (!kr) throw new Error("Trousseau introuvable.");
        await fnLoanReturnKeyring(
          String(kr.cabinet_id),
          Number(kr.hook_no),
          String(kr.ring_code ?? "").toUpperCase(),
        );
      } else if (action === "keyring-edit") {
        if (!canRole("edition")) throw new Error("Permission refusée: édition.");
        openKeyringEditModal(keyringId);
        return;
      } else if (action === "keyring-delete") {
        if (!canRole("suppression")) throw new Error("Permission refusée: suppression.");
        if (!confirm("Supprimer ce trousseau ?")) return;
        const { error: clearErr } = await supa
          .from("keys")
          .update({ keyring_id: null })
          .eq("keyring_id", keyringId);
        if (clearErr) throw clearErr;
        const { error: delErr } = await supa
          .from("keyrings")
          .delete()
          .eq("id", keyringId);
        if (delErr) throw delErr;
        await logAuditEvent({
          event_type: "keyring_delete",
          action: "keyring_delete",
          target: keyringTargetFromRing(state.keyrings.find((k) => Number(k.id) === Number(keyringId))),
          details: "Suppression du trousseau",
          source: "frontend",
        });
      } else if (action === "key-borrow") {
        if (!canSelfBorrowCabinet()) throw new Error("Permission refusée: emprunt.");
        await fnLoanCreate(keyId);
      } else if (action === "key-admin-loan") {
        if (!canAdminLendCabinet()) throw new Error("Permission refusée: prêt administrateur.");
        await openAdminLoanModal({ mode: "key", keyId });
      } else if (action === "key-return") {
        if (!canRole("retour")) throw new Error("Permission refusée: retour.");
        const loan = state.loansByKey?.get(keyId);
        if (loan && state.profile?.id && loan.borrower_id !== state.profile.id) {
          const borrowerName = loanBorrowerLabel(loan);
          openReturnPrompt({
            keyId,
            loanId: loan.id,
            borrowerName,
            loanedAt: loan.loaned_at,
          });
          return;
        }
        try {
          if (Number.isFinite(loanId) && loanId > 0) {
            await fnLoanReturn(loanId);
          } else {
            await fnLoanReturnByKeyLocal(keyId);
          }
        } catch (err) {
          if (isForbiddenError(err)) {
            const fallbackLoan = state.loansByKey?.get(keyId);
            if (fallbackLoan) {
              const borrowerName = loanBorrowerLabel(fallbackLoan);
              openReturnPrompt({
                keyId,
                loanId: fallbackLoan.id,
                borrowerName,
                loanedAt: fallbackLoan.loaned_at,
              });
              return;
            }
          }
          throw err;
        }
      } else if (action === "key-missing") {
        if (!canRole("signalement")) throw new Error("Permission refusée: signalement.");
        const key = state.keys.find(k => k.id === keyId);
        if (!key) throw new Error("Clé introuvable.");
        if (key.keyring_id) {
          const ringKeys = state.keys.filter(k => Number(k.keyring_id) === Number(key.keyring_id));
          const ringLoan = ringKeys.map(k => state.loansByKey?.get(k.id)).find(Boolean);
          if (ringLoan) {
            const borrowerName = loanBorrowerLabel(ringLoan);
            const text = `Le trousseau est emprunté par ${borrowerName} le ${formatDateFr(ringLoan.loaned_at)}. Est-ce que ce trousseau est de retour mais la clé est manquante ?`;
            openMissingPrompt({
              keyId,
              mode: "ring",
              keyringId: key.keyring_id,
              text,
            });
            return;
          }
        } else {
          const loan = state.loansByKey?.get(keyId);
          if (loan) {
            const borrowerName = loanBorrowerLabel(loan);
            const text = `La clé est empruntée par ${borrowerName} le ${formatDateFr(loan.loaned_at)}. Avez-vous contacté ${borrowerName} pour savoir si la clé est perdue ?`;
            openMissingPrompt({
              keyId,
              mode: "key",
              loanId: loan.id,
              text,
            });
            return;
          }
        }
        await fnReportMissing(keyId);
      } else if (action === "key-found") {
        if (!canRole("signalement")) throw new Error("Permission refusée: signalement.");
        await fnReportFound(keyId);
      } else if (action === "key-edit") {
        if (!canRole("edition")) throw new Error("Permission refusée: édition.");
        openEditModal(keyId);
        return;
      } else if (action === "key-delete") {
        if (!canRole("suppression")) throw new Error("Permission refusée: suppression.");
        const key = state.keys.find(k => k.id === keyId);
        if (key?.keyring_id) {
          openKeyInRingModal(keyId);
          return;
        }
        openDeleteKeyModal(keyId);
        return;
      }

      await refreshAfterAction();
    } catch (err) {
      const payload = err?.payload;
      const msg = payload?.error || err?.message || String(err);
      alert(msg);
    } finally {
      btn.disabled = false;
    }
  });

  $("hookBorrowAll").addEventListener("click", async () => {
    if (!canSelfBorrowCabinet()) return;
    if (state.hookModal.hookNo == null) return;
    const { keyringsForHook, singles } = getHookDetail(state.hookModal.hookNo);
    try {
      for (const kr of keyringsForHook) {
        const cabId = kr.cabinet_id ?? state.cabinetId;
        const hookNo = kr.hook_no ?? state.hookModal.hookNo;
        const ringCode = kr.ring_code;
        if (!Number.isFinite(Number(cabId)) || !Number.isFinite(Number(hookNo)) || !ringCode) {
          throw new Error(`Trousseau invalide (cabinet_id=${cabId}, hook_no=${hookNo}, ring_code=${ringCode})`);
        }
        await fnLoanCreateKeyring(
          String(cabId),
          Number(hookNo),
          String(ringCode).toUpperCase(),
          kr.note ?? null,
        );
      }
      for (const k of singles) {
        if (k.is_missing) continue;
        if (state.loansByKey?.has(k.id)) continue;
        await fnLoanCreate(k.id);
      }
      await refreshAfterAction();
    } catch (err) {
      const msg = err?.payload?.error || err?.message || String(err);
      alert(msg);
    }
  });

  $("hookReturnAll").addEventListener("click", async () => {
    if (state.hookModal.hookNo == null) return;
    const { keyringsForHook, singles } = getHookDetail(state.hookModal.hookNo);
    try {
      for (const kr of keyringsForHook) {
        const cabId = kr.cabinet_id ?? state.cabinetId;
        const hookNo = kr.hook_no ?? state.hookModal.hookNo;
        const ringCode = kr.ring_code;
        if (!Number.isFinite(Number(cabId)) || !Number.isFinite(Number(hookNo)) || !ringCode) {
          throw new Error(`Trousseau invalide (cabinet_id=${cabId}, hook_no=${hookNo}, ring_code=${ringCode})`);
        }
        await fnLoanReturnKeyring(
          String(cabId),
          Number(hookNo),
          String(ringCode).toUpperCase(),
        );
      }
      for (const k of singles) {
        const loan = state.loansByKey?.get(k.id);
        if (loan?.id) await fnLoanReturn(loan.id);
        else await fnLoanReturnByKeyLocal(k.id);
      }
      await refreshAfterAction();
    } catch (err) {
      const msg = err?.payload?.error || err?.message || String(err);
      alert(msg);
    }
  });

  // --- Modal éditer clé ---
  $("editClose").addEventListener("click", closeEditModal);
  $("editCancel").addEventListener("click", closeEditModal);
  $("editOverlay").addEventListener("click", closeEditModal);

  $("editSave").addEventListener("click", async () => {
    if (!state.editModal.keyId) return;
    const keyId = state.editModal.keyId;
    try {
      $("editSave").disabled = true;
      $("editStatus").textContent = "Enregistrement...";

    const hookNoRaw = $("edit_hook_no").value.trim();
    const hookNo = hookNoRaw ? Number(hookNoRaw) : null;
    if (hookNoRaw) {
      try {
        assertHookWithinCabinetLimit(hookNo);
      } catch (e) {
        $("editStatus").textContent = e?.message ?? "No crochet invalide.";
        return;
      }
    }
    const keyNo = $("edit_key_no").value.trim();
    const local = $("edit_local").value.trim();
    const pavilionIdRaw = $("edit_pavilion_id").value.trim();
    const pavilionId = pavilionIdRaw ? Number(pavilionIdRaw) : null;
    if (pavilionIdRaw && !Number.isFinite(pavilionId)) {
      $("editStatus").textContent = "Pavillon invalide.";
      return;
    }
    const pavillon = getPavilionLegacyTextById(pavilionId);
    const utilisation = $("edit_utilisation").value.trim();
    const remarque = $("edit_remarque").value.trim();
    const quantiteRaw = $("edit_quantite").value.trim();
    const quantiteNum = Number(quantiteRaw || "1");
    if (!Number.isFinite(quantiteNum) || quantiteNum <= 0 || !Number.isInteger(quantiteNum)) {
      $("editStatus").textContent = "Quantité invalide.";
      return;
    }

    const key = state.keys.find(k => k.id === keyId);
    const changedHook = key && hookNo != null && Number(key.hook_no) !== Number(hookNo);
    const previousQty = 1;
    const changedQty = quantiteNum !== previousQty;
    if (changedHook) {
      const ok = confirm(`Changer de crochet ${key.hook_no} ? ${hookNo} ?`);
      if (!ok) return;
    }
    if (changedQty) {
      const okQty = confirm(`Confirmer le changement de quantite: ${previousQty} -> ${quantiteNum} ?`);
      if (!okQty) return;
    }

    const payload = { key_no: keyNo, local, pavillon, pavilion_id: pavilionId, utilisation, remarque };
    if (hookNo != null) payload.hook_no = hookNo;
    if (changedHook) payload.keyring_id = null;

    const { error } = await supa
        .from("keys")
        .update(payload)
        .eq("id", keyId);
      if (error) throw error;

      const selectedRingId = $("edit_keyring").value ? Number($("edit_keyring").value) : null;
      const currentRingId = getCurrentKeyringIdForKey(keyId);

      if (currentRingId !== selectedRingId) {
        const { error: ringErr } = await supa
          .from("keys")
          .update({ keyring_id: selectedRingId })
          .eq("id", keyId);
      if (ringErr) throw ringErr;
    }

      const resolvedHook = hookNo != null ? hookNo : key?.hook_no;
      const resolvedKey = {
        ...(key || {}),
        cabinet_id: key?.cabinet_id ?? state.cabinetId,
        hook_no: resolvedHook,
        key_no: keyNo || key?.key_no || null,
        local,
        utilisation,
        remarque,
        pavillon,
        pavilion_id: pavilionId,
      };
      const detailParts = [];
      if ((key?.local ?? "") !== local) detailParts.push(`local: ${local || "-"}`);
      if ((key?.utilisation ?? "") !== utilisation) detailParts.push(`utilisation: ${utilisation || "-"}`);
      if ((key?.remarque ?? "") !== remarque) detailParts.push(`remarque: ${remarque || "-"}`);
      if ((key?.pavillon ?? "") !== pavillon) detailParts.push(`pavillon: ${pavillon || "-"}`);
      if ((key?.key_no ?? "") !== keyNo) detailParts.push(`key_no: ${keyNo || "-"}`);
      if (changedHook) detailParts.push(`hook: ${key?.hook_no ?? "?"} -> ${hookNo}`);
      await logAuditEvent({
        event_type: changedHook ? "key_move" : "key_update",
        action: changedHook ? "key_move" : "key_update",
        target: keyTargetFromKey(resolvedKey, keyId),
        details: detailParts.join("; ") || "Aucun changement",
        source: "frontend",
      });

      // La table "keys" n'a pas de colonne quantite: pour > 1, on cree des copies.
      if (quantiteNum > 1) {
        const targetHook = hookNo != null ? hookNo : Number(key?.hook_no);
        assertHookWithinCabinetLimit(targetHook);
        await fnImportKeysCsv(Number(state.cabinetId), [{
          tag: String(targetHook),
          key_no: keyNo,
          pavillon,
          local,
          utilisation,
          departement: key?.departement ?? "",
          quantite: String(quantiteNum - 1),
          remarque,
        }]);
      }

      await refreshAfterAction();
      closeEditModal();
    } catch (e) {
      const msg = e?.message ?? String(e);
      $("editStatus").textContent = `Erreur: ${msg}`;
    } finally {
      $("editSave").disabled = false;
    }
  });

  $("hookCreateKeyring").addEventListener("click", () => {
    if (!canAdministrateCurrentCabinet()) return;
    if (!state.hookModal.selectedKeyIds.size) return;
    const hookNo = state.hookModal.hookNo;
    if (!Number.isFinite(hookNo)) return;
    openKeyringCreateModal(hookNo, state.hookModal.selectedKeyIds);
  });

  $("hookAddKey").addEventListener("click", () => {
    if (!canAdministrateCurrentCabinet()) return;
    const hookNo = state.hookModal.hookNo;
    if (!Number.isFinite(hookNo)) return;
    openManualAddForHook(hookNo);
  });

  $("hookAddToKeyring").addEventListener("click", () => {
    if (!canAdministrateCurrentCabinet()) return;
    if (!state.hookModal.selectedKeyIds.size) return;
    const hookNo = state.hookModal.hookNo;
    if (!Number.isFinite(hookNo)) return;
    openKeyringPickModal(hookNo);
  });

  $("hookRemoveFromKeyring").addEventListener("click", async () => {
    if (!canAdministrateCurrentCabinet()) return;
    const selected = [...state.hookModal.selectedKeyIds];
    const selectedKeys = selected.map(id => state.keys.find(k => k.id === id)).filter(Boolean);
    const selectedWith = selectedKeys.filter(k => k.keyring_id).map(k => k.id);
    if (!selectedWith.length) return;
    try {
      const { error } = await supa
        .from("keys")
        .update({ keyring_id: null })
        .in("id", selectedWith);
      if (error) throw error;
      state.hookModal.selectedKeyIds.clear();
      setHookSelectMode(false);
      await refreshAfterAction();
    } catch (err) {
      const msg = err?.payload?.error || err?.message || String(err);
      alert(msg);
    }
  });

  // --- Modal éditer trousseau ---
  $("krEditClose").addEventListener("click", closeKeyringEditModal);
  $("krEditCancel").addEventListener("click", closeKeyringEditModal);
  $("keyringEditOverlay").addEventListener("click", closeKeyringEditModal);

  $("krEditSave").addEventListener("click", async () => {
    if (!state.keyringEditModal.keyringId) return;
    const keyringId = state.keyringEditModal.keyringId;
    try {
      $("krEditSave").disabled = true;
      $("krEditStatus").textContent = "Enregistrement...";

      const hookNoRaw = $("kr_edit_hook_no").value.trim();
      const hookNo = hookNoRaw ? Number(hookNoRaw) : null;
      if (hookNoRaw) {
        try {
          assertHookWithinCabinetLimit(hookNo);
        } catch (e) {
          $("krEditStatus").textContent = e?.message ?? "No crochet invalide.";
          return;
        }
      }
      const ring_code = $("kr_edit_ring_code").value.trim();
      const name = $("kr_edit_name").value.trim();
      const note = $("kr_edit_note").value.trim();
      const existing = state.keyrings.find(k => k.id === keyringId);
      const changedHook = existing && hookNo != null && Number(existing.hook_no) !== Number(hookNo);
      if (changedHook) {
        const ok = confirm(`Changer de crochet ${existing.hook_no} ? ${hookNo} ?`);
        if (!ok) return;
      }

      const { error } = await supa
        .from("keyrings")
        .update({ ring_code, name, note, ...(hookNo != null ? { hook_no: hookNo } : {}) })
        .eq("id", keyringId);
      if (error) throw error;

      if (changedHook) {
        const { error: kErr } = await supa
          .from("keys")
          .update({ hook_no: hookNo })
          .eq("keyring_id", keyringId);
        if (kErr) throw kErr;
      }

      await logAuditEvent({
        event_type: changedHook ? "keyring_move" : "keyring_update",
        action: changedHook ? "keyring_move" : "keyring_update",
        target: keyringTargetFromRing(existing, { hook_no: hookNo, ring_code }),
        details: (() => {
          if (changedHook) return `hook: ${existing?.hook_no ?? "?"} -> ${hookNo}`;
          const parts = [];
          const prevCode = String(existing?.ring_code ?? "").trim().toUpperCase();
          const nextCode = String(ring_code ?? "").trim().toUpperCase();
          const prevName = String(existing?.name ?? "").trim();
          const nextName = String(name ?? "").trim();
          const prevNote = String(existing?.note ?? "").trim();
          const nextNote = String(note ?? "").trim();
          if (prevCode !== nextCode) parts.push(`ring_code: ${nextCode || "-"}`);
          if (prevName !== nextName) parts.push(`name: ${nextName || "-"}`);
          if (prevNote !== nextNote) parts.push(`note: ${nextNote || "-"}`);
          return parts.join("; ") || "Aucun changement";
        })(),
        source: "frontend",
      });

      await refreshAfterAction();
      closeKeyringEditModal();
    } catch (e) {
      const msg = e?.message ?? String(e);
      $("krEditStatus").textContent = `Erreur: ${msg}`;
    } finally {
      $("krEditSave").disabled = false;
    }
  });

  // --- Modal Créer trousseau ---
  $("krCreateClose").addEventListener("click", closeKeyringCreateModal);
  $("krCreateCancel").addEventListener("click", closeKeyringCreateModal);
  $("keyringCreateOverlay").addEventListener("click", closeKeyringCreateModal);

  $("krCreateList").addEventListener("change", (e) => {
    const cb = e.target.closest("input.keyring-create-check[data-key-id]");
    if (!cb) return;
    const keyId = Number(cb.dataset.keyId);
    if (!Number.isFinite(keyId)) return;
    if (cb.checked) state.keyringCreateModal.selectedKeyIds.add(keyId);
    else state.keyringCreateModal.selectedKeyIds.delete(keyId);
  });

  $("krCreateAddKey").addEventListener("click", () => {
    const hookNo = state.keyringCreateModal.hookNo;
    if (!Number.isFinite(hookNo)) return;
    state.hookModal.returnToCreateKeyring = true;
    state.hookModal.pendingCreateKeyring = {
      hookNo,
      selectedKeyIds: new Set(state.keyringCreateModal.selectedKeyIds),
    };
    closeKeyringCreateModal();
    $("m_hook").value = String(hookNo);
    setTab("manual");
    openModal();
  });

  $("krCreateSave").addEventListener("click", async () => {
    const hookNo = state.keyringCreateModal.hookNo;
    const selectedIds = [...state.keyringCreateModal.selectedKeyIds];
    if (!Number.isFinite(hookNo)) return;
    if (!selectedIds.length) {
      $("krCreateStatus").textContent = "Sélectionne au moins une clé.";
      return;
    }
    try {
      $("krCreateSave").disabled = true;
      $("krCreateStatus").textContent = "Création...";

      const ringCodeRaw = $("kr_create_ring_code").value.trim();
      const ring_code = ringCodeRaw || nextRingCodeForHook(hookNo);
      const nameRaw = $("kr_create_name").value.trim();
      const name = nameRaw || "";
      const note = $("kr_create_note").value.trim() || null;

      const { data: ring, error: ringErr } = await supa
        .from("keyrings")
        .insert({
          cabinet_id: Number(state.cabinetId),
          hook_no: hookNo,
          ring_code,
          name,
          note,
        })
        .select("id")
        .single();
      if (ringErr) throw ringErr;

      const { error: itemsErr } = await supa
        .from("keys")
        .update({ keyring_id: ring.id })
        .in("id", selectedIds);
      if (itemsErr) throw itemsErr;

      await logAuditEvent({
        event_type: "keyring_create",
        action: "keyring_create",
        target: keyringTargetFromRing({ cabinet_id: state.cabinetId, hook_no, ring_code }),
        details: `hook=${hookNo}, keys=${selectedIds.length}`,
        source: "frontend",
      });

      state.hookModal.selectedKeyIds.clear();
      setHookSelectMode(false);
      await refreshAfterAction();
      closeKeyringCreateModal();
    } catch (e) {
      const msg = e?.message ?? String(e);
      $("krCreateStatus").textContent = `Erreur: ${msg}`;
    } finally {
      $("krCreateSave").disabled = false;
    }
  });

  // --- Modal Ajouter — un trousseau ---
  $("krPickClose").addEventListener("click", closeKeyringPickModal);
  $("krPickCancel").addEventListener("click", closeKeyringPickModal);
  $("keyringPickOverlay").addEventListener("click", closeKeyringPickModal);

  $("krPickSave").addEventListener("click", async () => {
    const hookNo = state.keyringPickModal.hookNo;
    if (!Number.isFinite(hookNo)) return;
    const ringId = Number($("kr_pick_select").value);
    if (!Number.isFinite(ringId)) {
      $("krPickStatus").textContent = "Choisis un trousseau.";
      return;
    }
    const selected = [...state.hookModal.selectedKeyIds];
    const selectedKeys = selected.map(id => state.keys.find(k => k.id === id)).filter(Boolean);
    const selectedWithout = selectedKeys.filter(k => !k.keyring_id).map(k => k.id);
    if (!selectedWithout.length) {
      $("krPickStatus").textContent = "Aucune clé hors trousseau sélectionnée.";
      return;
    }
    try {
      $("krPickSave").disabled = true;
      $("krPickStatus").textContent = "Ajout...";
      const ringHasOnLoan = state.keys
        .filter(k => Number(k.keyring_id) === Number(ringId))
        .some(k => state.loansByKey?.has(k.id));
      const { error } = await supa
        .from("keys")
        .update({ keyring_id: ringId })
        .in("id", selectedWithout);
      if (error) throw error;
      await logAuditEvent({
        event_type: "key_update",
        action: "key_update",
        target: keyringTargetFromRing(state.keyrings.find((k) => Number(k.id) === Number(ringId))),
        details: `Affectation de ${selectedWithout.length} clé(s)`,
        source: "frontend",
      });
      if (ringHasOnLoan) {
        const ringLoan = state.keys
          .filter((key) => Number(key.keyring_id) === Number(ringId))
          .map((key) => state.loansByKey?.get(key.id))
          .find(Boolean);
        for (const keyId of selectedWithout) {
          const key = state.keys.find(k => k.id === keyId);
          if (!key || key.is_missing) continue;
          try {
            if (ringLoan && canAdminLendCabinet() && (ringLoan.borrower_id || ringLoan.borrower_name)) {
              await rpcAdminCreateLoan({
                key_id: keyId,
                borrower_id: ringLoan.borrower_id ?? null,
                borrower_name: ringLoan.borrower_id ? null : ringLoan.borrower_name,
                note: ringLoan.note ?? null,
              });
            } else {
              await fnLoanCreate(keyId);
            }
          } catch (e) {
            console.warn("loan-create failed for key", keyId, e);
          }
        }
      }
      state.hookModal.selectedKeyIds.clear();
      setHookSelectMode(false);
      await refreshAfterAction();
      closeKeyringPickModal();
    } catch (e) {
      const msg = e?.message ?? String(e);
      $("krPickStatus").textContent = `Erreur: ${msg}`;
    } finally {
      $("krPickSave").disabled = false;
    }
  });

  // --- Modal Clé dans trousseau ---
  $("keyInRingClose").addEventListener("click", closeKeyInRingModal);
  $("keyInRingOverlay").addEventListener("click", closeKeyInRingModal);

  $("keyInRingRemove").addEventListener("click", async () => {
    const keyId = state.keyInRingModal.keyId;
    if (!keyId) return;
    try {
      $("keyInRingStatus").textContent = "Mise — jour...";
      const { error } = await supa
        .from("keys")
        .update({ keyring_id: null })
        .eq("id", keyId);
      if (error) throw error;
      await logAuditEvent({
        event_type: "key_update",
        action: "key_update",
        target: keyTargetFromKey(state.keys.find((k) => Number(k.id) === Number(keyId)), keyId),
        details: "Retrait du trousseau",
        source: "frontend",
      });
      await refreshAfterAction();
      closeKeyInRingModal();
    } catch (e) {
      $("keyInRingStatus").textContent = `Erreur: ${e?.message ?? e}`;
    }
  });

  $("keyInRingDelete").addEventListener("click", async () => {
    const keyId = state.keyInRingModal.keyId;
    if (!keyId) return;
    closeKeyInRingModal();
    openDeleteKeyModal(keyId);
  });

  // --- Modal Supprimer clé ---
  $("deleteKeyClose").addEventListener("click", closeDeleteKeyModal);
  $("deleteKeyCancel").addEventListener("click", closeDeleteKeyModal);
  $("deleteKeyOverlay").addEventListener("click", closeDeleteKeyModal);

  $("deleteKeyConfirm").addEventListener("click", async () => {
    const keyId = state.deleteKeyModal.keyId;
    if (!keyId) return;
    try {
      $("deleteKeyConfirm").disabled = true;
      $("deleteKeyStatus").textContent = "Suppression...";

      const key = state.keys.find(k => k.id === keyId);
      if (!key) throw new Error("Clé introuvable.");

      const reason = $("delete_key_reason").value.trim() || null;
      const { error } = await supa.functions.invoke("key-delete", {
        body: { key_id: keyId, reason },
      });
      if (error) throw error;
      await logAuditEvent({
        event_type: "key_delete",
        action: "key_delete",
        target: keyTargetFromKey(key, keyId),
        details: reason || "Suppression de clé",
        source: "frontend",
      });

      await refreshAfterAction();
      closeDeleteKeyModal();
    } catch (e) {
      $("deleteKeyStatus").textContent = `Erreur: ${e?.message ?? e}`;
    } finally {
      $("deleteKeyConfirm").disabled = false;
    }
  });

  // --- Modal manquant pendant prêt ---
  $("missingPromptClose").addEventListener("click", closeMissingPrompt);
  $("missingPromptNo").addEventListener("click", closeMissingPrompt);
  $("missingPromptOverlay").addEventListener("click", closeMissingPrompt);

  $("missingPromptYes").addEventListener("click", async () => {
    const keyId = state.missingPrompt.keyId;
    if (!keyId) return;
    try {
      $("missingPromptYes").disabled = true;
      $("missingPromptStatus").textContent = "Traitement...";

      if (state.missingPrompt.mode === "ring") {
        const keyringId = state.missingPrompt.keyringId;
        if (!keyringId) throw new Error("Trousseau introuvable.");
        const kr = state.keyrings.find(k => k.id === keyringId);
        if (!kr) throw new Error("Trousseau introuvable.");
        const { error } = await supa.functions.invoke("loan-return-keyring", {
          body: {
            cabinet_id: String(kr.cabinet_id),
            hook_no: Number(kr.hook_no),
            ring_code: String(kr.ring_code ?? "").toUpperCase(),
          },
        });
        if (error) throw error;
        await fnReportMissing(keyId);
      } else if (state.missingPrompt.mode === "key") {
        const loanId = state.missingPrompt.loanId;
        if (Number.isFinite(loanId) && loanId > 0) await fnLoanReturn(loanId);
        else await fnLoanReturnByKeyLocal(keyId);
        await fnReportMissing(keyId);
      }

      await refreshAfterAction();
      closeMissingPrompt();
    } catch (e) {
      $("missingPromptStatus").textContent = `Erreur: ${e?.message ?? e}`;
    } finally {
      $("missingPromptYes").disabled = false;
    }
  });

  // --- Modal suggestions ---
  $("hookProposals").addEventListener("click", () => {
    if (state.hookModal.hookNo == null) return;
    if (!canRole("suggestion")) return;
    openProposalModal(state.hookModal.hookNo);
  });
  $("proposalClose").addEventListener("click", closeProposalModal);
  $("proposalCancel").addEventListener("click", closeProposalModal);
  $("proposalOverlay").addEventListener("click", closeProposalModal);
  $("proposalScopeGeneral").addEventListener("change", () => {
    $("proposalTargetRow").style.display = $("proposalScopeGeneral").checked ? "none" : "";
  });
  $("proposalScopeSpecific").addEventListener("change", () => {
    $("proposalTargetRow").style.display = $("proposalScopeGeneral").checked ? "none" : "";
  });
  $("proposalSave").addEventListener("click", async () => {
    if (!canRole("suggestion")) {
      $("proposalStatus").textContent = "Permission refusée: suggestion.";
      return;
    }
    const message = $("proposalMessage").value.trim();
    if (!message) {
      $("proposalStatus").textContent = "Écris un message.";
      return;
    }
    const isGeneral = $("proposalScopeGeneral").checked;
    const target = $("proposalTarget").value;
    let keyId = null;
    let keyringId = null;
    let hookNo = null;
    if (!isGeneral) {
      if (target === "hook") {
        hookNo = state.proposalModal.hookNo ?? null;
      } else if (target.startsWith("key:")) {
        const id = Number(target.split(":")[1]);
        if (Number.isFinite(id)) keyId = id;
      } else if (target.startsWith("ring:")) {
        const id = Number(target.split(":")[1]);
        if (Number.isFinite(id)) keyringId = id;
      }
    }
    if (!isGeneral && hookNo == null) {
      hookNo = state.proposalModal.hookNo ?? null;
    }
    if (isGeneral) {
      keyId = null;
      keyringId = null;
      hookNo = null;
    }
    let payloadMessage = message;
    try {
      $("proposalSave").disabled = true;
      $("proposalStatus").textContent = "Enregistrement...";
      await createKeySuggestion({
        cabinet_id: isGeneral ? null : state.cabinetId,
        key_id: keyId,
        keyring_id: keyringId,
        hook_no: hookNo,
        is_general: isGeneral,
        message: payloadMessage,
        created_by: state.profile?.id ?? null,
        status: "open",
      });
      $("proposalStatus").textContent = "Suggestion enregistrée.";
      closeProposalModal();
    } catch (e) {
      $("proposalStatus").textContent = `Erreur: ${e?.message ?? e}`;
    } finally {
      $("proposalSave").disabled = false;
    }
  });

  // --- Modal retour demandé ---
  $("returnPromptClose").addEventListener("click", closeReturnPrompt);
  $("returnPromptNo").addEventListener("click", closeReturnPrompt);
  $("returnPromptOverlay").addEventListener("click", closeReturnPrompt);

  $("returnPromptYes").addEventListener("click", () => {
    state.returnPrompt.step = 2;
    renderReturnPromptStep();
  });

  $("returnPromptCancel").addEventListener("click", closeReturnPrompt);

  $("returnPromptReturn").addEventListener("click", async () => {
    const keyId = state.returnPrompt.keyId;
    const loanId = state.returnPrompt.loanId;
    if (!keyId) return;
    try {
      $("returnPromptStatus").textContent = "Traitement...";
      $("returnPromptReturn").disabled = true;
      $("returnPromptBorrow").disabled = true;
      if (Number.isFinite(loanId) && loanId > 0) {
        await fnLoanReturnAny({ loan_id: loanId, key_id: keyId });
      } else {
        await fnLoanReturnAny({ key_id: keyId });
      }
      await refreshAfterAction();
      closeReturnPrompt();
    } catch (e) {
      const msg = e?.message ?? String(e);
      if (isForbiddenError(e)) {
        $("returnPromptStatus").textContent = "Action non autorisée. Seul l'emprunteur ou un admin peut retourner cette clé.";
      } else {
        $("returnPromptStatus").textContent = `Erreur: ${msg}`;
      }
    } finally {
      $("returnPromptReturn").disabled = false;
      $("returnPromptBorrow").disabled = false;
    }
  });

  $("returnPromptBorrow").addEventListener("click", async () => {
    const keyId = state.returnPrompt.keyId;
    const loanId = state.returnPrompt.loanId;
    if (!keyId) return;
    try {
      $("returnPromptStatus").textContent = "Traitement...";
      $("returnPromptReturn").disabled = true;
      $("returnPromptBorrow").disabled = true;
      if (Number.isFinite(loanId) && loanId > 0) {
        await fnLoanReturnAny({ loan_id: loanId, key_id: keyId });
      } else {
        await fnLoanReturnAny({ key_id: keyId });
      }
      closeReturnPrompt();
      await refreshAfterAction();
      if (canAdminLendCabinet()) {
        await openAdminLoanModal({ mode: "key", keyId });
      } else {
        await fnLoanCreate(keyId);
        await refreshAfterAction();
      }
    } catch (e) {
      const msg = e?.message ?? String(e);
      if (isForbiddenError(e)) {
        $("returnPromptStatus").textContent = "Action non autorisée. Seul l'emprunteur ou un admin peut retourner cette clé.";
      } else {
        $("returnPromptStatus").textContent = `Erreur: ${msg}`;
      }
    } finally {
      $("returnPromptReturn").disabled = false;
      $("returnPromptBorrow").disabled = false;
    }
  });

  $("adminLoanClose").addEventListener("click", closeAdminLoanModal);
  $("adminLoanCancel").addEventListener("click", closeAdminLoanModal);
  $("adminLoanOverlay").addEventListener("click", closeAdminLoanModal);
  $("adminLoanSave").addEventListener("click", async () => {
    try {
      const borrowerId = String($("adminLoanBorrowerSelect").value || "").trim();
      const borrowerName = String($("adminLoanBorrowerCustom").value || "").trim();
      const note = String($("adminLoanNote").value || "").trim();
      if (!borrowerId && !borrowerName) {
        $("adminLoanStatus").textContent = "Choisis un utilisateur ou saisis un nom.";
        return;
      }

      $("adminLoanSave").disabled = true;
      $("adminLoanStatus").textContent = "Prêt en cours...";

      if (state.adminLoanModal.mode === "keyring") {
        const keyring = state.keyrings.find((row) => Number(row.id) === Number(state.adminLoanModal.keyringId));
        if (!keyring) throw new Error("Trousseau introuvable.");
        await rpcAdminCreateKeyringLoan({
          cabinet_id: keyring.cabinet_id,
          hook_no: keyring.hook_no,
          ring_code: keyring.ring_code,
          borrower_id: borrowerId || null,
          borrower_name: borrowerId ? null : borrowerName,
          note,
        });
      } else {
        if (!Number.isFinite(Number(state.adminLoanModal.keyId))) throw new Error("Clé introuvable.");
        await rpcAdminCreateLoan({
          key_id: state.adminLoanModal.keyId,
          borrower_id: borrowerId || null,
          borrower_name: borrowerId ? null : borrowerName,
          note,
        });
      }

      await refreshAfterAction();
      closeAdminLoanModal();
    } catch (e) {
      $("adminLoanStatus").textContent = `Erreur: ${e?.message ?? e}`;
    } finally {
      $("adminLoanSave").disabled = false;
    }
  });


}


window.addEventListener("DOMContentLoaded", () => {
  boot().catch((e) => {
    console.error(e);
    const msg = e?.message ?? String(e);
    setStatus("Erreur: " + msg);
    const list = document.getElementById("list");
    if (list) list.innerHTML = `<div class="muted" style="padding:12px;">Erreur: ${msg}</div>`;
  });
});





