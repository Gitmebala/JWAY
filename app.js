/* JWAY — JKUAT Juja campus navigation
   Buildings: OpenStreetMap contributors (ODbL) + JKUAT ArcGIS survey.
   Rooms: venue codes harvested from JKUAT exam timetables.
   Routing: Dijkstra over the campus footpath graph, endpoints projected onto edges. */

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
}

const D = window.CAMPUS;
const B = D.buildings, NODES = D.nodes, ADJ = D.adj;

/* ---------- projection: WGS84 <-> local metres ---------- */
const LAT0 = -1.0955, LON0 = 37.014;
const MLAT = 110574, MLON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const X = lon => (lon - LON0) * MLON;
const Y = lat => -(lat - LAT0) * MLAT;
const toLon = x => x / MLON + LON0;
const toLat = y => LAT0 - y / MLAT;
const ll = p => [toLat(p[1]), toLon(p[0])];

const NX = NODES.map(n => X(n[0])), NY = NODES.map(n => Y(n[1]));
B.forEach(b => { b.x = X(b.lon); b.y = Y(b.lat); });

const WALK = 1.35;                       // m/s, unhurried student pace
const secsFor = m => Math.round(m / WALK);
const clock = d => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function humanTime(sec) {
  if (sec < 60) return 'under a minute';
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/* ---------- stored data ---------- */
const LS_ROOMS = 'jway.rooms.v3', LS_PREFS = 'jway.prefs.v1';
const load = (k, dflt) => { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : dflt; }
  catch (e) { return dflt; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

let ROOMS = load(LS_ROOMS, null) || D.rooms.slice();
let PREFS = load(LS_PREFS, { voice: true });

const byName = n => B.find(b => b.name === n);
const bldById = id => B.find(b => b.id === id);
const findRoom = code => ROOMS.find(r => norm(r.code) === norm(code));

/* ---------- routing ---------- */
/* nearest point on any walkable edge — lets a route start mid-path
   instead of detouring to the nearest junction */
function attach(x, y) {
  let best = { d: Infinity };
  for (let u = 0; u < ADJ.length; u++) {
    for (const e of ADJ[u]) {
      const v = e[0];
      if (v < u) continue;
      const ax = NX[u], ay = NY[u], dx = NX[v] - ax, dy = NY[v] - ay;
      const L2 = dx * dx + dy * dy;
      if (!L2) continue;
      let t = ((x - ax) * dx + (y - ay) * dy) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + t * dx, py = ay + t * dy;
      const d = Math.hypot(x - px, y - py);
      if (d < best.d) {
        const len = Math.sqrt(L2);
        best = { d, u, v, t, px, py, dU: t * len, dV: (1 - t) * len, st: e[2] };
      }
    }
  }
  return best;
}

function dijkstraMulti(sources) {
  const n = NODES.length;
  const dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1);
  const vis = new Uint8Array(n);
  const pq = [];
  const push = it => { pq.push(it); let i = pq.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (pq[p][0] <= pq[i][0]) break;
      [pq[p], pq[i]] = [pq[i], pq[p]]; i = p; } };
  const pop = () => { const top = pq[0], last = pq.pop();
    if (pq.length) { pq[0] = last; let i = 0;
      for (;;) { const l = 2*i+1, r = l+1; let m = i;
        if (l < pq.length && pq[l][0] < pq[m][0]) m = l;
        if (r < pq.length && pq[r][0] < pq[m][0]) m = r;
        if (m === i) break; [pq[m], pq[i]] = [pq[i], pq[m]]; i = m; } }
    return top; };
  for (const [node, d0] of sources) if (d0 < dist[node]) { dist[node] = d0; push([d0, node]); }
  while (pq.length) {
    const [d, u] = pop();
    if (vis[u]) continue; vis[u] = 1;
    for (const [v, w] of ADJ[u]) {
      const nd = d + w;
      if (nd < dist[v]) { dist[v] = nd; prev[v] = u; push([nd, v]); }
    }
  }
  return { dist, prev };
}

function routeBetween(from, to) {
  const A = attach(from.x, from.y), Z = attach(to.x, to.y);
  const { dist, prev } = dijkstraMulti([[A.u, A.dU], [A.v, A.dV]]);
  const cU = dist[Z.u] + Z.dU, cV = dist[Z.v] + Z.dV;
  let meters = Math.min(cU, cV);
  let end = cU <= cV ? Z.u : Z.v;

  // both ends on the same edge — walking straight along it may beat the graph
  if ((A.u === Z.u && A.v === Z.v)) {
    const direct = Math.hypot(A.px - Z.px, A.py - Z.py);
    if (direct <= meters) return { pts: [[A.px, A.py], [Z.px, Z.py]], meters: direct };
  }
  if (!isFinite(meters)) return null;

  const chain = []; let c = end;
  while (c !== -1) { chain.push(c); c = prev[c]; }
  chain.reverse();

  /* points plus, for each point, the street of the segment leaving it */
  const seq = [{ p: [A.px, A.py], st: A.st }];
  for (let i = 0; i < chain.length; i++) {
    const u = chain[i], nx = chain[i + 1];
    let st = -1;
    if (nx != null) { const e = ADJ[u].find(e => e[0] === nx); st = e ? e[2] : -1; }
    else st = Z.st;
    seq.push({ p: [NX[u], NY[u]], st });
  }
  seq.push({ p: [Z.px, Z.py], st: -1 });
  const kept = seq.filter((s, i) =>
    i === 0 || Math.hypot(s.p[0] - seq[i-1].p[0], s.p[1] - seq[i-1].p[1]) > 0.5);
  return { pts: kept.map(s => s.p), segSt: kept.map(s => s.st), meters };
}

const COMPASS = ['north','north-east','east','south-east','south','south-west','west','north-west'];
const bearing = (ax, ay, bx, by) => (Math.atan2(bx - ax, -(by - ay)) * 180 / Math.PI + 360) % 360;
const compass = b => COMPASS[Math.round(b / 45) % 8];
const angDiff = (a, b) => ((a - b + 540) % 360) - 180;

function nearestBuilding(x, y, maxM, skip, landmarksOnly) {
  const bad = new Set((skip || []).filter(Boolean).map(b => b.id));
  let best = null, bd = maxM * maxM;
  for (const b of B) {
    if (bad.has(b.id)) continue;
    if (landmarksOnly && !isLandmark(b)) continue;
    const d = (b.x - x) ** 2 + (b.y - y) ** 2;
    if (d < bd) { bd = d; best = b; }
  }
  return best;
}
/* things a person can actually recognise while walking past.
   An auto-numbered gate or an unnamed pitch helps nobody. */
const WEAK_LANDMARK = /^(Gate \d+|Sports Pitch|ATM|Pitch B|Tuck Shop|.* Parking)$/i;
const WEAK_CAT = new Set(['Gate', 'Green', 'Money']);
function isLandmark(b) {
  if (WEAK_LANDMARK.test(b.name)) return false;
  if (WEAK_CAT.has(b.cat)) return false;
  return true;
}

/* turn steps, each carrying the along-route distance at which it happens */
function buildSteps(pts, segSt, from, to) {
  const STREETS = D.streets || [];
  /* the street a leg mostly runs along, weighted by distance */
  function legStreet(i0, i1) {
    const tally = {};
    for (let i = i0; i < i1; i++) {
      const s = segSt[i];
      if (s == null || s < 0) continue;
      tally[s] = (tally[s] || 0) + Math.hypot(pts[i+1][0]-pts[i][0], pts[i+1][1]-pts[i][1]);
    }
    let bestS = -1, bestD = 0, total = 0;
    for (const k in tally) { total += tally[k]; if (tally[k] > bestD) { bestD = tally[k]; bestS = +k; } }
    const span = Math.hypot(pts[i1][0]-pts[i0][0], pts[i1][1]-pts[i0][1]);
    /* only name it if the leg genuinely runs along it */
    return (bestS >= 0 && bestD > 18 && bestD > span * 0.45) ? STREETS[bestS] : null;
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++)
    cum.push(cum[i-1] + Math.hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1]));

  const legs = [];
  let i = 0;
  while (i < pts.length - 1) {
    const b0 = bearing(pts[i][0], pts[i][1], pts[i+1][0], pts[i+1][1]);
    let j = i + 1;
    while (j < pts.length - 1) {
      const nb = bearing(pts[j][0], pts[j][1], pts[j+1][0], pts[j+1][1]);
      if (Math.abs(angDiff(nb, b0)) > 22) break;
      j++;
    }
    legs.push({ i0: i, i1: j, bear: b0, m: cum[j] - cum[i] });
    i = j;
  }
  const merged = [];
  for (const lg of legs) {
    const p = merged[merged.length - 1];
    if (p && lg.m < 26) { p.m += lg.m; p.i1 = lg.i1; } else merged.push({ ...lg });
  }

  /* which hand a landmark falls on, given the direction of travel.
     Screen axes: x east, y south — so the right-hand vector is (-dy, dx). */
  function sideOf(p0, p1, b) {
    const dx = p1[0]-p0[0], dy = p1[1]-p0[1];
    const len = Math.hypot(dx, dy); if (len < 1) return null;
    const rx = -dy / len, ry = dx / len;
    const dot = (b.x - p1[0]) * rx + (b.y - p1[1]) * ry;
    return Math.abs(dot) < 8 ? null : (dot > 0 ? 'right' : 'left');
  }

  const steps = [];
  let mark = null;
  merged.forEach((lg, k) => {
    const end = pts[lg.i1];
    const near = nearestBuilding(end[0], end[1], 55, [to, from.bld, mark], true);
    if (near) mark = near;
    /* something worth passing halfway down a long leg */
    let pass = null;
    if (lg.m > 110) {
      const mid = pts[Math.floor((lg.i0 + lg.i1) / 2)];
      const pb = nearestBuilding(mid[0], mid[1], 45, [to, from.bld, near, mark], true);
      if (pb) {
        const s = sideOf(pts[lg.i0], mid, pb);
        if (s) { pass = { b: pb, side: s }; mark = pb; }
      }
    }
    const street = legStreet(lg.i0, lg.i1);
    const prevStreet = k ? legStreet(merged[k-1].i0, merged[k-1].i1) : null;
    const newStreet = street && street !== prevStreet ? street : null;

    let icon, text, voice;
    if (k === 0) {
      icon = 'start';
      const on = street ? ` on <em>${escapeHtml(street)}</em>` : '';
      text = `Head <em>${compass(lg.bear)}</em>${on || ` from ${escapeHtml(from.name)}`}`;
      voice = `Head ${compass(lg.bear)}${street ? ' on ' + street : ''}`;
    } else {
      const d = angDiff(lg.bear, merged[k-1].bear);
      const a = Math.abs(d), dir = d > 0 ? 'right' : 'left';
      if (a < 25) {
        icon = 'straight';
        text = street ? `Continue on <em>${escapeHtml(street)}</em>` : 'Keep going straight';
        voice = street ? `Continue on ${street}` : 'Continue straight';
      } else {
        if (a < 62) { icon = dir === 'right' ? 'sright' : 'sleft'; text = `Bear <em>${dir}</em>`; voice = `Bear ${dir}`; }
        else if (a < 140) { icon = dir; text = `Turn <em>${dir}</em>`; voice = `Turn ${dir}`; }
        else { icon = dir; text = `Double back to your <em>${dir}</em>`; voice = `Turn ${dir} sharply`; }
        if (newStreet) { text += ` onto <em>${escapeHtml(newStreet)}</em>`; voice += ` onto ${newStreet}`; }
      }
      if (near) { text += ` at ${escapeHtml(near.name)}`; voice += ` at ${near.name}`; }
    }
    if (pass) {
      text += `, passing ${escapeHtml(pass.b.name)} on your <em>${pass.side}</em>`;
      voice += `, passing ${pass.b.name} on your ${pass.side}`;
    }
    steps.push({ icon, text, voice, m: lg.m, at: cum[lg.i1], i0: lg.i0, i1: lg.i1 });
  });
  /* which side of the final approach the destination sits on */
  let arriveSide = null;
  const lastLeg = merged[merged.length - 1];
  if (lastLeg) arriveSide = sideOf(pts[lastLeg.i0], pts[lastLeg.i1], to);
  steps.push({ icon: 'finish', m: 0, at: cum[cum.length-1],
    text: `Arrive at <em>${escapeHtml(to.name)}</em>` +
          (arriveSide ? `, on your <em>${arriveSide}</em>` : ''),
    voice: `You have arrived at ${to.name}` + (arriveSide ? `, on your ${arriveSide}` : ''),
    i0: pts.length-1, i1: pts.length-1 });
  return { steps, cum };
}

/* ---------- map ---------- */
const map = L.map('map', { zoomControl: false }).setView([-1.0955, 37.014], 16);
L.control.zoom({ position: 'bottomright' }).addTo(map);

const sat = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  { maxZoom: 21, maxNativeZoom: 19,
    attribution: 'Imagery &copy; Esri | Buildings &amp; paths &copy; OpenStreetMap contributors' });
const streets = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  { maxZoom: 21, maxNativeZoom: 19, attribution: '&copy; OpenStreetMap contributors' });
let satOn = true; sat.addTo(map);
document.getElementById('layerBtn').onclick = () => {
  satOn = !satOn;
  map.removeLayer(satOn ? streets : sat); (satOn ? sat : streets).addTo(map);
  document.getElementById('layerBtn').textContent = satOn ? 'Satellite' : 'Map';
  document.querySelectorAll('.bldTip,.stTip').forEach(e => e.classList.toggle('lite', !satOn));
};

L.polygon(D.campus.map(p => [p[1], p[0]]), { color: '#F0A57A', weight: 2, opacity: .5,
  dashArray: '9 7', fill: false, interactive: false }).addTo(map);

/* ---------- the walking network itself ---------- */
const pathLayer = L.layerGroup().addTo(map);
const stLabelLayer = L.layerGroup().addTo(map);
{
  const plain = [], named = [], byStreet = {};
  const seen = new Set();
  for (let u = 0; u < ADJ.length; u++) {
    for (const e of ADJ[u]) {
      const v = e[0];
      if (v < u) continue;
      const k = u + ':' + v;
      if (seen.has(k)) continue;
      seen.add(k);
      const seg = [[NODES[u][1], NODES[u][0]], [NODES[v][1], NODES[v][0]]];
      if (e[2] >= 0) {
        named.push(seg);
        (byStreet[e[2]] = byStreet[e[2]] || []).push({ seg, len: e[1] });
      } else plain.push(seg);
    }
  }
  // dark casing first so light paths read against pale ground
  L.polyline(plain.concat(named), { color: '#241708', weight: 5.5, opacity: .38,
    lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(pathLayer);
  L.polyline(plain, { color: '#FBEEDD', weight: 2, opacity: .7, dashArray: '5 4',
    lineCap: 'round', interactive: false }).addTo(pathLayer);
  L.polyline(named, { color: '#FFF6EA', weight: 3.4, opacity: .92,
    lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(pathLayer);

  // one label per street, on its longest run
  for (const idx in byStreet) {
    const name = (D.streets || [])[idx];
    if (!name) continue;
    const best = byStreet[idx].sort((a, b) => b.len - a.len)[0];
    const [a, b] = best.seg;
        let ang = Math.atan2(b[0] - a[0], b[1] - a[1]) * 180 / Math.PI;
    ang = -ang;
    if (ang > 90) ang -= 180; else if (ang < -90) ang += 180;
    const line = L.polyline(best.seg, { opacity: 0, weight: 1, interactive: false });
    line.bindTooltip(
      `<span style="display:inline-block;transform:rotate(${ang.toFixed(1)}deg)">${escapeHtml(name)}</span>`,
      { permanent: true, direction: 'center', className: 'stTip', opacity: 1 });
    line._mz = 17;
    line.addTo(stLabelLayer);
  }
}

const bLayer = L.layerGroup().addTo(map);
const shapeOf = {};
for (const b of B) {
  const POI_COLOR = { Gate: '#8FD1C0', Sport: '#9CC96B', Green: '#7FB77E', Food: '#F4C15D',
                      Shop: '#F4C15D', Health: '#F58B8B', Money: '#F4C15D', Venue: '#C7A8F2' };
  const isPoi = b.ring.length <= 2 && b.cat && b.cat !== 'Building';
  const shape = b.ring.length > 2
    ? L.polygon(b.ring.map(p => [p[1], p[0]]),
        { color: '#F2C9A8', weight: 1, opacity: .8, fillColor: '#E8A87C', fillOpacity: .16 })
    : L.circleMarker([b.lat, b.lon], isPoi
        ? { radius: 5, color: '#fff', weight: 1.6, fillColor: POI_COLOR[b.cat] || '#8FD1C0', fillOpacity: .95 }
        : { radius: 7, color: '#F2C9A8', weight: 2, fillColor: '#E8A87C', fillOpacity: .3 });
  shape.on('click', () => openBuilding(b));
  shape.addTo(bLayer); shapeOf[b.id] = shape;
  const a = b.area || 0;
  b._mz = a >= 1100 ? 15 : a >= 380 ? 16 : 17;     // big blocks read from campus view
  if (b.cat && b.cat !== 'Building') b._mz = 17;
  shape.bindTooltip(escapeHtml(b.name.split(' — ')[0]),
    { permanent: true, direction: 'center', className: 'bldTip', opacity: 1 });
}
/* Label placement: show the most significant name that fits, then drop any
   that would collide with one already placed — the way a printed map does it. */
const tipEl = layer => {
  const t = layer && layer.getTooltip();
  return t ? t.getElement() : null;
};
function syncLabels() {
  const z = map.getZoom();
  const pad = map.getSize();
  const view = { x: 0, y: 0, w: pad.x, h: pad.y };
  const placed = [];

  const hide = el => { if (el) el.style.display = 'none'; };
  const overlaps = box => placed.some(p =>
    !(box.x + box.w < p.x || p.x + p.w < box.x || box.y + box.h < p.y || p.y + p.h < box.y));

  const consider = (el, priority) => {
    if (!el) return;
    el.style.display = '';
    const r = el.getBoundingClientRect();
    if (!r.width) { hide(el); return; }
    const box = { x: r.x - 3, y: r.y - 2, w: r.width + 6, h: r.height + 4 };
    // off-screen labels cost nothing to skip
    if (box.x + box.w < view.x || box.x > view.w || box.y + box.h < view.y || box.y > view.h) {
      hide(el); return;
    }
    if (overlaps(box)) hide(el); else placed.push(box);
  };

  for (const b of B) hide(tipEl(shapeOf[b.id]));
  stLabelLayer.eachLayer(l => hide(tipEl(l)));

  // streets first — they anchor the reader's sense of the place
  if (z >= 17) stLabelLayer.eachLayer(l => consider(tipEl(l)));

  // then buildings, largest and most significant first
  const rank = b => (b.cat && b.cat !== 'Building' ? 0 : 1) * 1e7 + (b.area || 0);
  B.filter(b => z >= b._mz).sort((a, b) => rank(b) - rank(a))
   .forEach(b => consider(tipEl(shapeOf[b.id])));
}
map.on('zoomend moveend', syncLabels); setTimeout(syncLabels, 500);
const fixSize = () => map.invalidateSize({ animate: false });
addEventListener('resize', fixSize);
addEventListener('orientationchange', () => setTimeout(fixSize, 250));
setTimeout(fixSize, 120);

let routeLine = null, routeCase = null, mkA = null, mkB = null, meMarker = null, meAcc = null;
const pin = (t, c) => L.divIcon({ className: '',
  html: `<div class="mkPin" style="background:${c}">${t}</div>`, iconSize: [26,26], iconAnchor: [13,13] });

/* Leaflet caches the container size, and that cache can be stale or zero
   before layout settles — fitting against it lands you on a world view.
   Re-measure first, then keep padding well inside the real container. */
function fitRoute(bounds, tries) {
  map.invalidateSize({ animate: false });
  const s = map.getSize();
  if ((s.x < 120 || s.y < 120) && (tries || 0) < 25) {
    setTimeout(() => fitRoute(bounds, (tries || 0) + 1), 120);
    return;
  }
  const wide = s.x > 820;
  map.fitBounds(bounds, {
    paddingTopLeft: [Math.min(wide ? 400 : 24, s.x * 0.35), Math.min(130, s.y * 0.22)],
    paddingBottomRight: [Math.min(24, s.x * 0.08), Math.min(wide ? 36 : 230, s.y * 0.30)],
    maxZoom: 19
  });
}

function drawRoute(pts, from, to, fit) {
  [routeLine, routeCase, mkA, mkB].forEach(l => l && map.removeLayer(l));
  const path = pts.map(ll);
  routeCase = L.polyline(path, { color: '#3A1607', weight: 11, opacity: .55,
    lineCap: 'round', lineJoin: 'round' }).addTo(map);
  routeLine = L.polyline(path, { color: '#F2762E', weight: 6,
    lineCap: 'round', lineJoin: 'round' }).addTo(map);
  mkA = L.marker([from.lat, from.lon], { icon: pin('A', '#2E6A4C') }).addTo(map);
  mkB = L.marker([to.lat, to.lon], { icon: pin('B', '#C2521B') }).addTo(map);
  Object.values(shapeOf).forEach(s => s.setStyle && s.setStyle({ weight: 1, color: '#F2C9A8' }));
  if (shapeOf[to.id] && shapeOf[to.id].setStyle)
    shapeOf[to.id].setStyle({ weight: 3, color: '#F2762E', fillColor: '#F2762E', fillOpacity: .32 });
  if (fit !== false) fitRoute(routeLine.getBounds());
}

/* ---------- search ---------- */
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/* Room codes in these blocks encode their own floor: a three-digit code
   starts with the floor (CTC 207 -> 2nd), anything shorter is ground level
   (CTC 03). So we can resolve a code nobody has ever recorded. */
const CODE_PREFIX = ['CTC', 'ELB', 'HRD', 'NSC', 'CLB', 'NCLB', 'SCC', 'EMB'];
function prefixBuilding(pre) {
  const n = norm(pre);
  const hit = ROOMS.find(r => r.bid && norm(r.code).startsWith(n + ' '))
           || ROOMS.find(r => r.bid && norm(r.code) === n);
  return hit ? hit.bid : null;
}
function deriveRoom(q) {
  const m = norm(q).match(/^([a-z]{2,4})\s*(\d{1,3})([a-z])?$/);
  if (!m) return null;
  const pre = CODE_PREFIX.find(p => p.toLowerCase() === m[1]);
  if (!pre) return null;
  const bid = prefixBuilding(pre);
  if (!bid) return null;
  const num = m[2], suffix = (m[3] || '').toUpperCase();
  const code = `${pre} ${num}${suffix}`;
  if (ROOMS.some(r => norm(r.code) === norm(code))) return null;   // already known
  return { code, bid, floor: num.length === 3 ? +num[0] : 0,
           wing: '', hint: '', src: 'derived' };
}

function searchAll(q) {
  const n = norm(q); if (!n) return [];
  const nq = n.replace(/\s+/g, '');
  /* people type "ctc105" as often as "CTC 105" — spacing must not matter */
  const score = (hay) => {
    const sq = hay.replace(/\s+/g, '');
    let best = -1;
    for (const [h, needle] of [[hay, n], [sq, nq]]) {
      const t = h === needle ? 0 : h.startsWith(needle) ? 1 : h.includes(needle) ? 2 : -1;
      if (t >= 0 && (best < 0 || t < best)) best = t;
    }
    return best;
  };
  const out = [];
  for (const r of ROOMS) {
    const sc = score(norm(r.code));
    if (sc < 0) continue;
    out.push({ sc, kind: 'room', room: r, label: r.code, bld: r.bid ? bldById(r.bid) : null });
  }
  const derived = deriveRoom(q);
  if (derived) out.push({ sc: 0.2, kind: 'room', room: derived, label: derived.code,
                          bld: bldById(derived.bid) });
  for (const b of B) {
    let sc = -1;
    for (const h of [norm(b.name), ...(b.alias || []).map(norm)]) {
      const s = score(h);
      if (s >= 0 && (sc < 0 || s < sc)) sc = s;
    }
    if (sc < 0) continue;
    out.push({ sc: sc + .5, kind: 'bld', bld: b, label: b.name });
  }
  return out.sort((a, b) => a.sc - b.sc || a.label.length - b.label.length).slice(0, 9);
}
function wireSearch(inputId, boxId, onPick) {
  const inp = document.getElementById(inputId), box = document.getElementById(boxId);
  let items = [], cur = -1;
  const close = () => { box.hidden = true; cur = -1; };
  const render = () => {
    box.textContent = '';
    items.forEach((it, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'sitem'; b.setAttribute('aria-selected', i === cur);
      if (it.kind === 'room') {
        b.innerHTML = `<span class="code"></span><span class="nm"></span><span class="meta${it.bld?'':' unmapped'}"></span>`;
        b.querySelector('.code').textContent = it.room.code;
        b.querySelector('.nm').textContent = it.bld ? it.bld.name : 'location unknown';
        const fl = it.room.floor ? 'floor ' + it.room.floor : 'ground';
        b.querySelector('.meta').textContent = it.bld
          ? (it.room.src === 'derived' ? fl + ' ?' : fl) : 'unplaced';
      } else {
        b.innerHTML = `<span class="nm"></span><span class="meta"></span>`;
        b.querySelector('.nm').textContent = it.bld.name;
        b.querySelector('.meta').textContent = (it.bld.cat || 'Building').toLowerCase();
      }
      b.onclick = () => { close(); onPick(it); };
      box.append(b);
    });
    box.hidden = !items.length;
  };
  inp.addEventListener('input', () => { items = searchAll(inp.value); cur = -1; render(); });
  inp.addEventListener('focus', () => { if (inp.value) { items = searchAll(inp.value); render(); } });
  inp.addEventListener('keydown', e => {
    if (box.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); cur = Math.min(cur+1, items.length-1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cur = Math.max(cur-1, 0); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); const it = items[cur >= 0 ? cur : 0];
      if (it) { close(); onPick(it); } }
    else if (e.key === 'Escape') close();
  });
  document.addEventListener('click', e => { if (!box.contains(e.target) && e.target !== inp) close(); });
}

/* ---------- state ---------- */
let FROM = null, TO = null, ROUTE = null, STEPS = null, CUM = null;
const fromInp = document.getElementById('from'), toInp = document.getElementById('to');
const asPlace = b => ({ bld: b, id: b.id, lat: b.lat, lon: b.lon, x: b.x, y: b.y, name: b.name });

wireSearch('from', 'sFrom', it => {
  if (!it.bld) return toast('That room has no confirmed location yet.');
  FROM = asPlace(it.bld);
  fromInp.value = it.kind === 'room' ? `${it.room.code} (${it.bld.name})` : it.bld.name;
  route();
});
wireSearch('to', 'sTo', it => { setDestination(it); });

function setDestination(it) {
  if (it.kind === 'room') { TO = { bld: it.bld, room: it.room }; toInp.value = it.room.code; }
  else { TO = { bld: it.bld, room: null }; toInp.value = it.bld.name; }
  route();
}
document.getElementById('swapBtn').onclick = () => {
  if (!FROM || !TO || !TO.bld) return;
  const nf = asPlace(TO.bld), nt = { bld: FROM.bld, room: null };
  FROM = nf; TO = nt; fromInp.value = FROM.name; toInp.value = TO.bld.name; route();
};

/* ---------- geolocation & compass ---------- */
let watchId = null, lastFix = null, heading = null;
function showMe(lat, lon, acc) {
  if (!meMarker) {
    meMarker = L.marker([lat, lon], { interactive: false, zIndexOffset: 800,
      icon: L.divIcon({ className: '', iconSize: [26,26], iconAnchor: [13,13],
        html: '<div class="meWrap"><div class="meCone" id="meCone"></div><div class="meDot"></div></div>' })
    }).addTo(map);
    meAcc = L.circle([lat, lon], { radius: acc || 12, color: '#1F6FEB', weight: 1, opacity: .35,
      fillColor: '#1F6FEB', fillOpacity: .10, interactive: false }).addTo(map);
  } else { meMarker.setLatLng([lat, lon]); meAcc.setLatLng([lat, lon]).setRadius(acc || 12); }
  paintHeading();
}
function paintHeading() {
  const c = document.getElementById('meCone');
  if (!c) return;
  if (heading == null) { c.style.display = 'none'; return; }
  c.style.display = ''; c.style.transform = `rotate(${heading}deg)`;
}
function onOrient(e) {
  let h = null;
  if (e.webkitCompassHeading != null) h = e.webkitCompassHeading;
  else if (e.absolute && e.alpha != null) h = (360 - e.alpha) % 360;
  if (h == null || isNaN(h)) return;
  heading = h; paintHeading();
}
function initCompass() {
  const DOE = window.DeviceOrientationEvent;
  if (!DOE) return;
  if (typeof DOE.requestPermission === 'function') {
    DOE.requestPermission().then(r => {
      if (r === 'granted') addEventListener('deviceorientation', onOrient, true);
    }).catch(() => {});
  } else {
    addEventListener('deviceorientationabsolute', onOrient, true);
    addEventListener('deviceorientation', onOrient, true);
  }
}
function useFix(p, setFrom) {
  const lat = p.coords.latitude, lon = p.coords.longitude;
  lastFix = { lat, lon, acc: p.coords.accuracy, x: X(lon), y: Y(lat) };
  showMe(lat, lon, p.coords.accuracy);
  if (p.coords.heading != null && !isNaN(p.coords.heading) && p.coords.speed > 0.6)
    { heading = p.coords.heading; paintHeading(); }
  if (!setFrom) return;
  const near = nearestBuilding(lastFix.x, lastFix.y, 80);
  FROM = { bld: near, id: null, lat, lon, x: lastFix.x, y: lastFix.y,
    name: near ? `Near ${near.name}` : 'My location' };
  fromInp.value = FROM.name;
}
function locate(then) {
  if (!navigator.geolocation) { toast('This browser has no location access.'); then && then(false); return; }
  navigator.geolocation.getCurrentPosition(p => {
    useFix(p, true); then && then(true);
  }, err => {
    toast(err.code === 1 ? 'Location blocked — pick a starting building instead.'
                         : "Couldn't get a GPS fix — pick a starting building.");
    then && then(false);
  }, { enableHighAccuracy: true, timeout: 10000 });
}
document.getElementById('locBtn').onclick = () => {
  toast('Finding you…');
  locate(ok => { if (ok) { map.setView([lastFix.lat, lastFix.lon], 18); route(); } });
};

/* ---------- speech ---------- */
const synth = window.speechSynthesis;
let lastSpoken = '', voicePick = null;
function pickVoice() {
  if (!synth) return;
  const vs = synth.getVoices();
  voicePick = vs.find(v => /en-GB/i.test(v.lang)) || vs.find(v => /en[-_]/i.test(v.lang)) || vs[0] || null;
}
if (synth) { pickVoice(); synth.onvoiceschanged = pickVoice; }
function speak(text, force) {
  if (!PREFS.voice || !synth || !text) return;
  if (!force && text === lastSpoken) return;
  lastSpoken = text;
  try {
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.03; u.pitch = 1; u.volume = 1;
    if (voicePick) { u.voice = voicePick; u.lang = voicePick.lang; } else u.lang = 'en-GB';
    synth.speak(u);
  } catch (e) {}
}
const buzz = ms => { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) {} };

const voiceBtn = document.getElementById('voiceBtn');
function paintVoiceBtn() {
  voiceBtn.classList.toggle('off', !PREFS.voice);
  voiceBtn.title = PREFS.voice ? 'Spoken directions on' : 'Spoken directions off';
  voiceBtn.setAttribute('aria-pressed', String(PREFS.voice));
}
voiceBtn.onclick = () => {
  PREFS.voice = !PREFS.voice; save(LS_PREFS, PREFS); paintVoiceBtn();
  if (PREFS.voice) speak('Spoken directions on', true); else synth && synth.cancel();
};
paintVoiceBtn();

/* voice destination */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const micBtn = document.getElementById('micBtn');
if (!SR) micBtn.style.display = 'none';
micBtn.onclick = () => {
  if (!SR) return;
  const rec = new SR();
  rec.lang = 'en-KE'; rec.interimResults = false; rec.maxAlternatives = 3;
  micBtn.classList.add('live'); toast('Listening — say where you want to go');
  rec.onresult = ev => {
    const heard = ev.results[0][0].transcript || '';
    const q = heard.replace(/^(take|get|walk|guide|navigate|go|show)\s+(me\s+)?(to|the)?\s*/i, '')
                   .replace(/^(where\s+is|find)\s*/i, '').trim();
    const hits = searchAll(q);
    if (!hits.length) { toast(`Didn't find “${heard}”`); speak(`I could not find ${heard}`, true); return; }
    setDestination(hits[0]);
    speak(`Routing to ${hits[0].label}`, true);
  };
  rec.onerror = () => toast('Voice input failed — type it instead.');
  rec.onend = () => micBtn.classList.remove('live');
  try { rec.start(); } catch (e) { micBtn.classList.remove('live'); }
};

/* ---------- sheet render ---------- */
const ICONS = {
  start:'<path d="M12 20V6"/><path d="M6 11l6-6 6 6"/>',
  straight:'<path d="M12 19V6"/><path d="M7 11l5-5 5 5"/>',
  left:'<path d="M19 18H10a3 3 0 0 1-3-3V7"/><path d="M3 11l4-4 4 4"/>',
  right:'<path d="M5 18h9a3 3 0 0 0 3-3V7"/><path d="M13 11l4-4 4 4"/>',
  sleft:'<path d="M17 20v-6a4 4 0 0 0-4-4H7"/><path d="M11 6L7 10l4 4"/>',
  sright:'<path d="M7 20v-6a4 4 0 0 1 4-4h6"/><path d="M13 6l4 4-4 4"/>',
  finish:'<path d="M12 21s7-6.4 7-11a7 7 0 1 0-14 0c0 4.6 7 11 7 11z"/><circle cx="12" cy="10" r="2.4"/>'
};
const sheetBody = document.getElementById('sheetBody');
const floorWord = f => f === 0 ? 'ground floor' : f === 1 ? '1st floor'
  : f === 2 ? '2nd floor' : f === 3 ? '3rd floor' : f + 'th floor';
const fmtDist = m => m < 1000 ? `${Math.round(m/5)*5}<span> m</span>` : `${(m/1000).toFixed(2)}<span> km</span>`;

function indoorLine(room) {
  if (!room) return '';
  const bits = [floorWord(room.floor || 0)];
  if (room.wing) bits.push(room.wing);
  return bits.join(', ') + (room.hint ? '. ' + room.hint : '');
}

function route(fit) {
  if (!FROM || !TO) return renderIdle();
  if (!TO.bld) return renderUnplaced();
  const r = routeBetween(FROM, TO.bld);
  if (!r) { sheetBody.innerHTML = '<div class="empty"><h3>No route</h3><p>Those points aren\'t connected on the campus path network.</p></div>'; return; }
  ROUTE = r;
  const built = buildSteps(r.pts, r.segSt, FROM, TO.bld);
  STEPS = built.steps; CUM = built.cum;
  drawRoute(r.pts, FROM, TO.bld, fit);

  const secs = secsFor(r.meters);
  const arrive = new Date(Date.now() + secs * 1000);
  let h = `<div class="summary">
      <div class="dist">${fmtDist(r.meters)}</div>
      <div class="time">${humanTime(secs)}</div>
      <div class="eta">arrive ${clock(arrive)}</div>
      <div class="grow"></div>
      <button class="startBtn" id="startNav">Start</button>
    </div>
    <div class="dest"><div class="lbl">Destination</div>
      <div class="nm">${escapeHtml(TO.room ? TO.room.code : TO.bld.name)}</div>`;
  if (TO.room) h += `<div class="in">in ${escapeHtml(TO.bld.name)}</div>`;
  if (TO.room && (TO.room.wing || TO.room.hint))
    h += `<div class="hint">${escapeHtml(indoorLine(TO.room))}</div>`;
  else if (TO.room)
    h += `<div class="hint soft">${escapeHtml(floorWord(TO.room.floor || 0))} — exact door not recorded</div>`;
  h += `</div><ul class="steps">`;
  for (const s of STEPS) {
    h += `<li><span class="ico ${s.icon === 'finish' ? 'fin' : ''}">
      <svg viewBox="0 0 24 24">${ICONS[s.icon] || ICONS.straight}</svg></span>
      <span class="stxt"><span class="m">${s.text}</span>
      ${s.m > 4 ? `<span class="d">${Math.round(s.m)} m${secsFor(s.m) >= 60 ? ' · ' + humanTime(secsFor(s.m)) : ''}</span>` : ''}</span></li>`;
  }
  h += `</ul><div class="rowline">
      <button class="rowbtn" id="addBtn">Edit rooms</button>
      <button class="rowbtn" id="gmapsBtn">Open in Google Maps</button>
    </div>`;
  sheetBody.innerHTML = h;
  wireSheet();
}
function renderUnplaced() {
  [routeLine, routeCase, mkB].forEach(l => l && map.removeLayer(l));
  routeLine = routeCase = mkB = null; ROUTE = null;
  const c = TO.room.code;
  sheetBody.innerHTML = `<div class="notice"><b>${escapeHtml(c)} — location not confirmed.</b>
      This room appears on JKUAT's own exam timetables, but no public source records which
      building it sits in, so JWAY won't guess and send you the wrong way.
      <br><button data-edit="${escapeHtml(c)}">Set where ${escapeHtml(c)} is</button></div>
    <div class="rowline"><button class="rowbtn" id="addBtn">Edit rooms</button></div>`;
  wireSheet();
}
function renderIdle() {
  sheetBody.innerHTML = `<div class="empty">
      <h3>Where are you headed?</h3>
      <p>Say it, type it, or tap a building. JWAY talks you there so you can keep your head up.</p>
      <ul><li>Rooms: <code>ELB 212</code>, <code>HRD 205</code>, <code>NSC</code></li>
      <li>Buildings: <code>EMB</code>, <code>library</code>, <code>hall 4</code></li></ul></div>
    <div class="rowline"><button class="rowbtn" id="addBtn">Edit rooms</button></div>`;
  wireSheet();
}
function wireSheet() {
  const a = document.getElementById('addBtn'); if (a) a.onclick = () => openDialog(null);
  const g = document.getElementById('gmapsBtn');
  if (g) g.onclick = () => open(`https://www.google.com/maps/dir/?api=1&origin=${FROM.lat},${FROM.lon}` +
    `&destination=${TO.bld.lat},${TO.bld.lon}&travelmode=walking`, '_blank');
  const s = document.getElementById('startNav'); if (s) s.onclick = startNav;
  sheetBody.querySelectorAll('[data-edit]').forEach(b =>
    b.onclick = () => openDialog(b.getAttribute('data-edit')));
}

function openBuilding(b) {
  const rooms = ROOMS.filter(r => r.bid === b.id);
  L.popup({ closeButton: false, offset: [0,-4] }).setLatLng([b.lat, b.lon]).setContent(
    `<div class="popT">${escapeHtml(b.name)}</div>
     ${rooms.length ? `<div class="popR">Rooms: ${rooms.slice(0,6).map(r=>escapeHtml(r.code)).join(', ')}</div>` : ''}
     <div class="popB"><button id="pbFrom">Start here</button><button id="pbTo">Go here</button></div>`
  ).openOn(map);
  setTimeout(() => {
    const f = document.getElementById('pbFrom'), t = document.getElementById('pbTo');
    if (f) f.onclick = () => { FROM = asPlace(b); fromInp.value = b.name; map.closePopup(); route(); };
    if (t) t.onclick = () => { TO = { bld: b, room: null }; toInp.value = b.name; map.closePopup(); route(); };
  }, 20);
}

/* ---------- live navigation ---------- */
const navBar = document.getElementById('navBar');
let navOn = false, followMe = true, spoken = {}, lastOffAnnounce = 0, arrived = false;

function startNav() {
  if (!ROUTE) return;
  if (!navigator.geolocation) return toast('This device has no GPS.');
  navOn = true; followMe = true; spoken = {}; arrived = false;
  navBar.hidden = false;
  document.getElementById('searchCard').classList.add('hidden');
  document.getElementById('sheet').classList.add('mini');
  initCompass();                                  // gesture-gated on iOS — we're inside a click
  const first = STEPS[0];
  speak(`Starting. ${first.voice}. ${Math.round(ROUTE.meters)} metres, about ${humanTime(secsFor(ROUTE.meters))}.`, true);
  watchId = navigator.geolocation.watchPosition(p => {
    useFix(p, false); updateNav();
    if (followMe) map.setView([p.coords.latitude, p.coords.longitude],
      Math.max(map.getZoom(), 18), { animate: true });
  }, err => {
    toast(err.code === 1 ? 'Location blocked — navigation needs GPS.' : 'Lost GPS signal.');
  }, { enableHighAccuracy: true, maximumAge: 1200, timeout: 15000 });
  updateNav();
}
function stopNav() {
  navOn = false; navBar.hidden = true;
  document.getElementById('searchCard').classList.remove('hidden');
  document.getElementById('sheet').classList.remove('mini');
  if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  synth && synth.cancel();
}
document.getElementById('navExit').onclick = stopNav;
document.getElementById('recenter').onclick = () => {
  followMe = true; if (lastFix) map.setView([lastFix.lat, lastFix.lon], 18);
};
map.on('dragstart', () => { if (navOn) followMe = false; });

function snapToRoute(x, y) {
  const p = ROUTE.pts;
  let best = { d: Infinity, along: 0, seg: 0 };
  for (let i = 0; i < p.length - 1; i++) {
    const ax = p[i][0], ay = p[i][1], dx = p[i+1][0]-ax, dy = p[i+1][1]-ay;
    const L2 = dx*dx + dy*dy;
    let t = L2 ? ((x-ax)*dx + (y-ay)*dy) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(x - (ax + t*dx), y - (ay + t*dy));
    if (d < best.d) best = { d, along: CUM[i] + t * Math.sqrt(L2), seg: i };
  }
  return best;
}

function updateNav() {
  if (!navOn || !ROUTE || !STEPS) return;
  const dEl = document.getElementById('navDist'), iEl = document.getElementById('navInstr'),
        rEl = document.getElementById('navRemain'), eEl = document.getElementById('navEta'),
        svg = document.getElementById('navIcoSvg'), sub = document.getElementById('navSub');
  if (!lastFix) {
    dEl.textContent = 'GPS'; iEl.textContent = 'Waiting for a fix…';
    svg.innerHTML = ICONS.straight; rEl.textContent = '—'; eEl.textContent = '—';
    navBar.classList.add('pending'); return;
  }
  navBar.classList.remove('pending');
  const snap = snapToRoute(lastFix.x, lastFix.y);
  const total = ROUTE.meters, remaining = Math.max(0, total - snap.along);

  /* arrival */
  if (remaining < 16) {
    if (!arrived) {
      arrived = true; buzz([120, 60, 120]);
      const indoor = TO.room ? ` Your room is on the ${indoorLine(TO.room)}` : '';
      speak(`You have arrived at ${TO.bld.name}.${indoor}`, true);
    }
    dEl.textContent = 'Arrived';
    iEl.textContent = TO.room ? `${TO.room.code} — ${indoorLine(TO.room)}` : TO.bld.name;
    svg.innerHTML = ICONS.finish;
    sub.textContent = TO.room && !TO.room.wing ? 'Exact door not recorded' : '';
    rEl.textContent = '0 m left'; eEl.textContent = 'here';
    return;
  }
  arrived = false;

  /* off route */
  if (snap.d > 45) {
    dEl.textContent = `${Math.round(snap.d)} m off`;
    iEl.textContent = 'Head back to the orange line';
    svg.innerHTML = ICONS.straight;
    sub.textContent = '';
    const now = Date.now();
    if (now - lastOffAnnounce > 20000) {
      lastOffAnnounce = now; buzz(300);
      speak('You are off the route. Head back to the path.', true);
    }
    rEl.textContent = remaining < 1000 ? `${Math.round(remaining/5)*5} m left` : `${(remaining/1000).toFixed(2)} km left`;
    eEl.textContent = clock(new Date(Date.now() + secsFor(remaining) * 1000));
    return;
  }

  /* which turn is next */
  let idx = STEPS.findIndex(s => s.at > snap.along + 1);
  if (idx < 0) idx = STEPS.length - 1;
  const cur = STEPS[idx];
  const next = STEPS[Math.min(idx + 1, STEPS.length - 1)];
  const toTurn = Math.max(0, cur.at - snap.along);
  const instr = (idx === 0 && toTurn > 5) ? STEPS[0] : next;

  dEl.textContent = toTurn < 12 ? 'Now' : `${Math.round(toTurn / 5) * 5} m`;
  iEl.textContent = instr.voice;
  svg.innerHTML = ICONS[instr.icon] || ICONS.straight;

  /* facing the wrong way? only worth saying at the very start */
  let facing = '';
  if (heading != null && snap.along < 25) {
    const legBear = bearing(ROUTE.pts[0][0], ROUTE.pts[0][1], ROUTE.pts[1][0], ROUTE.pts[1][1]);
    const off = Math.abs(angDiff(heading, legBear));
    if (off > 115) {
      facing = 'You are facing the wrong way — turn around';
      if (!spoken.turnaround) { spoken.turnaround = true; buzz(200); speak('Turn around.', true); }
    } else if (off > 60) facing = `Face ${compass(legBear)}`;
  }
  sub.textContent = facing;

  /* spoken cues, once each per step */
  const key = idx + ':' + instr.icon;
  if (instr.icon !== 'finish' || toTurn < 60) {
    if (toTurn <= 150 && toTurn > 60 && !spoken[key + ':far'] && cur.m > 120) {
      spoken[key + ':far'] = 1; speak(`In ${Math.round(toTurn / 10) * 10} metres, ${instr.voice}`);
    }
    if (toTurn <= 45 && toTurn > 14 && !spoken[key + ':near']) {
      spoken[key + ':near'] = 1; speak(`In ${Math.round(toTurn / 5) * 5} metres, ${instr.voice}`);
    }
    if (toTurn <= 14 && !spoken[key + ':now']) {
      spoken[key + ':now'] = 1; buzz(150); speak(instr.voice + ' now');
    }
  }

  rEl.textContent = remaining < 1000 ? `${Math.round(remaining/5)*5} m left` : `${(remaining/1000).toFixed(2)} km left`;
  eEl.textContent = clock(new Date(Date.now() + secsFor(remaining) * 1000));
}

/* ---------- room editor ---------- */
const dlg = document.getElementById('dlg');
const fCode = document.getElementById('fCode'), fBld = document.getElementById('fBld'),
      fFloor = document.getElementById('fFloor'), fWing = document.getElementById('fWing'),
      fHint = document.getElementById('fHint');
fBld.innerHTML = ['<option value="">— unknown —</option>'].concat(
  B.slice().sort((a,b) => a.name.localeCompare(b.name))
   .map(b => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.name)}</option>`)).join('');
let editing = null;
function openDialog(code) {
  editing = code ? findRoom(code) : null;
  document.getElementById('dlgTitle').textContent = editing ? `Where is ${editing.code}?` : 'Add or correct a room';
  fCode.value = editing ? editing.code : '';
  fBld.value = editing && editing.bid ? editing.bid : (TO && TO.bld ? TO.bld.id : '');
  fFloor.value = String(editing ? (editing.floor || 0) : 0);
  fWing.value = editing ? (editing.wing || '') : '';
  fHint.value = editing ? (editing.hint || '') : '';
  dlg.showModal();
  setTimeout(() => (editing ? fBld : fCode).focus(), 40);
}
dlg.addEventListener('close', () => {
  if (dlg.returnValue !== 'save') return;
  const code = fCode.value.trim(); if (!code) return;
  const rec = { code, bid: fBld.value || null, floor: Number(fFloor.value),
    wing: fWing.value, hint: fHint.value.trim(), src: 'user' };
  const i = ROOMS.findIndex(r => norm(r.code) === norm(code));
  if (i >= 0) ROOMS[i] = rec; else ROOMS.push(rec);
  save(LS_ROOMS, ROOMS);
  const b = rec.bid ? bldById(rec.bid) : null;
  TO = { bld: b, room: rec }; toInp.value = rec.code;
  toast(b ? `${code} set in ${b.name}.` : `${code} saved without a building.`);
  route();
});

/* ---------- toast ---------- */
let tT;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(tT); tT = setTimeout(() => (t.hidden = true), 3600);
}

/* the directions sheet starts collapsed on narrow screens; the grab
   handle (or the summary row) opens it */
const sheetEl = document.getElementById('sheet');
const grabEl = document.querySelector('.grab');
function syncPeek() {
  if (innerWidth <= 820) sheetEl.classList.add('peek');
  else sheetEl.classList.remove('peek');
}
syncPeek();
addEventListener('resize', syncPeek);
if (grabEl) grabEl.onclick = () => sheetEl.classList.toggle('peek');
sheetBody.addEventListener('click', e => {
  if (sheetEl.classList.contains('peek') && e.target.closest('.summary, .dest')
      && !e.target.closest('button')) sheetEl.classList.remove('peek');
});

/* ---------- boot ---------- */
TO = { bld: byName('NSC — New Science Complex'), room: null };
toInp.value = TO.bld.name;
FROM = asPlace(byName('Hall 4'));
fromInp.value = FROM.name;
route();

/* swap the placeholder start for wherever you actually are */
locate(ok => { if (ok) route(); });

/* one last fit once the map reports ready, in case boot raced the layout */
map.whenReady(() => { fixSize(); if (routeLine) fitRoute(routeLine.getBounds()); });
