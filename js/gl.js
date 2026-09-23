// gl.js — the custom WebGL layer. Everything you actually see is drawn here;
// MapLibre only supplies the dark basemap, the camera, and a projection matrix.
//
// v2 grammar (Blair's brief, 2026-07-25):
//   The flow network is a FLAT SHEET floating above the city. Ribbons run in
//   that sheet — equally x and y, unlike a normal Sankey — and the only z is a
//   short S-shaped off-ramp at each end that drops to a node sitting on the
//   ground. Sheet altitude scales with zoom so the lift reads the same at every
//   scale. Nodes are red and shrinking when bikes leave, green and glowing when
//   bikes arrive.
//
// Two programs:
//   ARCS  — drawn TWICE per frame: a wide soft halo pass, then a narrow bright
//           core. Additive blending stacks them into an actual glow rather than
//           a coloured noodle. This is how the sun app's horizon arc reads as
//           light, and it is the single cheapest legibility win here.
//   NODES — ground-level glows, size by volume AND by net balance, colour by
//           net balance.
//
// Deliberately NO depth testing. No 3D buildings means nothing to occlude
// against, so pure additive blending is safe and an entire bug class disappears.

const LAYER_ID = 'pulse-gl';

const ARC_VERT = `
attribute vec3 a_pos;
attribute vec3 a_next;
attribute float a_side;
attribute float a_t;
attribute float a_w0;
attribute float a_w1;
attribute float a_taper;
attribute float a_end;    // 0 = segment start, 1 = segment end
uniform mat4 u_matrix;
uniform vec2 u_half;    // HALF the drawing buffer, so u_width is true pixels
uniform float u_width;
uniform float u_frac;
varying float v_t;
varying float v_side;
varying float v_w;
void main() {
  // Weight for BOTH neighbouring time frames is baked into the vertex, so a
  // corridor that exists in one frame and not the next fades instead of popping
  // — and the geometry only has to be rebuilt when the integer frame changes.
  float w8 = mix(a_w0, a_w1, u_frac);
  vec4 cA = u_matrix * vec4(a_pos, 1.0);
  vec4 cB = u_matrix * vec4(a_next, 1.0);
  vec2 sA = cA.xy / max(cA.w, 1e-6) * u_half;
  vec2 sB = cB.xy / max(cB.w, 1e-6) * u_half;
  vec2 dir = sB - sA;
  float len = length(dir);
  dir = len > 0.0001 ? dir / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  // Sankey rule: width IS the quantity. Sub-linear only enough that the biggest
  // corridor doesn't smother the map. a_taper thins the ribbon where it dives
  // down the off-ramp, so the descent reads as a ramp and not a wall.
  float w = u_width * (0.24 + 0.76 * sqrt(max(w8, 0.0))) * a_taper;
  // BOTH vertices of a segment carry the SAME (start, end) pair and pick their
  // endpoint with a_end. The obvious alternative — storing each vertex's own
  // position with its neighbour, and negating a_side on the far end to keep the
  // normal pointing the right way — makes v_side run +1 -> -1 along the ribbon's
  // LENGTH, so abs(v_side) pinches to zero mid-segment and the whole thing
  // renders as chevrons. Selecting the endpoint instead keeps the direction
  // forward for every vertex, so v_side means only one thing: across.
  vec4 base = mix(cA, cB, a_end);
  vec2 off = nrm * a_side * w / u_half * max(base.w, 1e-6);
  gl_Position = vec4(base.xy + off, base.z, base.w);
  v_t = a_t; v_side = a_side; v_w = w8;
}`;

const ARC_FRAG = `
precision mediump float;
uniform vec3 u_from;
uniform vec3 u_to;
uniform float u_alpha;
uniform float u_phase;
uniform float u_soft;   // 0 = core pass, 1 = halo pass
varying float v_t;
varying float v_side;
varying float v_w;
void main() {
  float e = abs(v_side);
  // Core: near-solid band with a feathered rim. Halo: a gaussian that never
  // reaches full opacity. Stacked additively they make a lit ribbon.
  float body = mix(smoothstep(1.0, 0.50, e), exp(-e * e * 2.1), u_soft);

  // Red at the origin, green at the destination — the same semantics the nodes
  // carry, so you can read a ribbon's direction without watching it move.
  vec3 col = mix(u_from, u_to, smoothstep(0.04, 0.96, v_t));

  // A travelling head. Static ribbons have no direction; this is what tells you
  // which way the people are going, and costs one uniform. Core pass only —
  // putting it in the halo too made the whole sheet shimmer.
  float d = fract(v_t - u_phase);
  float head = exp(-pow(d * 5.0, 2.0));

  float ends = smoothstep(0.0, 0.05, v_t) * smoothstep(0.0, 0.05, 1.0 - v_t);
  float a = body * ends * u_alpha * (0.34 + 0.66 * v_w) * (0.58 + 1.05 * head);
  vec3 c = col + vec3(1.0, 0.98, 0.92) * head * (1.0 - u_soft) * 0.8;
  gl_FragColor = vec4(c * a, a);
}`;

const NODE_VERT = `
attribute vec3 a_pos;
attribute float a_size;
attribute float a_net;
uniform mat4 u_matrix;
uniform float u_dpr;
uniform float u_scale;
uniform float u_grow;     // extra size for the glow pass, 1.0 for the body pass
uniform float u_vh;       // drawing buffer height, device px
uniform float u_anchor;   // 0 = sphere centred on the station, 1 = RESTING ON it
varying float v_net;
void main() {
  gl_Position = u_matrix * vec4(a_pos, 1.0);
  // Floor of 0.0, not 2.0: below-threshold stations are handed size 0 by the
  // CPU and must vanish completely. Eight hundred faint dots additively summed
  // is exactly the haze that made v1 read as noise.
  float body = clamp(a_size * u_scale, 0.0, 200.0) * u_dpr;
  gl_PointSize = clamp(a_size * u_scale * u_grow, 0.0, 200.0) * u_dpr;

  // ── Bottom-anchored spheres. Blair, 2026-09-15 ──────────────────────────────
  //
  //   "in week mode the balls almost looked like they were bouncing up and down,
  //    which would be very cool. I think we could get that effect by anchoring
  //    the location of the spheres to the bottom middle of the sphere instead of
  //    the physical center. So visually they would grow up and down more, which
  //    will make the map look like it's bouncing."
  //
  // A point sprite is centred on gl_Position, so a growing sphere used to expand
  // symmetrically — half of the growth went DOWN into the map, which cancels the
  // half going up and leaves the eye with a change of area rather than a change
  // of height. Shifting the sprite up by half its own body radius plants the
  // bottom of the ball on the station and sends all of the growth upward.
  //
  // Done in CLIP space against the real viewport height rather than in world
  // metres, because the intended effect is visual — the ball should sit on the
  // ground at any camera pitch, and a world-space lift would foreshorten away as
  // the camera flattens, which is the opposite of what he asked for.
  //
  // Deliberately uses the BODY size, not the glow-inflated one, so the halo stays
  // concentric with the ball it belongs to instead of sliding up off it.
  gl_Position.y += (body * 0.5 * u_anchor) / (u_vh * 0.5) * gl_Position.w;

  v_net = a_net;
}`;

// v4: the nodes are SPHERES, not glows. Blair's direction, 2026-09-09:
//   "each location should be a sphere and when the location is losing bikes the
//    sphere is red and it's getting smaller, and when the location is getting
//    bikes it's a green sphere and it's getting bigger… keeping in mind that it
//    has an X, Y and Z axis so it's not just flooding a page."
//
// Impostor spheres, not meshes. A point sprite with a normal reconstructed from
// gl_PointCoord is a perfect sphere for a fraction of the cost of ~1,050 real
// spheres, which matters because the target is a phone. The z-axis is real:
// app.js lifts each node off the ground plane by its balance, so filling
// stations ride high and draining ones sink toward the map. The camera is
// already pitched 52 degrees, so that height reads as parallax the moment you
// pan.
//
// Drawn in two passes, because one blend mode cannot do both jobs:
//   1. GLOW   — additive, oversized, soft. Keeps the "city as light" reading.
//   2. BODY   — alpha-blended, lit, specular. Makes it a ball you could pick up.

const NODE_FRAG = `
precision mediump float;
uniform vec3 u_out;      // departures — red (or blue, in the bluegreen variant)
uniform vec3 u_in;       // arrivals — green
uniform vec3 u_mid;      // balanced — dim slate, NOT the midpoint of red and green
uniform float u_alpha;
uniform float u_body;    // 1.0 = lit sphere pass, 0.0 = additive glow pass
uniform float u_gloss;   // specular strength
uniform float u_rim;     // rim light
uniform float u_fill;    // ambient on the dark side
uniform float u_quiet;   // brightness a perfectly BALANCED sphere keeps
uniform float u_commit;  // gamma on the ramp; <1 pushes mid values to full hue
uniform float u_hue;     // 1.0 = interpolate AROUND the colour wheel in OKLCH
uniform vec3 u_lchOut;   // (L, C, h) of the draining colour
uniform vec3 u_lchIn;    // (L, C, h) of the filling colour — h already unwrapped
                         // on the CPU so a straight mix takes the short arc
varying float v_net;     // +1 = draining, -1 = filling

// ── OKLCH -> sRGB ────────────────────────────────────────────────────────────
// Why this exists, in Blair's words (2026-09-15): "green and red might have been
// bad initial choices because they are on opposite sides of the colour wheel, and
// the colour transitions we were using from one to the other went through the
// middle of the colour wheel, rather than around the edge, so to human eyes that
// gradient and transition didn't make sense."
//
// Exactly right, and it is a property of the SPACE, not of the two colours. Mixing
// two hues in RGB cuts a straight chord through the middle of the solid, where
// chroma collapses: the midpoint of red and green is olive (v4), of red and a
// blue-grey is mauve (v8). Rotating the HUE ANGLE instead holds the chroma up and
// walks the rim, so blue -> green passes through a real cyan.
//
// OKLab rather than HSL because HSL's "lightness" is not lightness — its yellow at
// L=50% is far brighter than its blue at L=50%, so a constant-L sweep still
// flickers in brightness. OKLab is built so that a constant L looks constant.
vec3 oklch2srgb(vec3 lch) {
  float a = lch.y * cos(lch.z);
  float b = lch.y * sin(lch.z);
  float l_ = lch.x + 0.3963377774 * a + 0.2158037573 * b;
  float m_ = lch.x - 0.1055613458 * a - 0.0638541728 * b;
  float s_ = lch.x - 0.0894841775 * a - 1.2914855480 * b;
  float l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  vec3 lin = vec3(
     4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
  // Clamp rather than gamut-map: the two endpoints are inside sRGB and the arc
  // between them stays near it, so the worst case is a few percent of chroma at
  // the cyan midpoint. A real gamut mapper is not worth a branch per fragment.
  lin = clamp(lin, 0.0, 1.0);
  return pow(lin, vec3(1.0 / 2.2));
}

void main() {
  // gl_PointCoord's y runs DOWN the sprite. Flip it or the light lands on the
  // wrong hemisphere and every sphere reads as lit from below, which the eye
  // notices instantly even when it cannot say why.
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  p.y = -p.y;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;

  // Two-segment ramp through a neutral, so nothing ever renders brown, and a
  // balanced sphere is DIM as well as colourless — quiet twice over.
  // Gamma the ramp before mixing. Without it the distribution of net balance
  // is bunched near zero, so most spheres sat in the neutral and the field read
  // as mostly grey with a few coloured outliers. pow(|t|, commit) with commit<1
  // lifts the middle of the range into real colour while leaving a genuinely
  // balanced station (t≈0) neutral, which is the one that SHOULD be grey.
  float t = clamp(v_net, -1.0, 1.0);
  float m = pow(abs(t), u_commit);
  vec3 ramp = t > 0.0 ? mix(u_mid, u_out, m) : mix(u_mid, u_in, m);
  // Hue mode ignores the neutral entirely — there is no colourless midpoint to
  // pass through, which is the whole point. v_net arrives EASED rather than
  // latched, so a reversal is a visible sweep rather than a swap.
  vec3 arc = oklch2srgb(mix(u_lchIn, u_lchOut, (t + 1.0) * 0.5));
  vec3 base = mix(ramp, arc, u_hue);
  base *= u_quiet + (1.0 - u_quiet) * abs(t);

  if (u_body < 0.5) {
    // ── GLOW pass. Exponential falloff, not a linear ramp — linear ramps band.
    float r = sqrt(r2);
    float halo = exp(-pow(r * 1.9, 2.0));
    float a = halo * u_alpha;
    gl_FragColor = vec4(base * a, a);
    return;
  }

  // ── BODY pass: reconstruct the sphere normal and light it.
  vec3 n = vec3(p, sqrt(max(0.0, 1.0 - r2)));
  vec3 L = normalize(vec3(-0.40, 0.52, 0.76));
  float diff = max(dot(n, L), 0.0);
  float spec = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 26.0);
  float rim  = pow(1.0 - n.z, 3.0);

  // Emissive floor, then shading on top: it has to stay light on a dark map, so
  // the dark side of a sphere is dim rather than black.
  vec3 col = base * (u_fill + (1.0 - u_fill) * diff);
  col += base * rim * u_rim;
  col += vec3(1.0) * spec * u_gloss;

  // Antialias the silhouette in the last few percent of the radius.
  float edge = smoothstep(1.0, 0.90, sqrt(r2));
  float a = edge * u_alpha;
  gl_FragColor = vec4(col * a, a);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error('shader: ' + gl.getShaderInfoLog(s));
  }
  return s;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('link: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

export const hex = (h) => [
  parseInt(h.slice(1, 3), 16) / 255,
  parseInt(h.slice(3, 5), 16) / 255,
  parseInt(h.slice(5, 7), 16) / 255,
];

// sRGB hex -> OKLCH (L, C, hue in radians). The companion to oklch2srgb above;
// done on the CPU once per page so the shader never converts in that direction.
export function oklch(h) {
  const srgb = hex(h).map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  const [r, g, b] = srgb;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return [L, Math.hypot(A, B), Math.atan2(B, A)];
}

export const COL = {
  // 2026-09-14, Blair: "the green and red need to be a bit more vibrant - like
  // ferrari red and HEX #28B80F green." Both are now his values exactly. Note
  // #28b80f is DARKER than the old mint (#2bff9a) but far more saturated, which
  // is the trade he asked for — it reads as a colour rather than as a glow, and
  // it sits much further from the red in hue so the two sides separate cleanly.
  out: hex('#ff2800'),      // Ferrari red — draining, bikes leaving
  in: hex('#28b80f'),       // arrivals / filling
  arcFrom: hex('#ff2800'),
  arcTo: hex('#28b80f'),
  // The midpoint of the balance scale. v4 interpolated red->green directly and
  // every near-balanced station came out OLIVE BROWN, because that is what sits
  // halfway between those two hues. Brown reads as a third category the data
  // does not have. Routing the ramp through a dim slate instead means balanced
  // stations go quiet and recede, and only the ones actually doing something
  // carry colour — which is the whole point of the view.
  // 2026-09-13, Blair: "the map seems to be an odd mix of green red, purples and
  // greys — it needs to be more red or green." The purples were THIS value. A
  // blue-grey slate mixed toward red passes through mauve, and mixed toward
  // green passes through teal, so the neutral zone was reading as two extra
  // hues the data does not have — the same mistake as the olive-brown in v4,
  // one step around the wheel.
  //
  // A dark NEUTRAL grey has no hue to contribute, so the ramp now runs red ->
  // neutral -> green and nothing in between is a colour.
  //
  // 2026-09-15: LIGHTENED from #3a3a3c. Blair: "even small spheres should have
  // bright colors. Having them dark hides them against the black background."
  // #3a3a3c against a near-black map is almost invisible, and because the ramp
  // mixes TOWARDS it, every partially-saturated sphere was dragged dark as well
  // as grey — which is where the "dark reds and dark greens" came from. The
  // neutral is now a mid grey that holds its own against black. Balanced
  // stations still recede, but by being SMALL (size is the magnitude), not by
  // being invisible.
  mid: hex('#7b7b82'),
};

export const ARC_STRIDE = 12;   // pos(3) next(3) side t w0 w1 taper end

export class PulseLayer {
  constructor() {
    this.id = LAYER_ID;
    this.type = 'custom';
    this.renderingMode = '3d';
    this.gl = null;
    this.map = null;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.arcCount = 0;
    this.nodeCount = 0;
    this.phase = 0;
    this.arcAlpha = 1;
    this.nodeAlpha = 1;
    this.arcWidth = 7;        // half-width in CSS pixels of the fattest ribbon
    // Sphere look. Set from app.js TUNE (which is URL-overridable) so Blair can
    // change any of these from a phone without editing a file.
    this.gloss = 0.55;
    this.rim = 0.45;
    this.fill = 0.44;   // ambient on the sphere's dark side. 0.30 -> 0.44 on
                        // 2026-09-15: at 7-11 px a sphere is mostly its dark
                        // hemisphere, so the shading term was the largest single
                        // darkener of exactly the small spheres Blair wants bright.
    this.quiet = 1.0;   // 0.55 -> 1.0 on 2026-09-15. This multiplied every sphere's
                        // brightness by its own |net|, so a small sphere was dim ON
                        // TOP OF being desaturated — magnitude encoded a third time,
                        // in luminance, after size and colour had both already said
                        // it. Brightness is now flat and size carries the quantity
                        // alone. Set below 1 to dim balanced stations again.
    this.anchor = 1;          // 1 = spheres REST ON their station, 0 = centred on it.
                              // See the note in NODE_VERT for why this is a screen-space
                              // shift rather than a world-space lift.
    // Set by app.js from the variant table. `palette` overrides COL; `hue` swaps
    // the two-colour ramp for an OKLCH arc; `depth` turns on depth testing, which
    // is only meaningful when something opaque (the 3D buildings) has written the
    // depth buffer first.
    this.palette = null;
    this.hue = 0;
    this.lchOut = [0, 0, 0];
    this.lchIn = [0, 0, 0];
    this.depth = false;
    this.glowSize = 2.3;      // glow sprite radius as a multiple of the body
    this.glowAlpha = 0.30;
    this._pendingArc = null;
    this._pendingNode = null;
  }

  onAdd(map, gl) {
    this.map = map;
    this.gl = gl;
    this.arcProg = program(gl, ARC_VERT, ARC_FRAG);
    this.nodeProg = program(gl, NODE_VERT, NODE_FRAG);
    this.arcBuf = gl.createBuffer();
    this.nodeBuf = gl.createBuffer();
    const au = (n) => gl.getUniformLocation(this.arcProg, n);
    const nu = (n) => gl.getUniformLocation(this.nodeProg, n);
    this.aLoc = {
      pos: gl.getAttribLocation(this.arcProg, 'a_pos'),
      next: gl.getAttribLocation(this.arcProg, 'a_next'),
      side: gl.getAttribLocation(this.arcProg, 'a_side'),
      t: gl.getAttribLocation(this.arcProg, 'a_t'),
      w0: gl.getAttribLocation(this.arcProg, 'a_w0'),
      w1: gl.getAttribLocation(this.arcProg, 'a_w1'),
      taper: gl.getAttribLocation(this.arcProg, 'a_taper'),
      end: gl.getAttribLocation(this.arcProg, 'a_end'),
    };
    this.aU = {
      matrix: au('u_matrix'), half: au('u_half'), width: au('u_width'),
      alpha: au('u_alpha'), phase: au('u_phase'), frac: au('u_frac'),
      soft: au('u_soft'), from: au('u_from'), to: au('u_to'),
    };
    this.nLoc = {
      pos: gl.getAttribLocation(this.nodeProg, 'a_pos'),
      size: gl.getAttribLocation(this.nodeProg, 'a_size'),
      net: gl.getAttribLocation(this.nodeProg, 'a_net'),
    };
    this.nU = {
      matrix: nu('u_matrix'), dpr: nu('u_dpr'), scale: nu('u_scale'),
      alpha: nu('u_alpha'), out: nu('u_out'), in: nu('u_in'), mid: nu('u_mid'),
      body: nu('u_body'), grow: nu('u_grow'),
      gloss: nu('u_gloss'), rim: nu('u_rim'), fill: nu('u_fill'), quiet: nu('u_quiet'),
      vh: nu('u_vh'), anchor: nu('u_anchor'),
      commit: nu('u_commit'),
      hue: nu('u_hue'), lchOut: nu('u_lchOut'), lchIn: nu('u_lchIn'),
    };
    if (this._pendingArc) { this.setArcs(this._pendingArc, this._pendingArcN); this._pendingArc = null; }
    if (this._pendingNode) { this.setNodes(this._pendingNode); this._pendingNode = null; }
  }

  setArcs(f32, count) {
    if (!this.gl) { this._pendingArc = f32; this._pendingArcN = count; return; }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.arcBuf);
    gl.bufferData(gl.ARRAY_BUFFER, f32, gl.DYNAMIC_DRAW);
    this.arcCount = count;
  }

  // Interleaved: pos(3) size(1) net(1) = 5 floats
  setNodes(f32) {
    if (!this.gl) { this._pendingNode = f32; return; }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeBuf);
    gl.bufferData(gl.ARRAY_BUFFER, f32, gl.DYNAMIC_DRAW);
    this.nodeCount = f32.length / 5;
  }

  render(gl, matrix) {
    const hw = gl.drawingBufferWidth / 2, hh = gl.drawingBufferHeight / 2;
    // Depth testing is OFF unless the variant draws buildings. With nothing opaque
    // in the scene there is nothing to occlude against, and additive blending with
    // no depth test is a whole bug class that never happens. With buildings, the
    // extrusions have already written depth in the opaque pass, so testing (but
    // never WRITING — the spheres are translucent and must not occlude each other
    // by depth) is what puts a sphere behind a tower.
    if (this.depth) { gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); }
    else gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    // Premultiplied additive: the fragment shaders output colour * alpha.
    gl.blendFunc(gl.ONE, gl.ONE);

    // arcAlpha 0 means the ribbons are off, not merely transparent — skip the two
    // draw calls entirely rather than rendering ~35k invisible vertices twice a frame.
    if (this.arcCount && this.arcAlpha > 0) {
      gl.useProgram(this.arcProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.arcBuf);
      const S = ARC_STRIDE * 4;
      const L = this.aLoc, U = this.aU;
      gl.enableVertexAttribArray(L.pos);   gl.vertexAttribPointer(L.pos, 3, gl.FLOAT, false, S, 0);
      gl.enableVertexAttribArray(L.next);  gl.vertexAttribPointer(L.next, 3, gl.FLOAT, false, S, 12);
      gl.enableVertexAttribArray(L.side);  gl.vertexAttribPointer(L.side, 1, gl.FLOAT, false, S, 24);
      gl.enableVertexAttribArray(L.t);     gl.vertexAttribPointer(L.t, 1, gl.FLOAT, false, S, 28);
      gl.enableVertexAttribArray(L.w0);    gl.vertexAttribPointer(L.w0, 1, gl.FLOAT, false, S, 32);
      gl.enableVertexAttribArray(L.w1);    gl.vertexAttribPointer(L.w1, 1, gl.FLOAT, false, S, 36);
      gl.enableVertexAttribArray(L.taper); gl.vertexAttribPointer(L.taper, 1, gl.FLOAT, false, S, 40);
      gl.enableVertexAttribArray(L.end);   gl.vertexAttribPointer(L.end, 1, gl.FLOAT, false, S, 44);
      gl.uniformMatrix4fv(U.matrix, false, matrix);
      gl.uniform2f(U.half, hw, hh);
      gl.uniform1f(U.phase, this.phase);
      gl.uniform1f(U.frac, this.frac || 0);
      gl.uniform3fv(U.from, COL.arcFrom);
      gl.uniform3fv(U.to, COL.arcTo);

      // Halo first, then core on top. Order is cosmetic under additive blending
      // but keeps the intent obvious to whoever reads this next.
      const w = this.arcWidth * this.dpr;
      gl.uniform1f(U.soft, 1.0);
      gl.uniform1f(U.width, w * 3.4);
      gl.uniform1f(U.alpha, this.arcAlpha * 0.13);
      gl.drawArrays(gl.TRIANGLES, 0, this.arcCount);

      gl.uniform1f(U.soft, 0.0);
      gl.uniform1f(U.width, w);
      gl.uniform1f(U.alpha, this.arcAlpha);
      gl.drawArrays(gl.TRIANGLES, 0, this.arcCount);
    }

    if (this.nodeCount) {
      gl.useProgram(this.nodeProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeBuf);
      const S = 5 * 4;
      const L = this.nLoc, U = this.nU;
      gl.enableVertexAttribArray(L.pos);  gl.vertexAttribPointer(L.pos, 3, gl.FLOAT, false, S, 0);
      gl.enableVertexAttribArray(L.size); gl.vertexAttribPointer(L.size, 1, gl.FLOAT, false, S, 12);
      gl.enableVertexAttribArray(L.net);  gl.vertexAttribPointer(L.net, 1, gl.FLOAT, false, S, 16);
      const P = this.palette || COL;
      gl.uniformMatrix4fv(U.matrix, false, matrix);
      gl.uniform1f(U.dpr, this.dpr);
      gl.uniform1f(U.scale, this.nodeScale || 1);
      gl.uniform3fv(U.out, P.out);
      gl.uniform3fv(U.in, P.in);
      gl.uniform3fv(U.mid, P.mid);
      gl.uniform1f(U.hue, this.hue);
      gl.uniform3fv(U.lchOut, this.lchOut);
      gl.uniform3fv(U.lchIn, this.lchIn);
      gl.uniform1f(U.gloss, this.gloss);
      gl.uniform1f(U.rim, this.rim);
      gl.uniform1f(U.fill, this.fill);
      gl.uniform1f(U.quiet, this.quiet);
      gl.uniform1f(U.vh, gl.drawingBufferHeight);
      gl.uniform1f(U.anchor, this.anchor === undefined ? 1 : this.anchor);
      gl.uniform1f(U.commit, this.commit === undefined ? 0.62 : this.commit);

      // PASS 1 — glow. Additive, oversized, soft: the city still reads as light.
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.uniform1f(U.body, 0.0);
      gl.uniform1f(U.grow, this.glowSize);
      gl.uniform1f(U.alpha, this.nodeAlpha * this.glowAlpha);
      gl.drawArrays(gl.POINTS, 0, this.nodeCount);

      // PASS 2 — body. Premultiplied alpha over the glow, so a sphere reads as a
      // solid object rather than a bright patch. Additive cannot do this: two
      // overlapping additive spheres sum to white and the silhouette disappears,
      // which is exactly what stops them looking like objects.
      // app.js writes the buffer sorted far-to-near, so painter's order is right.
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1f(U.body, 1.0);
      gl.uniform1f(U.grow, 1.0);
      gl.uniform1f(U.alpha, this.nodeAlpha);
      gl.drawArrays(gl.POINTS, 0, this.nodeCount);
    }

    gl.depthMask(true);
  }
}
