/**
 * **Model** — the auto-router/planner for the LED electronics tool. Pure: it takes
 * a flat FKLD/FOLD pattern + a {@link Circuit} and returns the routed copper traces
 * ({@link RoutedCircuit}), all in flat millimetres.
 *
 * Routing runs on the dual gap graph from {@link gapGraph}: every trace is a
 * shortest path of centroid → gap-midpoint → centroid hops, so copper only ever
 * crosses a hinge at its midpoint and never jumps a tile that has no shared gap.
 *
 * Two nets only — **PWR** and **GND**. Each LED bridges a gap: one leg on face `a` (the `pwr`
 * side), the other on face `b` (the `gnd` side); copper terminates on the gray tile at the LED's
 * pinched leg pad, never in mid-gap. The router lays two stars from the battery: a `pwr` rail to
 * every LED's `a` leg and a `gnd` rail to every `b` leg, each laterally offset to opposite sides of
 * a shared hinge so coincident rails read apart.
 *
 * **Crossings are allowed.** Copper tape's underside is insulated (adhesive backing), so where two
 * tapes cross they don't short — the rails are laid by independent shortest paths and may freely
 * cross or overlap. No DRC / non-crossing routing is attempted; the output is a fabrication/layout
 * guide (the view/export thicken each polyline into tape rectangles via `tapeQuads`).
 */
import {
  type Circuit,
  type GapEdge,
  type GapGraph,
  type Led,
  type RoutedCircuit,
  type Trace2D,
  type Vec2,
  flatFaces,
  gapForLed,
  gapGraph,
} from "./electronics.js";
import type { FoldFile } from "./fold-file.js";

/** Fraction of a hinge's half-length to push the PWR/GND rails apart at each crossing. */
const RAIL_OFFSET_FRAC = 0.3;

interface Dijkstra {
  dist: number[];
  prev: number[];
}

/** Single-source shortest paths over the gap graph (binary-heap Dijkstra). */
function dijkstra(graph: GapGraph, source: number): Dijkstra {
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

/** Node-index path from `source` (the Dijkstra root) to `target`, or null if unreachable. */
function pathNodes(d: Dijkstra, source: number, target: number): number[] | null {
  if (d.dist[target] === Infinity) return null;
  const out: number[] = [];
  let cur = target;
  while (cur !== -1) {
    out.push(cur);
    if (cur === source) break;
    cur = d.prev[cur]!;
  }
  if (out[out.length - 1] !== source) return null;
  return out.reverse();
}

/**
 * Turn a node path into a flat-mm polyline. `side` shifts gap-midpoint nodes toward one end of
 * their hinge so the PWR/GND rails separate at each crossing.
 */
function polyline(graph: GapGraph, nodes: number[], side: "pwr" | "gnd"): Vec2[] {
  const midToGap = new Map<number, number>();
  graph.gaps.forEach((g, i) => midToGap.set(g.mid, i));
  return nodes.map((node) => {
    const gi = midToGap.get(node);
    if (gi == null) return graph.pos[node]!;
    const gap = graph.gaps[gi]!;
    const [a, b] = gap.ends;
    const toward = side === "pwr" ? a : b;
    const dx = toward.x - gap.point.x;
    const dy = toward.y - gap.point.y;
    return { x: gap.point.x + dx * RAIL_OFFSET_FRAC, y: gap.point.y + dy * RAIL_OFFSET_FRAC };
  });
}

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
  const graph = gapGraph(fold, faces);
  const centroid = (face: number): Vec2 => graph.pos[face] ?? { x: 0, y: 0 };

  const ledPoints = circuit.leds.map((led) => {
    const gap = gapForLed(graph.gaps, led);
    return gap ? gap.point : { x: 0, y: 0 };
  });
  const batteryFace = circuit.battery && circuit.battery.face >= 0 && circuit.battery.face < faces.length
    ? circuit.battery.face
    : null;
  const batteryPoint = batteryFace != null ? centroid(batteryFace) : null;

  const traces: Trace2D[] = [];
  const unreachable: number[] = [];
  const placed = placeLeds(graph, circuit.leds, faces.length, unreachable);
  if (batteryFace == null || placed.length === 0) {
    return { ledPoints, batteryPoint, traces, unreachable };
  }

  planTwoNet(graph, batteryFace, placed, traces, unreachable);
  return { ledPoints, batteryPoint, traces, unreachable };
}

/** Two offset stars from the battery: a `pwr` rail to every LED's `a` leg, a `gnd` rail to its `b` leg. */
function planTwoNet(
  graph: GapGraph,
  battery: number,
  placed: PlacedLed[],
  traces: Trace2D[],
  unreachable: number[],
): void {
  const d = dijkstra(graph, battery);
  for (const p of placed) {
    const pwr = pathNodes(d, battery, p.aFace);
    const gnd = pathNodes(d, battery, p.bFace);
    if (!pwr || !gnd) {
      unreachable.push(p.index); // a leg with no copper path to the battery
      continue;
    }
    const pwrPts = polyline(graph, pwr, "pwr");
    pwrPts.push(p.aLeg);
    traces.push({ net: "pwr", points: pwrPts });
    const gndPts = polyline(graph, gnd, "gnd");
    gndPts.push(p.bLeg);
    traces.push({ net: "gnd", points: gndPts });
  }
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
