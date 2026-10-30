(function () {
  try {
    var key = 'reqcase.shadow-recorder.theme';
    var mode = localStorage.getItem(key) || 'dark';
    if (mode !== 'dark' && mode !== 'light' && mode !== 'system') mode = 'dark';
    var resolved = mode === 'system'
      ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      : mode;
    document.documentElement.setAttribute('data-theme', resolved);
    document.documentElement.setAttribute('data-theme-mode', mode);
    document.documentElement.style.colorScheme = resolved;
    var meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute('content', resolved);
  } catch (e) {}
})();

window.addEventListener('dragover', function (event) {
  event.preventDefault();
});
window.addEventListener('drop', function (event) {
  event.preventDefault();
});
