/**
 * Foldable printed-kirigami joinery — the single source of truth for the 3D-printed tile structure,
 * shared by the STL export (`stl-export.ts`) and the house/door generator (`scripts/gen-house-door.ts`),
 * and matched by the 3D-Sim render (`sim-canvas.ts`). It is the "rotating-units" kirigami you fold up
 * from flat (PyKirigami `2508.15753v3.pdf`; the reference part `kirigamish_parachuteish_180mm.stl`).
 *
 * Every triangular face → a RIGID tile, inset (scaled about its incentre by `gap`) so there is a gap
 * around every tile. Between every adjacent pair of tiles that share a fold/facet edge sits a THIN
 * living-hinge bridge — a low, narrow slab spanning the gap, thin enough (`hingeThickness ≪ thickness`)
 * to bend, so the tiles rotate about the shared edge and the whole sheet folds up. Per edge:
 *   • "merge"    → fold/facet edge shared by two faces: a thin HINGE bridges the gap (the fold line).
 *   • "cut"      → "C" edge: NO bridge — the gap stays open (the kirigami opening).
 *   • "boundary" → outer rim (one face): no bridge (a free edge).
 * Tiles are full extruded bricks `v_top = v + thickness·n`; the hinges are thin and on the base side
 * so the part prints flat and folds along every hinge into the 3D shape.
 */
export type V3 = [number, number, number];
export type EdgeRole = "cut" | "merge" | "boundary";

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Role of a face edge from its FOLD assignment and how many faces share it. */
export function edgeRole(assignment: string | undefined, faceCount: number): EdgeRole {
  if (assignment === "C") return "cut"; // the kirigami opening — gap stays open, no hinge
  if (faceCount <= 1) return "boundary"; // outer rim (incl. "B") — free edge, no hinge
  return "merge"; // M/V/F fold or flat facet shared by two faces — bridged by a thin hinge
}

export interface JoineryOptions {
  /** Rigid tile thickness (model units). */
  thickness: number;
  /** Tile inset: each tile is scaled about its incentre by `1 - gap`, opening a gap around it. */
  gap: number;
  /** Hinge slab thickness (≪ `thickness` so it bends). */
  hingeThickness: number;
  /** Fraction of each shared edge the hinge bridge spans, centred. */
  hingeSpan: number;
  /** How far the hinge pokes under each tile, as a fraction of its inset corner→incentre span, so it welds to both. */
  hingeOverlap: number;
  /** "flat" → tiles in the z = 0 plane extruded +z (the print); "folded" → per-face normal (gallery). */
  layout: "flat" | "folded";
  /**
   * FOLD assignment of an edge ("M"/"V"/"F"/…), used to seat each hinge on the INSIDE of its fold so
   * the rigid tiles pivot about it: valley → near the top face, mountain → near the bottom, flat →
   * mid-thickness (neutral). Omit → all hinges sit mid-thickness.
   */
  assignmentOf?: (a: number, b: number) => string | undefined;
}

/** Vertical seat of a hinge within the tile thickness, from its fold assignment (valley top / mountain bottom). */
function hingeLow(assignment: string | undefined, thickness: number, hingeThickness: number): number {
  if (assignment === "V") return thickness - hingeThickness; // valley folds shut on top → hinge near the top
  if (assignment === "M") return 0; // mountain folds shut on the bottom → hinge near the bottom
  return (thickness - hingeThickness) / 2; // flat / unknown → neutral mid-thickness
}

/**
 * Build the foldable-joinery triangle soup (every 3 vertices = one CCW-outward facet) for a whole
 * kirigamized model: inset rigid tiles + thin hinge bridges across every shared fold/facet edge.
 * `coords` are the chosen layout's vertex positions; `roleOf(a,b)` classifies an undirected edge.
 */
export function buildFoldableJoinery(
  faces: number[][],
  coords: V3[],
  roleOf: (a: number, b: number) => EdgeRole,
  opts: JoineryOptions,
): V3[] {
  const out: V3[] = [];
  const tri = (a: V3, b: V3, c: V3): void => { out.push(a, b, c); };
  const quad = (a: V3, b: V3, c: V3, d: V3): void => { tri(a, b, c); tri(a, c, d); };

  // per-face frame: outward normal n (flat → +z), incentre I, and the inset (scaled) corners
  const faceN: V3[] = [], faceInset: V3[][] = [];
  faces.forEach((f) => {
    const P = f.map((i) => coords[i]);
    const n: V3 = opts.layout === "flat" ? [0, 0, 1] : unit(cross(sub(P[1], P[0]), sub(P[2], P[0])));
    faceN.push(n);
    faceInset.push(insetPolygon(P, opts.gap));
  });

  // tiles: each inset polygon extruded by `thickness` along n → a closed prism (top + bottom + walls)
  faces.forEach((_f, fi) => {
    const ring = faceInset[fi], n = faceN[fi];
    const top = ring.map((v) => add(v, mul(n, opts.thickness)));
    for (let i = 1; i + 1 < ring.length; i++) { tri(top[0], top[i], top[i + 1]); tri(ring[0], ring[i + 1], ring[i]); } // caps
    for (let i = 0; i < ring.length; i++) { const j = (i + 1) % ring.length; quad(ring[i], ring[j], top[j], top[i]); } // walls
  });

  // hinges: one thin bridge per shared fold/facet ("merge") edge, welding the two tiles' inset edges
  const edgeFaces = new Map<string, Array<{ f: number; u: number; w: number }>>();
  faces.forEach((f, fi) => {
    for (let k = 0; k < f.length; k++) {
      const u = f[k], w = f[(k + 1) % f.length], key = u < w ? `${u}_${w}` : `${w}_${u}`;
      (edgeFaces.get(key) ?? edgeFaces.set(key, []).get(key)!).push({ f: fi, u, w });
    }
  });
  const { hingeThickness: hT, hingeSpan: span, hingeOverlap: ov, thickness: T } = opts;
  for (const [, fl] of edgeFaces) {
    if (fl.length !== 2) continue;
    if (roleOf(fl[0].u, fl[0].w) !== "merge") continue; // only fold/facet edges get a hinge
    const e0 = 0.5 - span / 2, e1 = 0.5 + span / 2;
    const navg = unit(add(faceN[fl[0].f], faceN[fl[1].f]));
    const lo = hingeLow(opts.assignmentOf?.(fl[0].u, fl[0].w), T, hT); // seat the hinge on the inside of its fold
    // each tile's inset edge endpoints (poked toward the incentre by `ov` so the bridge welds in)
    const side = (s: { f: number; u: number; w: number }): [V3, V3] => {
      const Iu = faceInset[s.f][faces[s.f].indexOf(s.u)], Iw = faceInset[s.f][faces[s.f].indexOf(s.w)];
      const ctr = mul(faceInset[s.f].reduce(add, [0, 0, 0] as V3), 1 / faceInset[s.f].length);
      const a = lerp(Iu, Iw, e0), b = lerp(Iu, Iw, e1);
      return [lerp(a, ctr, ov), lerp(b, ctr, ov)]; // poke toward the incentre so the bridge welds into the tile
    };
    const [a0, a1] = side(fl[0]);
    const [b0, b1] = side(fl[1]); // fl[1] shares u,w (opposite winding) → b0~near u, b1~near w
    // thin slab seated at height `lo` (inside of the fold), spanning +hT along navg
    const base = [a0, a1, b1, b0].map((v) => add(v, mul(navg, lo)));
    const top = base.map((v) => add(v, mul(navg, hT)));
    quad(base[0], base[3], base[2], base[1]); // bottom (−navg)
    quad(top[0], top[1], top[2], top[3]); // top (+navg)
    for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; quad(base[i], base[j], top[j], top[i]); } // walls
  }
  return out;
}

/** Inset a planar polygon by scaling its corners toward the incentre by `1 - gap` (uniform edge offset). */
function insetPolygon(P: V3[], gap: number): V3[] {
  // weighted incentre approx: centroid is exact for the regular case and stable for thin triangles
  const c = mul(P.reduce(add, [0, 0, 0] as V3), 1 / P.length);
  const s = Math.max(0.05, 1 - gap);
  return P.map((v) => add(c, mul(sub(v, c), s)));
}
