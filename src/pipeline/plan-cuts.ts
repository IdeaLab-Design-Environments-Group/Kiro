/**
 * Cut planning (M2/K2): decide where the cuts go — necessity, connection,
 * routing — under the PROPER-KIRIGAMI invariant: the cut sheet must stay one
 * connected piece.
 *
 * Pattern: greedy approximation algorithm + strategy switch. The dart-vs-tuck
 * decision is an explicit `strategy` parameter (the proposal's "dial"); the
 * Steiner-tree connection problem (NP-hard) is approximated by the standard
 * MST-of-metric-closure 2-approximation — exactly "shortest paths along mesh
 * edges" from the algorithm spec.
 *
 * Formulas / rules (kirigamizer_algorithms.tex §4 + K1 vents):
 *   necessity:   v needs a cut  ⟺  δ(v) ≠ 0 (and not tucked)
 *   routing:     min_C Σ_{e∈C} (len(e) + λ·vis(e))   [vis ≡ 0 in v1]
 *   sign rule:   δ>0 → dart (cut-degree ≥ 1: the dart gap of angle δ closes
 *                when folded);
 *                δ<0 → slit reaching v (cut-degree ≥ 1) + a VENT sliver of
 *                angle |δ| removed in the unfold (K1) — the old "wedge rule"
 *                (cut-degree ≥ 2 splitting the fan) is obsolete: the vent
 *                supplies the 2π closure without tearing the sheet.
 *
 * Connectivity: the cut set is a FOREST (cycles pruned) touching the mesh
 * boundary at most ONCE (the boundary pseudo-terminal joins the MST exactly
 * once, and terminal-to-terminal paths are forbidden from passing THROUGH
 * boundary vertices) — a tree with ≤1 boundary contact never disconnects.
 */

import { edgeLength } from "./mesh.js";
import { PipelineError, type CutPlan, type DefectReport, type MeshTopology, type TriMesh } from "./types.js";

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
 * Vertices in `noTransit` may be reached (as path endpoints) but are never
 * expanded — paths cannot pass THROUGH them (K2: keeps interior cut paths
 * off the boundary so the sheet cannot be torn boundary-to-boundary).
 */
export function shortestPaths(
  mesh: TriMesh,
  topo: MeshTopology,
  sources: number[],
  weights?: number[],
  noTransit?: Set<number>,
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
    if (noTransit?.has(u) && dist[u] > 0) continue; // reachable, not expandable
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
 * Plan the cut set: necessity → connection (MST of metric closure, ≤1
 * boundary attachment, interior paths never transit the boundary) →
 * per-vertex action tags. δ<0 closure is handled by K1 vents in the unfold.
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
    // Terminal-to-terminal paths must not pass THROUGH boundary vertices
    // (K2 connectivity: a cut path transiting the boundary tears the sheet).
    const sols = new Map<number, ShortestPathResult>();
    for (const t of cutTerminals) {
      sols.set(t, shortestPaths(mesh, topo, [t], weights, topo.boundaryVertices));
    }
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

  // δ<0 closure: handled by K1 VENTS in the unfold — a slit reaching v
  // (cut-degree ≥ 1, guaranteed: every terminal is on the tree or its
  // dangling-slit special case) plus a sliver of |δ| removed makes the flat
  // material at v exactly 2π. No fan-splitting wedge rule, no extra tears.

  const cutEdges = [...cutSet].sort((a, b) => a - b);
  const lengthCost = cutEdges.reduce((acc, e) => acc + edgeLength(mesh, topo, e), 0);
  return {
    cutEdges,
    perVertexAction,
    cost: { length: lengthCost, visibility: 0, lambda },
  };
}

