/**
 * Kirigamized house-door → printable STLs with PyKirigami HINGE joinery + circuit channels.
 *
 *   public/examples/house-door.stl  (input solid)
 *     → parseMesh → condition → kirigamize → FKLD (flat crease pattern + foldedForm 3D house)
 *     → two assemblies, same topology, different layout:
 *         • house-door-kirigami.stl       — the FOLDED house (tiles on the foldedForm 3D shape)
 *         • house-door-kirigami-flat.stl  — the UNFOLDED sheet (tiles in the flat crease pattern)
 *
 * Each is: rigid **face-tiles** (coplanar triangles merged per face → one prism, inset toward the
 * face centroid) + a TPU **hinge CYLINDER** on every interior M/V fold edge (PyKirigami Fig. 2c —
 * the 1-DOF axis tiles rotate about). Hinges span only the centre of each edge, "C" cut-slits stay
 * open, and the inter-tile inset gaps are bare — those openings are the channels circuits route
 * through. ASCII STL only.
 *
 * Run:  npx vite-node scripts/gen-house-door.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseMesh } from "../src/pipeline/import.js";
import { kirigamize } from "../src/pipeline/kirigamize.js";

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// ---- tunables (mm) ----------------------------------------------------------------------------
const TILE_T = 1.4; // rigid tile thickness
const INSET_MM = 1.6; // shrink each tile toward its centroid → bare-hinge gap = 2·INSET between tiles
const HINGE_R = 1.2; // hinge cylinder radius (≥ INSET so it bonds both tile edges)
const HINGE_SPAN = 0.5; // fraction of each fold edge the hinge covers, centred (ends stay open)
const HINGE_SIDES = 8; // cylinder cross-section facets
const FOLDED_SIZE = 60; // longest bbox dim of the folded house
const FLAT_SIZE = 130; // longest bbox dim of the unfolded sheet

// ---- load + kirigamize ------------------------------------------------------------------------
const root = resolve(import.meta.dirname, "..");
const mesh = parseMesh(readFileSync(resolve(root, "public/examples/house-door.stl"), "utf8"), "stl");
const fkld = kirigamize(mesh).fkld as Record<string, unknown>;
const faces = fkld.faces_vertices as number[][];
const edgesV = fkld.edges_vertices as number[][];
const edgesA = fkld.edges_assignment as string[];
const flatCoords = (fkld.vertices_coords as number[][]).map((c): V3 => [c[0], c[1], c[2] ?? 0]);
const foldedCoords = ((fkld.file_frames as Record<string, unknown>[])[0].vertices_coords as number[][]).map((c): V3 => [c[0], c[1], c[2] ?? 0]);

// ---- topology (layout-independent) ------------------------------------------------------------
const ekey = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);
const assignOf = new Map<string, string>();
edgesV.forEach((e, i) => assignOf.set(ekey(e[0], e[1]), edgesA[i]));
const edgeFaceCount = new Map<string, number>();
for (const f of faces) for (let i = 0; i < f.length; i++) {
  const k = ekey(f[i], f[(i + 1) % f.length]);
  edgeFaceCount.set(k, (edgeFaceCount.get(k) ?? 0) + 1);
}

// merge coplanar triangles across flat "F" facet seams → one tile per real face
const parent = faces.map((_f, i) => i);
const findRoot = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
{
  const firstOnEdge = new Map<string, number>();
  faces.forEach((f, fi) => {
    for (let i = 0; i < f.length; i++) {
      const k = ekey(f[i], f[(i + 1) % f.length]);
      if (assignOf.get(k) !== "F") continue;
      const prev = firstOnEdge.get(k);
      if (prev === undefined) firstOnEdge.set(k, fi);
      else { const ra = findRoot(prev), rb = findRoot(fi); if (ra !== rb) parent[ra] = rb; }
    }
  });
}
const groupFaces = new Map<number, number[]>();
faces.forEach((_f, fi) => { const g = findRoot(fi); (groupFaces.get(g) ?? groupFaces.set(g, []).get(g)!).push(fi); });

/** Ordered outer boundary loop of a merged tile (null for a holed/disjoint boundary → fallback). */
function boundaryLoop(fis: number[]): number[] | null {
  const present = new Set<string>();
  for (const fi of fis) { const f = faces[fi]; for (let i = 0; i < f.length; i++) present.add(`${f[i]}_${f[(i + 1) % f.length]}`); }
  const nextOf = new Map<number, number>();
  for (const k of present) { const [a, b] = k.split("_").map(Number); if (!present.has(`${b}_${a}`)) nextOf.set(a, b); }
  if (nextOf.size < 3) return null;
  const start = nextOf.keys().next().value as number;
  const loop = [start];
  let cur = nextOf.get(start)!, guard = 0;
  while (cur !== start) { if (guard++ > 9999 || !nextOf.has(cur)) return null; loop.push(cur); cur = nextOf.get(cur)!; }
  return loop.length === nextOf.size ? loop : null;
}
const loops = new Map<number, number[] | null>();
for (const [g, fis] of groupFaces) loops.set(g, boundaryLoop(fis));

// ---- per-layout assembly ----------------------------------------------------------------------
function emitAssembly(src: V3[], target: number, extrudeUp: boolean, outName: string): { tiles: number; hinges: number; cuts: number; facets: number } {
  // scale + recentre (x/y centred, z based at 0)
  const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const c of src) for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d], c[d]); hi[d] = Math.max(hi[d], c[d]); }
  const s = target / Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const P: V3[] = src.map((c) => [(c[0] - (lo[0] + hi[0]) / 2) * s, (c[1] - (lo[1] + hi[1]) / 2) * s, (c[2] - lo[2]) * s]);

  const out: string[] = [`solid ${outName}`];
  const tri = (a: V3, b: V3, c: V3): void => {
    const n = unit(cross(sub(b, a), sub(c, a)));
    out.push(`facet normal ${n[0]} ${n[1]} ${n[2]}`, "outer loop",
      `vertex ${a[0]} ${a[1]} ${a[2]}`, `vertex ${b[0]} ${b[1]} ${b[2]}`, `vertex ${c[0]} ${c[1]} ${c[2]}`, "endloop", "endfacet");
  };
  const quad = (a: V3, b: V3, c: V3, d: V3): void => { tri(a, b, c); tri(a, c, d); };
  const faceNormal = (f: number[]): V3 => unit(cross(sub(P[f[1]], P[f[0]]), sub(P[f[2]], P[f[0]])));

  // tiles: one prism per merged face, inset toward its centroid, extruded by TILE_T
  let tiles = 0;
  for (const [g, fis] of groupFaces) {
    let c: V3 = [0, 0, 0], nv = 0;
    for (const fi of fis) for (const v of faces[fi]) { c = add(c, P[v]); nv++; }
    const ctr = mul(c, 1 / nv);
    const n: V3 = extrudeUp ? [0, 0, 1] : faceNormal(faces[fis[0]]);
    const insetV = (v: number): V3 => { const toG = sub(ctr, P[v]); const d = len(toG) || 1; return add(P[v], mul(toG, Math.min(INSET_MM, d * 0.45) / d)); };
    const emitPrism = (loopP: V3[]): void => {
      const top = loopP.map((p) => add(p, mul(n, TILE_T)));
      for (let i = 1; i + 1 < loopP.length; i++) { tri(top[0], top[i], top[i + 1]); tri(loopP[0], loopP[i + 1], loopP[i]); }
      for (let i = 0; i < loopP.length; i++) { const j = (i + 1) % loopP.length; quad(loopP[i], loopP[j], top[j], top[i]); }
    };
    const lp = loops.get(g);
    if (lp) emitPrism(lp.map(insetV));
    else for (const fi of fis) emitPrism(faces[fi].map(insetV));
    tiles++;
  }

  // hinge cylinder along the central HINGE_SPAN of each interior M/V fold edge
  const emitHinge = (p0: V3, p1: V3): void => {
    const axis = unit(sub(p1, p0));
    const ref: V3 = Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const u = unit(cross(axis, ref)), w = unit(cross(axis, u));
    const a = add(p0, mul(sub(p1, p0), 0.5 - HINGE_SPAN / 2));
    const b = add(p0, mul(sub(p1, p0), 0.5 + HINGE_SPAN / 2));
    const ring = (cc: V3): V3[] => Array.from({ length: HINGE_SIDES }, (_v, i) => {
      const t = (2 * Math.PI * i) / HINGE_SIDES;
      return add(cc, add(mul(u, Math.cos(t) * HINGE_R), mul(w, Math.sin(t) * HINGE_R)));
    });
    const ra = ring(a), rb = ring(b);
    for (let i = 0; i < HINGE_SIDES; i++) { const j = (i + 1) % HINGE_SIDES; quad(ra[i], ra[j], rb[j], rb[i]); tri(a, ra[j], ra[i]); tri(b, rb[i], rb[j]); }
  };
  let hinges = 0, cuts = 0;
  for (const [k, c] of edgeFaceCount) {
    const a = assignOf.get(k);
    if (c === 2 && (a === "M" || a === "V")) { const [s0, s1] = k.split("_").map(Number); emitHinge(P[s0], P[s1]); hinges++; }
    else if (c === 1 && a === "C") cuts++;
  }

  out.push(`endsolid ${outName}`);
  writeFileSync(resolve(root, "public/examples", `${outName}.stl`), out.join("\n") + "\n");
  return { tiles, hinges, cuts, facets: out.filter((l) => l.startsWith("facet")).length };
}

const folded = emitAssembly(foldedCoords, FOLDED_SIZE, false, "house-door-kirigami");
const flat = emitAssembly(flatCoords, FLAT_SIZE, true, "house-door-kirigami-flat");
writeFileSync(resolve(root, "public/examples/house-door.fkld"), JSON.stringify(fkld));

for (const [name, r, size] of [["folded", folded, FOLDED_SIZE], ["flat ", flat, FLAT_SIZE]] as const) {
  console.log(`${name}: tiles=${r.tiles} hinges(M/V)=${r.hinges} cut-slits=${r.cuts} facets=${r.facets}  (${size}mm)`);
}
console.log(`circuit channels: 2·${INSET_MM}=${2 * INSET_MM}mm inter-tile gaps + ${(1 - HINGE_SPAN) * 100}% open hinge-ends + open cut-slits`);
console.log("wrote house-door-kirigami.stl, house-door-kirigami-flat.stl, house-door.fkld");
