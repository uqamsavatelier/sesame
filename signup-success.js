const $ = (id) => document.getElementById(id);

(() => {
  const t = localStorage.getItem("sav_theme") === "light" ? "light" : "dark";
  document.body.dataset.theme = t;
})();

let remaining = 5;
const countdownEl = $("countdownValue");

const timer = setInterval(() => {
  remaining -= 1;
  if (countdownEl) countdownEl.textContent = String(Math.max(remaining, 0));
  if (remaining > 0) return;
  clearInterval(timer);
  window.location.href = "./login.html";
}, 1000);
