// shell.js — the on-screen furniture, built in JS so the variant pages stay a few
// lines long each. Copies of a markup block are the most reliable way for several
// pages to drift apart, so the page IS the variant declaration and this writes the
// identical furniture into all of them.
//
// v12 (2026-09-22): rebuilt on the standard kit (/kit/ember-ui.css). Sentence case,
// no glowing dots, no "A · B · C" strings, one raised control (play).
//
// v14 (2026-10-09, Blair): the day spelled out, and no hour (the globe already tells
// the time). The trip/station counts and the byline are gone from the header. Every
// pane is data-glass: real refraction (js/glass.js).
// v15 (same day, Blair): one header card again, and no "Pulse" in it ("it's weird to
// have the name of the app in the app"). The day is the title now; the globe sits
// beside it as the clock.
// v17 (2026-10-10): kit release 1.0.0; both panes take the glass skin.
// v18 (same day, Blair): the "Other versions" button is gone ("we want clean and
// simple"). The menu is still at /pulse/menu/; nothing in the app links to it.

const PAUSE = '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><rect x="5" y="4" width="3.4" height="12" rx="1"/><rect x="11.6" y="4" width="3.4" height="12" rx="1"/></svg>';
export const PLAY = '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M6.5 4.2v11.6c0 .6.7 1 1.2.6l8.4-5.8a.75.75 0 000-1.2L7.7 3.6c-.5-.4-1.2 0-1.2.6z"/></svg>';
export { PAUSE };

// Speed detents. The slider value is the exponent: speed = 2^value.
// 4× removed 2026-10-09 (Blair: "it doesn't work"). 2× removed 2026-10-10 (Blair: "2x still
// glitches, either fix or get rid of it"). The cause is the data, not a bug to patch: the
// week is 168 hourly frames and each sphere follows a per-screen-frame average (TUNE.smoothFast
// in app.js), so at 2× an hour lasts about one and a half screen frames and the spheres trail
// the clock by most of a day. Faster than 1× needs finer data, not a faster clock.
// The app opens at ¼× (Blair, same day).
export const SPEEDS = [-2, -1, 0];
export const DEFAULT_SPEED = -2;
const tick = (e) => (e < 0 ? ['¼×', '½×'][e + 2] : `${2 ** e}×`);

// Opened from a home-screen icon there is no browser bar, so no way back to the page that
// linked here (Blair, 2026-10-10). Only then does the app show its own back button.
// "Reached from the site" = the referrer is another page on this origin; someone who put
// Pulse itself on their home screen has nowhere to go back to.
let FROM_SITE = false;
try { const r = new URL(document.referrer); FROM_SITE = r.origin === location.origin && !r.pathname.startsWith(new URL('..', import.meta.url).pathname); } catch (e) {}
const STANDALONE = (((window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true) && FROM_SITE) || /[?&]standalone=1\b/.test(location.search);
// It goes back to the page that linked here, at the place it was left (Blair, 2026-10-13:
// it used to open the home page from the top). The count of history entries when the app
// loaded says how far back that is, whatever the app has added since.
const HISTORY_AT_LOAD = history.length;
function siteBackHref() { try { const r = new URL(document.referrer); if (r.origin === location.origin) return r.href; } catch (e) {} return '/'; }
function siteBack(e) { if (HISTORY_AT_LOAD > 1) { e.preventDefault(); history.go(HISTORY_AT_LOAD - history.length - 1); } }
const BACK = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.5 4.5L7 10l5.5 5.5"/></svg>';

export function mountShell(ui, variant) {
  ui.innerHTML = `
  <header id="head" class="e-pane" data-glass data-skin="glass">
    <canvas id="globe" width="128" height="128" aria-hidden="true"></canvas>
    <div id="h-big" class="e-title">&nbsp;</div>
    <div id="where" class="e-caption">Toronto Bike Share<br><span id="h-small"></span></div>
  </header>
  ${STANDALONE ? `<a id="back" class="e-btn e-btn--icon" href="${siteBackHref()}" aria-label="Back">${BACK}</a>` : ''}

  <div id="dock" class="e-pane" data-glass data-skin="glass">
    <button id="play" class="e-btn e-btn--primary e-btn--icon" type="button" aria-label="Pause">${PAUSE}</button>
    <div class="e-field">
      <label class="e-label" for="speed">Speed</label>
      <output id="speedval" class="e-value" for="speed">${tick(DEFAULT_SPEED)}</output>
      <input id="speed" class="e-range" type="range" min="${SPEEDS[0]}" max="${SPEEDS[SPEEDS.length - 1]}" step="1" value="${DEFAULT_SPEED}" aria-label="Playback speed">
      <div class="e-ticks">${SPEEDS.map((e) => `<span>${tick(e)}</span>`).join('')}</div>
    </div>
    <div id="legend">
      <span class="e-key e-key--drain"><i style="color:${variant.palette.out}"></i>Emptying</span>
      <span class="e-key e-key--fill"><i style="color:${variant.palette.in}"></i>Filling</span>
    </div>
  </div>`;
  const back = ui.querySelector('#back');
  if (back) back.addEventListener('click', siteBack);
}
