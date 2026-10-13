// app.js — Pulse. A typical week of Toronto Bike Share, as light.
//
// There is no server and no API. 2025 is closed history: it is precomputed into
// fixed binaries by build/aggregate.py, and playback is an index into them rather
// than a query. That is the whole reason a week plays on a phone without
// stuttering.
//
// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-15 — WEEK ONLY, AND FOUR VERSIONS OF IT.
//
// Blair: "make pulse have just the week option, no day/year/place, we will deal
// with those when we have the visual finalized. So the only user inputs are
// play/pause, speed slider, and map movement. (dev server) will just be
// a page with buttons for links to different versions."
//
// So this file is now an ENGINE with a variant table, mounted by four three-line
// pages under /v/. DAY, YEAR and PLACE are gone from the app — not deleted from
// history; `git show v10-all-regimes` has them, and their binaries are still in
// data/ untouched, so bringing one back is a table entry and a page.
//
// What went with them: the time scrubber (he asked for exactly three inputs), the
// regime buttons, the corridor ribbons (off since v5), and the level-of-detail
// machinery (off since v9 — "all the balls all the time", and the map's minZoom
// makes the thresholds unreachable anyway).
// ─────────────────────────────────────────────────────────────────────────────

import { PulseLayer, hex, oklch } from './gl.js?v=31';
import { mountShell, PLAY, PAUSE, SPEEDS } from './shell.js?v=39';
import { restyleMap, STYLE_URL } from './mapstyle.js?v=32';
import { createGlassLayer } from '../kit/glass/host-maplibre.js?v=1.0.2';

const APP_VERSION = 'v22';

// Which year's typical week. 2025 by default again (Blair, 2026-09-22 evening: "switch
// it back to 2025 average week, I didn't realize the 2026 data wasn't current"). 2026 so
// far covers only 1 January to 31 March, a winter week; ?year=2026 still loads it.
const YEAR = new URLSearchParams(location.search).get('year') || window.PULSE_YEAR || '2025';
// Resolved from this module's own address, so the site works at a domain root
// (the VM) and under a subpath (GitHub Pages) without a build step.
const ROOT = new URL('../', import.meta.url);
const DATA = new URL(YEAR === '2025' ? 'data/' : `data/${YEAR}/`, ROOT).href;

// WEEK: 168 hourly frames, one typical week, stored at L2 (one node per station).
// dur: ms for one week at 1×. 10000 -> 8000 on 2026-10-09 (Blair: "increase the speed of 1x by 25%").
const WEEK = { frames: 168, dur: 8000, level: 2 };

// Embedded as a live backdrop on another page (blairz.ca's home page sets
// window.PULSE_EMBED before loading this module). The host page supplies #map and hidden
// #ui, #status and #ver; the engine runs unchanged, but the map takes no input, shows no
// attribution control (the host page credits the map in its own text), and the frame
// loop stops while the host says the map is off screen (window.__pulse.setPlaying).
const EMBED = window.PULSE_EMBED || null;
const DOW = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

// ─────────────────────────────────────────────────────────── variants
//
// Each one answers the same question — "what is this station doing right now?" —
// with a different sentence. They share every line of maths up to the last step;
// only the mapping from the smoothed net flow to (size, colour) differs.
const VARIANTS = {
  // Blair, 2026-09-22: "The red/green version works best so let's ditch the rest.
  // Let's do 4 versions." All four share the v10/v11 encoding exactly — size is
  // |net flow|, colour is its sign — and differ only in scale or in the map under it.
  // Green-only, blue/green and the 3D city are at tag v11-four-variants.

  // 1. The existing one, which he called "an exceptional piece of work as it is".
  current: {
    name: 'Red and green',
    size: 'magnitude', colour: 'sign', map: 'dark',
    palette: { out: '#ff2800', in: '#28b80f', mid: '#7b7b82' },
  },
  // 2. "The size gradients will increase by 50% to exaggerate the effect of growing
  //    and shrinking." The size RANGE is 1.5x (22.5 px -> 33.75 px), spread both ways
  //    from the middle so shrinking is exaggerated as well as growing. The floor stops
  //    at 4 px rather than going to 2: every station stays visible.
  bold: {
    name: 'Bigger swings',
    size: 'magnitude', colour: 'sign', map: 'dark',
    palette: { out: '#ff2800', in: '#28b80f', mid: '#7b7b82' },
    tune: { minSize: 4, radius: 37.75 },
  },
  // 3. "The map elements (everything but the black) lightened up a bit so it's not so
  //    dark (make the water lighter too)." The background stays black.
  light: {
    name: 'Lighter map',
    size: 'magnitude', colour: 'sign', map: 'lifted',
    palette: { out: '#ff2800', in: '#28b80f', mid: '#7b7b82' },
  },
  // 4. "A color scheme for the map similar to the default on Google Maps." The
  //    additive halo is off: on a pale map it only washes toward white.
  google: {
    name: 'Daylight map',
    size: 'magnitude', colour: 'sign', map: 'google',
    palette: { out: '#ea2a12', in: '#1f9e0a', mid: '#7b7b82' },
    tune: { glow: 0 },
  },
  // 5. Not a version of the data: the bench for the glass. Blair, 2026-10-09, after the
  //    static ~/ui-lab page: "it's just not the same as in the app - the colors, the
  //    motion... Could we possibly make a version of pulse like the top version but with
  //    the glass tuning?" Identical to `current`, plus js/tuner.js: sliders that drive
  //    glassLayer.params live. Unlisted on the hub; reached at /v/tuner/.
  tuner: {
    name: 'Glass tuner',
    size: 'magnitude', colour: 'sign', map: 'dark',
    palette: { out: '#ff2800', in: '#28b80f', mid: '#7b7b82' },
    tuner: true,
  },
};

const VARIANT = VARIANTS[window.PULSE_VARIANT] || VARIANTS.current;

// ── TUNE ──────────────────────────────────────────────────────────────────────
// Blair, 2026-09-09: "it's just a matter of getting the right scale, getting the
// right shades… let me take a look at it and then we'll tweak the fucking
// variables." So they are all here, and EVERY ONE can be overridden from the URL
// without editing a file — which matters because he is usually on a phone:
//
//   (dev server)
//
const TUNE = {
  radius:    30,    // sphere radius in screen px at the top of the scale
  minSize:   7.5,   // px. The BOTTOM of the scale, not a clamp — see nodeGeometry.
  lift:     150,    // metres every sphere floats above the ground plane — constant.
  anchor:      1,   // 1 = spheres REST ON their station, so all growth goes upward
                    // and the field reads as bouncing. 0 = centred sprites.
  gloss:    0.55,   // specular highlight strength
  rim:      0.45,   // rim light around the silhouette
  fill:     0.44,   // ambient on the sphere's dark side (0 = black, 1 = flat)
  quiet:    1.00,   // brightness a perfectly balanced sphere keeps
  glow:     0.30,   // brightness of the additive halo behind each sphere
  glowSize: 2.3,    // halo radius as a multiple of the sphere
  commit:   0.62,   // gamma on the colour ramp (sign mode only)

  // Temporal smoothing. One EMA per node; the sphere follows it rather than the
  // raw hourly number, because the raw number flickers and Blair's read of that
  // was "blinking and flashing rather than changing colours smoothly."
  smoothFast: 0.07,

  netPct:      0.99,  // percentile of |net flow| used as the scale, NOT the maximum.
                      // See netScale() — the maximum was the bug behind "most of
                      // the balls are just gone".
  netSizeGamma: 0.45, // |net|^this -> 0..1. Below 1 = compressive, which a heavy
                      // tail needs.
  signedBias:   1.0,  // signed sizing only (the green variant): a gamma on the
                      // 0..1 size fraction AFTER the sign is folded in. 1 = the
                      // resting size sits exactly mid-range; above 1 pushes it
                      // down, so balanced stations are small and only filling
                      // ones are large.

  // ── Hysteresis on the colour sign, and the 2026-09-15 fix to it ────────────
  // A Schmitt trigger: green only above +threshold, red only below -threshold,
  // and between the two a station KEEPS the colour it had. So at idle the rule is
  // "keep the colour of the last direction you actually moved."
  //
  // v10 used ONE ABSOLUTE THRESHOLD for all 1,054 stations, and Blair found what
  // that costs: "on week mode there are a lot of stations, especially on Yonge
  // from Davenport north, that always stay red."
  //
  // Measured on the real week binary, three full loops per station:
  //
  //   rule                     flips/node/loop   stations red >90% of the loop
  //                                              (of which balanced over the week)
  //   absolute 0.02 (v10)           8.1               94   (36 balanced)
  //   per-station, k=0.25          10.5               53   ( 4 balanced)
  //   per-station, k=0.50           8.7               70   ( 4 balanced)
  //   per-station, k=0.75           6.4               93   (11 balanced)
  //
  // k=0.5 is the choice: the same flicker as today, and the number of stations
  // stuck on one colour despite being balanced over the week drops 36 -> 4.
  //
  // WHY IT HAPPENED, because it generalises: one absolute threshold on a quantity
  // whose scale varies a thousandfold across the field is a different rule for
  // every member of the field. A quiet station's arrivals dribble in below the
  // threshold while its departures arrive in one commuter spike that crosses it —
  // so it latches red and never latches back. The threshold has to be in units of
  // that station's own traffic.
  //
  // NOTE: most of the Yonge stations he named are NOT this bug. 75 Holly St sends
  // out 60,325 bikes a week and takes in 22,788; Yonge/Orchard View is -43%;
  // Balliol -55%. Midtown sits on top of the Davenport escarpment and people ride
  // DOWN it, so those stations genuinely empty and are refilled by truck, and the
  // trucks are not in the trip data. Red is the honest answer there.
  flipRel:   0.50,  // threshold as a fraction of the station's own mean |net flow|
  flipFloor: 0.004, // …but never below this fraction of the regime scale
  flipThresh: 0.02, // the old absolute threshold. Used when flipRel = 0.
  hueEase:   0.10,  // bluegreen only: how fast the hue sweeps to its new target,
                    // per rendered frame. Lower = a longer, more visible sweep.

  zoomGain:  0.55,  // how much spheres grow as you zoom IN. 0 = fixed screen size.
  zoomRef:   11.9,  // the zoom at which `radius` means what it says.
  absolute:  1,     // size against the regime peak rather than each frame's own
};
Object.assign(TUNE, VARIANT.tune || {});
for (const [k, v] of new URLSearchParams(location.search)) {
  if (k in TUNE && isFinite(parseFloat(v))) TUNE[k] = parseFloat(v);
}

const state = {
  t: 8.0,          // continuous frame position
  playing: true,
  speed: 1,
  manifest: null,
  flow: null,      // Uint16Array: [frame][out per node][in per node]
  merc: null,      // Float64Array of mercator xyz per node
  scale: 1,        // metres -> mercator units
  n: 0,
};

const layer = new PulseLayer();
let map = null;
let nodeBuf = null;
let nodeOrder = null;   // node indices, re-sorted far-to-near every frame
let nodeDepth = null;

// ─────────────────────────────────────────────────────────── data

async function loadFlow() {
  const info = state.manifest.regimes.week.flow[String(WEEK.level)];
  const r = await fetch(DATA + info.file);
  if (!r.ok) throw new Error(`${info.file}: ${r.status}`);
  state.flow = new Uint16Array(await r.arrayBuffer());
}

function buildMercator() {
  const nodes = state.manifest.levels[String(WEEK.level)].nodes;
  state.n = nodes.length;
  const arr = new Float64Array(nodes.length * 3);
  for (let i = 0; i < nodes.length; i++) {
    const m = maplibregl.MercatorCoordinate.fromLngLat([nodes[i].lon, nodes[i].lat], 0);
    arr[i * 3] = m.x; arr[i * 3 + 1] = m.y; arr[i * 3 + 2] = 0;
  }
  state.merc = arr;
  state.scale = maplibregl.MercatorCoordinate
    .fromLngLat([-79.38, 43.66], 0).meterInMercatorCoordinateUnits();
}

// ─────────────────────────────────────────────────────────── scales
//
// Both of these are properties of a fixed binary, so they are scanned once and
// cached rather than recomputed per frame.

let _peak = 0;
function regimePeak() {
  if (_peak) return _peak;
  const n = state.n, buf = state.flow;
  let peak = 1;
  for (let f = 0; f < WEEK.frames; f++) {
    const b = f * n * 2;
    for (let i = 0; i < n; i++) {
      const v = buf[b + i] + buf[b + n + i];
      if (v > peak) peak = v;
    }
  }
  return (_peak = peak);
}

// The scale |arrivals - departures| is measured against.
//
// 2026-09-15: THIS USED TO BE THE ABSOLUTE MAXIMUM, AND THAT WAS THE BUG BEHIND
// TWO OF BLAIR'S THREE COMPLAINTS. Net flow across 1,054 stations is savagely
// heavy-tailed — the busiest station-hour is more than a THOUSAND times the
// median one — so dividing by the maximum put the typical station at 0.0006 of
// the scale, the size curve squared it, and week drew 11 of 1,054 spheres.
// The 99th percentile is a property of the bulk of the data instead of its worst
// outlier. Clamping the top 1% costs one station its extra size and buys the
// other 1,053 their visibility.
let _netScale = 0;
function netScale() {
  if (_netScale) return _netScale;
  const n = state.n, buf = state.flow;
  const vals = new Float32Array(WEEK.frames * n);
  let w = 0;
  for (let f = 0; f < WEEK.frames; f++) {
    const b = f * n * 2;
    for (let i = 0; i < n; i++) vals[w++] = Math.abs(buf[b + n + i] - buf[b + i]);
  }
  vals.sort();
  return (_netScale = Math.max(1, vals[Math.floor(vals.length * TUNE.netPct)]));
}

// Per-station colour threshold — the Yonge fix. In units of the regime scale, so
// it drops straight into the same comparison the absolute threshold used.
let _flipThr = null;
function flipThresholds() {
  if (_flipThr) return _flipThr;
  const n = state.n, buf = state.flow, scale = netScale();
  const thr = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (TUNE.flipRel <= 0) { thr[i] = TUNE.flipThresh; continue; }
    let sum = 0;
    for (let f = 0; f < WEEK.frames; f++) {
      const b = f * n * 2;
      sum += Math.abs(buf[b + n + i] - buf[b + i]);
    }
    thr[i] = Math.max(TUNE.flipFloor, TUNE.flipRel * (sum / WEEK.frames) / scale);
  }
  return (_flipThr = thr);
}

// ── per-node smoothing state, held ACROSS frames ─────────────────────────────
// Indexed by node index i, never by draw order k — the depth sort reorders k
// every time the camera moves, and smoothing a value into the wrong node
// produces a field that shimmers when you pan and nowhere else.
let smFast = null;   // Float32Array: the smoothed net flow
let smSign = null;   // Int8Array: the latched colour sign (the Schmitt trigger's memory)
let smHue  = null;   // Float32Array: eased hue position, bluegreen only
let smT = null;      // last playback position, to detect a jump

function resetSmoothing(n) {
  smFast = new Float32Array(n);
  smSign = new Int8Array(n);
  smHue = new Float32Array(n);
  smT = null;
}

let nodeOrderBearing = null, nodeOrderN = 0;
// Embed only: stations a host page asked not to draw (window.__pulse.hideWhere), 1 per station.
let hiddenNode = null;
function nodeGeometry(f0, f1, frac) {
  const n = state.n, buf = state.flow, merc = state.merc;
  if (!nodeBuf || nodeBuf.length !== n * 5) nodeBuf = new Float32Array(n * 5);
  if (!nodeOrder || nodeOrder.length !== n) nodeOrder = new Int32Array(n);
  if (!nodeDepth || nodeDepth.length !== n) nodeDepth = new Float32Array(n);
  if (!smFast || smFast.length !== n) resetSmoothing(n);

  const b0 = f0 * n * 2, b1 = f1 * n * 2;
  const npeak = netScale();
  const thr = flipThresholds();

  // The camera is pitched, so the spheres overlap and the BODY pass is
  // alpha-blended — which means draw order is visible. Sort far-to-near. "Far" is
  // along the screen-up direction in mercator space; mercator y grows SOUTHWARD,
  // so bearing 0 (north at the top) makes up = (0, -1).
  const B = (map.getBearing() * Math.PI) / 180;
  const ux = Math.sin(B), uy = -Math.cos(B);
  // The order depends only on the bearing and the station list, so it is worked out again
  // only when one of them changes, not ~900 comparisons-with-a-callback every frame.
  if (B !== nodeOrderBearing || nodeOrderN !== n) {
    for (let i = 0; i < n; i++) {
      nodeOrder[i] = i;
      nodeDepth[i] = merc[i * 3] * ux + merc[i * 3 + 1] * uy;
    }
    nodeOrder.sort((a, b) => nodeDepth[b] - nodeDepth[a]);
    nodeOrderBearing = B; nodeOrderN = n;
  }
  const ord = nodeOrder;

  // A scrub or a reload is a TELEPORT, not motion. Easing across it would smear
  // hours of the city into one long wipe. Detect the jump and snap instead.
  const tNow = f0 + frac;
  const jumped = smT === null || Math.abs(tNow - smT) > 1.5;
  smT = tNow;

  const aF = TUNE.smoothFast;
  const zscale = Math.pow(2, (map.getZoom() - TUNE.zoomRef) * TUNE.zoomGain);
  const signedSize = VARIANT.size === 'signed';
  const hueMode = VARIANT.colour === 'hue';

  for (let k = 0; k < n; k++) {
    const i = ord[k];
    const out = buf[b0 + i] * (1 - frac) + buf[b1 + i] * frac;
    const inn = buf[b0 + n + i] * (1 - frac) + buf[b1 + n + i] * frac;

    // ── THE QUANTITY ───────────────────────────────────────────────────────
    // Blair, 2026-09-14: "the diameter of the balls is the rate at which the
    // number of bicycles is changing… so at any given moment there should be
    // nearly an equal amount of red and green on the map."
    //
    // That last sentence is the test, and it is why this works: every bike that
    // leaves one station arrives at another, so the net flows across the city
    // sum to roughly zero.
    const nRaw = Math.max(-1, Math.min(1, (inn - out) / npeak));
    if (jumped) smFast[i] = nRaw;
    else smFast[i] += (nRaw - smFast[i]) * aF;
    const sNet = smFast[i];

    // ── SIZE ───────────────────────────────────────────────────────────────
    const mag = Math.pow(Math.abs(sNet), TUNE.netSizeGamma);
    // magnitude: 0 = balanced (small), 1 = moving hard either way (big).
    // signed:  0.5 = balanced, 1 = filling hard (big), 0 = draining hard (small).
    const shape = signedSize
      ? Math.pow(0.5 + 0.5 * Math.sign(sNet) * mag, TUNE.signedBias)
      : mag;

    // ── COLOUR ─────────────────────────────────────────────────────────────
    let sg = smSign[i];
    if (sg === 0) sg = sNet >= 0 ? 1 : -1;      // first frame for this node
    if (sNet > thr[i]) sg = 1;
    else if (sNet < -thr[i]) sg = -1;
    smSign[i] = sg;
    // Shader convention: +1 = u_out (draining), -1 = u_in (filling).
    const target = sg > 0 ? -1 : 1;
    let net;
    if (hueMode) {
      // Ease rather than snap, so a reversal is a visible sweep around the rim
      // of the wheel instead of an instant swap. This is the difference Blair
      // asked for: "they do a transition in colour from blue to green and back
      // as the in/out flow reverses."
      if (jumped) smHue[i] = target;
      else smHue[i] += (target - smHue[i]) * TUNE.hueEase;
      net = smHue[i];
    } else {
      net = target;
    }

    const o = k * 5;
    nodeBuf[o] = merc[i * 3];
    nodeBuf[o + 1] = merc[i * 3 + 1];
    nodeBuf[o + 2] = TUNE.lift * state.scale;
    nodeBuf[o + 3] = hiddenNode && hiddenNode[i] ? 0 : (TUNE.minSize + (TUNE.radius - TUNE.minSize) * shape) * zscale;
    nodeBuf[o + 4] = net;
  }

  layer.anchor = TUNE.anchor;
  layer.gloss = TUNE.gloss;
  layer.rim = TUNE.rim;
  layer.fill = TUNE.fill;
  layer.glowAlpha = TUNE.glow;
  layer.glowSize = TUNE.glowSize;
  layer.quiet = TUNE.quiet;
  layer.commit = TUNE.commit;
  layer.setNodes(nodeBuf);
}

// ─────────────────────────────────────────────────────────── time & labels

// The day only, spelled out (Blair, 2026-10-09: "Wednesday not Wed", and no hour,
// because the globe already tells the time).
function label(t) {
  const d = Math.floor(Math.floor(t) / 24) % 7;
  return { big: DOW[d], small: `${YEAR} typical week` };
}

// ─────────────────────────────────────────────────────────── globe clock
// Blair, 2026-09-14: "a little spinning earth that has toronto facing the user at
// noon." It is a clock you read without reading.
//
// GEOSYNCHRONOUS since 2026-09-15. It used to spin, which is astronomically
// honest and the wrong picture: the thing being read is TORONTO'S time of day,
// and Toronto kept leaving the frame — at 3am the disc showed the Pacific. Now
// the camera is parked over Toronto and the LIGHT moves. Noon is a fully lit
// face; 6pm is lit from the left because the sun is in the west; 3am is dark with
// a rim of dawn on the right.
//
// The sun's declination is held at zero — the equinox. A week carries an hour but
// no date, so there is no season to render and inventing one would be a
// decoration that lies.

const TOR = { lat: 43.6532, lon: -79.3832 };

// A coarse outline, deliberately crude: at 48 px nothing finer survives.
const LAND = [
  [[70,-168],[71,-156],[69,-141],[70,-128],[68,-110],[69,-95],[74,-95],[73,-80],
   [66,-63],[60,-64],[55,-60],[52,-56],[47,-52],[45,-61],[41,-70],[35,-76],
   [30,-81],[25,-80],[29,-89],[26,-97],[21,-97],[16,-95],[15,-87],[9,-79],
   [13,-87],[20,-105],[28,-114],[34,-120],[40,-124],[48,-125],[55,-131],
   [59,-140],[60,-152],[58,-158],[65,-166],[70,-168]],
  [[11,-72],[10,-61],[1,-50],[-5,-35],[-13,-38],[-23,-41],[-33,-53],[-41,-62],
   [-52,-69],[-45,-74],[-33,-71],[-18,-70],[-5,-81],[2,-79],[11,-72]],
  [[36,-6],[43,-9],[48,-5],[51,2],[58,5],[63,10],[70,20],[69,33],[60,30],
   [45,37],[41,29],[36,36],[31,32],[30,20],[33,11],[37,10],[36,-6]],
];

function drawGlobe(canvas, hour) {
  const g = canvas.getContext('2d');
  if (!g) return;
  const W = canvas.width, R = W * 0.45, C = W / 2;

  // Called every frame, but the globe is a clock: it only has something new to
  // say when the hour moves. The terminator below is a per-pixel pass, so
  // redrawing it at 60fps for a picture that changes twice a second is the kind
  // of cost that is invisible until it is on a phone.
  if (drawGlobe._lastW === W && Math.abs(hour - drawGlobe._lastHour) < 0.02) return;
  drawGlobe._lastW = W; drawGlobe._lastHour = hour;

  g.clearRect(0, 0, W, W);

  const grad = g.createRadialGradient(C - R * 0.35, C - R * 0.35, R * 0.1, C, C, R);
  grad.addColorStop(0, '#1d4a6b');
  grad.addColorStop(0.65, '#123449');
  grad.addColorStop(1, '#05131d');
  g.beginPath(); g.arc(C, C, R, 0, Math.PI * 2); g.fillStyle = grad; g.fill();

  const centreLon = TOR.lon;
  const D = Math.PI / 180;
  const proj = (lat, lon) => {
    const dl = (lon - centreLon) * D, la = lat * D;
    const cosc = Math.cos(la) * Math.cos(dl);
    return { x: C + R * Math.cos(la) * Math.sin(dl), y: C - R * Math.sin(la), vis: cosc > 0 };
  };

  g.save();
  g.beginPath(); g.arc(C, C, R, 0, Math.PI * 2); g.clip();

  g.strokeStyle = 'rgba(255,255,255,0.10)'; g.lineWidth = W * 0.008;
  for (let lon = -180; lon < 180; lon += 30) {
    g.beginPath(); let pen = false;
    for (let lat = -90; lat <= 90; lat += 6) {
      const q = proj(lat, lon);
      if (!q.vis) { pen = false; continue; }
      pen ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y); pen = true;
    }
    g.stroke();
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    g.beginPath(); let pen = false;
    for (let lon = -180; lon <= 180; lon += 6) {
      const q = proj(lat, lon);
      if (!q.vis) { pen = false; continue; }
      pen ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y); pen = true;
    }
    g.stroke();
  }

  g.fillStyle = 'rgba(120,142,96,0.90)';
  g.strokeStyle = 'rgba(160,182,128,0.85)';
  g.lineWidth = W * 0.012;
  for (const poly of LAND) {
    g.beginPath(); let pen = false, any = false;
    for (const [lat, lon] of poly) {
      const q = proj(lat, lon);
      if (!q.vis) { pen = false; continue; }
      pen ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y); pen = true; any = true;
    }
    if (any) { g.fill(); g.stroke(); }
  }

  const t = proj(TOR.lat, TOR.lon);
  if (t.vis) {
    g.beginPath(); g.arc(t.x, t.y, W * 0.05, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255,156,0,0.30)'; g.fill();
    g.beginPath(); g.arc(t.x, t.y, W * 0.022, 0, Math.PI * 2);
    g.fillStyle = '#ffc255'; g.fill();
  }

  // Night, per pixel. The terminator is a great circle, which projects to an
  // ellipse that is a nuisance to path out correctly at every phase and is wrong
  // in a way you notice. The disc is a few thousand pixels; an exact answer is
  // cheaper than a clever one.
  const dl = -(hour - 12) * 15 * D;
  const sx = Math.sin(dl), sy = 0, sz = Math.cos(dl);

  if (!drawGlobe._night || drawGlobe._night.width !== W) {
    drawGlobe._night = document.createElement('canvas');
    drawGlobe._night.width = drawGlobe._night.height = W;
  }
  const nc = drawGlobe._night;
  const ng = nc.getContext('2d');
  if (!drawGlobe._nightImg || drawGlobe._nightImg.width !== W) {
    drawGlobe._nightImg = ng.createImageData(W, W);
  }
  const img = drawGlobe._nightImg;
  const px = img.data;
  const SOFT = 0.16, DARK = 0.80;
  for (let y = 0; y < W; y++) {
    const ny = -((y + 0.5) - C) / R;
    for (let x = 0; x < W; x++) {
      const nx = ((x + 0.5) - C) / R;
      const r2 = nx * nx + ny * ny;
      const o = (y * W + x) * 4;
      if (r2 > 1) { px[o + 3] = 0; continue; }
      const nz = Math.sqrt(1 - r2);
      const cosSun = nx * sx + ny * sy + nz * sz;
      let night = -cosSun / SOFT;
      night = night <= 0 ? 0 : night >= 1 ? 1 : night;
      px[o] = 2; px[o + 1] = 6; px[o + 2] = 16;
      px[o + 3] = (night * DARK * 255) | 0;
    }
  }
  ng.putImageData(img, 0, 0);
  g.drawImage(nc, 0, 0);
  g.restore();

  g.beginPath(); g.arc(C, C, R, 0, Math.PI * 2);
  g.strokeStyle = 'rgba(255,255,255,0.20)'; g.lineWidth = W * 0.012; g.stroke();
}

// ─────────────────────────────────────────────────────────── main loop

let last = performance.now();

// ?reel=1 — the TikTok / Reels cut (Blair, 2026-09-22: "No UI, needs to explain itself
// within 2 seconds or so"). Implies capture mode. Every control is hidden; the top of
// the frame carries what this is, the time, and what the colours mean, from frame one.
// Nothing sits in the bottom fifth or the right edge, where the apps draw their own UI.
const REEL = new URLSearchParams(location.search).get('reel') === '1';
const CAPTURE = REEL || new URLSearchParams(location.search).get('capture') === '1';

// Weekday rush windows, and the one sentence each earns. Both were checked against
// rendered 2025 frames before being written here: Tue 9 am the core is green (filling)
// while the rest of the city is red; Mon 7 pm the core is red. Do not add a caption
// for anything that has not been looked at in a frame first.
const RUSH = [
  { from: 7, to: 10, text: 'Morning rush: downtown fills up' },
  { from: 16, to: 19, text: 'Evening rush: downtown empties' },
];
function rushAt(t) {
  const d = Math.floor(t / 24) % 7, h = t % 24;
  if (d > 4) return null;
  for (const r of RUSH) if (h >= r.from - 0.5 && h < r.to + 0.5) {
    const edge = Math.min(h - (r.from - 0.5), r.to + 0.5 - h);
    return { text: r.text, alpha: Math.max(0, Math.min(1, edge / 0.5)) };
  }
  return null;
}

function buildReel() {
  const pal = VARIANT.palette;
  const el = document.createElement('div');
  el.id = 'reel';
  el.innerHTML = `
    <div class="r-hook">Toronto bike share,<br>hour by hour</div>
    <div class="r-sub">Every trip of 2025, folded into one week</div>
    <div class="r-clock"><span id="r-day"></span> <span id="r-hour"></span></div>
    <div class="r-week">${DOW.map((d, i) => `<span data-d="${i}"><b></b>${d[0]}</span>`).join('')}</div>
    <div class="r-key"><i style="background:${pal.out}"></i>Red: more bikes leaving than arriving</div>
    <div class="r-key"><i style="background:${pal.in}"></i>Green: more arriving than leaving</div>
    <div id="r-note"></div>
    <div class="r-credit">City of Toronto Open Data. Map © OpenStreetMap contributors</div>`;
  document.body.appendChild(el);
}

function updateReel(t) {
  const f = Math.floor(t), d = Math.floor(f / 24) % 7, h = f % 24;
  document.getElementById('r-day').textContent = DOW[d];
  document.getElementById('r-hour').textContent = `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`;
  document.querySelectorAll('.r-week span').forEach((s) => {
    const i = +s.dataset.d;
    s.classList.toggle('on', i === d);
    s.querySelector('b').style.width = `${i < d ? 100 : i === d ? ((t % 24) / 24) * 100 : 0}%`;
  });
  const note = document.getElementById('r-note'), r = rushAt(t % 168);
  note.textContent = r ? r.text : note.textContent;
  note.style.opacity = r ? r.alpha : 0;
}


// Advance the week by `dh` hours, `n` times, with one smoothing update per advance,
// then paint once and resolve when the map has rendered. Capture mode only.
function captureStep(dh, n = 1) {
  for (let i = 0; i < n; i++) {
    state.t = (state.t + dh + WEEK.frames) % WEEK.frames;
    const f0 = Math.floor(state.t) % WEEK.frames;
    if (state.flow) nodeGeometry(f0, (f0 + 1) % WEEK.frames, state.t - Math.floor(state.t));
  }
  layer.nodeScale = Math.max(0.55, Math.min(2.4, (map.getZoom() - 8.5) * 0.30));
  const L = label(state.t);
  document.getElementById('h-big').textContent = L.big;
  document.getElementById('h-small').textContent = L.small;
  if (globeCanvas) drawGlobe(globeCanvas, state.t % 24);
  if (REEL) updateReel(state.t);
  return new Promise((res) => {
    map.once('render', () => requestAnimationFrame(() => res(L.big)));
    map.triggerRepaint();
  });
}

let looping = false;
function frameLoop(now) {
  // Embedded and paused means off screen: stop drawing altogether, not just the clock.
  if (EMBED && !state.playing) { looping = false; return; }
  looping = true;
  const dt = Math.min(100, now - last);
  last = now;

  if (state.playing) {
    state.t = (state.t + (dt * state.speed / WEEK.dur) * WEEK.frames) % WEEK.frames;
  }

  const f0 = Math.floor(state.t) % WEEK.frames;
  const f1 = (f0 + 1) % WEEK.frames;
  const frac = state.t - Math.floor(state.t);

  if (state.flow) nodeGeometry(f0, f1, frac);

  layer.nodeScale = Math.max(0.55, Math.min(2.4, (map.getZoom() - 8.5) * 0.30));

  const L = label(state.t);
  const hBig = document.getElementById('h-big');
  // Only on change: the text changes once a day of the week, not once a frame.
  if (hBig && hBig.textContent !== L.big) { hBig.textContent = L.big; document.getElementById('h-small').textContent = L.small; }
  if (globeCanvas) drawGlobe(globeCanvas, state.t % 24);

  map.triggerRepaint();
  requestAnimationFrame(frameLoop);
}

// ─────────────────────────────────────────────────────────── buildings
//
// Lifted from the sun app (`sun-stable/js/map.js:brightenBuildings`), including
// the two lessons that cost it a week:
//   1. OPAQUE on purpose. A constant-opaque extrusion renders in the OPAQUE pass
//      and WRITES THE DEPTH BUFFER, which is the only reason a custom 3D layer
//      above it can be occluded by it. Any `fill-extrusion-opacity` below 1 —
//      even a zoom interpolation — pushes it into the translucent pass, which
//      skips depth-write, and the spheres float in front of every tower.
//   2. Warm-neutral dark, never cool: a cool base reads blue-purple once
//      anything brightens the scene.
function addBuildings(map) {
  if (map.getLayer('building-3d')) return;
  try {
    map.addLayer({
      id: 'building-3d',
      type: 'fill-extrusion',
      source: 'openmaptiles',
      'source-layer': 'building',
      minzoom: 13,           // the basemap carries no buildings below this
      paint: {
        'fill-extrusion-color': '#1b1a18',
        'fill-extrusion-height': ['get', 'render_height'],
        'fill-extrusion-base': ['get', 'render_min_height'],
      },
    });
    console.log('PULSE step: buildings added');
  } catch (e) {
    console.log('PULSE: buildings unavailable — ' + e.message);
  }
}

// ─────────────────────────────────────────────────────────── boot

window.addEventListener('unhandledrejection', (e) => {
  console.log('PULSE-REJECT', e.reason && (e.reason.stack || e.reason.message || e.reason));
  const st = document.getElementById('status');
  if (st) st.textContent = 'failed: ' + (e.reason && (e.reason.message || e.reason));
});
window.addEventListener('error', (e) => console.log('PULSE-ERR', e.message));

// The glass is the UI kit's (app/kit/, pinned release 1.0.2; never edited here).
// `backdrop` is how bright the map under the panes is: it picks white or black ink on
// stained glass, so the daylight map says so.
const glassLayer = createGlassLayer({ backdrop: VARIANT.map === 'google' ? 0.8 : 0.05 });

mountShell(document.getElementById('ui'), VARIANT);
// ember-ui.js ran before this module wrote the furniture, so it has not seen these
// controls: init() wires the slider and marks the buttons inside a glass-skin pane.
if (window.EmberUI) window.EmberUI.init(document.getElementById('ui'));
if (VARIANT.tuner) import('./tuner.js?v=2').then((m) => m.mountTuner(glassLayer));
const globeCanvas = document.getElementById('globe');

async function boot() {
  const status = document.getElementById('status');
  try {
    console.log('PULSE step: boot ' + (window.PULSE_VARIANT || 'current'));
    status.textContent = `Loading ${YEAR}`;
    state.manifest = await (await fetch(DATA + 'manifest.json')).json();

    const cam = VARIANT.camera || {};
    // Where the camera settles. 11.9 -> 11.4 on 2026-10-10 (Blair: "make the default zoom
    // further out").
    const HOME = {
      center: cam.center || [-79.3915, 43.6555],
      zoom: cam.zoom || 11.4,
      pitch: cam.pitch || 52,
      bearing: cam.bearing === undefined ? -17 : cam.bearing,
    };
    // The opening move, as in the apartments map: the app opens a little wide, flat and
    // turned, behind the loading screen, then eases to HOME once everything is drawn. About
    // 20% closer, 15 degrees of turn, 10 of tilt: enough to say that all three move. Any
    // touch stops it. Not in an embed, a capture, or for anyone who asked for less motion.
    const INTRO = !EMBED && !CAPTURE && !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    const OPEN = INTRO ? { ...HOME, zoom: HOME.zoom - 0.26, pitch: HOME.pitch - 10, bearing: HOME.bearing - 15 } : HOME;
    map = new maplibregl.Map({
      container: 'map',
      style: STYLE_URL[VARIANT.map] || STYLE_URL.dark,
      ...OPEN,
      minZoom: 9.5,
      maxZoom: 17,
      // Reel: the text owns the top ~half of the frame and TikTok's caption the bottom
      // fifth, so the camera centres the city in the band between them. Pitch comes
      // down so the core is not foreshortened into a sliver in a narrow frame.
      ...(REEL ? { pitch: 38, zoom: 11.55, center: [-79.395, 43.662] } : {}),
      // Smooth edges, and no more than 2 device px per CSS px: on a 3x phone that is under
      // half the pixels per frame for the map, the spheres' glow and the glass's full-screen
      // pass, which pays for the multisampling. Same setting as the Sun app (since
      // 2026-09-15). ?aa=0 and ?dpr=3 to compare. A host's EMBED.map overrides both.
      antialias: !/[?&]aa=0\b/.test(location.search),
      pixelRatio: Math.min(devicePixelRatio || 1, +((/[?&]dpr=([\d.]+)/.exec(location.search) || [])[1]) || 2),
      attributionControl: EMBED ? false : { compact: true, customAttribution: 'Pulse by <a href="https://www.linkedin.com/in/blair-zasitko/" rel="author">Blair Zasitko</a>' },
      // EMBED.map: any MapLibre constructor option the host wants (antialias, pixelRatio).
      ...(EMBED ? { interactive: false, ...(EMBED.camera || {}), ...(EMBED.map || {}) } : {}),
    });

    if (REEL) map.setPadding({ top: 400, bottom: 150, left: 0, right: 0 });   // not a constructor option
    // Embed: the host may say WHERE on the screen the map's centre should sit
    // (EMBED.target() -> {x, y} in CSS px). MapLibre centres the map in whatever is left
    // after padding, so the padding is chosen to make that leftover box's middle the point.
    if (EMBED && typeof EMBED.target === 'function') {
      const place = () => {
        const p = EMBED.target(), c = map.getContainer();
        if (!p) return;
        const W = c.clientWidth, H = c.clientHeight;
        const x = Math.max(0, Math.min(W, p.x)), y = Math.max(0, Math.min(H, p.y));
        map.setPadding({ left: Math.max(0, 2 * x - W), right: Math.max(0, W - 2 * x),
                         top: Math.max(0, 2 * y - H), bottom: Math.max(0, H - 2 * y) });
      };
      place();
      map.on('resize', place);
    }

    // MapLibre's attribution control mounts EXPANDED and only collapses once the
    // user taps the (i) — a strip of web-page text along the bottom of what is
    // supposed to read as an app. The (i) stays, so OpenFreeMap / OpenStreetMap
    // terms are one tap away; this is what compact mode is for.
    const deWeb = () => document.querySelectorAll('.maplibregl-ctrl-attrib.maplibregl-compact-show')
      .forEach((el) => el.classList.remove('maplibregl-compact-show'));
    deWeb();
    setTimeout(deWeb, 400);
    setTimeout(deWeb, 1500);

    // Map-load watchdog. MapLibre's 'load' waits on style AND first tiles, so a
    // slow connection can leave it unfired forever and the app stuck on the
    // splash. The sun app shipped a fix for exactly this (v90); proceed once the
    // STYLE is ready and treat full 'load' as a bonus.
    await new Promise((res) => {
      let done = false;
      const go = (why) => { if (!done) { done = true; console.log('PULSE map ready: ' + why); res(); } };
      if (map.isStyleLoaded()) go('already');
      map.once('load', () => go('load'));
      map.once('styledata', () => setTimeout(() => go('styledata'), 250));
      setTimeout(() => go('watchdog'), 6000);
    });

    restyleMap(map, VARIANT.map);
    document.body.classList.add('map-' + VARIANT.map);   // panes darken over a pale map
    buildMercator();
    if (VARIANT.buildings) addBuildings(map);       // BEFORE our layer, so ours is on top
    layer.palette = {
      out: hex(VARIANT.palette.out),
      in: hex(VARIANT.palette.in),
      mid: hex(VARIANT.palette.mid),
    };
    layer.hue = VARIANT.colour === 'hue' ? 1 : 0;
    if (layer.hue) {
      // OKLCH endpoints, with the hues arranged so a straight interpolation takes
      // the SHORT way round the wheel (blue -> cyan -> green) rather than the long
      // way through magenta and red.
      const a = oklch(VARIANT.palette.out), b = oklch(VARIANT.palette.in);
      while (b[2] - a[2] > Math.PI) b[2] -= 2 * Math.PI;
      while (a[2] - b[2] > Math.PI) b[2] += 2 * Math.PI;
      layer.lchOut = a; layer.lchIn = b;
    }
    layer.depth = !!VARIANT.depth;
    map.addLayer(layer);
    // Embed: a host page that moves its own glass (the home page's pane) gets a call inside
    // the map's frame, just before the glass layer measures, so the pane and its lens are
    // placed in the same frame whatever order the browser runs events in. Draws nothing.
    if (EMBED && typeof EMBED.frame === 'function') {
      map.addLayer({ id: 'embed-frame', type: 'custom', renderingMode: '2d', render() { EMBED.frame(); } });
    }
    // Glass LAST: it copies the frame everything above just drew and refracts it
    // through every [data-glass] pane. The layer comes from the UI kit.
    try { map.addLayer(glassLayer); } catch (e) { console.log('PULSE: glass unavailable — ' + e.message); }

    await loadFlow();
    console.log('PULSE step: week in, ' + state.n + ' stations');

    // Load, then show (Blair, 2026-10-10: no half-loaded app on screen with things popping
    // into existence). The loading screen stays until the basemap tiles for the opening view
    // are in and one frame has been drawn with them. Never waits past 6 seconds.
    await new Promise((res) => {
      const t0 = performance.now();
      const check = () => {
        if (map.areTilesLoaded() || performance.now() - t0 > 6000) { map.once('render', () => requestAnimationFrame(res)); map.triggerRepaint(); }
        else setTimeout(check, 80);
      };
      check();
    });

    status.classList.add('gone');
    document.getElementById('ui').classList.add('ready');
    if (INTRO) setTimeout(() => map.easeTo({ ...HOME, duration: 2600, essential: true,
      easing: (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2) }), 700);

    // ?capture=1: no free-running loop. build/render_video.mjs drives time through
    // window.__pulse.step so every video frame gets exactly the smoothing updates live
    // playback would have given it, whatever speed the headless renderer manages.
    if (CAPTURE) {
      document.body.classList.add('capture');          // a video cannot follow a link
      if (REEL) { document.body.classList.add('reel'); buildReel(); updateReel(state.t); }
      window.__pulse = { step: captureStep, setT: (t) => { state.t = t; }, ready: true };
    }
    else {
      requestAnimationFrame(frameLoop);
      if (EMBED) {
        // The camera at offset 0, taken at the first setOffset() call so a host may frame
        // the view (centre, zoom) first. setOffset() pans from here, so the result depends
        // only on the offset, never on the order of calls.
        let base = null, step = null;   // step: the ground per screen px at the centre, taken with base
        window.__pulse = {
          ready: true,
          map,   // the MapLibre map, for a host that frames its own view
          layerId: layer.id,   // the spheres, for a host that adds its own layer under them
          setPlaying(on) {
            state.playing = !!on;
            if (on && !looping) { looping = true; last = performance.now(); requestAnimationFrame(frameLoop); }
          },
          // Move the map straight up the screen by y CSS px, as if it were part of the page,
          // while the canvas stays put. Call it from a scroll handler: that runs before this
          // frame's draw, so the map moves in the frame the page scrolled.
          // The camera is rotated (bearing -17) and tilted (pitch 52), so the move is worked
          // out on screen, not on the compass, and at a constant ground speed: the ground one
          // screen pixel covers at the centre, straight down the screen, times y. Content at
          // the centre then moves exactly 1:1 with the page for the whole swipe; above the
          // centre it moves slower and below it faster, which is the tilt, but nothing slows
          // down as the swipe goes on. (Two earlier versions were wrong, both seen by Blair on
          // 2026-10-10: moving due south drifted the map up and to the right; bringing "the
          // point y px below the centre" to the centre slowed the map the farther he swiped,
          // because rows lower on the screen are nearer and cover less ground.)
          offset: 0,
          setOffset(y) {
            if (y === this.offset) return;
            if (!base) {
              base = maplibregl.MercatorCoordinate.fromLngLat(map.getCenter());
              const c = map.project(map.getCenter());
              const up = maplibregl.MercatorCoordinate.fromLngLat(map.unproject([c.x, c.y - 1]));
              const down = maplibregl.MercatorCoordinate.fromLngLat(map.unproject([c.x, c.y + 1]));
              step = { x: (down.x - up.x) / 2, y: (down.y - up.y) / 2 };
            }
            this.offset = y;
            map.jumpTo({ center: new maplibregl.MercatorCoordinate(base.x + y * step.x, base.y + y * step.y).toLngLat() });
          },
          // Leave some stations out: test(lng, lat) -> true hides that station's sphere until
          // the next call. For a host that has words on the map and wants them readable
          // (the home page's tagline, 2026-10-12). Returns how many are hidden.
          hideWhere(test) {
            const nodes = state.manifest.levels[String(WEEK.level)].nodes;
            hiddenNode = new Uint8Array(nodes.length);
            let k = 0;
            for (let i = 0; i < nodes.length; i++) if (test(nodes[i].lon, nodes[i].lat)) { hiddenNode[i] = 1; k++; }
            map.triggerRepaint();
            return k;
          },
          // What the glass drew in its last frame: { ok, panes, buttons, dropped, error }.
          glass: () => glassLayer.readout(),
        };
      }
    }
  } catch (e) {
    status.textContent = 'failed: ' + e.message;
    console.error(e);
  }
}

// ─────────────────────────────────────────────────────────── ui
// Three inputs, by instruction: play/pause, speed, and the map itself.

document.getElementById('play').addEventListener('click', (e) => {
  state.playing = !state.playing;
  e.currentTarget.innerHTML = state.playing ? PAUSE : PLAY;
  e.currentTarget.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
});

// Logarithmic speed. The slider value IS the exponent, so 0 is 1x, -2 is 0.25x
// and +2 is 4x — and the middle of the travel is the middle of the perceived
// range, which a linear slider over the same span never is.
const speedEl = document.getElementById('speed');
const speedVal = document.getElementById('speedval');
function applySpeed() {
  const e = Math.max(SPEEDS[0], Math.min(SPEEDS[SPEEDS.length - 1], Math.round(Number(speedEl.value))));
  state.speed = Math.pow(2, e);
  speedVal.textContent = e < 0 ? ['¼×', '½×'][e + 2] : `${2 ** e}×`;
  if (window.EmberUI) window.EmberUI.sync(speedEl);
}
if (speedEl) { speedEl.addEventListener('input', applySpeed); applySpeed(); }

document.getElementById('ver').textContent = APP_VERSION + '·' + (window.PULSE_VARIANT || 'current');
boot();
