/**
 * Old-West false-front GENERAL STORE → public/examples/general-store.stl, a kirigamizable low-poly
 * solid in the same family as house.stl / barn.stl / hotel.stl (unit scale, ASCII STL, z-up, open
 * bottom shell). The signature of a boomtown general store is the **ARCHED false front**: the front
 * wall rises into a curved parapet (a segmental arch) above the storefront, the "GENERAL STORE" sign
 * board. Behind it sits a lower flat roof; a central DOOR is a boundary notch in the storefront.
 *
 * Build: the parapet top is an arch a(x) (cosine bump, shoulder SH at the two ends → peak PK at
 * centre), so the front facade + the parapet's back face + the top ribbon are built on an x-grid
 * (N+1 stations) to carry the curve; the roof, back wall and the two ear-clipped end walls are flat.
 * a(0)=a(W)=SH, so the arch springs cleanly from the end walls (no seam). Open bottom, like the others.
 *
 * Run:  node scripts/gen-general-store.mjs
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ---- dimensions (unit scale) --------------------------------------------------------------------
const W = 1.5;   // width (x)
const D = 1.2;   // depth (y); front wall y=0, back wall y=D
const HE = 0.95; // eave / flat-roof height behind the false front
const SH = 1.25; // parapet shoulder height (the arch springs from here at the two ends)
const PK = 1.6;  // parapet arch peak height (centre)
const PT = 0.12; // parapet thickness (front strip depth that rises above the roof)
const DOOR = { x0: 0.6, x1: 0.92, z: 0.58 }; // central door: notch in the storefront's bottom edge
const N = 8;     // arch segments across the width

const xs = Array.from({ length: N + 1 }, (_v, i) => (i * W) / N);
const arch = (x) => SH + (PK - SH) * (0.5 - 0.5 * Math.cos((2 * Math.PI * x) / W)); // SH at ends, PK at centre
const A = xs.map(arch);

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const CENTER = [W / 2, D / 2, HE / 2];
const tris = [];
function addTri(a, b, c) {
  const n = cross(sub(b, a), sub(c, a));
  if (Math.hypot(...n) < 1e-12) return;
  const m = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
  tris.push(dot(n, sub(m, CENTER)) >= 0 ? [a, b, c] : [a, c, b]); // wind so the normal points outward
}
const quad = (a, b, c, d) => { addTri(a, b, c); addTri(a, c, d); };

// ---- ear clipping for the two end-wall profiles (re-used from the barn/hotel generators) ---------
function earClip(poly) {
  const n = poly.length, idx = [...Array(n).keys()], out = [];
  const ar = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
  let S = 0; for (let i = 0; i < n; i++) { const j = (i + 1) % n; S += poly[i][0] * poly[j][1] - poly[j][0] * poly[i][1]; }
  if (S < 0) idx.reverse();
  const inT = (p, a, b, c) => { const d1 = ar(a, b, p), d2 = ar(b, c, p), d3 = ar(c, a, p); return !(((d1 < 0) || (d2 < 0) || (d3 < 0)) && ((d1 > 0) || (d2 > 0) || (d3 > 0))); };
  let g = 0;
  while (idx.length > 3 && g++ < 4000) {
    let cut = false;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i - 1 + idx.length) % idx.length], b = idx[i], c = idx[(i + 1) % idx.length];
      if (ar(poly[a], poly[b], poly[c]) <= 1e-12) continue;
      let ear = true;
      for (const k of idx) if (k !== a && k !== b && k !== c && inT(poly[k], poly[a], poly[b], poly[c])) { ear = false; break; }
      if (ear) { out.push([a, b, c]); idx.splice(i, 1); cut = true; break; }
    }
    if (!cut) break;
  }
  if (idx.length === 3) out.push([idx[0], idx[1], idx[2]]);
  return out;
}

// ---- FRONT FACADE (y = 0): storefront with a door notch, topped by the arch (x-z polygon) --------
const facade = [[0, 0], [DOOR.x0, 0], [DOOR.x0, DOOR.z], [DOOR.x1, DOOR.z], [DOOR.x1, 0], [W, 0]];
for (let i = N; i >= 0; i--) facade.push([xs[i], A[i]]); // right side (W,0)→(W,SH), arch over, down to (0,SH)
for (const [a, b, c] of earClip(facade)) {
  const P = (k) => [facade[k][0], 0, facade[k][1]];
  addTri(P(a), P(b), P(c));
}

// ---- PARAPET BACK (y = PT): the false front's rear face, from the roof up to the arch -----------
const pback = [[0, HE], [W, HE]];
for (let i = N; i >= 0; i--) pback.push([xs[i], A[i]]);
for (const [a, b, c] of earClip(pback)) {
  const P = (k) => [pback[k][0], PT, pback[k][1]];
  addTri(P(a), P(b), P(c));
}

// ---- PARAPET TOP ribbon (z = a(x), y 0..PT): the arched cap connecting facade-top to pback-top ---
for (let i = 0; i < N; i++) {
  quad([xs[i], 0, A[i]], [xs[i + 1], 0, A[i + 1]], [xs[i + 1], PT, A[i + 1]], [xs[i], PT, A[i]]);
}

// ---- ROOF (z = HE, y PT..D), BACK WALL (y = D) --------------------------------------------------
quad([0, PT, HE], [W, PT, HE], [W, D, HE], [0, D, HE]);
quad([0, D, 0], [W, D, 0], [W, D, HE], [0, D, HE]);

// ---- END WALLS (x = 0 and x = W): the side silhouette (open floor) ------------------------------
const sideProfile = [[0, 0], [0, SH], [PT, SH], [PT, HE], [D, HE], [D, 0]]; // (y,z); floor edge open
const sideTris = earClip(sideProfile);
for (const x of [0, W]) for (const [a, b, c] of sideTris) {
  const P = (k) => [x, sideProfile[k][0], sideProfile[k][1]];
  addTri(P(a), P(b), P(c));
}

// ---- write ASCII STL ---------------------------------------------------------------------------
const out = ["solid general_store"];
for (const [a, b, c] of tris) {
  let n = cross(sub(b, a), sub(c, a));
  const l = Math.hypot(...n) || 1; n = [n[0] / l, n[1] / l, n[2] / l];
  out.push(`facet normal ${n[0]} ${n[1]} ${n[2]}`, "outer loop",
    `vertex ${a[0]} ${a[1]} ${a[2]}`, `vertex ${b[0]} ${b[1]} ${b[2]}`, `vertex ${c[0]} ${c[1]} ${c[2]}`,
    "endloop", "endfacet");
}
out.push("endsolid general_store");
const path = resolve(import.meta.dirname, "..", "public/examples/general-store.stl");
writeFileSync(path, out.join("\n") + "\n");
console.log(`general-store.stl: ${tris.length} facets → ${path}`);
console.log(`  arched false front ${W}×${D}, eave ${HE}, shoulder ${SH} → arch peak ${PK}; central door`);
