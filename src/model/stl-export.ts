/**
 * STL export — the 3D-printed tiles, with **fold-adaptive triangulation**: faces that fold harder get
 * subdivided into more (smaller) tiles, flatter faces stay coarse. Per crease we read the fold angle
 * (`fkld:edges_dihedralTarget`, 0 = flat); a face's fold level is the sharpest crease it touches,
 * normalised against the model's sharpest fold, so resolution tracks "things folding on each other".
 *
 * Each resulting triangle is then inset toward its own centroid (separated, like the sim's printed
 * render) and extruded from z = 0 to a chosen height — a closed, watertight prism per tile.
 *
 * Coordinates are the flat pattern `vertices_coords` (z = 0 base); n-gon faces are fan-triangulated.
 */
import type { FoldFile } from "./fold-file.js";
import { DEFAULT_MAX_SUBDIV, DETAIL_OFFSET, foldDepths, subdivBary, TILE_INSET_FRAC } from "./tile-subdiv.js";

export interface StlExport {
  filename: string;
  text: string;
  /** Tile height actually used (model units) — lets the menu prefill its input. */
  height: number;
  /** Model unit label for the menu (`frame_unit` when present, else "units"). */
  unit: string;
  /** Max subdivision level applied to the most-folded faces — lets the menu prefill its input. */
  maxSubdiv: number;
}

type V3 = [number, number, number];

/** Default tile height as a fraction of the flat bbox diagonal (≈ the sim's visual `TILE_THICK_FRAC`). */
const DEFAULT_HEIGHT_FRAC = 0.02;
/** Hinge-bridge half-width along its edge (matches the sim's `W`), and slab thickness as a height fraction. */
const BRIDGE_HALF_W = 0.16;
const BRIDGE_T_FRAC = 0.35;

/**
 * Build the ASCII-STL export of the separated, extruded, fold-adaptive tiles. `heightUnits` is the
 * tile height in model units (null/≤0 → size-relative default); `maxSubdiv` caps adaptive splitting
 * (null → default). Returns null if there are no faces.
 */
export function buildStlExport(
  fold: FoldFile,
  baseName = "kirigami",
  heightUnits?: number | null,
  maxSubdiv?: number | null,
): StlExport | null {
  const faces = fold.faces_vertices;
  if (!Array.isArray(faces) || faces.length === 0) return null;
  const coords = fold.vertices_coords; // flat pattern; vert() reads z = c[2] ?? 0
  if (!Array.isArray(coords) || coords.length === 0) return null;

  const vert = (i: number): V3 => {
    const c = coords[i] ?? [];
    return [Number(c[0]) || 0, Number(c[1]) || 0, Number(c[2]) || 0];
  };

  const h = heightUnits != null && heightUnits > 0 ? heightUnits : DEFAULT_HEIGHT_FRAC * bboxDiagonal(coords);
  const unit = typeof fold.frame_unit === "string" && fold.frame_unit ? fold.frame_unit : "units";
  const cap = maxSubdiv != null && maxSubdiv >= 0 ? Math.floor(maxSubdiv) : DEFAULT_MAX_SUBDIV;
  const depthOf = faceDepths(fold, faces, cap);

  const out: string[] = [`solid ${baseName}`];
  faces.forEach((face, fi) => {
    if (!Array.isArray(face) || face.length < 3) return;
    const corners = face.map(vert);
    const subTris = subdivBary(depthOf[fi]);
    // Fan to base triangles, subdivide each by this face's fold level, then inset + extrude each tri.
    for (let k = 1; k + 1 < corners.length; k++) {
      const base: [V3, V3, V3] = [corners[0], corners[k], corners[k + 1]];
      for (const bt of subTris) {
        writePrism(out, insetToCentroid([evalBary(bt[0], base), evalBary(bt[1], base), evalBary(bt[2], base)]), h);
      }
    }
  });
  // Hinge bridges: a strap across every interior M/V/F edge tying the two tile tops together (cuts/
  // boundary edges get none, so the kirigami still opens) — matches the sim's printed bridge layer.
  emitBridges(out, fold, faces, vert, h);
  out.push(`endsolid ${baseName}`);
  return { filename: `${baseName}.stl`, text: out.join("\n") + "\n", height: h, unit, maxSubdiv: cap };
}

/** Evaluate a barycentric weight against a triangle's three corners. */
function evalBary(w: [number, number, number], t: [V3, V3, V3]): V3 {
  return [
    w[0] * t[0][0] + w[1] * t[1][0] + w[2] * t[2][0],
    w[0] * t[0][1] + w[1] * t[1][1] + w[2] * t[2][1],
    w[0] * t[0][2] + w[1] * t[1][2] + w[2] * t[2][2],
  ];
}

/** Per-face subdivision depth: more for harder-folding faces, normalised to the model's sharpest fold. */
function faceDepths(fold: FoldFile, faces: number[][], level: number): number[] {
  const foldMag = edgeFoldMagnitudes(fold, faces);
  const score = faces.map((f) => {
    let s = 0;
    for (let k = 0; k < f.length; k++) s = Math.max(s, foldMag.get(edgeKey(f[k], f[(k + 1) % f.length])) ?? 0);
    return s;
  });
  return foldDepths(score, level + DETAIL_OFFSET); // level 0 → 1 subdivision (slider shift)
}

/**
 * Emit a strap slab across every interior M/V/F edge (2 faces + a fold/facet assignment), inset
 * toward each face centroid and sitting at the tile top — the printable twin of the sim's bridge
 * layer. Cut ("C") and boundary ("B") edges get NO bridge so the kirigami still opens.
 */
function emitBridges(out: string[], fold: FoldFile, faces: number[][], vert: (i: number) => V3, hTop: number): void {
  const ev = fold.edges_vertices, ea = fold.edges_assignment;
  if (!Array.isArray(ev) || !Array.isArray(ea)) return;
  const assign = new Map<string, string>();
  for (let i = 0; i < ev.length; i++) assign.set(edgeKey(ev[i][0], ev[i][1]), ea[i]);

  const edgeFaces = new Map<string, number[]>();
  faces.forEach((f, fi) => {
    for (let k = 0; k < f.length; k++) {
      const key = edgeKey(f[k], f[(k + 1) % f.length]);
      (edgeFaces.get(key) ?? edgeFaces.set(key, []).get(key)!).push(fi);
    }
  });

  const tb = hTop * BRIDGE_T_FRAC;
  for (const [key, fs] of edgeFaces) {
    if (fs.length !== 2) continue; // boundary / split cut → stays open
    const a = assign.get(key);
    if (a !== "M" && a !== "V" && a !== "F") continue; // only legal hinges (never C / B)
    const [s0, s1] = key.split(",").map(Number);
    const e0 = vert(s0), e1 = vert(s1);
    const lo = lerpXY(e0, e1, 0.5 - BRIDGE_HALF_W), hi = lerpXY(e0, e1, 0.5 + BRIDGE_HALF_W);
    const c1 = centroid(faces[fs[0]], vert), c2 = centroid(faces[fs[1]], vert);
    // quad loop: face1(lo→hi) then face2(hi→lo), all inset toward their own centroid
    const q: [number, number][] = [insetXY(lo, c1), insetXY(hi, c1), insetXY(hi, c2), insetXY(lo, c2)];
    writeSlab(out, q, hTop, hTop - tb);
  }
}

/** A flat quad (4 xy corners) extruded between z = zBot..zTop → a closed, watertight slab. */
function writeSlab(out: string[], q: [number, number][], zTop: number, zBot: number): void {
  const t = q.map((p): V3 => [p[0], p[1], zTop]);
  const b = q.map((p): V3 => [p[0], p[1], zBot]);
  writeFacet(out, t[0], t[1], t[2]); writeFacet(out, t[0], t[2], t[3]); // top
  writeFacet(out, b[0], b[2], b[1]); writeFacet(out, b[0], b[3], b[2]); // bottom (reversed)
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    writeFacet(out, b[i], b[j], t[j]); writeFacet(out, b[i], t[j], t[i]); // side wall
  }
}

const lerpXY = (a: V3, b: V3, s: number): [number, number] => [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s];
const insetXY = (p: [number, number], c: [number, number]): [number, number] => [
  p[0] + (c[0] - p[0]) * TILE_INSET_FRAC,
  p[1] + (c[1] - p[1]) * TILE_INSET_FRAC,
];
function centroid(face: number[], vert: (i: number) => V3): [number, number] {
  let x = 0, y = 0;
  for (const i of face) { const v = vert(i); x += v[0]; y += v[1]; }
  return [x / face.length, y / face.length];
}

/** Map each undirected edge → fold magnitude (rad): crease targets when present, else folded dihedral. */
function edgeFoldMagnitudes(fold: FoldFile, faces: number[][]): Map<string, number> {
  const ev = fold.edges_vertices;
  const dt = (fold as { "fkld:edges_dihedralTarget"?: unknown[] })["fkld:edges_dihedralTarget"];
  if (Array.isArray(ev) && Array.isArray(dt)) {
    const map = new Map<string, number>();
    let any = false;
    for (let i = 0; i < ev.length; i++) {
      const m = Math.abs(Number(dt[i]) || 0);
      if (m > 1e-6) any = true;
      map.set(edgeKey(ev[i][0], ev[i][1]), m);
    }
    if (any) return map;
  }
  // Fallback: actual dihedral between adjacent faces in the declared folded form.
  const folded = foldedFrameCoords(fold);
  return folded ? dihedralsFromFolded(faces, folded) : new Map();
}

/** Dihedral fold angle (0 = coplanar) across every interior edge of the folded mesh. */
function dihedralsFromFolded(faces: number[][], coords: number[][]): Map<string, number> {
  const edgeFaces = new Map<string, number[]>();
  faces.forEach((f, fi) => {
    for (let k = 0; k < f.length; k++) {
      const key = edgeKey(f[k], f[(k + 1) % f.length]);
      (edgeFaces.get(key) ?? edgeFaces.set(key, []).get(key)!).push(fi);
    }
  });
  const normals = faces.map((f) => faceNormal(f, coords));
  const map = new Map<string, number>();
  for (const [key, fs] of edgeFaces) {
    if (fs.length === 2) {
      const dot = normals[fs[0]][0] * normals[fs[1]][0] + normals[fs[0]][1] * normals[fs[1]][1] + normals[fs[0]][2] * normals[fs[1]][2];
      map.set(key, Math.acos(Math.min(1, Math.max(-1, dot)))); // 0 = flat … π = folded back
    } else map.set(key, 0);
  }
  return map;
}

function foldedFrameCoords(fold: FoldFile): number[][] | null {
  const flat = fold.vertices_coords;
  if (!Array.isArray(flat)) return null;
  const frames = (fold as { file_frames?: Array<{ frame_classes?: string[]; vertices_coords?: number[][] }> }).file_frames;
  const f = frames?.find(
    (fr) => Array.isArray(fr.vertices_coords) && fr.vertices_coords.length === flat.length && (fr.frame_classes ?? []).includes("foldedForm"),
  );
  return f?.vertices_coords ?? null;
}

/** Newell's method — robust polygon normal (works for triangles and n-gons). */
function faceNormal(face: number[], coords: number[][]): V3 {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < face.length; i++) {
    const a = coords[face[i]] ?? [], b = coords[face[(i + 1) % face.length]] ?? [];
    const ax = Number(a[0]) || 0, ay = Number(a[1]) || 0, az = Number(a[2]) || 0;
    const bx = Number(b[0]) || 0, by = Number(b[1]) || 0, bz = Number(b[2]) || 0;
    nx += (ay - by) * (az + bz);
    ny += (az - bz) * (ax + bx);
    nz += (ax - bx) * (ay + by);
  }
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

const edgeKey = (a: number, b: number): string => (a < b ? `${a},${b}` : `${b},${a}`);

/** Shrink each corner toward the triangle centroid so the tile separates from its neighbours. */
function insetToCentroid(tri: [V3, V3, V3]): [V3, V3, V3] {
  const gx = (tri[0][0] + tri[1][0] + tri[2][0]) / 3;
  const gy = (tri[0][1] + tri[1][1] + tri[2][1]) / 3;
  const gz = (tri[0][2] + tri[1][2] + tri[2][2]) / 3;
  return tri.map(([x, y, z]): V3 => [
    x + (gx - x) * TILE_INSET_FRAC,
    y + (gy - y) * TILE_INSET_FRAC,
    z + (gz - z) * TILE_INSET_FRAC,
  ]) as [V3, V3, V3];
}

/** Write a closed, watertight triangular prism: flat triangle (a,b,c) at its z, extruded +h in z. */
function writePrism(out: string[], [a, b, c]: [V3, V3, V3], h: number): void {
  // Canonicalize to CCW (in xy) so top normals point +z and side walls face outward.
  const ccw = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) >= 0;
  const p0 = a, p1 = ccw ? b : c, p2 = ccw ? c : b;
  const top = (p: V3): V3 => [p[0], p[1], p[2] + h];
  const t0 = top(p0), t1 = top(p1), t2 = top(p2);

  writeFacet(out, p0, p2, p1); // bottom → normal −z
  writeFacet(out, t0, t1, t2); // top → normal +z
  const base = [p0, p1, p2], tops = [t0, t1, t2];
  for (let e = 0; e < 3; e++) {
    const j = (e + 1) % 3;
    writeFacet(out, base[e], base[j], tops[j]); // side wall, outward
    writeFacet(out, base[e], tops[j], tops[e]);
  }
}

function bboxDiagonal(coords: number[][]): number {
  let xl = Infinity, xh = -Infinity, yl = Infinity, yh = -Infinity;
  for (const c of coords) {
    const x = Number(c[0]) || 0, y = Number(c[1]) || 0;
    xl = Math.min(xl, x); xh = Math.max(xh, x);
    yl = Math.min(yl, y); yh = Math.max(yh, y);
  }
  const d = Math.hypot(xh - xl, yh - yl);
  return Number.isFinite(d) && d > 0 ? d : 1;
}

function writeFacet(out: string[], a: V3, b: V3, c: V3): void {
  const n = normal(a, b, c);
  out.push(`  facet normal ${fmt(n[0])} ${fmt(n[1])} ${fmt(n[2])}`);
  out.push("    outer loop");
  out.push(`      vertex ${fmt(a[0])} ${fmt(a[1])} ${fmt(a[2])}`);
  out.push(`      vertex ${fmt(b[0])} ${fmt(b[1])} ${fmt(b[2])}`);
  out.push(`      vertex ${fmt(c[0])} ${fmt(c[1])} ${fmt(c[2])}`);
  out.push("    endloop");
  out.push("  endfacet");
}

function normal(a: V3, b: V3, c: V3): V3 {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

const fmt = (n: number): string => (Number.isFinite(n) ? String(Math.round(n * 1e6) / 1e6) : "0");
