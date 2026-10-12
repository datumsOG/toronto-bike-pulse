// tuner.js — the glass bench, loaded only by /v/tuner/ (app.js, VARIANT.tuner).
//
// Blair, 2026-10-09: the static lab page "is just not the same as in the app - the
// colors, the motion, etc, I can't judge it properly." So the sliders live here, over
// the real map, the real spheres and the real panes. Each slider writes straight into
// glassLayer.params (kit/glass/host-maplibre.js), which render() reads every frame.
//
// The panel itself is deliberately NOT glass: it is a solid sheet, so it never changes
// while you tune and never counts as a pane. Values persist in this browser
// (localStorage) and "Copy values" puts them on the clipboard as JSON.

const KEY = 'pulse-glass-tune-v1';

// key, label, min, max, step, what it does
const ROWS = [
  ['spread',     'Spread',      2, 120, 1,    'how far the lens reaches in from the edge'],
  ['curve',      'Curve',       0.6, 4, 0.01, 'low = wide soft lens, high = sharp bevel'],
  ['amp',        'Amplitude',   0, 60, 1,     'how far the map is bent at the rim'],
  ['edgeBlur',   'Edge blur',   0, 8, 0.1,    'blur where the lens bends fastest'],
  ['centreBlur', 'Centre blur', 0, 12, 0.1,   'flat blur across the whole pane'],
  ['frost',      'Frost',       0, 100, 1,    'light fog across the pane (0 in kit 1.0.0)'],
  ['rim',        'Rim light',   0, 1, 0.01,   'how far the highlight reaches in from the edge'],
  ['spec',       'Specular',    0, 3, 0.01,   'highlight strength'],
  ['fresnel',    'Edge glow',   0, 1, 0.01,   'cool brightening along the edge'],
  ['shadow',     'Shadow',      0, 0.8, 0.01, 'the dark halo a pane casts on the map'],
  ['tint',       'Pane tint',   0, 0.8, 0.01, 'smoke behind the text (0 = clear glass)'],
];

const CSS = `
#tune { position: fixed; z-index: 30; left: 12px; right: 12px; top: 50%; transform: translateY(-50%);
  max-width: 420px; margin: 0 auto; max-height: 46vh; overflow-y: auto; -webkit-overflow-scrolling: touch;
  padding: 12px 14px 14px; border-radius: 18px; background: rgba(10, 10, 12, 0.9);
  box-shadow: 0 12px 34px rgba(0, 0, 0, 0.5); color: #fff; font-family: var(--e-font); }
#tune[hidden] { display: none; }
#tune .t-row { display: grid; grid-template-columns: 92px 1fr 46px; align-items: center; column-gap: 10px; min-height: 40px; }
#tune .t-row label { font: 600 14px/1.2 var(--e-font); }
#tune .t-row output { font: 700 14px/1 var(--e-font); font-variant-numeric: tabular-nums; text-align: right; }
#tune .t-row input { width: 100%; margin: 0; }
#tune .t-row.changed label::after { content: ''; display: inline-block; width: 6px; height: 6px; margin-left: 6px;
  border-radius: 50%; background: #fff; vertical-align: middle; }
#tune .t-act { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }
#tune .t-note { font: 400 12.5px/1.4 var(--e-font); margin: 8px 0 0; min-height: 1.4em; }
#tune-toggle { position: fixed; z-index: 31; right: 12px; top: calc(50% - 23vh - 54px); }
`;

export function mountTuner(layer) {
  const defaults = { ...layer.params, tint: 0.26 };   // 0.26 = the kit's --e-pane-tint
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { saved = {}; }
  const val = { ...defaults };
  for (const [k] of ROWS) if (typeof saved[k] === 'number' && isFinite(saved[k])) val[k] = saved[k];

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const panel = document.createElement('div');
  panel.id = 'tune';
  panel.innerHTML = ROWS.map(([k, label, min, max, step, hint]) => `
    <div class="t-row" data-k="${k}" title="${hint}">
      <label for="t-${k}">${label}</label>
      <input class="e-range" id="t-${k}" type="range" min="${min}" max="${max}" step="${step}" aria-label="${label}: ${hint}">
      <output for="t-${k}"></output>
    </div>`).join('') + `
    <div class="t-act">
      <button id="t-copy" class="e-btn" type="button">Copy values</button>
      <button id="t-reset" class="e-btn" type="button">Reset to shipped</button>
    </div>
    <p class="t-note" id="t-note" role="status"></p>`;
  document.body.appendChild(panel);

  const toggle = document.createElement('button');
  toggle.id = 'tune-toggle';
  toggle.type = 'button';
  toggle.className = 'e-btn e-btn--primary';
  document.body.appendChild(toggle);

  const note = panel.querySelector('#t-note');
  const fmt = (step, v) => (step >= 1 ? String(Math.round(v)) : v.toFixed(step >= 0.1 ? 1 : 2));

  function apply() {
    for (const [k] of ROWS) if (k !== 'tint') layer.params[k] = val[k];
    // The pane's smoke tint is CSS (kit: .e-pane[data-glass]), not part of the shader.
    document.querySelectorAll('.e-pane[data-glass]').forEach((el) => {
      el.style.background = `rgba(8, 8, 10, ${val.tint})`;
    });
    layer.repaint();
  }
  function paint() {
    for (const [k, , , , step] of ROWS) {
      const row = panel.querySelector(`[data-k="${k}"]`);
      const input = row.querySelector('input');
      input.value = val[k];
      row.querySelector('output').textContent = fmt(step, val[k]);
      row.classList.toggle('changed', Math.abs(val[k] - defaults[k]) > 1e-9);
      if (window.EmberUI) window.EmberUI.sync(input);
    }
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(val)); } catch (e) { /* private mode */ } }

  panel.addEventListener('input', (e) => {
    const row = e.target.closest('.t-row');
    if (!row) return;
    val[row.dataset.k] = +e.target.value;
    paint(); apply(); save();
    note.textContent = '';
  });
  panel.querySelector('#t-reset').addEventListener('click', () => {
    Object.assign(val, defaults);
    paint(); apply(); save();
    note.textContent = 'Back to the values every app ships with.';
  });
  panel.querySelector('#t-copy').addEventListener('click', async () => {
    const out = {};
    for (const [k, , , , step] of ROWS) out[k] = +fmt(step, val[k]);
    const txt = JSON.stringify(out);
    try { await navigator.clipboard.writeText(txt); note.textContent = 'Copied. Paste it into the chat.'; }
    catch (e) { note.textContent = txt; }   // no clipboard permission: show it so it can be selected
  });

  let open = true;
  try { open = localStorage.getItem(KEY + '-open') !== '0'; } catch (e) { /* default open */ }
  function setOpen(o) {
    open = o;
    panel.hidden = !o;
    toggle.textContent = o ? 'Hide sliders' : 'Tune glass';
    toggle.setAttribute('aria-expanded', String(o));
    try { localStorage.setItem(KEY + '-open', o ? '1' : '0'); } catch (e) { /* private mode */ }
  }
  toggle.addEventListener('click', () => setOpen(!open));

  if (window.EmberUI) window.EmberUI.init(panel);
  setOpen(open);
  paint();
  apply();
}
