/**
 * Old-West clapboard CHURCH → public/examples/church.stl, a KIRIGAMIZABLE solid in the Western-town
 * family (unit scale, ASCII STL, z-up). A steep-gable chapel with a pointed (Gothic) front door.
 *
 * IMPORTANT — kirigami needs a DEVELOPABLE surface. A roof-top cupola/spire (the photo's belfry) is
 * NOT developable: where its walls meet the ridge the patch can't flatten, so the unfold fails
 * ("developability audit failed … patch is not developable"). So the foldable church drops the cupola
 * and keeps the developable parts (gable nave + Gothic door). The 3D belfry is available as a separate
 * DISPLAY model (set CUPOLA=1) but that one will NOT kirigamize.
 *
 * Run:  node scripts/gen-church.mjs        (foldable chapel)
 *       CUPOLA=1 node scripts/gen-church.mjs  (display church with the 3D belfry — not foldable)
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const W = 1.0, D = 1.5, HE = 0.85, HR = 1.45;        // nave: width, depth, eave, ridge (steep gable)
const DOOR = { x0: 0.39, x1: 0.61, spring: 0.46, peak: 0.7 }; // tall pointed (Gothic) front door
const CUPOLA = !!process.env.CUPOLA;                 // display-only 3D belfry (does NOT kirigamize)
const CB = { r: 0.2, ya: 0.22, yb: 0.62, hb: 1.7, apex: 1.9 }; // cupola box + low pyramid cap
const roofZ = (x) => HR - (HR - HE) * Math.abs(x - W / 2) / (W / 2);

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const CENTER = [W / 2, D / 2, HR / 2];
const tris = [];
function addTri(a, b, c, ref = CENTER) {
  const n = cross(sub(b, a), sub(c, a));
  if (Math.hypot(...n) < 1e-9) return;
  const m = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
  tris.push(dot(n, sub(m, ref)) >= 0 ? [a, b, c] : [a, c, b]);
}
const quad = (a, b, c, d, ref) => { addTri(a, b, c, ref); addTri(a, c, d, ref); };
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
      let ear = true;
      for (const k of idx) if (k !== a && k !== b && k !== c && inT(poly[k], poly[a], poly[b], poly[c])) { ear = false; break; }
      if (ear) { out.push([a, b, c]); idx.splice(i, 1); cut = true; break; }
    }
    if (!cut) break;
  }
  if (idx.length === 3) out.push([idx[0], idx[1], idx[2]]);
  return out;
}
const gXZ = (poly, y, ref) => { for (const [a, b, c] of earClip(poly)) addTri([poly[a][0], y, poly[a][1]], [poly[b][0], y, poly[b][1]], [poly[c][0], y, poly[c][1]], ref); };

// ridge verts on the gables only when the cupola needs them (keep the foldable gable simple otherwise)
const ridge = CUPOLA ? [[W, HE], [W / 2 + CB.r, roofZ(W / 2 + CB.r)], [W / 2, HR], [W / 2 - CB.r, roofZ(W / 2 - CB.r)], [0, HE]]
  : [[W, HE], [W / 2, HR], [0, HE]];

// ---- front gable (Gothic door) + back gable -----------------------------------------------------
const { x0, x1, spring, peak } = DOOR;
gXZ([[0, 0], [x0, 0], [x0, spring], [(x0 + x1) / 2, peak], [x1, spring], [x1, 0], [W, 0], ...ridge], 0, CENTER);
gXZ([[0, 0], [W, 0], ...ridge], D, [W / 2, D + 10, HR / 2]);

// ---- side walls + roof slopes -------------------------------------------------------------------
quad([0, 0, 0], [0, D, 0], [0, D, HE], [0, 0, HE], [-10, D / 2, HE / 2]);   // left wall
quad([W, 0, 0], [W, D, 0], [W, D, HE], [W, 0, HE], [W + 10, D / 2, HE / 2]); // right wall
if (!CUPOLA) {
  quad([0, 0, HE], [W / 2, 0, HR], [W / 2, D, HR], [0, D, HE], CENTER);     // left roof slope
  quad([W / 2, 0, HR], [W, 0, HE], [W, D, HE], [W / 2, D, HR], CENTER);     // right roof slope
} else {
  // roof with a hole for the cupola + a stitched box + low pyramid cap (DISPLAY only — not developable)
  const { r, ya, yb, hb, apex } = CB, RZ = roofZ(W / 2 - r), P = (x, y) => [x, y, roofZ(x)];
  const rq = (x0, x1, y0, y1) => quad(P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1), CENTER);
  rq(0, W / 2 - r, 0, ya); rq(0, W / 2 - r, ya, yb); rq(0, W / 2 - r, yb, D); rq(W / 2 - r, W / 2, 0, ya); rq(W / 2 - r, W / 2, yb, D);
  rq(W / 2 + r, W, 0, ya); rq(W / 2 + r, W, ya, yb); rq(W / 2 + r, W, yb, D); rq(W / 2, W / 2 + r, 0, ya); rq(W / 2, W / 2 + r, yb, D);
  const cR = [W / 2, (ya + yb) / 2, (HR + hb) / 2];
  quad([W / 2 - r, ya, RZ], [W / 2 - r, yb, RZ], [W / 2 - r, yb, hb], [W / 2 - r, ya, hb], cR);
  quad([W / 2 + r, ya, RZ], [W / 2 + r, yb, RZ], [W / 2 + r, yb, hb], [W / 2 + r, ya, hb], cR);
  const fp = [[W / 2 - r, RZ], [W / 2, HR], [W / 2 + r, RZ], [W / 2 + r, hb], [W / 2 - r, hb]];
  gXZ(fp, ya, cR); gXZ(fp, yb, cR);
  const tp = [[W / 2 - r, ya, hb], [W / 2 + r, ya, hb], [W / 2 + r, yb, hb], [W / 2 - r, yb, hb]], tip = [W / 2, (ya + yb) / 2, apex];
  for (let i = 0; i < 4; i++) addTri(tp[i], tp[(i + 1) % 4], tip, [W / 2, (ya + yb) / 2, HR]);
}

// ---- write ASCII STL ----------------------------------------------------------------------------
const out = ["solid church"];
for (const [a, b, c] of tris) {
  let n = cross(sub(b, a), sub(c, a));
  const l = Math.hypot(...n) || 1; n = [n[0] / l, n[1] / l, n[2] / l];
  out.push(`facet normal ${n[0]} ${n[1]} ${n[2]}`, "outer loop",
    `vertex ${a[0]} ${a[1]} ${a[2]}`, `vertex ${b[0]} ${b[1]} ${b[2]}`, `vertex ${c[0]} ${c[1]} ${c[2]}`,
    "endloop", "endfacet");
}
out.push("endsolid church");
writeFileSync(resolve(import.meta.dirname, "..", "public/examples/church.stl"), out.join("\n") + "\n");
console.log(`church.stl: ${tris.length} facets — ${CUPOLA ? "DISPLAY (3D belfry, not foldable)" : "foldable steep-gable chapel + Gothic door"}`);
