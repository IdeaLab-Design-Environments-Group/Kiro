/**
 * Circuit → geometry engine. Resolves a {@link Circuit} (parts pinned to faces by barycentric coords)
 * into concrete geometry in WHATEVER space the caller supplies node positions for: pass flat
 * `vertices` and you get the flat layout (the separate STL export); pass the live folded positions and
 * you get the on-the-fold layout (the sim overlay). One source of truth → sim preview and export match.
 *
 * Each part gets an in-plane frame (long axis × short axis × face normal) so its body and pads sit on
 * the tile and ride the fold. Traces are routed on the FLAT pattern (a straight pad-to-pad segment,
 * sampled) and each sample mapped onto the surface, so a trace follows the tiles and bridges hinge
 * gaps as a short jumper.
 */
import { COMPONENT_SPECS, type Circuit, type ComponentKind, type PadRef } from "./circuit.js";

export type Vec3 = [number, number, number];

/** The minimal mesh the engine needs — structurally satisfied by a `FoldNet`. */
export interface MeshRef {
  faces: [number, number, number][];
  vertices: { x: number; y: number; z: number }[];
}

/** Node index → position in the target space (flat vertices, or live folded `model.position`). */
export type CoordsFn = (node: number) => Vec3;

export interface ComponentGeom {
  id: string;
  kind: ComponentKind;
  center: Vec3;
  x: Vec3; // unit long (pad-to-pad) axis
  y: Vec3; // unit short axis
  n: Vec3; // unit face normal
  len: number;
  wid: number;
  pads: [Vec3, Vec3];
  color: number;
}

export interface CircuitGeom {
  components: ComponentGeom[];
  traces: { id: string; path: Vec3[] }[];
  /** Flat bbox diagonal — the size base for part footprints and default trace rib dimensions. */
  scale: number;
}

/** Resolve a circuit into geometry positioned via `coords` (flat or folded). */
export function resolveCircuit(circuit: Circuit, net: MeshRef, coords: CoordsFn): CircuitGeom {
  const diag = flatDiagonal(net);
  const display = circuit.components.map((c) => frameFor(c.face, c.bary, c.rot, net, coords, c.id, c.kind, diag));
  const flat = circuit.components.map((c) =>
    frameFor(c.face, c.bary, c.rot, net, (i) => flatNode(net, i), c.id, c.kind, diag),
  );
  const byId = new Map(circuit.components.map((c, i) => [c.id, i] as const));

  const traces = circuit.traces
    .map((t) => {
      const fi = byId.get(t.from.comp), ti = byId.get(t.to.comp);
      if (fi == null || ti == null) return null;
      const a = padPos(flat[fi], t.from), b = padPos(flat[ti], t.to);
      const aDisp = padPos(display[fi], t.from);
      return { id: t.id, path: routeOnSurface(a, b, aDisp, padPos(display[ti], t.to), net, coords, diag) };
    })
    .filter((t): t is { id: string; path: Vec3[] } => t !== null);

  return { components: display, traces, scale: diag };
}

function frameFor(
  face: number, bary: [number, number, number], rot: number, net: MeshRef, coords: CoordsFn,
  id: string, kind: ComponentKind, diag: number,
): ComponentGeom {
  const f = net.faces[face] ?? [0, 0, 0];
  const c0 = coords(f[0]), c1 = coords(f[1]), c2 = coords(f[2]);
  const center = baryMix(c0, c1, c2, bary);
  const n = norm(cross(sub(c1, c0), sub(c2, c0)));
  const t = norm(sub(c1, c0));
  const bb = norm(cross(n, t));
  const cs = Math.cos(rot), sn = Math.sin(rot);
  const x = norm(add(scale(t, cs), scale(bb, sn)));
  const y = norm(add(scale(t, -sn), scale(bb, cs)));
  const spec = COMPONENT_SPECS[kind];
  const len = spec.len * diag, wid = spec.wid * diag;
  const pads: [Vec3, Vec3] = [add(center, scale(x, len / 2)), sub(center, scale(x, len / 2))];
  return { id, kind, center, x, y, n, len, wid, pads, color: spec.color };
}

const padPos = (g: ComponentGeom, ref: PadRef): Vec3 => g.pads[ref.pad] ?? g.center;

/** Sample the flat pad-to-pad segment and map each sample onto the surface in the display space. */
function routeOnSurface(aFlat: Vec3, bFlat: Vec3, aDisp: Vec3, bDisp: Vec3, net: MeshRef, coords: CoordsFn, diag: number): Vec3[] {
  const dist = Math.hypot(bFlat[0] - aFlat[0], bFlat[1] - aFlat[1]);
  const steps = Math.max(1, Math.min(64, Math.round(dist / (0.03 * diag))));
  const path: Vec3[] = [aDisp];
  for (let k = 1; k < steps; k++) {
    const u = k / steps;
    const px = aFlat[0] + (bFlat[0] - aFlat[0]) * u, py = aFlat[1] + (bFlat[1] - aFlat[1]) * u;
    const hit = locateFlat(px, py, net);
    path.push(hit ? baryMix(coords(net.faces[hit.face][0]), coords(net.faces[hit.face][1]), coords(net.faces[hit.face][2]), hit.bary)
                  : [aDisp[0] + (bDisp[0] - aDisp[0]) * u, aDisp[1] + (bDisp[1] - aDisp[1]) * u, aDisp[2] + (bDisp[2] - aDisp[2]) * u]);
  }
  path.push(bDisp);
  return path;
}

/** Find the flat face containing (x,y); fall back to the nearest face centroid with clamped bary. */
export function locateFlat(x: number, y: number, net: MeshRef): { face: number; bary: [number, number, number] } | null {
  let best = -1, bestD = Infinity, bestB: [number, number, number] = [1, 0, 0];
  for (let f = 0; f < net.faces.length; f++) {
    const [i, j, k] = net.faces[f];
    const a = net.vertices[i], b = net.vertices[j], c = net.vertices[k];
    const bary = baryOf(x, y, a, b, c);
    if (bary[0] >= -1e-6 && bary[1] >= -1e-6 && bary[2] >= -1e-6) return { face: f, bary };
    const cx = (a.x + b.x + c.x) / 3, cy = (a.y + b.y + c.y) / 3;
    const d = (cx - x) ** 2 + (cy - y) ** 2;
    if (d < bestD) { bestD = d; best = f; bestB = clampBary(bary); }
  }
  return best >= 0 ? { face: best, bary: bestB } : null;
}

function baryOf(px: number, py: number, a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }): [number, number, number] {
  const v0x = b.x - a.x, v0y = b.y - a.y, v1x = c.x - a.x, v1y = c.y - a.y, v2x = px - a.x, v2y = py - a.y;
  const den = v0x * v1y - v1x * v0y || 1e-12;
  const v = (v2x * v1y - v1x * v2y) / den;
  const w = (v0x * v2y - v2x * v0y) / den;
  return [1 - v - w, v, w];
}

function clampBary(b: [number, number, number]): [number, number, number] {
  const c = b.map((v) => Math.max(0, v)) as [number, number, number];
  const s = c[0] + c[1] + c[2] || 1;
  return [c[0] / s, c[1] / s, c[2] / s];
}

function flatNode(net: MeshRef, i: number): Vec3 {
  const v = net.vertices[i] ?? { x: 0, y: 0, z: 0 };
  return [v.x, v.y, v.z ?? 0];
}

function flatDiagonal(net: MeshRef): number {
  let xl = Infinity, xh = -Infinity, yl = Infinity, yh = -Infinity;
  for (const v of net.vertices) { xl = Math.min(xl, v.x); xh = Math.max(xh, v.x); yl = Math.min(yl, v.y); yh = Math.max(yh, v.y); }
  const d = Math.hypot(xh - xl, yh - yl);
  return Number.isFinite(d) && d > 0 ? d : 1;
}

// --- tiny vec3 helpers -------------------------------------------------------
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const baryMix = (a: Vec3, b: Vec3, c: Vec3, w: [number, number, number]): Vec3 => [
  w[0] * a[0] + w[1] * b[0] + w[2] * c[0],
  w[0] * a[1] + w[1] * b[1] + w[2] * c[1],
  w[0] * a[2] + w[1] * b[2] + w[2] * c[2],
];
