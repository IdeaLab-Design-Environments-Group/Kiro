/**
 * Old-West clapboard CHURCH → public/examples/church.stl, a KIRIGAMIZABLE solid in the Western-town
 * family (unit scale, ASCII STL, z-up). Modelled on the photo: a steep-gable NAVE with a square
 * central BELL TOWER and a STEEPLE on top.
 *
 * KIRIGAMI CONSTRAINT → the body must be a closed genus-0 orientable 2-manifold whose surface is
 * DEVELOPABLE *and that the kirigami can actually FOLD FROM FLAT* (the folded pose must be a free
 * equilibrium). Two shapes break the fold even though they're valid solids, found by running the
 * pipeline's verify on variants:
 *   • a free-standing rooftop tower leaves a horizontal ROOF SHELF around its base → the pattern is
 *     multistable and settles into a different isometric shape (does NOT fold from flat).
 *   • a 4-sided PYRAMID steeple apex is a cone point that also won't free-fold.
 * What DOES fold: a SILHOUETTE-PRISM church — the front outline (gable + central tower + steeple)
 * extruded straight back — with the tower spanning the FULL depth (no shelf) and a GABLED/ridge
 * steeple (no pyramid apex). A parameter sweep (run via `_churchvariants.ts`) showed a SQUARE tower
 * footprint does NOT free-fold (it goes to a wrong isometric branch) — the tower must be NARROWER in
 * width than the nave is deep, so the foldable bell tower is a deep, slightly rectangular central
 * tower (0.3 wide × 0.5 deep). Verified: `kirigamizeMesh` → folds from flat, d_H ≈ 0.
 *
 * Run:  node scripts/gen-church.mjs
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ---- dimensions (unit scale, z-up; these PROPORTIONS are verified to fold from flat) -------------
const W = 1.0, D = 0.5;            // nave width (x) and depth (y)
const WT = 0.3;                    // central tower width (must be < D for the pattern to free-fold)
const TX0 = (W - WT) / 2, TX1 = (W + WT) / 2; // tower x-span (centred)
const HE = 0.58, HR = 0.86;        // nave eave + ridge (steep gable)
const HT = 1.35, HS = 1.8;         // tower top + steeple apex
const rz = (x) => HR - (HR - HE) * Math.abs(x - W / 2) / (W / 2); // nave roofline height

// Front outline (XZ): nave gable, a square tower rising from the ridge, a steep gabled steeple.
const SIL = [
  [0, 0], [W, 0], [W, HE],
  [TX1, rz(TX1)], [TX1, HT], [W / 2, HS], [TX0, HT], [TX0, rz(TX0)],
  [0, HE],
];

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const tris = [];
const addTri = (a, b, c) => { if (Math.hypot(...cross(sub(b, a), sub(c, a))) > 1e-9) tris.push([a, b, c]); };
const quad = (a, b, c, d) => { addTri(a, b, c); addTri(a, c, d); };
function earClip(poly) {
  const n = poly.length, idx = [...Array(n).keys()], out = [];
  const ar = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
  let A = 0; for (let i = 0; i < n; i++) { const j = (i + 1) % n; A += poly[i][0] * poly[j][1] - poly[j][0] * poly[i][1]; }
  if (A < 0) idx.reverse();
  const inT = (p, a, b, c) => { const d1 = ar(a, b, p), d2 = ar(b, c, p), d3 = ar(c, a, p); return !(((d1 < 0) || (d2 < 0) || (d3 < 0)) && ((d1 > 0) || (d2 > 0) || (d3 > 0))); };
  let g = 0;
  while (idx.length > 3 && g++ < 3000) {
    let cut = false;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i - 1 + idx.length) % idx.length], b = idx[i], c = idx[(i + 1) % idx.length];
      if (ar(poly[a], poly[b], poly[c]) <= 1e-12) continue;
      let ok = true;
      for (const k of idx) if (k !== a && k !== b && k !== c && inT(poly[k], poly[a], poly[b], poly[c])) { ok = false; break; }
      if (ok) { out.push([a, b, c]); idx.splice(i, 1); cut = true; break; }
    }
    if (!cut) break;
  }
  if (idx.length === 3) out.push([idx[0], idx[1], idx[2]]);
  return out;
}

/** Globally consistent OUTWARD winding (per-face heuristics fail on non-convex massings). */
function orientOutward(rawTris) {
  const key = (p) => p.map((v) => Math.round(v * 1e5)).join(",");
  const vm = new Map(), V = [];
  const vid = (p) => { const k = key(p); let i = vm.get(k); if (i === undefined) { i = V.length; vm.set(k, i); V.push(p); } return i; };
  const F = rawTris.map((t) => t.map(vid));
  const adj = new Map();
  F.forEach((f, fi) => { for (let e = 0; e < 3; e++) { const a = f[e], b = f[(e + 1) % 3], k = a < b ? `${a}_${b}` : `${b}_${a}`; (adj.get(k) ?? adj.set(k, []).get(k)).push(fi); } });
  const flip = (fi) => { const f = F[fi]; [f[1], f[2]] = [f[2], f[1]]; };
  const seen = new Array(F.length).fill(false), st = [0]; seen[0] = true;
  while (st.length) {
    const fi = st.pop(), f = F[fi];
    for (let e = 0; e < 3; e++) {
      const a = f[e], b = f[(e + 1) % 3], k = a < b ? `${a}_${b}` : `${b}_${a}`;
      const nb = (adj.get(k) || []).find((g) => g !== fi);
      if (nb === undefined || seen[nb]) continue;
      const g = F[nb]; let sd = false;
      for (let e2 = 0; e2 < 3; e2++) if (g[e2] === a && g[(e2 + 1) % 3] === b) sd = true;
      if (sd) flip(nb); seen[nb] = true; st.push(nb);
    }
  }
  let vol = 0;
  for (const f of F) { const a = V[f[0]], b = V[f[1]], c = V[f[2]]; vol += (a[0] * (b[1] * c[2] - c[1] * b[2]) - a[1] * (b[0] * c[2] - c[0] * b[2]) + a[2] * (b[0] * c[1] - c[0] * b[1])) / 6; }
  if (vol < 0) F.forEach((_, fi) => flip(fi));
  return F.map((f) => [V[f[0]], V[f[1]], V[f[2]]]);
}

// ---- build the prism: front cap, back cap, one wall per outline edge -----------------------------
for (const y of [0, D]) for (const [a, b, c] of earClip(SIL)) addTri([SIL[a][0], y, SIL[a][1]], [SIL[b][0], y, SIL[b][1]], [SIL[c][0], y, SIL[c][1]]);
for (let i = 0; i < SIL.length; i++) {
  const [x0, z0] = SIL[i], [x1, z1] = SIL[(i + 1) % SIL.length];
  quad([x0, 0, z0], [x1, 0, z1], [x1, D, z1], [x0, D, z0]);
}

// ---- write ASCII STL (globally-consistent outward normals) --------------------------------------
const oriented = orientOutward(tris);
const out = ["solid church"];
for (const [a, b, c] of oriented) {
  let n = cross(sub(b, a), sub(c, a));
  const l = Math.hypot(...n) || 1; n = [n[0] / l, n[1] / l, n[2] / l];
  out.push(`facet normal ${n[0]} ${n[1]} ${n[2]}`, "outer loop",
    `vertex ${a[0]} ${a[1]} ${a[2]}`, `vertex ${b[0]} ${b[1]} ${b[2]}`, `vertex ${c[0]} ${c[1]} ${c[2]}`,
    "endloop", "endfacet");
}
out.push("endsolid church");
writeFileSync(resolve(import.meta.dirname, "..", "public/examples/church.stl"), out.join("\n") + "\n");
console.log(`church.stl: ${oriented.length} facets — gable nave + central bell tower & gabled steeple (folds from flat)`);
