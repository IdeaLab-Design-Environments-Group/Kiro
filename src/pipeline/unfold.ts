/**
 * Seamed unfolding (M3): cut Q along the planned forest and flatten each
 * developable patch isometrically; add relief cuts until the layout embeds.
 *
 * Pattern: functional core + bounded iterative-refinement loop (the relief
 * loop), with the overlap predicate exported pure for isolated testing.
 *
 * Layout formula (BFS over the face dual; all lengths are 3D rest lengths,
 * so the layout is isometric by construction): placing the third vertex c of
 * a face across placed edge (a,b),
 *     x = (l_ac² + l_ab² − l_bc²) / (2·l_ab)
 *     y = √(max(0, l_ac² − x²))
 *     p_c = p_a + x·û ± y·n̂,   û = (p_b−p_a)/l_ab, n̂ = û rotated 90°,
 * sign chosen so c lands on the side opposite the already-placed face
 * (unfolding flattens the dihedral to zero).
 *
 * Topology: cutting splits each vertex into one copy per fan wedge
 * (separators = cut edges; slit ENDPOINTS keep a single wedge — they don't
 * split, which is why δ<0 vertices need the M2 wedge rule). Provenance is
 * recorded in `origVertex` (cut/flat vertex → Q vertex) and cut edges in
 * `lips` (the two boundary copies that must rejoin when folded).
 */

import { distance } from "../core/vec3.js";
import { edgeKey, edgeLength, vertexWedges } from "./mesh.js";
import { shortestPaths } from "./plan-cuts.js";
import {
  PipelineError,
  type CutPlan,
  type LipPair,
  type MeshTopology,
  type TriMesh,
  type UnfoldResult,
  type Vec2,
} from "./types.js";

/** Hard cap on relief-loop iterations (each adds ≥1 cut edge, so ≤E anyway). */
export const RELIEF_MAX = 64;

/** Relative tolerance for the developability audit (per edge length). */
const AUDIT_REL = 1e-6;

export interface CutMesh {
  mesh: TriMesh;
  /** cut vertex → source (Q) vertex. */
  origVertex: number[];
  lips: LipPair[];
}

/**
 * Split the mesh along `cutEdges`: one vertex copy per fan wedge. Boundary
 * source edges in the cut set are ignored (already boundary). Returns a fresh
 * mesh — re-derive topology, never mutate.
 */
export function cutAlongEdges(mesh: TriMesh, topo: MeshTopology, cutEdges: number[]): CutMesh {
  const cutSet = new Set(cutEdges.filter((e) => topo.edges[e].faces.length === 2));
  const isCut = (e: number): boolean => cutSet.has(e);

  const vertices: TriMesh["vertices"] = [];
  const origVertex: number[] = [];
  /** cornerCopy.get(`${f}_${v}`) → cut-mesh vertex id for face f's corner at v. */
  const cornerCopy = new Map<string, number>();

  for (let v = 0; v < mesh.vertices.length; v++) {
    const wedges = vertexWedges(mesh, topo, v, isCut);
    for (const wedge of wedges) {
      const id = vertices.length;
      vertices.push({ ...mesh.vertices[v] });
      origVertex.push(v);
      for (const f of wedge.faces) cornerCopy.set(`${f}_${v}`, id);
    }
  }

  const faces = mesh.faces.map(
    (fv, f) => fv.map((v) => cornerCopy.get(`${f}_${v}`)!) as [number, number, number],
  );

  const lips: LipPair[] = [];
  for (const e of cutSet) {
    const { a, b, faces: ef } = topo.edges[e];
    const [f1, f2] = ef;
    lips.push({
      sourceEdge: e,
      lipA: [cornerCopy.get(`${f1}_${a}`)!, cornerCopy.get(`${f1}_${b}`)!],
      lipB: [cornerCopy.get(`${f2}_${a}`)!, cornerCopy.get(`${f2}_${b}`)!],
    });
  }

  return { mesh: { vertices, faces }, origVertex, lips };
}

const cross2 = (ax: number, ay: number, bx: number, by: number): number => ax * by - ay * bx;

/**
 * BFS isometric layout of one connected patch of the cut mesh. Throws
 * PipelineError("unfold") when a non-tree placement disagrees — that means
 * the patch is not developable, i.e. a planner bug, not a relief case.
 */
export function unfoldPatch(cut: CutMesh, patchFaces: number[]): Vec2[] {
  const { mesh } = cut;
  const flat: (Vec2 | null)[] = new Array(mesh.vertices.length).fill(null);
  const inPatch = new Set(patchFaces);

  // Face adjacency over shared (undirected) edges, limited to the patch.
  const edgeFaces = new Map<string, number[]>();
  for (const f of patchFaces) {
    const [i, j, k] = mesh.faces[f];
    for (const [a, b] of [[i, j], [j, k], [k, i]] as [number, number][]) {
      const key = edgeKey(a, b);
      const list = edgeFaces.get(key) ?? [];
      list.push(f);
      edgeFaces.set(key, list);
    }
  }

  const d3 = (a: number, b: number): number => distance(mesh.vertices[a], mesh.vertices[b]);

  // Seed: first face at the origin, first edge along +x, third vertex at +y.
  const f0 = patchFaces[0];
  const [s0, s1, s2] = mesh.faces[f0];
  const l01 = d3(s0, s1);
  flat[s0] = { x: 0, y: 0 };
  flat[s1] = { x: l01, y: 0 };
  {
    const lac = d3(s0, s2);
    const lbc = d3(s1, s2);
    const x = (lac * lac + l01 * l01 - lbc * lbc) / (2 * l01);
    const y = Math.sqrt(Math.max(0, lac * lac - x * x));
    flat[s2] = { x, y };
  }

  const placeAcross = (a: number, b: number, c: number, oppositeTo: number): Vec2 => {
    const pa = flat[a]!;
    const pb = flat[b]!;
    const lab = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    const lac = d3(a, c);
    const lbc = d3(b, c);
    const x = (lac * lac + lab * lab - lbc * lbc) / (2 * lab);
    const y = Math.sqrt(Math.max(0, lac * lac - x * x));
    const ux = (pb.x - pa.x) / lab;
    const uy = (pb.y - pa.y) / lab;
    // n̂ = û rotated +90°; choose the sign putting c opposite `oppositeTo`.
    const po = flat[oppositeTo]!;
    const sideO = cross2(pb.x - pa.x, pb.y - pa.y, po.x - pa.x, po.y - pa.y);
    const sign = sideO > 0 ? -1 : 1;
    return { x: pa.x + x * ux + sign * y * -uy, y: pa.y + x * uy + sign * y * ux };
  };

  const visited = new Set<number>([f0]);
  const queue: number[] = [f0];
  while (queue.length > 0) {
    const f = queue.shift()!;
    const [i, j, k] = mesh.faces[f];
    for (const [a, b, c] of [[i, j, k], [j, k, i], [k, i, j]] as [number, number, number][]) {
      for (const g of edgeFaces.get(edgeKey(a, b)) ?? []) {
        if (g === f || visited.has(g) || !inPatch.has(g)) continue;
        const gc = mesh.faces[g].find((v) => v !== a && v !== b)!;
        const pos = placeAcross(a, b, gc, c);
        if (flat[gc] === null) {
          flat[gc] = pos;
        } else {
          const err = Math.hypot(flat[gc]!.x - pos.x, flat[gc]!.y - pos.y);
          const scale = Math.max(d3(a, gc), d3(b, gc), 1e-12);
          if (err > AUDIT_REL * scale * 10) {
            throw new PipelineError(
              "unfold",
              `developability audit failed: vertex ${gc} placed inconsistently (err ${err.toExponential(2)} mm) — patch is not developable (planner bug)`,
              { vertex: gc, err },
            );
          }
        }
        visited.add(g);
        queue.push(g);
      }
    }
  }

  // Audit: every patch edge's flat length must equal its 3D rest length.
  for (const [key, fs] of edgeFaces) {
    if (fs.length === 0) continue;
    const [a, b] = key.split("_").map(Number);
    const pa = flat[a];
    const pb = flat[b];
    if (!pa || !pb) {
      throw new PipelineError("unfold", `patch vertex ${pa ? b : a} never placed — patch not edge-connected`);
    }
    const lFlat = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    const l3 = d3(a, b);
    if (Math.abs(lFlat - l3) > AUDIT_REL * Math.max(l3, 1e-12) * 10) {
      throw new PipelineError("unfold", `isometry audit failed on edge ${key}: flat ${lFlat} vs rest ${l3}`);
    }
  }

  return flat.map((p) => p ?? { x: 0, y: 0 });
}

/**
 * SAT overlap test for two triangles, each shrunk by `eps` toward its
 * centroid so adjacent triangles sharing vertices/edges never false-positive.
 */
export function trianglesOverlap(a: Vec2[], b: Vec2[], eps = 1e-6): boolean {
  const shrink = (t: Vec2[]): Vec2[] => {
    const cx = (t[0].x + t[1].x + t[2].x) / 3;
    const cy = (t[0].y + t[1].y + t[2].y) / 3;
    return t.map((p) => ({ x: cx + (p.x - cx) * (1 - eps), y: cy + (p.y - cy) * (1 - eps) }));
  };
  const A = shrink(a);
  const B = shrink(b);
  const axes: Vec2[] = [];
  for (const t of [A, B]) {
    for (let i = 0; i < 3; i++) {
      const p = t[i];
      const q = t[(i + 1) % 3];
      axes.push({ x: -(q.y - p.y), y: q.x - p.x });
    }
  }
  for (const axis of axes) {
    let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
    for (const p of A) {
      const d = p.x * axis.x + p.y * axis.y;
      minA = Math.min(minA, d);
      maxA = Math.max(maxA, d);
    }
    for (const p of B) {
      const d = p.x * axis.x + p.y * axis.y;
      minB = Math.min(minB, d);
      maxB = Math.max(maxB, d);
    }
    if (maxA < minB || maxB < minA) return false; // separating axis found
  }
  return true;
}

/**
 * First overlapping face pair in the flat layout (BFS-order indices into
 * `faces`), or null. Pairs sharing a vertex articulate legally and are skipped.
 */
export function findSelfOverlap(
  flat: Vec2[],
  faces: [number, number, number][],
): [number, number] | null {
  const tris = faces.map((f) => f.map((v) => flat[v]) as Vec2[]);
  const boxes = tris.map((t) => ({
    minX: Math.min(t[0].x, t[1].x, t[2].x),
    maxX: Math.max(t[0].x, t[1].x, t[2].x),
    minY: Math.min(t[0].y, t[1].y, t[2].y),
    maxY: Math.max(t[0].y, t[1].y, t[2].y),
  }));
  for (let i = 0; i < faces.length; i++) {
    for (let j = i + 1; j < faces.length; j++) {
      if (faces[i].some((v) => faces[j].includes(v))) continue; // share a vertex
      const a = boxes[i];
      const b = boxes[j];
      if (a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY) continue;
      if (trianglesOverlap(tris[i], tris[j])) return [i, j];
    }
  }
  return null;
}

/**
 * Cut → flatten (per patch) → relief loop. Cutting may legitimately
 * disconnect the surface (a slit vertex can be a patch's only articulation),
 * so each connected component is laid out independently; overlap is tested
 * within patches only (the M4 packer translates patches apart). Each relief
 * pass adds ≥1 interior edge to the cut set, hard-capped at RELIEF_MAX.
 */
export function seamedUnfold(mesh: TriMesh, topo: MeshTopology, plan: CutPlan): UnfoldResult {
  const cutSet = new Set(plan.cutEdges);
  const reliefEdges: number[] = [];

  for (let pass = 0; pass <= RELIEF_MAX; pass++) {
    const cut = cutAlongEdges(mesh, topo, [...cutSet]);
    const components = labelComponents(cut.mesh);

    // Lay out every patch into one global flat array.
    const flat: Vec2[] = new Array(cut.mesh.vertices.length).fill(null).map(() => ({ x: 0, y: 0 }));
    const patchFaceIds: number[][] = Array.from({ length: components.count }, () => []);
    for (let f = 0; f < cut.mesh.faces.length; f++) patchFaceIds[components.label[f]].push(f);
    for (const faceIds of patchFaceIds) {
      const local = unfoldPatch(cut, faceIds);
      const touched = new Set<number>();
      for (const f of faceIds) for (const v of cut.mesh.faces[f]) touched.add(v);
      for (const v of touched) flat[v] = local[v];
    }

    // Overlap detection per patch (cross-patch overlap is meaningless here).
    let overlap: [number, number] | null = null;
    for (const faceIds of patchFaceIds) {
      const subset = faceIds.map((f) => cut.mesh.faces[f]);
      const o = findSelfOverlap(flat, subset);
      if (o !== null) {
        overlap = [faceIds[o[0]], faceIds[o[1]]];
        break;
      }
    }

    if (overlap === null) {
      const totalCutLength = [...cutSet].reduce((acc, e) => acc + edgeLength(mesh, topo, e), 0);
      return {
        flat,
        faces: cut.mesh.faces,
        patchOfFace: components.label,
        patchCount: components.count,
        origVertex: cut.origVertex,
        lips: cut.lips,
        reliefEdges: [...reliefEdges],
        totalCutLength,
      };
    }

    if (pass === RELIEF_MAX) {
      throw new PipelineError(
        "unfold",
        `relief loop exceeded RELIEF_MAX=${RELIEF_MAX} passes; last overlapping face pair: ${overlap[0]}, ${overlap[1]}`,
        { overlap },
      );
    }

    const added = addReliefCut(mesh, topo, cut, flat, overlap, cutSet);
    reliefEdges.push(...added);
  }
  /* istanbul ignore next */
  throw new PipelineError("unfold", "unreachable");
}

/** Face-connectivity labeling over shared edges of a TriMesh. */
function labelComponents(mesh: TriMesh): { count: number; label: number[] } {
  const edgeFaces = new Map<string, number[]>();
  for (let f = 0; f < mesh.faces.length; f++) {
    const [i, j, k] = mesh.faces[f];
    for (const [a, b] of [[i, j], [j, k], [k, i]] as [number, number][]) {
      const key = edgeKey(a, b);
      const list = edgeFaces.get(key) ?? [];
      list.push(f);
      edgeFaces.set(key, list);
    }
  }
  const label = new Array<number>(mesh.faces.length).fill(-1);
  let count = 0;
  for (let seed = 0; seed < mesh.faces.length; seed++) {
    if (label[seed] !== -1) continue;
    const queue = [seed];
    label[seed] = count;
    while (queue.length > 0) {
      const f = queue.pop()!;
      const [i, j, k] = mesh.faces[f];
      for (const [a, b] of [[i, j], [j, k], [k, i]] as [number, number][]) {
        for (const g of edgeFaces.get(edgeKey(a, b)) ?? []) {
          if (label[g] === -1) {
            label[g] = count;
            queue.push(g);
          }
        }
      }
    }
    count++;
  }
  return { count, label };
}

/**
 * Relief: route the shortest interior source-mesh path from the existing cut
 * graph / boundary to a source vertex of the later overlapping face, so the
 * overlapping limb swings away on the next unfold. Returns the edges added.
 */
function addReliefCut(
  mesh: TriMesh,
  topo: MeshTopology,
  cut: CutMesh,
  flat: Vec2[],
  overlap: [number, number],
  cutSet: Set<number>,
): number[] {
  const [, f2] = overlap; // later face in BFS order — the limb to free
  const tri = cut.mesh.faces[f2];
  const cx = (flat[tri[0]].x + flat[tri[1]].x + flat[tri[2]].x) / 3;
  const cy = (flat[tri[0]].y + flat[tri[1]].y + flat[tri[2]].y) / 3;

  // Sources: every vertex already on the cut graph or the mesh boundary.
  const sources = new Set<number>();
  for (const e of cutSet) {
    sources.add(topo.edges[e].a);
    sources.add(topo.edges[e].b);
  }
  for (const v of topo.boundaryVertices) sources.add(v);

  const res = shortestPaths(mesh, topo, [...sources]);

  // Candidate targets: f2's source vertices ordered by flat distance to the
  // overlap centroid; take the first yielding a non-empty path of new edges.
  const candidates = [...tri]
    .map((v) => ({ src: cut.origVertex[v], d: Math.hypot(flat[v].x - cx, flat[v].y - cy) }))
    .sort((p, q) => p.d - q.d);

  for (const { src } of candidates) {
    const path: number[] = [];
    let cur = src;
    while (res.prevEdge[cur] !== -1) {
      path.push(res.prevEdge[cur]);
      cur = res.prevVertex[cur];
    }
    const fresh = path.filter((e) => !cutSet.has(e) && topo.edges[e].faces.length === 2);
    if (fresh.length > 0) {
      for (const e of fresh) cutSet.add(e);
      return fresh;
    }
  }

  // All three vertices already touch the cut graph: free the face itself by
  // cutting its shortest not-yet-cut interior edge.
  let bestE = -1;
  let best = Infinity;
  for (const [a, b] of [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]]) {
    const e = topo.edgeIndex.get(edgeKey(cut.origVertex[a], cut.origVertex[b]));
    if (e === undefined || cutSet.has(e) || topo.edges[e].faces.length !== 2) continue;
    const l = edgeLength(mesh, topo, e);
    if (l < best) {
      best = l;
      bestE = e;
    }
  }
  if (bestE === -1) {
    throw new PipelineError("unfold", "relief cut: no addable edge near overlap", { overlap });
  }
  cutSet.add(bestE);
  return [bestE];
}
