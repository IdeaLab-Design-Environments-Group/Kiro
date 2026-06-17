/**
 * Circuit → geometry engine. Resolves a {@link Circuit} (parts pinned to faces by barycentric coords)
 * into concrete geometry in WHATEVER space the caller supplies node positions for: pass flat
 * `vertices` and you get the flat layout (the separate STL export); pass the live folded positions and
 * you get the on-the-fold layout (the sim overlay). One source of truth → sim preview and export match.
 *
 * Each part gets an in-plane frame (long axis × short axis × face normal); its two copper pads sit on
 * the long axis at ±`padPitch`/2 — the real SMD pad centres of the source fab.pretty footprint.
 *
 * Traces do NOT cut straight across the rigid tiles. They are routed on the **bare-cloth gap network**
 * — the strips of exposed fabric the tile inset leaves along every triangle edge — via a shortest path
 * over the mesh's edge graph (vertices ↔ edge midpoints). So a trace threads the spaces *between* the
 * triangles and crosses each fold on the continuous cloth, with NO bridge/jumper over a hinge. The
 * routed polyline is returned with a per-point surface normal so the renderer can lay a full-width
 * copper ribbon flat on the cloth.
 */
import { COMPONENT_SPECS, type Circuit, type ComponentKind, type ComponentMarker, type PadRef } from "./circuit.js";

export type Vec3 = [number, number, number];

/** Copper trace width as a fraction of the flat bbox diagonal (shared: sim ribbon + STL ribs). */
export const TRACE_W = 0.012;

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
  marker: ComponentMarker;
  center: Vec3;
  x: Vec3; // unit long (pad-to-pad) axis
  y: Vec3; // unit short axis
  n: Vec3; // unit face normal
  len: number; // body length (world units)
  wid: number; // body width (world units)
  padLen: number; // copper pad length along x (world units)
  padWid: number; // copper pad width along y (world units)
  pads: [Vec3, Vec3];
  color: number;
}

export interface TraceGeom {
  id: string;
  /** Routed polyline through the cloth gaps, pad → pad, in the caller's space. */
  path: Vec3[];
  /** Unit surface normal at each path point (for laying a flat ribbon on the cloth). */
  normals: Vec3[];
}

export interface CircuitGeom {
  components: ComponentGeom[];
  traces: TraceGeom[];
  /** Keys (`min_max`) of the mesh edges any trace runs across — the renderer drops their hinge bridge. */
  crossedEdges: string[];
  /** Flat bbox diagonal — the size base for part footprints and trace width. */
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

  const graph = buildGapGraph(net);
  const faceNrm = new Map<number, Vec3>();
  const faceNormal = (fi: number): Vec3 => {
    let n = faceNrm.get(fi);
    if (!n) {
      const f = net.faces[fi] ?? [0, 0, 0];
      n = norm(cross(sub(coords(f[1]), coords(f[0])), sub(coords(f[2]), coords(f[0]))));
      faceNrm.set(fi, n);
    }
    return n;
  };
  const crossed = new Set<string>();

  const traces = circuit.traces
    .map((t): TraceGeom | null => {
      const fi = byId.get(t.from.comp), ti = byId.get(t.to.comp);
      if (fi == null || ti == null) return null;
      const aFlat = padPos(flat[fi], t.from), bFlat = padPos(flat[ti], t.to);
      const aDisp = padPos(display[fi], t.from), bDisp = padPos(display[ti], t.to);
      const fromFace = circuit.components[fi].face, toFace = circuit.components[ti].face;
      return routeTrace(t.id, graph, fromFace, toFace, aFlat, bFlat, aDisp, bDisp, coords, faceNormal, crossed);
    })
    .filter((t): t is TraceGeom => t !== null);

  return { components: display, traces, crossedEdges: [...crossed], scale: diag };
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
  const len = spec.bodyLen * diag, wid = spec.bodyWid * diag;
  const padLen = spec.padLen * diag, padWid = spec.padWid * diag;
  const half = (spec.padPitch * diag) / 2;
  const pads: [Vec3, Vec3] = [add(center, scale(x, half)), sub(center, scale(x, half))];
  return { id, kind, marker: spec.marker, center, x, y, n, len, wid, padLen, padWid, pads, color: spec.color };
}

const padPos = (g: ComponentGeom, ref: PadRef): Vec3 => g.pads[ref.pad] ?? g.center;

// --- Cloth-gap router --------------------------------------------------------
// The exposed-fabric channels run along every triangle edge and meet at the vertices. We route on
// that 1-skeleton (each edge split at its midpoint) so the trace stays in the gaps and crosses each
// hinge on the shared edge (continuous cloth) — never bridging it.

interface GapEdge { u: number; v: number; key: string; }
interface GapGraph {
  nV: number; // node ids 0..nV-1 are vertices; nV+ei is edge ei's midpoint
  edges: GapEdge[];
  faceEdges: number[][]; // face → its three edge indices
  faceVerts: [number, number, number][];
  vertFaces: number[][]; // vertex → incident faces
  edgeFaces: number[][]; // edge index → incident faces
  pos: Vec3[]; // FLAT position of every node (used for routing distances)
  adj: { to: number; w: number }[][];
}

const edgeKey = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);

function buildGapGraph(net: MeshRef): GapGraph {
  const nV = net.vertices.length;
  const index = new Map<string, number>();
  const edges: GapEdge[] = [];
  const edgeFaces: number[][] = [];
  const faceEdges: number[][] = [];
  const vertFaces: number[][] = Array.from({ length: nV }, () => []);
  net.faces.forEach((f, fi) => {
    const fe: number[] = [];
    const pairs: [number, number][] = [[f[0], f[1]], [f[1], f[2]], [f[2], f[0]]];
    for (const [a, b] of pairs) {
      const key = edgeKey(a, b);
      let ei = index.get(key);
      if (ei == null) {
        ei = edges.length; index.set(key, ei);
        edges.push({ u: Math.min(a, b), v: Math.max(a, b), key });
        edgeFaces.push([]);
      }
      edgeFaces[ei].push(fi);
      fe.push(ei);
    }
    faceEdges.push(fe);
    for (const vtx of f) if (!vertFaces[vtx].includes(fi)) vertFaces[vtx].push(fi);
  });

  const nNodes = nV + edges.length;
  const pos: Vec3[] = new Array(nNodes);
  for (let i = 0; i < nV; i++) pos[i] = flatNode(net, i);
  const adj: { to: number; w: number }[][] = Array.from({ length: nNodes }, () => []);
  edges.forEach((e, ei) => {
    const en = nV + ei;
    const a = pos[e.u], b = pos[e.v];
    pos[en] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const wa = dist2(pos[en], a), wb = dist2(pos[en], b);
    adj[en].push({ to: e.u, w: wa }); adj[e.u].push({ to: en, w: wa });
    adj[en].push({ to: e.v, w: wb }); adj[e.v].push({ to: en, w: wb });
  });
  return { nV, edges, faceEdges, faceVerts: net.faces, vertFaces, edgeFaces, pos, adj };
}

/** Nodes (3 verts + 3 edge mids) of a face, used to splice a pad terminal into the gap graph. */
function faceNodes(g: GapGraph, face: number): number[] {
  const f = g.faceVerts[face], fe = g.faceEdges[face];
  if (!f || !fe) return [];
  return [f[0], f[1], f[2], g.nV + fe[0], g.nV + fe[1], g.nV + fe[2]];
}

/** Dijkstra from pad A to pad B over the gap graph; returns the interior node sequence (or null). */
function shortestGapPath(g: GapGraph, fromFace: number, fromFlat: Vec3, toFace: number, toFlat: Vec3): number[] | null {
  const aNodes = faceNodes(g, fromFace), bNodes = faceNodes(g, toFace);
  if (!aNodes.length || !bNodes.length) return null;
  const N = g.pos.length;
  const SRC = N, DST = N + 1;
  const dist = new Float64Array(N + 2).fill(Infinity);
  const prev = new Int32Array(N + 2).fill(-1);
  const done = new Uint8Array(N + 2);
  const bLeg = new Map<number, number>(); // node → leg cost to DST
  for (const nd of bNodes) bLeg.set(nd, dist2(g.pos[nd], toFlat));

  const heap = new MinHeap();
  dist[SRC] = 0; heap.push(SRC, 0);
  while (heap.size) {
    const u = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    if (u === DST) break;
    const relax = (to: number, w: number): void => {
      const nd = dist[u] + w;
      if (nd < dist[to]) { dist[to] = nd; prev[to] = u; heap.push(to, nd); }
    };
    if (u === SRC) {
      for (const nd of aNodes) relax(nd, dist2(fromFlat, g.pos[nd]));
    } else if (u < N) {
      for (const e of g.adj[u]) relax(e.to, e.w);
      const legB = bLeg.get(u);
      if (legB != null) relax(DST, legB);
    }
  }
  if (prev[DST] < 0) return null;
  const rev: number[] = [];
  for (let n = prev[DST]; n >= 0 && n !== SRC; n = prev[n]) rev.push(n); // only base nodes (skip SRC/DST)
  rev.reverse();
  return rev;
}

/** Build a trace's display geometry: route through the gaps, then map every waypoint into `coords` space. */
function routeTrace(
  id: string, g: GapGraph, fromFace: number, toFace: number,
  aFlat: Vec3, bFlat: Vec3, aDisp: Vec3, bDisp: Vec3,
  coords: CoordsFn, faceNormal: (fi: number) => Vec3, crossed: Set<string>,
): TraceGeom {
  const nA = faceNormal(fromFace), nB = faceNormal(toFace);
  const vertNormal = (v: number): Vec3 => {
    const fs = g.vertFaces[v];
    if (!fs?.length) return nA;
    let acc: Vec3 = [0, 0, 0];
    for (const f of fs) acc = add(acc, faceNormal(f));
    return norm(acc);
  };
  const edgeWaypoint = (ei: number): { pos: Vec3; nrm: Vec3 } => {
    const e = g.edges[ei];
    let acc: Vec3 = [0, 0, 0];
    for (const f of g.edgeFaces[ei]) acc = add(acc, faceNormal(f));
    return { pos: mid(coords(e.u), coords(e.v)), nrm: norm(acc) };
  };

  const path: Vec3[] = [aDisp];
  const normals: Vec3[] = [nA];
  const interior = fromFace === toFace ? [] : shortestGapPath(g, fromFace, aFlat, toFace, bFlat);
  if (interior) {
    for (const node of interior) {
      if (node < g.nV) {
        path.push(coords(node));
        normals.push(vertNormal(node));
      } else {
        const ei = node - g.nV;
        const wp = edgeWaypoint(ei);
        path.push(wp.pos);
        normals.push(wp.nrm);
        crossed.add(g.edges[ei].key);
      }
    }
  }
  path.push(bDisp);
  normals.push(nB);
  return { id, path, normals };
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

// --- binary min-heap (node, key) ---------------------------------------------
class MinHeap {
  private n: number[] = [];
  private k: number[] = [];
  get size(): number { return this.n.length; }
  push(node: number, key: number): void {
    this.n.push(node); this.k.push(key);
    let i = this.n.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= this.k[i]) break;
      this.swap(i, p); i = p;
    }
  }
  pop(): number {
    const top = this.n[0];
    const ln = this.n.pop()!, lk = this.k.pop()!;
    if (this.n.length) {
      this.n[0] = ln; this.k[0] = lk;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let s = i;
        if (l < this.n.length && this.k[l] < this.k[s]) s = l;
        if (r < this.n.length && this.k[r] < this.k[s]) s = r;
        if (s === i) break;
        this.swap(i, s); i = s;
      }
    }
    return top;
  }
  private swap(a: number, b: number): void {
    [this.n[a], this.n[b]] = [this.n[b], this.n[a]];
    [this.k[a], this.k[b]] = [this.k[b], this.k[a]];
  }
}

// --- tiny vec3 helpers -------------------------------------------------------
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const mid = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
const dist2 = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const baryMix = (a: Vec3, b: Vec3, c: Vec3, w: [number, number, number]): Vec3 => [
  w[0] * a[0] + w[1] * b[0] + w[2] * c[0],
  w[0] * a[1] + w[1] * b[1] + w[2] * c[1],
  w[0] * a[2] + w[1] * b[2] + w[2] * c[2],
];
