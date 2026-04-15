import { requireSessionOrRedirect, getMyProfile, signOut, isPendingApprovalRole, redirectToRoleHome, notifyAdminAboutPendingUsers } from "./auth.js";
import {
  listCabinets,
  listLoansAll,
  listLoansByBorrower,
  listKeysByIds,
  listProfilesByIds,
  listKeyringsByCabinet,
  listKeysByCabinet,
  listMissingByKeyIds,
  fnLoanReturn,
  countOpenSuggestions,
  countPendingUsers,
  countOpenLoansByBorrower,
} from "./api.js";
import { ensureAuditSyncStarted, installGlobalAuditErrorHooks } from "./audit.js";

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

function normalizeRole(role) {
  const r = String(role ?? "").trim().toLowerCase().replaceAll("-", "_").replace(/\s+/g, "_");
  if (r === "super_admin" || r === "superadmin") return "super_admin";
  if (r === "admin" || r === "consultant" || r === "user" || r === "new_user") return r;
  return "new_user";
}

function isAdminRole(role) {
  const r = normalizeRole(role);
  return r === "admin" || r === "super_admin";
}

function roleLabel(role) {
  const r = normalizeRole(role);
  return r === "super_admin" ? "Super-admin"
    : r === "admin" ? "Administrateur"
      : r === "consultant" ? "Consultant"
        : r === "new_user" ? "Salle d'attente"
        : "Utilisateur";
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

function formatKey(k) {
  const a = k?.local ? `${k.local}` : "";
  const b = k?.key_no ? `#${k.key_no}` : "";
  return (a && b) ? `${a} ${b}` : (a || b || "Clé");
}

function statusLabel(l) {
  return l.returned_at ? "Terminé" : "En cours";
}

function statusClass(l) {
  return l.returned_at ? "badge ok" : "badge warn";
}

function loanBorrowerLabel(loan) {
  return state.borrowersById.get(loan?.borrower_id) || loan?.borrower_name || loan?.borrower_id || "—";
}

const state = {
  page: document.body.dataset.page || "loans",
  profile: null,
  role: "new_user",
  activeTab: "mine",
  cabinets: [],
  loans: [],
  keysById: new Map(),
  borrowersById: new Map(),
  keyringsById: new Map(),
  allKeysById: new Map(),
  missingRows: [],
  reportersById: new Map(),
  suggestionCount: 0,
  pendingUserCount: 0,
  myOpenLoanCount: 0,
};

function setActiveTab(tab) {
  const tabs = ["mine", "team", "missing"];
  for (const t of tabs) {
    const btn = $(`tab${t.charAt(0).toUpperCase() + t.slice(1)}Btn`);
    const panel = $(`tab${t.charAt(0).toUpperCase() + t.slice(1)}`);
    if (btn) btn.classList.toggle("active", t === tab);
    if (panel) panel.style.display = t === tab ? "" : "none";
  }
  state.activeTab = tab;
}

function refillCabinetFilters() {
  const opts = [
    `<option value="">Tous les cabinets</option>`,
    ...state.cabinets.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`),
  ].join("");
  const ids = ["cabinetFilterMine", "cabinetFilterTeam", "cabinetFilterMissing"];
  for (const id of ids) {
    const el = $(id);
    if (!el) continue;
    const prev = el.value;
    el.innerHTML = opts;
    if (prev) el.value = prev;
  }
}

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
  if (state.page === "loans" && !isAdminRole(state.role)) {
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
  }
  try {
    state.pendingUserCount = isAdminRole(state.role) ? await countPendingUsers() : 0;
    if (isAdminRole(state.role)) notifyAdminAboutPendingUsers(state.pendingUserCount);
  } catch {
    state.pendingUserCount = 0;
  }

  renderNav(state.profile, state.role);
  bindThemeToggle();

  state.cabinets = await listCabinets();
  if (state.page === "loans") {
    refillCabinetFilters();
  } else {
    $("cabinetFilter").innerHTML = [
      `<option value="">Tous les cabinets</option>`,
      ...state.cabinets.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`),
    ].join("");
  }

  state.loans = state.page === "loans"
    ? await listLoansAll()
    : await listLoansByBorrower(state.profile?.id);
  const loanKeyIds = [...new Set(state.loans.map((l) => l.key_id).filter(Boolean))];
  const loanKeys = await listKeysByIds(loanKeyIds);
  state.keysById = new Map(loanKeys.map((k) => [k.id, k]));

  const borrowerIds = [...new Set(state.loans.map((l) => l.borrower_id).filter(Boolean))];
  const borrowerProfiles = await listProfilesByIds(borrowerIds);
  state.borrowersById = new Map(borrowerProfiles.map((p) => [p.id, p.display_name ?? ""]));

  const allKeyrings = [];
  const allKeys = [];
  for (const c of state.cabinets) {
    const rings = await listKeyringsByCabinet(c.id);
    allKeyrings.push(...rings);
    if (state.page === "loans") {
      const keys = await listKeysByCabinet(c.id);
      allKeys.push(...keys);
    }
  }
  state.keyringsById = new Map(allKeyrings.map((r) => [r.id, r]));

  if (state.page === "loans") {
    state.allKeysById = new Map(allKeys.map((k) => [k.id, k]));
    const allKeyIds = [...new Set(allKeys.map((k) => k.id).filter(Boolean))];
    state.missingRows = allKeyIds.length ? await listMissingByKeyIds(allKeyIds) : [];
    const reporterIds = [...new Set(state.missingRows.map((m) => m.reported_by).filter(Boolean))];
    const reporterProfiles = reporterIds.length ? await listProfilesByIds(reporterIds) : [];
    state.reportersById = new Map(reporterProfiles.map((p) => [p.id, p.display_name ?? ""]));
  }

  render();
}

function filterLoans(mode) {
  const status = $(`statusFilter${mode === "mine" ? "Mine" : "Team"}`).value;
  const cab = $(`cabinetFilter${mode === "mine" ? "Mine" : "Team"}`).value;
  const q = $(`q${mode === "mine" ? "Mine" : "Team"}`).value.trim().toLowerCase();

  return state.loans.filter((l) => {
    if (mode === "mine" && String(l.borrower_id) !== String(state.profile?.id)) return false;
    if (mode === "team" && String(l.borrower_id) === String(state.profile?.id)) return false;
    if (status === "open" && l.returned_at) return false;
    if (status === "closed" && !l.returned_at) return false;

    const key = state.keysById.get(l.key_id);
    if (cab && key?.cabinet_id != null && String(key.cabinet_id) !== cab) return false;

    if (!q) return true;
    const borrower = loanBorrowerLabel(l);
    const ring = key?.keyring_id ? state.keyringsById.get(key.keyring_id) : null;
    const ringLabel = ring ? `trousseau ${ring.ring_code ?? ""} ${ring.name ?? ""}` : "";
    const hay = [
      key?.local,
      key?.key_no,
      key?.remarque,
      key?.utilisation,
      borrower,
      l.note,
      ringLabel,
      key?.hook_no,
    ].map((x) => String(x ?? "").toLowerCase()).join(" ");
    return hay.includes(q);
  });
}

function renderLoansList(mode) {
  const list = filterLoans(mode);
  const countId = mode === "mine" ? "countBadgeMine" : "countBadgeTeam";
  const listId = mode === "mine" ? "loansListMine" : "loansListTeam";
  $(countId).textContent = `${list.length} emprunt${list.length > 1 ? "s" : ""}`;

  if (!list.length) {
    $(listId).innerHTML = `<div class="muted">Aucun emprunt.</div>`;
    return;
  }

  const canReturn = mode === "mine";
  $(listId).innerHTML = list.map((l) => {
    const key = state.keysById.get(l.key_id);
    const borrower = loanBorrowerLabel(l);
    const hookNo = key?.hook_no ?? "—";
    const keyLabel = key ? formatKey(key) : "Clé supprimée";
    const local = key?.local ?? "—";
    const loanedAt = formatDateFr(l.loaned_at);
    const returnedAt = l.returned_at ? formatDateFr(l.returned_at) : "—";
    const keyBadge = `<span class="${statusClass(l)}">${statusLabel(l)}</span>`;
    const returnBtn = canReturn && !l.returned_at
      ? `<button class="btn secondary reactive" data-action="loan-return" data-loan-id="${l.id}">Retourner</button>`
      : "";
    return `
      <div class="key-row">
        <div class="key-main">
          <div><strong>Crochet #${escapeHtml(hookNo)}</strong> | ${escapeHtml(keyLabel)}</div>
          <div class="muted">Local: ${escapeHtml(local)} • Emprunté par ${escapeHtml(borrower)} le ${escapeHtml(loanedAt)} • Retourné le ${escapeHtml(returnedAt)}</div>
          ${l.note ? `<div class="muted">Note: ${escapeHtml(l.note)}</div>` : ""}
        </div>
        <div class="key-actions">
          ${returnBtn}
          ${keyBadge}
        </div>
      </div>
    `;
  }).join("");
}

function filterMissingEntries() {
  const cab = $("cabinetFilterMissing").value;
  const q = $("qMissing").value.trim().toLowerCase();

  const latestByKey = new Map();
  for (const row of state.missingRows) {
    const prev = latestByKey.get(row.key_id);
    if (!prev || String(row.reported_at) > String(prev.reported_at)) latestByKey.set(row.key_id, row);
  }

  const out = [];
  for (const row of latestByKey.values()) {
    const key = state.allKeysById.get(row.key_id);
    if (!key) continue;
    if (cab && String(key.cabinet_id) !== cab) continue;
    const ring = key.keyring_id ? state.keyringsById.get(key.keyring_id) : null;
    const reporter = state.reportersById.get(row.reported_by) || row.reported_by || "—";
    const hay = [
      key.local,
      key.key_no,
      key.hook_no,
      ring?.ring_code,
      ring?.name,
      reporter,
    ].map((x) => String(x ?? "").toLowerCase()).join(" ");
    if (q && !hay.includes(q)) continue;
    out.push({ row, key, ring, reporter });
  }
  return out;
}

function renderMissing() {
  const entries = filterMissingEntries();
  $("countBadgeMissing").textContent = `${entries.length} clé${entries.length > 1 ? "s" : ""} disparue${entries.length > 1 ? "s" : ""}`;
  if (!entries.length) {
    $("missingList").innerHTML = `<div class="muted">Aucune clé disparue.</div>`;
    return;
  }

  const cabinetsById = new Map(state.cabinets.map((c) => [String(c.id), c]));
  const grouped = new Map(); // cabinet_id -> hook_no -> { rings: Map, loose: [] }
  for (const e of entries) {
    const cabKey = String(e.key.cabinet_id);
    if (!grouped.has(cabKey)) {
      grouped.set(cabKey, new Map());
    }
    const hooks = grouped.get(cabKey);
    const hookNo = Number(e.key.hook_no);
    const hookKey = Number.isFinite(hookNo) ? hookNo : -1;
    if (!hooks.has(hookKey)) hooks.set(hookKey, { rings: new Map(), loose: [] });
    const g = hooks.get(hookKey);
    if (e.ring) {
      const ringKey = String(e.ring.id);
      if (!g.rings.has(ringKey)) g.rings.set(ringKey, { ring: e.ring, keys: [] });
      g.rings.get(ringKey).keys.push(e);
    } else {
      g.loose.push(e);
    }
  }

  const cabinetCards = [...grouped.entries()].map(([cabId, hooks]) => {
    const cab = cabinetsById.get(cabId);
    const cabName = cab?.name ?? `Cabinet ${cabId}`;
    const hookRows = [...hooks.entries()]
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([hookNo, g]) => {
        const looseRows = g.loose
          .sort((a, b) => String(a.key.key_no ?? "").localeCompare(String(b.key.key_no ?? "")))
          .map((e) => `
            <tr>
              <td>${escapeHtml(hookNo > 0 ? hookNo : "—")}</td>
              <td>Clé ${escapeHtml(e.key.key_no ?? e.key.id ?? "—")}</td>
              <td>${escapeHtml(e.key.local ?? "—")}</td>
              <td>${escapeHtml(e.reporter)}</td>
              <td>${escapeHtml(formatDateFr(e.row.reported_at))}</td>
            </tr>
          `).join("");

        const ringRows = [...g.rings.values()]
          .sort((a, b) => String(a.ring.ring_code ?? "").localeCompare(String(b.ring.ring_code ?? "")))
          .map((rg) => {
            const keysHtml = rg.keys
              .sort((a, b) => String(a.key.key_no ?? "").localeCompare(String(b.key.key_no ?? "")))
              .map((e) => `
                <tr>
                  <td></td>
                  <td>&nbsp;&nbsp;&nbsp;Clé ${escapeHtml(e.key.key_no ?? e.key.id ?? "—")}</td>
                  <td>${escapeHtml(e.key.local ?? "—")}</td>
                  <td>${escapeHtml(e.reporter)}</td>
                  <td>${escapeHtml(formatDateFr(e.row.reported_at))}</td>
                </tr>
              `).join("");
            return `
              <tr>
                <td>${escapeHtml(hookNo > 0 ? hookNo : "—")}</td>
                <td>Trousseau ${escapeHtml(rg.ring.ring_code ?? "—")}${rg.ring.name ? ` • ${escapeHtml(rg.ring.name)}` : ""}</td>
                <td>—</td>
                <td>—</td>
                <td>—</td>
              </tr>
              ${keysHtml}
            `;
          }).join("");

        return `${ringRows}${looseRows}`;
      }).join("");

    return `
      <div class="item">
        <div class="item-header">
          <div class="title">${escapeHtml(cabName)}</div>
        </div>
        <div style="overflow:auto; margin-top:8px;">
          <table class="hook-existing-table" style="min-width:860px;">
            <thead>
              <tr>
                <th>Crochet</th>
                <th>Élément</th>
                <th>Local</th>
                <th>Signalé par</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              ${hookRows}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }).join("");

  $("missingList").innerHTML = cabinetCards;
}

function render() {
  if (state.page === "my-loans") {
    const status = $("statusFilter").value;
    const cab = $("cabinetFilter").value;
    const q = $("q").value.trim().toLowerCase();
    const filtered = state.loans.filter((l) => {
      if (status === "open" && l.returned_at) return false;
      if (status === "closed" && !l.returned_at) return false;
      const key = state.keysById.get(l.key_id);
      if (cab && key?.cabinet_id != null && String(key.cabinet_id) !== cab) return false;
      if (!q) return true;
      const hay = [key?.local, key?.key_no, key?.remarque, key?.utilisation, l.note, key?.hook_no]
        .map((x) => String(x ?? "").toLowerCase()).join(" ");
      return hay.includes(q);
    });

    $("countBadge").textContent = `${filtered.length} emprunt${filtered.length > 1 ? "s" : ""}`;
    if (!filtered.length) {
      $("loansList").innerHTML = `<div class="muted">Aucun emprunt.</div>`;
      return;
    }
    $("loansList").innerHTML = filtered.map((l) => {
      const key = state.keysById.get(l.key_id);
      const hookNo = key?.hook_no ?? "—";
      const keyLabel = key ? formatKey(key) : "Clé supprimée";
      const local = key?.local ?? "—";
      const loanedAt = formatDateFr(l.loaned_at);
      const returnedAt = l.returned_at ? formatDateFr(l.returned_at) : "—";
      const keyBadge = `<span class="${statusClass(l)}">${statusLabel(l)}</span>`;
      const returnBtn = !l.returned_at
        ? `<button class="btn secondary reactive" data-action="loan-return" data-loan-id="${l.id}">Retourner</button>`
        : "";
      return `
        <div class="key-row">
          <div class="key-main">
            <div><strong>Crochet #${escapeHtml(hookNo)}</strong> | ${escapeHtml(keyLabel)}</div>
            <div class="muted">Local: ${escapeHtml(local)} • Emprunté le ${escapeHtml(loanedAt)} • Retourné le ${escapeHtml(returnedAt)}</div>
            ${l.note ? `<div class="muted">Note: ${escapeHtml(l.note)}</div>` : ""}
          </div>
          <div class="key-actions">${returnBtn}${keyBadge}</div>
        </div>
      `;
    }).join("");
    return;
  }

  renderLoansList("mine");
  renderLoansList("team");
  renderMissing();
}

function bind() {
  if (state.page === "my-loans") {
    $("statusFilter").addEventListener("change", render);
    $("cabinetFilter").addEventListener("change", render);
    $("q").addEventListener("input", render);
    $("loansList").addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-action='loan-return']");
      if (!btn) return;
      const loanId = Number(btn.dataset.loanId);
      if (!Number.isFinite(loanId)) return;
      try {
        btn.disabled = true;
        await fnLoanReturn(loanId);
        await loadData();
      } catch (err) {
        alert(err?.message ?? String(err));
      } finally {
        btn.disabled = false;
      }
    });
    return;
  }

  document.querySelectorAll(".tab[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => setActiveTab(btn.dataset.tab));
  });
  ["statusFilterMine", "cabinetFilterMine", "qMine", "statusFilterTeam", "cabinetFilterTeam", "qTeam", "cabinetFilterMissing", "qMissing"]
    .forEach((id) => {
      const el = $(id);
      if (!el) return;
      const ev = id.startsWith("q") ? "input" : "change";
      el.addEventListener(ev, render);
    });

  $("loansListMine").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action='loan-return']");
    if (!btn) return;
    const loanId = Number(btn.dataset.loanId);
    if (!Number.isFinite(loanId)) return;
    try {
      btn.disabled = true;
      await fnLoanReturn(loanId);
      await loadData();
    } catch (err) {
      alert(err?.message ?? String(err));
    } finally {
      btn.disabled = false;
    }
  });
}

bind();
if (state.page === "loans") setActiveTab("mine");
loadData();
