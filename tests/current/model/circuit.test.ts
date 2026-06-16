/**
 * Circuit engine + separate STL export: parts pinned to faces resolve into flat or folded geometry,
 * traces follow the surface, and the conductor layer exports as its own mesh.
 */
import { describe, it, expect } from "vitest";
import { resolveCircuit, locateFlat, type MeshRef } from "../../../src/model/circuit-geometry.js";
import { buildCircuitStl } from "../../../src/model/circuit-export.js";
import type { Circuit } from "../../../src/model/circuit.js";

// unit square split into two triangles sharing edge 0–2
const net: MeshRef = {
  vertices: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }, { x: 0, y: 10, z: 0 }],
  faces: [[0, 1, 2], [0, 2, 3]],
};
const circuit: Circuit = {
  components: [
    { id: "a", kind: "led", face: 0, bary: [0.34, 0.33, 0.33], rot: 0 },
    { id: "b", kind: "battery", face: 1, bary: [0.34, 0.33, 0.33], rot: 0 },
  ],
  traces: [{ id: "t", from: { comp: "a", pad: 1 }, to: { comp: "b", pad: 0 } }],
};
const flat = (i: number): [number, number, number] => [net.vertices[i].x, net.vertices[i].y, net.vertices[i].z];

describe("circuit-geometry: resolveCircuit", () => {
  it("places each part on its face with two distinct pads", () => {
    const g = resolveCircuit(circuit, net, flat);
    expect(g.components).toHaveLength(2);
    for (const c of g.components) {
      for (const k of [0, 1]) expect(c.center[k]).toBeGreaterThan(0);
      expect(c.pads[0]).not.toEqual(c.pads[1]);
      expect(c.len).toBeGreaterThan(0);
    }
    expect(g.traces).toHaveLength(1);
    expect(g.traces[0].path.length).toBeGreaterThanOrEqual(2);
  });

  it("routes a trace whose endpoints are the connected pads", () => {
    const g = resolveCircuit(circuit, net, flat);
    const a = g.components.find((c) => c.id === "a")!, b = g.components.find((c) => c.id === "b")!;
    const path = g.traces[0].path;
    expect(path[0]).toEqual(a.pads[1]);
    expect(path[path.length - 1]).toEqual(b.pads[0]);
  });

  it("follows the fold: with a lifted tile the trace gains z", () => {
    const folded = (i: number): [number, number, number] => [net.vertices[i].x, net.vertices[i].y, i >= 2 ? 6 : 0];
    const g = resolveCircuit(circuit, net, folded);
    expect(g.components.find((c) => c.id === "b")!.center[2]).toBeGreaterThan(0); // part on the lifted face
    expect(Math.max(...g.traces[0].path.map((p) => p[2]))).toBeGreaterThan(0); // trace climbs the fold
  });
});

describe("circuit-geometry: locateFlat", () => {
  it("finds the containing face, and falls back to the nearest for outside points", () => {
    expect(locateFlat(8, 2, net)!.face).toBe(0); // lower-right triangle
    expect(locateFlat(2, 8, net)!.face).toBe(1); // upper-left triangle
    const out = locateFlat(-5, -5, net)!; // outside the mesh → nearest face, clamped bary
    expect(out.bary.every((w) => w >= 0)).toBe(true);
  });
});

describe("circuit-export: buildCircuitStl", () => {
  it("writes a separate conductor solid with ribs + part footprints", () => {
    const out = buildCircuitStl(circuit, net, "demo")!;
    expect(out.filename).toBe("demo-circuit.stl");
    expect(out.text.startsWith("solid demo-circuit")).toBe(true);
    expect(out.text.trimEnd().endsWith("endsolid demo-circuit")).toBe(true);
    expect(out.componentCount).toBe(2);
    expect(out.traceCount).toBe(1);
    expect((out.text.match(/facet normal/g) ?? []).length).toBeGreaterThan(0);
    for (const m of out.text.matchAll(/vertex (\S+) (\S+) (\S+)/g)) {
      for (let k = 1; k <= 3; k++) expect(Number.isFinite(Number(m[k]))).toBe(true);
    }
  });

  it("returns null for an empty circuit", () => {
    expect(buildCircuitStl({ components: [], traces: [] }, net)).toBeNull();
  });
});
