export const APP_VERSION = "2.9.9";

document.querySelectorAll(".app-version").forEach((el) => {
  el.textContent = `Version ${APP_VERSION}`;
});
