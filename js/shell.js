// shell.js — the on-screen furniture, built in JS so the variant pages stay a few
// lines long each. Copies of a markup block are the most reliable way for several
// pages to drift apart, so the page IS the variant declaration and this writes the
// identical furniture into all of them.
//
// v12 (2026-09-22): rebuilt on the standard kit (/kit/ember-ui.css). Sentence case,
// no glowing dots, no "A · B · C" strings, one raised control (play).

const PAUSE = '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><rect x="5" y="4" width="3.4" height="12" rx="1"/><rect x="11.6" y="4" width="3.4" height="12" rx="1"/></svg>';
export const PLAY = '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M6.5 4.2v11.6c0 .6.7 1 1.2.6l8.4-5.8a.75.75 0 000-1.2L7.7 3.6c-.5-.4-1.2 0-1.2.6z"/></svg>';
export { PAUSE };

// Speed detents. The slider value is the exponent: speed = 2^value.
export const SPEEDS = [-2, -1, 0, 1, 2];
const tick = (e) => (e < 0 ? ['¼×', '½×'][e + 2] : `${2 ** e}×`);

export function mountShell(ui, variant) {
  ui.innerHTML = `
  <header id="head" class="e-pane">
    <div class="brand">
      <h1 class="e-title">Pulse</h1>
      <span class="e-caption">Toronto Bike Share</span>
    </div>
    <div id="clockrow">
      <canvas id="globe" width="96" height="96" aria-hidden="true"></canvas>
      <div>
        <div id="h-big" class="e-display">&nbsp;</div>
        <div id="h-small" class="e-caption"></div>
      </div>
    </div>
    <div id="stats" class="e-caption"></div>
    <a id="byline" class="e-caption" href="https://www.linkedin.com/in/blair-zasitko/" rel="author">Made by Blair Zasitko</a>
    <a id="back" class="e-btn" href="../../">Other versions</a>
  </header>

  <div id="dock" class="e-pane">
    <button id="play" class="e-btn e-btn--primary e-btn--icon" type="button" aria-label="Pause">${PAUSE}</button>
    <div class="e-field">
      <label class="e-label" for="speed">Speed</label>
      <output id="speedval" class="e-value" for="speed">1×</output>
      <input id="speed" class="e-range" type="range" min="${SPEEDS[0]}" max="${SPEEDS[SPEEDS.length - 1]}" step="1" value="0" aria-label="Playback speed">
      <div class="e-ticks">${SPEEDS.map((e) => `<span>${tick(e)}</span>`).join('')}</div>
    </div>
    <div id="legend">
      <span class="e-key e-key--drain"><i style="color:${variant.palette.out}"></i>Emptying</span>
      <span class="e-key e-key--fill"><i style="color:${variant.palette.in}"></i>Filling</span>
      <span class="e-caption">Size shows how fast</span>
    </div>
  </div>`;
}
