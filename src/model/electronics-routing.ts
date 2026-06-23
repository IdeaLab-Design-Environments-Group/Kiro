/**
 * **Model** — the auto-router/planner for the LED electronics tool. Pure: it takes
 * a flat FKLD/FOLD pattern + a {@link Circuit} and returns the routed copper traces
 * ({@link RoutedCircuit}), all in flat millimetres.
 *
 * Two nets only — **PWR** and **GND**. Each LED bridges a gap: one leg on face `a` (the `pwr`
 * side), the other on face `b` (the `gnd` side); copper terminates on the gray tile at the LED's
 * pinched leg pad.
 *
 * **Organized, in-body bus routing.** Routes run on the {@link faceRouteGraph} (face centroids linked
 * across every interior edge), so copper **stays strictly inside the body** — a trace can cross tiles
 * and gaps but never flies out into empty space the way a free straight line did. From the battery we
 * grow a shortest-path **tree** per net (PWR to every `a` leg, GND to every `b` leg): branches share
 * common trunks instead of fanning out as overlapping wedges, giving the clean bus look of hand-laid
 * copper tape. The two nets are offset to opposite sides of each shared run so they read as parallel
 * strips. Crossings are still allowed (insulated tape underside); no DRC is attempted.
 */
import {
  type Circuit,
  type GapEdge,
  type GapGraph,
  type Led,
  type RouteGraph,
  type RoutedCircuit,
  type Trace2D,
  type Vec2,
  faceRouteGraph,
  flatFaces,
  gapForLed,
  gapGraph,
} from "./electronics.js";
import type { FoldFile } from "./fold-file.js";

/** One placed LED resolved to its gap + the two tiles/legs its copper must reach. */
interface PlacedLed {
  index: number; // index into circuit.leds (for unreachable reporting)
  gap: GapEdge;
  /** Face carrying the `pwr` leg, and its leg pad (flat mm). */
  aFace: number;
  aLeg: Vec2;
  /** Face carrying the `gnd` leg, and its leg pad (flat mm). */
  bFace: number;
  bLeg: Vec2;
}

/** Resolve each authored LED to its gap; LEDs whose gap no longer exists are reported unreachable. */
function placeLeds(graph: GapGraph, leds: Led[], faceCount: number, unreachable: number[]): PlacedLed[] {
  const placed: PlacedLed[] = [];
  leds.forEach((led, index) => {
    const inRange = led.a >= 0 && led.a < faceCount && led.b >= 0 && led.b < faceCount;
    const gap = inRange ? gapForLed(graph.gaps, led) : null;
    if (!gap) {
      unreachable.push(index);
      return;
    }
    // Orient: leg `a` follows the LED's own `a` face so the +/− assignment stays stable.
    const aIsFaceA = gap.faceA === led.a;
    placed.push({
      index,
      gap,
      aFace: led.a,
      aLeg: aIsFaceA ? gap.legA : gap.legB,
      bFace: led.b,
      bLeg: aIsFaceA ? gap.legB : gap.legA,
    });
  });
  return placed;
}

/** Plan the copper routes for `circuit` over the flat pattern in `fold`. */
export function planRoutes(fold: FoldFile, circuit: Circuit): RoutedCircuit {
  const faces = flatFaces(fold);
  const gaps = gapGraph(fold, faces);
  const graph = faceRouteGraph(fold, faces);
  const centroid = (face: number): Vec2 => faces[face]?.centroid ?? { x: 0, y: 0 };

  const ledPoints = circuit.leds.map((led) => {
    const gap = gapForLed(gaps.gaps, led);
    return gap ? gap.point : { x: 0, y: 0 };
  });
  const batteryFace = circuit.battery && circuit.battery.face >= 0 && circuit.battery.face < faces.length
    ? circuit.battery.face
    : null;
  const batteryPoint = batteryFace != null ? centroid(batteryFace) : null;

  const traces: Trace2D[] = [];
  const unreachable: number[] = [];
  const placed = placeLeds(gaps, circuit.leds, faces.length, unreachable);
  if (batteryFace == null || placed.length === 0) {
    return { ledPoints, batteryPoint, traces, unreachable };
  }

  planTwoNet(graph, batteryFace, placed, traces, unreachable);
  return { ledPoints, batteryPoint, traces, unreachable };
}

/**
 * Grow a shortest-path tree from the battery on the in-body graph and emit it as offset bus strips:
 * PWR to every `a` leg (offset +), GND to every `b` leg (offset −). Shared tree edges are emitted
 * once, so branches that share a trunk read as a single strip. A short stub joins each tile to its
 * LED leg pad. LEDs whose leg-tile can't be reached in the body are reported unreachable.
 */
function planTwoNet(
  graph: RouteGraph,
  battery: number,
  placed: PlacedLed[],
  traces: Trace2D[],
  unreachable: number[],
): void {
  const dj = dijkstra(graph, battery);
  const off = railOffset(graph);

  const pwrTargets: { face: number; leg: Vec2 }[] = [];
  const gndTargets: { face: number; leg: Vec2 }[] = [];
  for (const p of placed) {
    if (dj.dist[p.aFace] === Infinity || dj.dist[p.bFace] === Infinity) {
      unreachable.push(p.index); // a leg tile is cut off from the battery within the body
      continue;
    }
    pwrTargets.push({ face: p.aFace, leg: p.aLeg });
    gndTargets.push({ face: p.bFace, leg: p.bLeg });
  }
  emitTree(graph, dj, battery, pwrTargets, "pwr", +off, traces);
  emitTree(graph, dj, battery, gndTargets, "gnd", -off, traces);
}

/** Lateral offset (flat mm) that separates the PWR/GND strips — relative to the pattern size. */
function railOffset(graph: RouteGraph): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of graph.pos) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const diag = Math.hypot(maxX - minX, maxY - minY) || 1;
  return diag * 0.006;
}

/** Emit a net's shortest-path tree (deduped edges) + leg stubs, each offset perpendicular by `off`. */
function emitTree(
  graph: RouteGraph,
  dj: Dijkstra,
  battery: number,
  targets: { face: number; leg: Vec2 }[],
  net: "pwr" | "gnd",
  off: number,
  traces: Trace2D[],
): void {
  const edges = new Map<string, [number, number]>();
  for (const t of targets) {
    let cur = t.face;
    while (cur !== battery) {
      const prev = dj.prev[cur]!;
      if (prev === -1) break;
      const key = cur < prev ? `${cur}_${prev}` : `${prev}_${cur}`;
      if (!edges.has(key)) edges.set(key, [Math.min(cur, prev), Math.max(cur, prev)]);
      cur = prev;
    }
  }
  for (const [, [u, v]] of edges) {
    traces.push({ net, points: offsetSeg(graph.pos[u]!, graph.pos[v]!, off) });
  }
  // Stubs onto the actual leg pads (so copper reaches each LED's tile, not just the centroid).
  for (const t of targets) {
    traces.push({ net, points: offsetSeg(graph.pos[t.face]!, t.leg, off) });
  }
}

/** Two-point segment offset perpendicular by `off` (parallel strip for the two nets). */
function offsetSeg(a: Vec2, b: Vec2, off: number): Vec2[] {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l = Math.hypot(dx, dy) || 1;
  const nx = (-dy / l) * off, ny = (dx / l) * off;
  return [{ x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny }];
}

interface Dijkstra {
  dist: number[];
  prev: number[];
}

/** Single-source shortest paths over the route graph (binary-heap Dijkstra). */
function dijkstra(graph: RouteGraph, source: number): Dijkstra {
  const n = graph.pos.length;
  const dist = new Array<number>(n).fill(Infinity);
  const prev = new Array<number>(n).fill(-1);
  dist[source] = 0;
  const heap = new MinHeap();
  heap.push(source, 0);
  while (heap.size > 0) {
    const u = heap.pop();
    const du = dist[u]!;
    for (const { to, w } of graph.adj[u]!) {
      const nd = du + w;
      if (nd < dist[to]!) {
        dist[to] = nd;
        prev[to] = u;
        heap.push(to, nd);
      }
    }
  }
  return { dist, prev };
}

/** Minimal binary min-heap keyed by priority (lazy-deletion: stale entries skipped by caller dist). */
class MinHeap {
  private nodes: number[] = [];
  private prio: number[] = [];

  get size(): number {
    return this.nodes.length;
  }

  push(node: number, priority: number): void {
    this.nodes.push(node);
    this.prio.push(priority);
    this.bubbleUp(this.nodes.length - 1);
  }

  pop(): number {
    const top = this.nodes[0]!;
    const lastN = this.nodes.pop()!;
    const lastP = this.prio.pop()!;
    if (this.nodes.length > 0) {
      this.nodes[0] = lastN;
      this.prio[0] = lastP;
      this.bubbleDown(0);
    }
    return top;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.prio[parent]! <= this.prio[i]!) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  private bubbleDown(i: number): void {
    const n = this.nodes.length;
    for (;;) {
      const l = 2 * i + 1, r = 2 * i + 2;
      let small = i;
      if (l < n && this.prio[l]! < this.prio[small]!) small = l;
      if (r < n && this.prio[r]! < this.prio[small]!) small = r;
      if (small === i) break;
      this.swap(i, small);
      i = small;
    }
  }

  private swap(a: number, b: number): void {
    [this.nodes[a], this.nodes[b]] = [this.nodes[b]!, this.nodes[a]!];
    [this.prio[a], this.prio[b]] = [this.prio[b]!, this.prio[a]!];
  }
}
