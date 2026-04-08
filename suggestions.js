import { requireSessionOrRedirect, getMyProfile, signOut } from "./auth.js";
import { supa } from "./supabaseClient.js";
import { isPendingApprovalRole, redirectToRoleHome } from "./auth.js";
import {
  listCabinets,
  listKeySuggestions,
  listKeysByCabinet,
  listKeysByIds,
  listKeyringsByCabinet,
  listKeyringsByIds,
  listProfilesByIds,
  updateKeySuggestion,
  countOpenSuggestions,
  countPendingUsers,
  countOpenLoansByBorrower,
} from "./api.js";
import { ensureAuditSyncStarted, installGlobalAuditErrorHooks, logAuditEvent } from "./audit.js";

const $ = (id) => document.getElementById(id);

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

function buildNavLinks(role) {
  const normalizedRole = normalizeRole(role);
  if (normalizedRole === "super_admin") {
    return [
      { label: "Clés", href: "./index.html" },
      { label: "Emprunts", href: "./loans.html" },
      { label: "Suggestions", href: "./suggestions.html", badge: Number(state.suggestionCount) || 0 },
      { label: "Configuration", href: "./configuration.html", badge: Number(state.pendingUserCount) || 0 },
      { label: "Déconnexion", action: "logout", danger: true },
    ];
  }
  if (isAdminRole(normalizedRole)) {
    return [
      { label: "Clés", href: "./index.html" },
      { label: "Emprunts", href: "./loans.html" },
      { label: "Suggestions", href: "./suggestions.html", badge: Number(state.suggestionCount) || 0 },
      { label: "Utilisateurs et audit", href: "./configuration.html", badge: Number(state.pendingUserCount) || 0 },
      { label: "Déconnexion", action: "logout", danger: true },
    ];
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

function renderNav(profile, role) {
  $("navHello").textContent = `Bonjour ${profile?.display_name ?? ""}`.trim();
  $("navRole").textContent = roleLabel(role);
  const links = buildNavLinks(role);
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

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDateFr(d) {
  try {
    return new Date(d).toLocaleDateString("fr-CA");
  } catch {
    return String(d ?? "");
  }
}

function normalizeText(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function statusLabel(v) {
  if (v === "triaged") return "En cours";
  if (v === "done") return "Terminé";
  if (v === "rejected") return "Rejeté";
  return "À faire";
}

function hookTarget(cabinetId, hookNo) {
  const cab = Number.isFinite(Number(cabinetId)) ? Math.trunc(Number(cabinetId)) : "?";
  const hook = Number.isFinite(Number(hookNo)) ? Math.trunc(Number(hookNo)) : "?";
  return `hook:${cab}/${hook}`;
}

function keyTargetFromKey(key, fallbackId = null) {
  const cab = Number.isFinite(Number(key?.cabinet_id ?? state.edit.cabinetId)) ? Math.trunc(Number(key?.cabinet_id ?? state.edit.cabinetId)) : "?";
  const hook = Number.isFinite(Number(key?.hook_no ?? state.edit.hookNo)) ? Math.trunc(Number(key?.hook_no ?? state.edit.hookNo)) : "?";
  const keyNo = String(key?.key_no ?? "").trim() || String(fallbackId ?? key?.id ?? "?");
  return `key:${cab}/${hook}/${keyNo}`;
}

function keyringTargetFromRing(ring, fallback = {}) {
  const cab = Number.isFinite(Number(ring?.cabinet_id ?? fallback?.cabinet_id ?? state.edit.cabinetId))
    ? Math.trunc(Number(ring?.cabinet_id ?? fallback?.cabinet_id ?? state.edit.cabinetId))
    : "?";
  const hook = Number.isFinite(Number(ring?.hook_no ?? fallback?.hook_no ?? state.edit.hookNo))
    ? Math.trunc(Number(ring?.hook_no ?? fallback?.hook_no ?? state.edit.hookNo))
    : "?";
  const code = String(ring?.ring_code ?? fallback?.ring_code ?? "").trim().toUpperCase() || "?";
  return `keyring:${cab}/${hook}/${code}`;
}

const state = {
  profile: null,
  role: "new_user",
  cabinets: [],
  suggestions: [],
  keysById: new Map(),
  keyringsById: new Map(),
  usersById: new Map(),
  edit: {
    open: false,
    cabinetId: null,
    hookNo: null,
    keys: [],
    keyrings: [],
  },
  editKeyId: null,
  editRingId: null,
  confirmAction: null,
  suggestionCount: 0,
  pendingUserCount: 0,
  myOpenLoanCount: 0,
};

async function loadData() {
  ensureAuditSyncStarted();
  installGlobalAuditErrorHooks();
  applyTheme();
  await requireSessionOrRedirect();
  state.profile = await getMyProfile();
  state.role = normalizeRole(state.profile?.role ?? "new_user");
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
    state.pendingUserCount = isAdminRole(state.role) ? await countPendingUsers() : 0;
  } catch {
    state.pendingUserCount = 0;
  }

  renderNav(state.profile, state.role);
  bindThemeToggle();

  state.cabinets = await listCabinets();
  $("cabinetFilter").innerHTML = [
    `<option value="">Tous les cabinets</option>`,
    ...state.cabinets.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`),
  ].join("");

  state.suggestions = await listKeySuggestions();
  const keyIds = [...new Set(state.suggestions.map(s => s.key_id).filter(Boolean))];
  const keyringIds = [...new Set(state.suggestions.map(s => s.keyring_id).filter(Boolean))];
  const userIds = [...new Set(state.suggestions.map(s => s.created_by).filter(Boolean))];

  const [keys, keyrings, users] = await Promise.all([
    listKeysByIds(keyIds),
    listKeyringsByIds(keyringIds),
    listProfilesByIds(userIds),
  ]);

  state.keysById = new Map(keys.map(k => [k.id, k]));
  state.keyringsById = new Map(keyrings.map(k => [k.id, k]));
  state.usersById = new Map(users.map(u => [u.id, u.display_name ?? ""]));

  render();
}

function filterSuggestions() {
  const status = $("statusFilter").value;
  const cab = $("cabinetFilter").value;
  const q = normalizeText($("q").value.trim());
  return state.suggestions.filter(s => {
    if (status !== "all" && s.status !== status) return false;
    if (cab && String(s.cabinet_id ?? "") !== cab) return false;
    if (!q) return true;
    const key = s.key_id ? state.keysById.get(s.key_id) : null;
    const ring = s.keyring_id ? state.keyringsById.get(s.keyring_id) : null;
    const author = state.usersById.get(s.created_by) || "";
    const hay = normalizeText([
      s.message,
      s.admin_note,
      s.hook_no,
      key?.key_no,
      key?.local,
      ring?.name,
      ring?.ring_code,
      author,
    ].join(" "));
    return hay.includes(q);
  });
}

function targetLabel(s) {
  if (s.is_general) return "Générale";
  if (s.key_id) {
    const k = state.keysById.get(s.key_id);
    return k ? `Clé #${k.key_no ?? k.id}` : "Clé";
  }
  if (s.keyring_id) {
    const r = state.keyringsById.get(s.keyring_id);
    if (r) return `Trousseau ${r.ring_code ?? "A"}${r.name ? ` (${r.name})` : ""}`;
    return "Trousseau";
  }
  if (s.hook_no) return `Crochet #${s.hook_no}`;
  return "Spécifique";
}

function resolveHookFromSuggestion(s) {
  if (s.hook_no) return Number(s.hook_no);
  if (s.key_id) {
    const k = state.keysById.get(s.key_id);
    return k?.hook_no ?? null;
  }
  if (s.keyring_id) {
    const r = state.keyringsById.get(s.keyring_id);
    return r?.hook_no ?? null;
  }
  return null;
}

function render() {
  const list = filterSuggestions();
  $("countBadge").textContent = `${list.length} suggestion${list.length > 1 ? "s" : ""}`;
  if (!list.length) {
    $("suggestionsList").innerHTML = `<div class="muted">Aucune suggestion.</div>`;
    return;
  }

  const html = list.map(s => {
    const author = state.usersById.get(s.created_by) || s.created_by || "—";
    const cab = state.cabinets.find(c => String(c.id) === String(s.cabinet_id));
    const target = targetLabel(s);
    return `
      <div class="key-row" data-id="${s.id}">
        <div class="key-main">
          <div><strong>${escapeHtml(target)}</strong>${cab ? ` • ${escapeHtml(cab.name)}` : ""}</div>
          <div class="muted">${escapeHtml(s.message || "")}</div>
          <div class="muted">Par ${escapeHtml(author)} le ${escapeHtml(formatDateFr(s.created_at))}</div>
          ${s.is_general ? "" : `<button class="btn secondary reactive" data-open-item="${s.id}">Ouvrir l’éditeur</button>`}
          <div class="muted" style="margin-top:6px;">
            <textarea class="input note-area" data-note="${s.id}" placeholder="Note admin (optionnel)">${escapeHtml(s.admin_note ?? "")}</textarea>
          </div>
        </div>
        <div class="key-actions">
          <select class="select" data-status="${s.id}">
            <option value="open"${s.status === "open" ? " selected" : ""}>À faire</option>
            <option value="triaged"${s.status === "triaged" ? " selected" : ""}>En cours</option>
            <option value="done"${s.status === "done" ? " selected" : ""}>Terminé</option>
            <option value="rejected"${s.status === "rejected" ? " selected" : ""}>Rejeté</option>
          </select>
          <button class="btn secondary reactive" data-save="${s.id}">Enregistrer</button>
        </div>
      </div>
    `;
  }).join("");

  $("suggestionsList").innerHTML = html;
}

function bind() {
  $("statusFilter").addEventListener("change", render);
  $("cabinetFilter").addEventListener("change", render);
  $("q").addEventListener("input", render);

  $("suggestionsList").addEventListener("click", async (e) => {
    const openBtn = e.target.closest("button[data-open-item]");
    if (openBtn) {
      const id = openBtn.dataset.openItem;
      const s = state.suggestions.find(x => String(x.id) === String(id));
      if (s) openEditHookModal(s);
      return;
    }
    const btn = e.target.closest("button[data-save]");
    if (!btn) return;
    const id = btn.dataset.save;
    const statusSel = document.querySelector(`select[data-status="${id}"]`);
    const noteEl = document.querySelector(`textarea[data-note="${id}"]`);
    if (!statusSel) return;
    const status = statusSel.value;
    const admin_note = noteEl ? noteEl.value.trim() : null;
    try {
      btn.disabled = true;
      const current = state.suggestions.find(s => String(s.id) === String(id));
      const prevStatus = current?.status ?? "";
      const prevNote = current?.admin_note ?? "";
      await updateKeySuggestion(id, { status, admin_note });
      const idx = state.suggestions.findIndex(s => String(s.id) === String(id));
      if (idx >= 0) {
        state.suggestions[idx].status = status;
        state.suggestions[idx].admin_note = admin_note;
      }
      const detailsParts = [];
      if (prevStatus !== status) detailsParts.push(`state: ${statusLabel(status)}`);
      if ((prevNote || "") !== (admin_note || "")) detailsParts.push(`note: ${admin_note || "-"}`);
      await logAuditEvent({
        event_type: "suggestion_update",
        action: "suggestion_update",
        target: `suggestion:${id}`,
        details: detailsParts.join("; ") || "Mise à jour suggestion",
        source: "frontend",
      });
      if (status === "done" || status === "rejected") {
        state.suggestionCount = Math.max(0, state.suggestionCount - 1);
        const badge = $("burgerBadge");
        if (badge) {
          badge.textContent = String(state.suggestionCount);
          badge.hidden = state.suggestionCount === 0;
        }
        const navLinks = [...document.querySelectorAll("#navLinksTop a.nav-link")];
        const sugLink = navLinks.find(a => (a.getAttribute("href") || "").includes("suggestions.html"));
        if (sugLink) {
          let navBadge = sugLink.querySelector(".nav-badge");
          if (state.suggestionCount > 0) {
            if (!navBadge) {
              navBadge = document.createElement("span");
              navBadge.className = "nav-badge";
              sugLink.appendChild(navBadge);
            }
            navBadge.textContent = String(state.suggestionCount);
          } else if (navBadge) {
            navBadge.remove();
          }
        }
      }
      render();
    } catch (err) {
      alert(err?.message ?? String(err));
    } finally {
      btn.disabled = false;
    }
  });
}

bind();
loadData();

function setModalOpen(id, open) {
  const overlay = $(id + "Overlay");
  const modal = $(id + "Modal");
  if (!overlay || !modal) return;
  overlay.hidden = !open;
  modal.hidden = !open;
  modal.setAttribute("aria-hidden", open ? "false" : "true");
}

async function openEditHookModal(suggestion) {
  const hookNo = resolveHookFromSuggestion(suggestion);
  if (!Number.isFinite(hookNo)) {
    alert("Impossible de trouver le crochet associé.");
    return;
  }
  const cabinetId = suggestion.cabinet_id ?? state.keysById.get(suggestion.key_id)?.cabinet_id ?? state.keyringsById.get(suggestion.keyring_id)?.cabinet_id;
  if (!cabinetId) {
    alert("Cabinet introuvable pour cette suggestion.");
    return;
  }
  state.edit.cabinetId = Number(cabinetId);
  state.edit.hookNo = Number(hookNo);
  $("editHookTitle").textContent = `Éditeur — Crochet #${hookNo}`;
  const cab = state.cabinets.find(c => String(c.id) === String(cabinetId));
  $("editHookSub").textContent = cab ? cab.name : "—";
  await loadEditHookData();
  renderEditHook();
  setModalOpen("editHook", true);
}

function closeEditHookModal() {
  setModalOpen("editHook", false);
  state.edit.open = false;
}

async function loadEditHookData() {
  const cid = state.edit.cabinetId;
  const [keys, rings] = await Promise.all([
    listKeysByCabinet(cid),
    listKeyringsByCabinet(cid),
  ]);
  state.edit.keys = keys.filter(k => Number(k.hook_no) === Number(state.edit.hookNo));
  state.edit.keyrings = rings.filter(r => Number(r.hook_no) === Number(state.edit.hookNo));
}

function renderEditHook() {
  const keys = state.edit.keys || [];
  const rings = state.edit.keyrings || [];
  const ringHtml = rings.map(r => {
    const ringKeys = keys.filter(k => Number(k.keyring_id) === Number(r.id));
    return `
      <div class="keyring-card">
        <div class="keyring-header">
          <div class="keyring-info">
            <div class="keyring-title">
              <span class="kpill">Trousseau ${escapeHtml(r.ring_code ?? "A")}${r.name ? ` (${escapeHtml(r.name)})` : ""}</span>
              <span class="muted">(${ringKeys.length} clés)</span>
            </div>
          </div>
          <div class="key-actions keyring-actions">
            <button class="btn secondary icon-btn reactive btn-edit" data-action="ring-edit" data-ring-id="${r.id}" title="Éditer">⚙</button>
            <button class="btn danger icon-btn reactive btn-delete" data-action="ring-delete" data-ring-id="${r.id}" title="Supprimer">X</button>
          </div>
        </div>
        <div class="keyring-body">
          ${ringKeys.map(k => renderKeyRow(k)).join("")}
        </div>
      </div>
    `;
  }).join("");

  const singleKeys = keys.filter(k => !k.keyring_id);
  const singlesHtml = singleKeys.map(k => renderKeyRow(k)).join("");

  $("editHookContent").innerHTML = `
    <div class="hook-list">
      ${ringHtml}
      ${singlesHtml}
    </div>
  `;
}

function renderKeyRow(k) {
  return `
    <div class="key-row" data-key-id="${k.id}">
      <span class="kpill">${escapeHtml(`#${k.key_no ?? k.id}`)}</span>
      <div class="key-main">
        <div class="muted">Local: ${escapeHtml(k.local ?? "—")} • Utilisation: ${escapeHtml(k.utilisation ?? "—")}</div>
        <div class="muted">Remarque: ${escapeHtml(k.remarque ?? "—")}</div>
      </div>
      <div class="key-actions">
        <button class="btn secondary icon-btn reactive btn-edit" data-action="key-edit" data-key-id="${k.id}" title="Éditer">⚙</button>
        <button class="btn danger icon-btn reactive btn-delete" data-action="key-delete" data-key-id="${k.id}" title="Supprimer">X</button>
      </div>
    </div>
  `;
}

function fillEditKeyModal(key) {
  $("ek_hook_no").value = key?.hook_no ?? "";
  $("ek_key_no").value = key?.key_no ?? "";
  $("ek_local").value = key?.local ?? "";
  $("ek_pavillon").value = key?.pavillon ?? "";
  $("ek_utilisation").value = key?.utilisation ?? "";
  $("ek_remarque").value = key?.remarque ?? "";
  
  $("editKeyStatus").textContent = "";
  const inRing = Number.isFinite(key?.keyring_id);
  $("ek_hook_no").disabled = inRing;
  if (inRing) {
    $("editKeyStatus").textContent = "Clé dans un trousseau : retirer du trousseau pour changer de crochet.";
  }
}

function fillEditRingModal(ring) {
  $("er_hook_no").value = ring?.hook_no ?? "";
  $("er_code").value = ring?.ring_code ?? "";
  $("er_name").value = ring?.name ?? "";
  $("er_note").value = ring?.note ?? "";
  $("editRingHook").textContent = `Crochet #${ring?.hook_no ?? "—"}`;
  $("editRingStatus").textContent = "";
}

function openConfirm(title, text, action) {
  $("confirmTitle").textContent = title;
  $("confirmText").textContent = text;
  $("confirmStatus").textContent = "";
  state.confirmAction = action;
  setModalOpen("confirm", true);
}

function closeConfirm() {
  state.confirmAction = null;
  setModalOpen("confirm", false);
}

function openCreateRingModal() {
  const hookNo = state.edit.hookNo;
  $("createRingHook").textContent = `Crochet #${hookNo}`;
  $("cr_code").value = "A";
  $("cr_name").value = `Trousseau ${$("cr_code").value}`;
  $("cr_note").value = "";
  const list = state.edit.keys
    .filter(k => !k.keyring_id)
    .map(k => `
      <label class="keyring-create-item">
        <input type="checkbox" data-key-id="${k.id}" />
        <span class="kpill">${escapeHtml(`#${k.key_no ?? k.id}`)}</span>
        <div class="meta">Local: ${escapeHtml(k.local ?? "—")} • Utilisation: ${escapeHtml(k.utilisation ?? "—")}</div>
      </label>
    `).join("");
  $("createRingList").innerHTML = list || `<div class="muted">Aucune clé disponible.</div>`;
  $("createRingStatus").textContent = "";
  setModalOpen("createRing", true);
}

function closeCreateRingModal() {
  setModalOpen("createRing", false);
}

function openAddKeyModal() {
  $("addKeyHook").textContent = `Crochet #${state.edit.hookNo}`;
  $("ak_key_no").value = "";
  $("ak_local").value = "";
  $("ak_pavillon").value = "";
  $("ak_utilisation").value = "";
  $("ak_remarque").value = "";
  
  $("addKeyStatus").textContent = "";
  setModalOpen("addKey", true);
}

function closeAddKeyModal() {
  setModalOpen("addKey", false);
}

function openEditKeyModal(keyId) {
  const key = state.edit.keys.find(k => k.id === keyId);
  if (!key) return;
  state.editKeyId = keyId;
  fillEditKeyModal(key);
  setModalOpen("editKey", true);
}

function closeEditKeyModal() {
  state.editKeyId = null;
  setModalOpen("editKey", false);
}

function openEditRingModal(ringId) {
  const ring = state.edit.keyrings.find(r => r.id === ringId);
  if (!ring) return;
  state.editRingId = ringId;
  fillEditRingModal(ring);
  setModalOpen("editRing", true);
}

function closeEditRingModal() {
  state.editRingId = null;
  setModalOpen("editRing", false);
}

function bindEditHookEvents() {
  $("editHookClose").addEventListener("click", closeEditHookModal);
  $("editHookOverlay").addEventListener("click", closeEditHookModal);
  $("editHookAddKey").addEventListener("click", openAddKeyModal);
  $("editHookCreateKeyring").addEventListener("click", openCreateRingModal);

  $("editHookContent").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const keyId = Number(btn.dataset.keyId);
    const ringId = Number(btn.dataset.ringId);
    if (action === "key-edit") openEditKeyModal(keyId);
    if (action === "key-delete") {
      openConfirm("Supprimer clé", "Confirmer la suppression de cette clé ?", async () => {
        await supa.from("keys").delete().eq("id", keyId);
        await logAuditEvent({
          event_type: "key_delete",
          action: "key_delete",
          target: keyTargetFromKey(state.edit.keys.find((k) => Number(k.id) === Number(keyId)), keyId),
          details: "Suppression depuis l'éditeur suggestions",
          source: "frontend",
        });
      });
    }
    if (action === "ring-edit") openEditRingModal(ringId);
    if (action === "ring-delete") {
      openConfirm("Supprimer trousseau", "Supprimer le trousseau et remettre les clés individuelles ?", async () => {
        await supa.from("keys").update({ keyring_id: null }).eq("keyring_id", ringId);
        await supa.from("keyrings").delete().eq("id", ringId);
        await logAuditEvent({
          event_type: "keyring_delete",
          action: "keyring_delete",
          target: keyringTargetFromRing(state.edit.keyrings.find((r) => Number(r.id) === Number(ringId))),
          details: "Suppression depuis l'éditeur suggestions",
          source: "frontend",
        });
      });
    }
  });

  $("editKeyClose").addEventListener("click", closeEditKeyModal);
  $("editKeyCancel").addEventListener("click", closeEditKeyModal);
  $("editKeySave").addEventListener("click", async () => {
    if (!state.editKeyId) return;
    try {
      $("editKeySave").disabled = true;
      const hookNoRaw = $("ek_hook_no").value.trim();
      const hookNo = hookNoRaw ? Number(hookNoRaw) : null;
      if (hookNoRaw && !Number.isFinite(hookNo)) {
        $("editKeyStatus").textContent = "No crochet invalide.";
        return;
      }
      const existing = state.edit.keys.find(k => k.id === state.editKeyId);
      const payload = {
        hook_no: hookNo,
        key_no: $("ek_key_no").value.trim() || null,
        local: $("ek_local").value.trim() || null,
        pavillon: $("ek_pavillon").value.trim() || null,
        utilisation: $("ek_utilisation").value.trim() || null,
        remarque: $("ek_remarque").value.trim() || null,
        
      };
      if (existing && hookNo != null && Number(existing.hook_no) !== Number(hookNo)) {
        payload.keyring_id = null;
      }
      const { error } = await supa.from("keys").update(payload).eq("id", state.editKeyId);
      if (error) throw error;
      await logAuditEvent({
        event_type: (existing && hookNo != null && Number(existing.hook_no) !== Number(hookNo)) ? "key_move" : "key_update",
        action: (existing && hookNo != null && Number(existing.hook_no) !== Number(hookNo)) ? "key_move" : "key_update",
        target: keyTargetFromKey({
          ...existing,
          hook_no: hookNo != null ? hookNo : existing?.hook_no,
          key_no: $("ek_key_no").value.trim() || existing?.key_no,
          local: $("ek_local").value.trim() || null,
          utilisation: $("ek_utilisation").value.trim() || null,
          remarque: $("ek_remarque").value.trim() || null,
          pavillon: $("ek_pavillon").value.trim() || null,
        }, state.editKeyId),
        details: [
          `local: ${$("ek_local").value.trim() || "-"}`,
          `utilisation: ${$("ek_utilisation").value.trim() || "-"}`,
          `remarque: ${$("ek_remarque").value.trim() || "-"}`,
          `pavillon: ${$("ek_pavillon").value.trim() || "-"}`,
          `key_no: ${$("ek_key_no").value.trim() || "-"}`,
          (existing && hookNo != null && Number(existing.hook_no) !== Number(hookNo)) ? `hook: ${existing.hook_no} -> ${hookNo}` : "",
        ].filter(Boolean).join("; "),
        source: "frontend",
      });
      await loadEditHookData();
      renderEditHook();
      closeEditKeyModal();
    } catch (e) {
      $("editKeyStatus").textContent = `Erreur: ${e?.message ?? e}`;
    } finally {
      $("editKeySave").disabled = false;
    }
  });

  $("editRingClose").addEventListener("click", closeEditRingModal);
  $("editRingCancel").addEventListener("click", closeEditRingModal);
  $("editRingSave").addEventListener("click", async () => {
    if (!state.editRingId) return;
    try {
      $("editRingSave").disabled = true;
      const hookNoRaw = $("er_hook_no").value.trim();
      const hookNo = hookNoRaw ? Number(hookNoRaw) : null;
      if (hookNoRaw && !Number.isFinite(hookNo)) {
        $("editRingStatus").textContent = "No crochet invalide.";
        return;
      }
      const existing = state.edit.keyrings.find(r => r.id === state.editRingId);
      const payload = {
        hook_no: hookNo,
        ring_code: $("er_code").value.trim().toUpperCase() || null,
        name: $("er_name").value.trim() || null,
        note: $("er_note").value.trim() || null,
      };
      const { error } = await supa.from("keyrings").update(payload).eq("id", state.editRingId);
      if (error) throw error;
      if (existing && hookNo != null && Number(existing.hook_no) !== Number(hookNo)) {
        const { error: kErr } = await supa
          .from("keys")
          .update({ hook_no: hookNo })
          .eq("keyring_id", state.editRingId);
        if (kErr) throw kErr;
      }
      await logAuditEvent({
        event_type: (existing && hookNo != null && Number(existing.hook_no) !== Number(hookNo)) ? "keyring_move" : "keyring_update",
        action: (existing && hookNo != null && Number(existing.hook_no) !== Number(hookNo)) ? "keyring_move" : "keyring_update",
        target: keyringTargetFromRing(existing, { hook_no: hookNo, ring_code: payload.ring_code }),
        details: (() => {
          if (existing && hookNo != null && Number(existing.hook_no) !== Number(hookNo)) {
            return `hook: ${existing.hook_no} -> ${hookNo}`;
          }
          const parts = [];
          const prevCode = String(existing?.ring_code ?? "").trim().toUpperCase();
          const nextCode = String(payload.ring_code ?? "").trim().toUpperCase();
          const prevName = String(existing?.name ?? "").trim();
          const nextName = String(payload.name ?? "").trim();
          const prevNote = String(existing?.note ?? "").trim();
          const nextNote = String(payload.note ?? "").trim();
          if (prevCode !== nextCode) parts.push(`ring_code: ${nextCode || "-"}`);
          if (prevName !== nextName) parts.push(`name: ${nextName || "-"}`);
          if (prevNote !== nextNote) parts.push(`note: ${nextNote || "-"}`);
          return parts.join("; ") || "Aucun changement";
        })(),
        source: "frontend",
      });
      await loadEditHookData();
      renderEditHook();
      closeEditRingModal();
    } catch (e) {
      $("editRingStatus").textContent = `Erreur: ${e?.message ?? e}`;
    } finally {
      $("editRingSave").disabled = false;
    }
  });

  $("createRingClose").addEventListener("click", closeCreateRingModal);
  $("createRingCancel").addEventListener("click", closeCreateRingModal);
  $("createRingSave").addEventListener("click", async () => {
    try {
      $("createRingSave").disabled = true;
      const code = $("cr_code").value.trim().toUpperCase();
      if (!/^[A-Z]$/.test(code)) {
        $("createRingStatus").textContent = "Code invalide (A-Z).";
        return;
      }
      const name = $("cr_name").value.trim() || null;
      const note = $("cr_note").value.trim() || null;
      const selected = [...$("createRingList").querySelectorAll("input[type='checkbox']:checked")]
        .map(cb => Number(cb.dataset.keyId))
        .filter(n => Number.isFinite(n));
      if (!selected.length) {
        $("createRingStatus").textContent = "Sélectionne au moins une clé.";
        return;
      }
      const { data: ring, error: ringErr } = await supa
        .from("keyrings")
        .insert({
          cabinet_id: state.edit.cabinetId,
          hook_no: state.edit.hookNo,
          ring_code: code,
          name,
          note,
        })
        .select("id")
        .single();
      if (ringErr) throw ringErr;
      const { error: updErr } = await supa.from("keys").update({ keyring_id: ring.id }).in("id", selected);
      if (updErr) throw updErr;
      await logAuditEvent({
        event_type: "keyring_create",
        action: "keyring_create",
        target: keyringTargetFromRing(null, { cabinet_id: state.edit.cabinetId, hook_no: state.edit.hookNo, ring_code: code }),
        details: `hook=${state.edit.hookNo}, keys=${selected.length}`,
        source: "frontend",
      });
      await loadEditHookData();
      renderEditHook();
      closeCreateRingModal();
    } catch (e) {
      $("createRingStatus").textContent = `Erreur: ${e?.message ?? e}`;
    } finally {
      $("createRingSave").disabled = false;
    }
  });

  $("addKeyClose").addEventListener("click", closeAddKeyModal);
  $("addKeyCancel").addEventListener("click", closeAddKeyModal);
  $("addKeySave").addEventListener("click", async () => {
    try {
      $("addKeySave").disabled = true;
      const payload = {
        cabinet_id: state.edit.cabinetId,
        hook_no: state.edit.hookNo,
        key_no: $("ak_key_no").value.trim() || null,
        local: $("ak_local").value.trim() || null,
        pavillon: $("ak_pavillon").value.trim() || null,
        utilisation: $("ak_utilisation").value.trim() || null,
        remarque: $("ak_remarque").value.trim() || null,
        
      };
      const { error } = await supa.from("keys").insert(payload);
      if (error) throw error;
      await logAuditEvent({
        event_type: "key_create",
        action: "key_create",
        target: payload.key_no
          ? keyTargetFromKey({ cabinet_id: state.edit.cabinetId, key_no: payload.key_no }, null)
          : hookTarget(state.edit.cabinetId, state.edit.hookNo),
        details: [
          `local: ${payload.local || "-"}`,
          `utilisation: ${payload.utilisation || "-"}`,
          `remarque: ${payload.remarque || "-"}`,
          `pavillon: ${payload.pavillon || "-"}`,
          `key_no: ${payload.key_no || "-"}`,
          `hook: ${state.edit.hookNo}`,
        ].join("; "),
        source: "frontend",
      });
      await loadEditHookData();
      renderEditHook();
      closeAddKeyModal();
    } catch (e) {
      $("addKeyStatus").textContent = `Erreur: ${e?.message ?? e}`;
    } finally {
      $("addKeySave").disabled = false;
    }
  });

  $("confirmClose").addEventListener("click", closeConfirm);
  $("confirmNo").addEventListener("click", closeConfirm);
  $("confirmOverlay").addEventListener("click", closeConfirm);
  $("confirmYes").addEventListener("click", async () => {
    if (!state.confirmAction) return;
    try {
      $("confirmYes").disabled = true;
      await state.confirmAction();
      await loadEditHookData();
      renderEditHook();
      closeConfirm();
    } catch (e) {
      $("confirmStatus").textContent = `Erreur: ${e?.message ?? e}`;
    } finally {
      $("confirmYes").disabled = false;
    }
  });
}

bindEditHookEvents();




