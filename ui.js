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
    return `<div class="kcell"><span class="${badge(k.state)}">${pillText}</span>${detail}</div>`;
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

  return `
    <div class="item clickable" data-hook-no="${hookNo}">
      <div class="item-header">
        <div>
          <div class="title">Crochet #${hookNo}</div>
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

