/**
 * Cut planning (M2): decide where the cuts go — necessity, connection, routing.
 *
 * Pattern: greedy approximation algorithm + strategy switch. The dart-vs-tuck
 * decision is an explicit `strategy` parameter (the proposal's "dial"); the
 * Steiner-tree connection problem (NP-hard) is approximated by the standard
 * MST-of-metric-closure 2-approximation — exactly "shortest paths along mesh
 * edges" from the algorithm spec.
 *
 * Formulas / rules (kirigamizer_algorithms.tex §4):
 *   necessity:   v needs a cut  ⟺  δ(v) ≠ 0 (and not tucked)
 *   routing:     min_C Σ_{e∈C} (len(e) + λ·vis(e))   [vis ≡ 0 in v1]
 *   sign rule:   δ>0 → dart (cut-degree ≥ 1 suffices: single wedge 2π−δ < 2π)
 *                δ<0 → slit with cut-degree ≥ 2 and every wedge < 2π
 *                (the "wedge rule" — a cut-degree-1 negative vertex keeps a
 *                 wedge of 2π−δ > 2π, which cannot embed flat)
 *
 * The cut set is kept a FOREST (cycles are pruned): cutting a genus-0 surface
 * along a forest keeps every patch a topological disk.
 */

import { edgeLength, faceAngles, vertexWedges } from "./mesh.js";
import { PipelineError, type CutPlan, type DefectReport, type MeshTopology, type TriMesh } from "./types.js";

const TAU = 2 * Math.PI;

export interface PlanOptions {
  /** Seam-visibility weight λ (cost plumbing; vis ≡ 0 in v1). */
  lambda: number;
  /** "dart": cut all defect vertices. "tuck-all": δ>0 vertices become tucks. */
  strategy: "dart" | "tuck-all";
  /** Extra terminals (Q vertex ids) — M5's refine hook. */
  extraTerminals?: number[];
}

export interface ShortestPathResult {
  dist: number[];
  /** prev[v] = edge id used to reach v (or -1). */
  prevEdge: number[];
  prevVertex: number[];
}

/**
 * Dijkstra over mesh vertices from (possibly multiple) sources.
 * Weight of edge e defaults to len(e) + λ·vis(e); vis ≡ 0 in v1.
 */
export function shortestPaths(
  mesh: TriMesh,
  topo: MeshTopology,
  sources: number[],
  weights?: number[],
): ShortestPathResult {
  const n = mesh.vertices.length;
  const w = weights ?? topo.edges.map((_, e) => edgeLength(mesh, topo, e));
  const dist = new Array<number>(n).fill(Infinity);
  const prevEdge = new Array<number>(n).fill(-1);
  const prevVertex = new Array<number>(n).fill(-1);
  // Binary-heap-free O(V²) Dijkstra — fine for coarse meshes.
  const done = new Array<boolean>(n).fill(false);
  for (const s of sources) dist[s] = 0;
  for (;;) {
    let u = -1;
    let best = Infinity;
    for (let v = 0; v < n; v++) {
      if (!done[v] && dist[v] < best) {
        best = dist[v];
        u = v;
      }
    }
    if (u === -1) break;
    done[u] = true;
    for (const e of topo.vertexEdges[u]) {
      const edge = topo.edges[e];
      const v = edge.a === u ? edge.b : edge.a;
      const d = dist[u] + w[e];
      if (d < dist[v] - 1e-12) {
        dist[v] = d;
        prevEdge[v] = e;
        prevVertex[v] = u;
      }
    }
  }
  return { dist, prevEdge, prevVertex };
}

/** Walk prev pointers from v back to the source; returns edge ids. */
function extractPath(res: ShortestPathResult, v: number): number[] {
  const edges: number[] = [];
  let cur = v;
  while (res.prevEdge[cur] !== -1) {
    edges.push(res.prevEdge[cur]);
    cur = res.prevVertex[cur];
  }
  return edges;
}

/** Spanning forest of an edge subset (drops cycle-closing edges). */
function spanningForest(topo: MeshTopology, edgeSet: Set<number>): Set<number> {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const kept = new Set<number>();
  for (const e of edgeSet) {
    const { a, b } = topo.edges[e];
    if (parent.get(a) === undefined) parent.set(a, a);
    if (parent.get(b) === undefined) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      parent.set(ra, rb);
      kept.add(e);
    }
  }
  return kept;
}

/**
 * Plan the cut set: necessity → connection (MST of metric closure) → wedge
 * rule for δ<0 → per-vertex action tags.
 */
export function planCuts(
  mesh: TriMesh,
  topo: MeshTopology,
  defects: DefectReport,
  opts: PlanOptions,
): CutPlan {
  const { lambda, strategy } = opts;
  const n = mesh.vertices.length;
  const weights = topo.edges.map((_, e) => edgeLength(mesh, topo, e)); // + λ·vis(e), vis ≡ 0

  const perVertexAction: CutPlan["perVertexAction"] = new Array(n).fill("none");
  const cutTerminals: number[] = [];
  for (let v = 0; v < n; v++) {
    const cls = defects.classes[v];
    if (cls === "positive") {
      if (strategy === "tuck-all") {
        perVertexAction[v] = "tuck";
      } else {
        perVertexAction[v] = "dart";
        cutTerminals.push(v);
      }
    } else if (cls === "negative") {
      perVertexAction[v] = "slit"; // tucking cannot supply missing angle
      cutTerminals.push(v);
    }
  }
  for (const v of opts.extraTerminals ?? []) {
    if (!cutTerminals.includes(v) && !topo.boundaryVertices.has(v)) cutTerminals.push(v);
  }

  const hasBoundary = topo.boundaryVertices.size > 0;
  const cutSet = new Set<number>();

  if (cutTerminals.length > 0) {
    // --- Connection: MST of the terminals' metric closure -----------------
    // Boundary acts as one extra pseudo-terminal reachable at the distance to
    // the nearest boundary vertex (multi-source Dijkstra).
    const sols = new Map<number, ShortestPathResult>();
    for (const t of cutTerminals) sols.set(t, shortestPaths(mesh, topo, [t], weights));
    const boundarySol = hasBoundary
      ? shortestPaths(mesh, topo, [...topo.boundaryVertices], weights)
      : null;

    type Node = number | "boundary";
    const nodes: Node[] = hasBoundary ? [...cutTerminals, "boundary"] : [...cutTerminals];
    const distOf = (u: Node, v: Node): number => {
      if (u === "boundary") return boundarySol!.dist[v as number];
      if (v === "boundary") return boundarySol!.dist[u as number];
      return sols.get(u)!.dist[v];
    };
    // Prim's MST over the closure.
    const inTree = new Set<Node>([nodes[0]]);
    const mstPairs: [Node, Node][] = [];
    while (inTree.size < nodes.length) {
      let bestPair: [Node, Node] | null = null;
      let best = Infinity;
      for (const u of inTree) {
        for (const v of nodes) {
          if (inTree.has(v)) continue;
          const d = distOf(u, v);
          if (d < best) {
            best = d;
            bestPair = [u, v];
          }
        }
      }
      if (!bestPair || !Number.isFinite(best)) {
        throw new PipelineError("plan-cuts", "mesh is disconnected — cannot connect cut terminals");
      }
      mstPairs.push(bestPair);
      inTree.add(bestPair[1]);
    }
    // Expand MST pairs to mesh-edge paths.
    for (const [u, v] of mstPairs) {
      let path: number[];
      if (u === "boundary") path = extractPath(boundarySol!, v as number);
      else if (v === "boundary") path = extractPath(boundarySol!, u);
      else path = extractPath(sols.get(u)!, v);
      for (const e of path) cutSet.add(e);
    }
    // Path unions can close cycles — prune to a forest.
    const forest = spanningForest(topo, cutSet);
    cutSet.clear();
    for (const e of forest) cutSet.add(e);

    // Single isolated terminal on a closed mesh (|terminals|=1, no boundary):
    // the MST is a lone vertex with no edges, but necessity still demands an
    // incident cut edge (a dangling slit) so the vertex becomes boundary.
    if (cutSet.size === 0 && cutTerminals.length === 1) {
      let bestE = -1;
      let best = Infinity;
      for (const e of topo.vertexEdges[cutTerminals[0]]) {
        if (weights[e] < best) {
          best = weights[e];
          bestE = e;
        }
      }
      cutSet.add(bestE);
    }
  }

  // --- Wedge rule: every wedge at a δ<0 vertex must span < 2π -------------
  // A δ<0 vertex carries total angle 2π−δ > 2π. With cut-degree ≤ 1 it keeps
  // a single wedge of that full angle (cut endpoints don't split fans), so we
  // add separators through the middle of the worst wedge until all embed.
  const WEDGE_MARGIN = 1e-9;
  for (let v = 0; v < n; v++) {
    if (defects.classes[v] !== "negative") continue;
    let guard = 0;
    for (;;) {
      const wedges = vertexWedges(mesh, topo, v, (e) => cutSet.has(e));
      const worst = wedges.reduce((a, b) => (b.angle > a.angle ? b : a), wedges[0]);
      if (wedges.length >= 2 && worst.angle < TAU - WEDGE_MARGIN) break;
      if (++guard > topo.vertexEdges[v].length) {
        throw new PipelineError("plan-cuts", `wedge rule failed to converge at vertex ${v}`, { vertex: v });
      }
      cutSet.add(splitEdgeForWedge(mesh, topo, v, worst, cutSet));
    }
  }

  const cutEdges = [...cutSet].sort((a, b) => a - b);
  const lengthCost = cutEdges.reduce((acc, e) => acc + edgeLength(mesh, topo, e), 0);
  return {
    cutEdges,
    perVertexAction,
    cost: { length: lengthCost, visibility: 0, lambda },
  };
}

/**
 * Pick the not-yet-cut separator edge nearest the angular middle of `wedge`
 * at vertex v. Separator candidates are the edges between consecutive wedge
 * faces (interior to the wedge by construction).
 */
function splitEdgeForWedge(
  mesh: TriMesh,
  topo: MeshTopology,
  v: number,
  wedge: { faces: number[]; angle: number },
  cutSet: Set<number>,
): number {
  const half = wedge.angle / 2;
  let acc = 0;
  let fallback = -1;
  for (let i = 0; i < wedge.faces.length - 1; i++) {
    const f = wedge.faces[i];
    const g = wedge.faces[i + 1];
    acc += faceAngles(mesh, f)[mesh.faces[f].indexOf(v)];
    const shared = mesh.faces[f].filter((x) => mesh.faces[g].includes(x) && x !== v)[0];
    const e = topo.edgeIndex.get(shared < v ? `${shared}_${v}` : `${v}_${shared}`)!;
    if (cutSet.has(e)) continue;
    if (acc >= half) return e;
    fallback = e;
  }
  if (fallback === -1) {
    throw new PipelineError("plan-cuts", `no splittable edge in wedge at vertex ${v}`, { vertex: v });
  }
  return fallback;
}
