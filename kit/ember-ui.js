// ember-ui.js — the small amount of behaviour the standard controls need.
// Include once per page, after the markup:  <script src="…/ember-ui.js" defer></script>
//
// 1. Sliders: keeps --pct in step with the value so the filled part of the groove
//    paints (WebKit has no ::range-progress), and marks the current tick label.
//    Call EmberUI.sync(input) after changing a slider's value from code.
// 2. Segmented controls: one aria-pressed button per .e-seg, and a 'change' event.
(function () {
  function sync(el) {
    var min = +el.min || 0, max = +el.max || 100, v = +el.value;
    el.style.setProperty('--pct', ((v - min) / ((max - min) || 1)) * 100 + '%');
    var field = el.closest('.e-field');
    var ticks = field && field.querySelectorAll('.e-ticks span');
    if (ticks && ticks.length === Math.round((max - min) / (+el.step || 1)) + 1) {
      ticks.forEach(function (t, i) { t.setAttribute('aria-current', String(min + i * (+el.step || 1) === v)); });
    }
  }
  function init(root) {
    (root || document).querySelectorAll('input.e-range').forEach(function (el) {
      if (el.__ember) return; el.__ember = true;
      el.addEventListener('input', function () { sync(el); });
      sync(el);
    });
    (root || document).querySelectorAll('.e-seg').forEach(function (seg) {
      if (seg.__ember) return; seg.__ember = true;
      seg.addEventListener('click', function (e) {
        var b = e.target.closest('button'); if (!b || !seg.contains(b)) return;
        seg.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        seg.dispatchEvent(new CustomEvent('change', { detail: { value: b.value || b.textContent.trim() } }));
      });
    });
  }
  window.EmberUI = { init: init, sync: sync };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { init(); });
  else init();
})();
