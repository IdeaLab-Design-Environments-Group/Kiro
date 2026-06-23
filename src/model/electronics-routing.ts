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
 * pinched leg pad. From the battery's two terminals the router runs a **direct (straight) tape** to
 * each LED's `a` leg (PWR) and `b` leg (GND).
 *
 * **Cables route freely.** The tape may cross anywhere — straight over tiles AND gaps — to reach its
 * target, and PWR/GND tapes may cross or overlap (copper tape's underside is insulated, so crossings
 * don't short). No gap-graph constraint and no DRC; the output is a fabrication/layout guide (the
 * view/export thicken each polyline into tape rectangles via `tapeQuads`).
 */
import {
  type Circuit,
  type GapEdge,
  type GapGraph,
  type Led,
  type RoutedCircuit,
  TAPE_W,
  type Trace2D,
  type Vec2,
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

  planTwoNet(batteryPoint!, placed, traces);
  return { ledPoints, batteryPoint, traces, unreachable };
}

/**
 * Direct tapes from the battery's two terminals: a `pwr` straight run to every LED's `a` leg and a
 * `gnd` straight run to its `b` leg. The two terminals are nudged either side of the battery centre
 * so PWR and GND leave from distinct pads. Cables cross freely, so a straight line always reaches.
 */
function planTwoNet(batteryCentre: Vec2, placed: PlacedLed[], traces: Trace2D[]): void {
  const pwrTerm: Vec2 = { x: batteryCentre.x - TAPE_W, y: batteryCentre.y };
  const gndTerm: Vec2 = { x: batteryCentre.x + TAPE_W, y: batteryCentre.y };
  for (const p of placed) {
    traces.push({ net: "pwr", points: [pwrTerm, p.aLeg] });
    traces.push({ net: "gnd", points: [gndTerm, p.bLeg] });
  }
}
