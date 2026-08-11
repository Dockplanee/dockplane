/*
 * Applies a stored theme preference before first paint.
 * Without a stored preference the stylesheet falls back to the operating
 * system setting, so this file only has to handle the explicit choice.
 */
(function () {
  try {
    var stored = window.localStorage.getItem('dockplane-theme');
    if (stored === 'light' || stored === 'dark') {
      document.documentElement.setAttribute('data-theme', stored);
    }
  } catch (error) {
    /* Storage access can be blocked; the media query default remains valid. */
  }
})();
