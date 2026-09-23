#!/usr/bin/env python3
"""
aggregate.py — turn a year of Toronto Bike Share trip records into a small,
fixed, GPU-ready set of files.

The governing idea: 2025 is CLOSED. This history is immutable and will never
change again. So there is no reason for the app to ever query anything. We do
all the work once, here, and ship a binary the renderer indexes directly.
That is why scrubbing a whole year stays smooth — the time slider is a texture
lookup, not a fetch.

Three time regimes, deliberately answering three different questions:
  DAY   — 24 buckets, the typical day.   "What does a day look like?"
  WEEK  — 168 buckets, the typical week. "How do weekdays differ from weekends?"
  YEAR  — 12 buckets, month by month.    "How does the city's flow CHANGE?"

The year view is not a fast day. Its frames are months, so what animates is
the difference between months — volume and the shift in preferred corridors.
As you zoom out in time, the visual encodes the derivative, not the value.

Three levels of detail, by grid quantization of fixed station coordinates:
  L2 = individual stations   (~1050)
  L1 = groups               (~0.008 deg, roughly 600-900 m)
  L0 = neighbourhoods       (~0.025 deg, roughly 2-3 km)

Memory discipline: this box has ~4 GB free and full swap. Everything streams.
Station-level origin-destination pairs are only accumulated for DAY (24 frames)
and YEAR (12 frames); WEEK arcs accumulate at L1 to bound the dict count.
"""

import csv, io, json, math, os, struct, sys, zipfile
from collections import defaultdict

ZIP = sys.argv[1] if len(sys.argv) > 1 else "/tmp/bs/2025.zip"
# Overridable so a second year can be built beside the first without touching it
# (2026-09-22: 2026 builds into app/data/2026/, 2025 stays in app/data/).
STATIONS = os.environ.get("PULSE_STATIONS", "/tmp/bs/stations.json")
OUT = os.path.expanduser(os.environ.get("PULSE_OUT", "~/pulse/app/data"))
YEAR = os.environ.get("PULSE_YEAR", "2025")

L1_Q = 0.008      # ~0.9 km latitude
L0_Q = 0.025      # ~2.8 km latitude
TOP_ARCS = 420    # arcs kept per frame; more than the eye can read at once

# ---------------------------------------------------------------- stations
def load_stations():
    d = json.load(open(STATIONS))["data"]["stations"]
    out = {}
    for s in d:
        try:
            out[int(s["station_id"])] = (float(s["lat"]), float(s["lon"]), s.get("name", ""))
        except (ValueError, KeyError, TypeError):
            continue
    return out

STA = load_stations()
print(f"stations: {len(STA)}")

# Stable index order so every array below shares one addressing scheme.
sids = sorted(STA)
sidx = {sid: i for i, sid in enumerate(sids)}
N2 = len(sids)

def qkey(lat, lon, q):
    return (round(lat / q), round(lon / q))

# Build L1 / L0 by quantizing each station's real position.
l1_key, l0_key = {}, {}
for sid in sids:
    lat, lon, _ = STA[sid]
    l1_key[sid] = qkey(lat, lon, L1_Q)
    l0_key[sid] = qkey(lat, lon, L0_Q)

def build_level(keymap):
    order = {}
    for sid in sids:
        k = keymap[sid]
        if k not in order:
            order[k] = len(order)
    # centroid + member count per cell
    acc = defaultdict(lambda: [0.0, 0.0, 0])
    for sid in sids:
        lat, lon, _ = STA[sid]
        a = acc[order[keymap[sid]]]
        a[0] += lat; a[1] += lon; a[2] += 1
    nodes = []
    for i in range(len(order)):
        a = acc[i]
        nodes.append({"lat": a[0] / a[2], "lon": a[1] / a[2], "n": a[2]})
    idx = [order[keymap[sid]] for sid in sids]   # station index -> level index
    return nodes, idx

L1_NODES, S2L1 = build_level(l1_key)
L0_NODES, S2L0 = build_level(l0_key)
N1, N0 = len(L1_NODES), len(L0_NODES)
print(f"levels: L2={N2} stations, L1={N1} groups, L0={N0} neighbourhoods")

# ---------------------------------------------------------------- accumulators
# flows[kind][frame][node] = [out, in]
day_out = [[0] * N2 for _ in range(24)]
day_in  = [[0] * N2 for _ in range(24)]
wk_out  = [[0] * N2 for _ in range(168)]
wk_in   = [[0] * N2 for _ in range(168)]
yr_out  = [[0] * N2 for _ in range(12)]
yr_in   = [[0] * N2 for _ in range(12)]

od_day = [defaultdict(int) for _ in range(24)]    # station level
od_yr  = [defaultdict(int) for _ in range(12)]    # station level
od_wk  = [defaultdict(int) for _ in range(168)]   # L1 level (memory bound)

n_days_seen = set()
total = 0
skipped = 0

# ---------------------------------------------------------------- parsing
def find_col(header, *cands):
    norm = [h.strip().lower().replace("_", " ").replace("  ", " ") for h in header]
    for c in cands:
        c = c.lower()
        for i, h in enumerate(norm):
            if h == c:
                return i
    for c in cands:
        c = c.lower()
        for i, h in enumerate(norm):
            if c in h:
                return i
    return None

TIME_FORMATS = ("%m/%d/%Y %H:%M", "%m/%d/%Y %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M")

def parse_time(s):
    """Return (month0, weekday, hour, daykey) or None. Hand-rolled: datetime.strptime
    on 6M rows is the single slowest thing in this script."""
    s = s.strip()
    if not s:
        return None
    try:
        if "/" in s:                      # M/D/YYYY H:MM
            date, _, clock = s.partition(" ")
            mm, dd, yy = date.split("/")
            mo, dy, yr = int(mm), int(dd), int(yy)
        else:                             # YYYY-MM-DD H:MM:SS
            date, _, clock = s.partition(" ")
            yy, mm, dd = date.split("-")
            mo, dy, yr = int(mm), int(dd), int(yy)
        hh = int(clock.split(":")[0]) if clock else 0
    except (ValueError, IndexError):
        return None
    if not (1 <= mo <= 12 and 1 <= dy <= 31 and 0 <= hh <= 23):
        return None
    # Zeller-ish weekday via the standard days-from-civil algorithm
    y = yr - (mo <= 2)
    era = (y if y >= 0 else y - 399) // 400
    yoe = y - era * 400
    doy = (153 * (mo + (-3 if mo > 2 else 9)) + 2) // 5 + dy - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    days = era * 146097 + doe - 719468
    wd = (days + 3) % 7          # 0 = Monday
    return mo - 1, wd, hh, days

z = zipfile.ZipFile(ZIP)
members = sorted(m.filename for m in z.infolist() if m.filename.lower().endswith(".csv"))

for name in members:
    with z.open(name) as raw:
        stream = io.TextIOWrapper(raw, encoding="utf-8-sig", errors="replace", newline="")
        rdr = csv.reader(stream)
        try:
            header = next(rdr)
        except StopIteration:
            continue
        ci_ss = find_col(header, "start station id")
        ci_es = find_col(header, "end station id")
        ci_st = find_col(header, "start time")
        if ci_ss is None or ci_es is None or ci_st is None:
            print(f"  !! {name}: cannot locate columns in {header}")
            continue
        cnt = 0
        for row in rdr:
            try:
                # int(float()): the 2026 file writes end ids as "7037.0"
                a = sidx.get(int(float(row[ci_ss])))
                b = sidx.get(int(float(row[ci_es])))
            except (ValueError, IndexError, TypeError):
                skipped += 1
                continue
            if a is None or b is None:
                skipped += 1
                continue
            t = parse_time(row[ci_st]) if ci_st < len(row) else None
            if t is None:
                skipped += 1
                continue
            mo, wd, hh, dk = t
            wkslot = wd * 24 + hh
            n_days_seen.add(dk)

            day_out[hh][a] += 1; day_in[hh][b] += 1
            wk_out[wkslot][a] += 1; wk_in[wkslot][b] += 1
            yr_out[mo][a] += 1;  yr_in[mo][b] += 1

            if a != b:
                od_day[hh][(a, b)] += 1
                od_yr[mo][(a, b)] += 1
                od_wk[wkslot][(S2L1[a], S2L1[b])] += 1
            cnt += 1
        total += cnt
        print(f"  {name}: {cnt:,} trips  (running {total:,})")

print(f"total trips: {total:,}   skipped: {skipped:,}   distinct days: {len(n_days_seen)}")

# ---------------------------------------------------------------- roll up + write
def rollup(per_station, idxmap, nnodes):
    out = [0] * nnodes
    for i, v in enumerate(per_station):
        if v:
            out[idxmap[i]] += v
    return out

def pack_flow(frames_out, frames_in, level):
    """uint16 per node per frame, scaled to a per-regime max so the GPU can read
    a normalized value with no per-frame CPU work."""
    if level == 2:
        fo, fi = frames_out, frames_in
    else:
        idxmap = S2L1 if level == 1 else S2L0
        nn = N1 if level == 1 else N0
        fo = [rollup(f, idxmap, nn) for f in frames_out]
        fi = [rollup(f, idxmap, nn) for f in frames_in]
    peak = max((max(max(a), max(b)) for a, b in zip(fo, fi)), default=1) or 1
    buf = bytearray()
    for a, b in zip(fo, fi):
        for v in a:
            buf += struct.pack("<H", min(65535, int(v * 65535 / peak)))
        for v in b:
            buf += struct.pack("<H", min(65535, int(v * 65535 / peak)))
    return bytes(buf), peak

def pack_arcs(od_frames, nodes_count):
    """Per frame: top-K (from, to, weight). uint16 indices, uint16 weight."""
    head, body = [], bytearray()
    peak = 1
    for d in od_frames:
        top = sorted(d.items(), key=lambda kv: -kv[1])[:TOP_ARCS]
        if top:
            peak = max(peak, top[0][1])
    for d in od_frames:
        top = sorted(d.items(), key=lambda kv: -kv[1])[:TOP_ARCS]
        head.append(len(top))
        for (a, b), w in top:
            body += struct.pack("<HHH", a, b, min(65535, int(w * 65535 / peak)))
    return head, bytes(body), peak

os.makedirs(OUT, exist_ok=True)
manifest = {
    "generated": os.environ.get("PULSE_GENERATED", "2026-07-25"),
    "source": f"Toronto Open Data — Bike Share Toronto Ridership {YEAR}",
    "year": YEAR,
    "first_day": None, "last_day": None,
    "trips": total,
    "days": len(n_days_seen),
    "levels": {
        "0": {"count": N0, "nodes": L0_NODES},
        "1": {"count": N1, "nodes": L1_NODES},
        "2": {"count": N2,
              "nodes": [{"lat": STA[s][0], "lon": STA[s][1], "name": STA[s][2]} for s in sids]},
    },
    "regimes": {},
}

if n_days_seen:
    import datetime as _dt
    _epoch = _dt.date(1970, 1, 1)
    manifest["first_day"] = str(_epoch + _dt.timedelta(days=min(n_days_seen)))
    manifest["last_day"] = str(_epoch + _dt.timedelta(days=max(n_days_seen)))

for kind, fo, fi, od, odlevel, nframes in (
    ("day",  day_out, day_in, od_day, 2, 24),
    ("week", wk_out,  wk_in,  od_wk,  1, 168),
    ("year", yr_out,  yr_in,  od_yr,  2, 12),
):
    reg = {"frames": nframes, "arcLevel": odlevel, "flow": {}}
    for lvl in (0, 1, 2):
        blob, peak = pack_flow(fo, fi, lvl)
        fn = f"{kind}-flow-L{lvl}.bin"
        open(os.path.join(OUT, fn), "wb").write(blob)
        reg["flow"][str(lvl)] = {"file": fn, "peak": peak,
                                 "nodes": (N2 if lvl == 2 else N1 if lvl == 1 else N0)}
    counts, body, apeak = pack_arcs(od, N2 if odlevel == 2 else N1)
    fn = f"{kind}-arcs.bin"
    open(os.path.join(OUT, fn), "wb").write(body)
    reg["arcs"] = {"file": fn, "counts": counts, "peak": apeak}
    manifest["regimes"][kind] = reg
    print(f"  wrote {kind}: flow L0/L1/L2 + {sum(counts):,} arcs")

json.dump(manifest, open(os.path.join(OUT, "manifest.json"), "w"), separators=(",", ":"))
sz = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))
print(f"DONE — {sz/1e6:.2f} MB total in {OUT}")
