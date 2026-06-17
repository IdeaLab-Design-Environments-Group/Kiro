/**
 * Windmill input solid → public/examples/windmill.stl, a kirigamizable low-poly solid in the same
 * family as house.stl / barn.stl (unit scale, ASCII STL, z-up). A classic Dutch tower mill:
 *   • a TAPERED OCTAGONAL TOWER (8 developable trapezoid faces, wider at the base),
 *   • a CONICAL CAP (8-triangle octagonal pyramid) on top,
 *   • a DOOR at the base (a boundary-connected notch in the front face, like barn.stl), and
 *   • the iconic FOUR SAILS — a "+" of flat blades on a hub standing off the front (SAILS=1).
 *
 * Tower + cap + door kirigamize cleanly (developable frustum + cone + notch). The sails are thin
 * appendages joined only at the hub; like the barn hayloft they may not unfold, so they are OFF by
 * default (SAILS=1 to include the solid). Open bottom (a shell), exactly like house/barn.
 *
 * Run:  node scripts/gen-windmill.mjs   (or  SAILS=1 node scripts/gen-windmill.mjs)
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const N = 8;            // octagonal tower
const RB = 0.55;        // base radius
const RT = 0.36;        // top radius (taper — classic Dutch mill batter)
const HT = 1.15;        // tower height (eave)
const HC = 0.34;        // cap height above the eave (apex)
const DOOR = { s0: 0.34, s1: 0.66, t1: 0.42 }; // door notch on the front face: width [s0,s1], up to height t1
// Sails are axle-mounted IN FRONT of the tower → a disconnected component the kirigamize pipeline
// drops. So they are a DISPLAY-ONLY extra: SAILS=1 writes windmill-display.stl (the recognizable
// windmill with sails); the default windmill.stl is the kirigamizable tower + cap + door.
const SAILS = !!process.env.SAILS;
const SAIL = { z: 0.86, len: 0.62, halfW: 0.07, thick: 0.05, hub: 0.1 }; // 4 blades + hub, on the front

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// octagon ring: vertex k at angle so that ONE face is centred on −y (the front, for the door + sails)
const ring = (r, z) => Array.from({ length: N }, (_, k) => {
  const a = (-90 + 180 / N + (k * 360) / N) * Math.PI / 180;
  return [r * Math.cos(a), r * Math.sin(a), z];
});
const base = ring(RB, 0), top = ring(RT, HT), apex = [0, 0, HT + HC];

const tris = [];
const CENTER = [0, 0, HT * 0.5];
function addTri(a, b, c, ref = CENTER) {
  const n = cross(sub(b, a), sub(c, a));
  if (Math.hypot(...n) < 1e-9) return;
  const mid = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
  tris.push(dot(n, sub(mid, ref)) >= 0 ? [a, b, c] : [a, c, b]); // wind so the normal points away from ref
}
const quad = (a, b, c, d, ref) => { addTri(a, b, c, ref); addTri(a, c, d, ref); };

// front face index = the side whose outward normal points most in −y
let front = 0, best = Infinity;
for (let i = 0; i < N; i++) {
  const j = (i + 1) % N, m = lerp(base[i], base[j], 0.5);
  if (m[1] < best) { best = m[1]; front = i; }
}

// ---- tower: N tapered trapezoid faces (door carved on the front face) ---------------------------
for (let i = 0; i < N; i++) {
  const j = (i + 1) % N;
  const BL = base[i], BR = base[j], TR = top[j], TL = top[i];
  if (i === front) {
    // bilinear param P(s,t): s across the face (0=BL→1=BR), t up (0=bottom→1=top)
    const P = (s, t) => lerp(lerp(BL, BR, s), lerp(TL, TR, s), t);
    const { s0, s1, t1 } = DOOR;
    quad(P(0, 0), P(s0, 0), P(s0, 1), P(0, 1));   // left strip
    quad(P(s1, 0), P(1, 0), P(1, 1), P(s1, 1));   // right strip
    quad(P(s0, t1), P(s1, t1), P(s1, 1), P(s0, 1)); // top strip above the doorway (door gap below)
  } else {
    quad(BL, BR, TR, TL);
  }
}
// ---- conical cap: N triangles to the apex -------------------------------------------------------
for (let i = 0; i < N; i++) addTri(top[i], top[(i + 1) % N], apex, [0, 0, HT]);

// ---- four sails: a "+" of flat blades on a hub standing off the front (optional) -----------------
if (SAILS) {
  const yf = -RT - SAIL.thick;            // hub front plane, just off the tower
  const yb = -RT * 0.98;                  // hub back plane (against the tower)
  const cz = SAIL.z;                       // hub centre height
  const boxYZ = (x0, x1, z0, z1, ref) => { // a thin slab in the x-z plane, spanning y∈[yb,yf]
    const f = [[x0, yf, z0], [x1, yf, z0], [x1, yf, z1], [x0, yf, z1]];
    const b = [[x0, yb, z0], [x1, yb, z0], [x1, yb, z1], [x0, yb, z1]];
    quad(f[0], f[1], f[2], f[3], ref); quad(b[3], b[2], b[1], b[0], ref);
    for (let k = 0; k < 4; k++) { const m = (k + 1) % 4; quad(b[k], f[k], f[m], b[m], ref); }
  };
  const ref = [0, -10, cz];                       // push normals outward (toward −y / away from tower)
  const hw = SAIL.halfW, L = SAIL.len, hub = SAIL.hub;
  boxYZ(-hub, hub, cz - hub, cz + hub, ref);                 // hub
  boxYZ(-hw, hw, cz + hub, cz + L, ref);                     // up blade
  boxYZ(-hw, hw, cz - L, cz - hub, ref);                     // down blade
  boxYZ(hub, hub + (L - hub), cz - hw, cz + hw, ref);        // right blade
  boxYZ(-(hub + (L - hub)), -hub, cz - hw, cz + hw, ref);    // left blade
}

// ---- write ASCII STL ----------------------------------------------------------------------------
const out = ["solid windmill"];
for (const [a, b, c] of tris) {
  let n = cross(sub(b, a), sub(c, a));
  const l = Math.hypot(...n) || 1; n = [n[0] / l, n[1] / l, n[2] / l];
  out.push(`facet normal ${n[0]} ${n[1]} ${n[2]}`, "outer loop",
    `vertex ${a[0]} ${a[1]} ${a[2]}`, `vertex ${b[0]} ${b[1]} ${b[2]}`, `vertex ${c[0]} ${c[1]} ${c[2]}`,
    "endloop", "endfacet");
}
out.push("endsolid windmill");
const file = SAILS ? "windmill-display.stl" : "windmill.stl"; // sails → display-only (don't overwrite the kirigamizable solid)
const path = resolve(import.meta.dirname, "..", "public/examples", file);
writeFileSync(path, out.join("\n") + "\n");
console.log(`${file}: ${tris.length} facets → ${path}`);
console.log(`  tower R ${RB}→${RT} h${HT} + cap ${HC} + door${SAILS ? " + 4 sails (DISPLAY ONLY — not kirigamizable)" : "  (kirigamizable)"}  (front face #${front})`);
