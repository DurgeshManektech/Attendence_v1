// theme.js — loaded in <head> so the saved theme is applied before the
// popup paints (no flash of the wrong theme). Uses localStorage because it's
// synchronous; chrome.storage would resolve too late.
//
// Saved choice wins; otherwise follow the system light/dark setting.

(function () {
  const KEY = "inout_theme";
  const root = document.documentElement;

  function systemTheme() {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }

  function apply(theme) {
    root.dataset.theme = theme;
  }

  apply(localStorage.getItem(KEY) || systemTheme());

  // Follow system changes live, unless the user picked a theme themselves.
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (!localStorage.getItem(KEY)) apply(systemTheme());
  });

  window.InOutTheme = {
    toggle() {
      const next = root.dataset.theme === "light" ? "dark" : "light";
      localStorage.setItem(KEY, next);
      apply(next);
      return next;
    },
    current: () => root.dataset.theme,
  };
})();
