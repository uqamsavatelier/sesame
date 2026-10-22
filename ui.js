export function groupByHook(keys) {
  const map = new Map();
  for (const k of keys) {
    const hook = k.hook_no ?? 0;
    if (!map.has(hook)) map.set(hook, []);
    map.get(hook).push(k);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]);
}

export function renderHookCard({ hookNo, keyLines, keyrings, role }) {
  const badge = (state) => {
    if (state === "missing") return "kpill missing";
    if (state === "onloan") return "kpill onloan";
    return "kpill";
  };
  const renderKeyLine = (k) => {
    const pillText = k.html ? k.html : escapeHtml(k.text);
    const detail = k.details?.length ? `<div class="kdetail">${k.details.join(" • ")}</div>` : "";
    return `<div class="kcell ${k.className ?? ""}"><span class="${badge(k.state)}">${pillText}</span>${detail}${k.media ?? ""}</div>`;
  };

  const keyringHtml = keyrings.length
    ? `
      <div class="keyring-stack">
        ${keyrings
          .map(
            (kr) => `
              <div class="keyring-group">
                <div class="keyring-label">
                  Trousseau ${escapeHtml(kr.ring_code ?? "A")}
                  <span class="muted">(${kr.keys.length} clés)</span>
                </div>
                <div class="kgrid keyring-grid">
                  ${kr.tagDetails?.length ? `<div class="kdetail">${kr.tagDetails.join(" • ")}</div>` : ""}
                  ${kr.keys.map(renderKeyLine).join("")}
                </div>
              </div>
            `
          )
          .join("")}
      </div>
    `
    : "";

  const singlesHtml = keyLines.length
    ? `
      <div class="kgrid">
        ${keyLines.map(renderKeyLine).join("")}
      </div>
    `
    : "";

  if (hookNo === "equipment") {
    return `
      <div class="equipment-list-stack">
        <div class="equipment-list-heading">Appareils / équipements</div>
        ${keyLines.map((line) => `
          <div class="item clickable equipment-list-item" data-hook-no="equipment" data-device-id="${escapeHtml(line.key_id)}">
            <div class="kgrid equipment-list-grid">${renderKeyLine(line)}</div>
          </div>
        `).join("")}
      </div>
    `;
  }

  return `
    <div class="item clickable" data-hook-no="${hookNo}">
      <div class="item-header">
        <div>
          <div class="title">${hookNo === "equipment" ? "Appareils / équipements" : `Crochet #${hookNo}`}</div>
        </div>
      </div>

      ${keyringHtml}
      ${singlesHtml}
    </div>
  `;
}


function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

