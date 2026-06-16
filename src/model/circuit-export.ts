/**
 * Separate circuit STL — the post-processing output. The traces (raised ribs) and SMD part footprints
 * are written as their OWN mesh, in the same flat XY as the tiles export, so the two files line up
 * (print the tiles, then the conductor layer on top / on a second head). Nothing here touches the tile
 * STL — "exported separately".
 *
 * Traces: each routed segment becomes a low rectangular rib. Parts: a body box + two pad boxes. All
 * flat (z = 0 base, extruded up), sized from the model bbox so they read at any pattern scale.
 */
import { type Circuit } from "./circuit.js";
import { type MeshRef, resolveCircuit, type Vec3 } from "./circuit-geometry.js";
import { boxFrame, type V3 } from "./stl-ascii.js";

export interface CircuitStl {
  filename: string;
  text: string;
  componentCount: number;
  traceCount: number;
}

/** Trace rib width / height and pad / body height, as fractions of the bbox diagonal. */
const RIB_W = 0.006;
const RIB_H = 0.012;
const PAD = 0.018;
const BODY_H = 0.03;

/** Build the separate circuit STL (ribs + part footprints), or null if the circuit is empty. */
export function buildCircuitStl(circuit: Circuit, net: MeshRef, baseName = "kirigami"): CircuitStl | null {
  if (circuit.components.length === 0 && circuit.traces.length === 0) return null;
  const geo = resolveCircuit(circuit, net, (i) => flatNode(net, i));
  const d = geo.scale;
  const ribW = RIB_W * d, ribH = RIB_H * d, padH = PAD * d, bodyH = BODY_H * d;

  const out: string[] = [`solid ${baseName}-circuit`];

  // Traces → a rib per segment (box along the segment, width ribW, z 0..ribH).
  for (const t of geo.traces) {
    for (let s = 0; s + 1 < t.path.length; s++) {
      const a = t.path[s], b = t.path[s + 1];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) continue;
      const x: V3 = [dx / len, dy / len, 0];
      const y: V3 = [-x[1], x[0], 0];
      const mid: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 0];
      boxFrame(out, mid, x, y, len / 2, ribW / 2, 0, ribH);
    }
  }

  // Parts → body + two pads (flat: x,y in-plane, extrude in z).
  for (const c of geo.components) {
    const x = flat2(c.x), y = flat2(c.y);
    boxFrame(out, flatXY(c.center), x, y, c.len / 2, c.wid / 2, 0, bodyH);
    for (const p of c.pads) boxFrame(out, flatXY(p), x, y, (PAD * d) / 2, (PAD * d) / 2, 0, padH);
  }

  out.push(`endsolid ${baseName}-circuit`);
  return {
    filename: `${baseName}-circuit.stl`,
    text: out.join("\n") + "\n",
    componentCount: geo.components.length,
    traceCount: geo.traces.length,
  };
}

const flatNode = (net: MeshRef, i: number): Vec3 => {
  const v = net.vertices[i] ?? { x: 0, y: 0, z: 0 };
  return [v.x, v.y, v.z ?? 0];
};
const flatXY = (v: Vec3): V3 => [v[0], v[1], 0];
const flat2 = (v: Vec3): V3 => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l, 0]; };
