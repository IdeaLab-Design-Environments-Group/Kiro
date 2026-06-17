import { describe, expect, it } from "vitest";
import {
  assertGenusZero,
  condition,
  dropDegenerates,
  orientFaces,
  weldVertices,
} from "../../../src/pipeline/conditioning.js";
import { parseMesh } from "../../../src/pipeline/import.js";
import { buildTopology, eulerCharacteristic } from "../../../src/pipeline/mesh.js";
import type { TriMesh } from "../../../src/pipeline/types.js";
import { makeCube, makeIcosphere, toAsciiStl } from "./fixtures/targets.js";

describe("weldVertices", () => {
  it("welds STL soup back to the cube's 8 vertices", () => {
    const soup = parseMesh(toAsciiStl(makeCube()), "stl");
    const { mesh, report } = weldVertices(soup);
    expect(mesh.vertices.length).toBe(8);
    expect(report.changed).toBe(36 - 8);
    // Welded soup must be a valid manifold again.
    const topo = buildTopology(orientFaces(mesh).mesh);
    expect(eulerCharacteristic(mesh, topo)).toBe(2);
  });
});

describe("orientFaces", () => {
  it("flips an inconsistently wound face", () => {
    const cube = makeCube();
    const flippedInput: TriMesh = {
      vertices: cube.vertices,
      faces: cube.faces.map((f, i) => (i === 5 ? ([f[0], f[2], f[1]] as [number, number, number]) : f)),
    };
    const { mesh, report } = orientFaces(flippedInput);
    expect(report.changed).toBe(1);
    expect(() => buildTopology(mesh)).not.toThrow();
  });
});

describe("dropDegenerates", () => {
  it("drops a zero-area sliver and its orphaned vertex", () => {
    const cube = makeCube();
    const v0 = cube.vertices[0];
    const v1 = cube.vertices[1];
    // Vertex 8 lies exactly on edge 0-1 → face [0,1,8] has zero area.
    const onEdge = { x: (v0.x + v1.x) / 2, y: v0.y, z: v0.z };
    const withSliver: TriMesh = {
      vertices: [...cube.vertices, onEdge],
      faces: [...cube.faces, [0, 1, 8]] as [number, number, number][],
    };
    const { mesh, report } = dropDegenerates(withSliver);
    expect(mesh.faces.length).toBe(12);
    expect(mesh.vertices.length).toBe(8);
    expect(report.changed).toBeGreaterThan(0);
  });
});

describe("condition (composed)", () => {
  it("turns cube STL soup into a clean closed manifold", () => {
    const soup = parseMesh(toAsciiStl(makeCube()), "stl");
    const { mesh, reports } = condition(soup);
    expect(reports.map((r) => r.pass)).toEqual(["weld", "degenerate", "orient"]);
    const topo = buildTopology(mesh);
    expect(eulerCharacteristic(mesh, topo)).toBe(2);
    expect(() => assertGenusZero(mesh, topo)).not.toThrow();
  });
});

describe("assertGenusZero", () => {
  it("accepts closed genus-0 (sphere) and a disk", () => {
    const sphere = makeIcosphere(1);
    const st = buildTopology(sphere);
    expect(() => assertGenusZero(sphere, st)).not.toThrow();

    const quad: TriMesh = {
      vertices: [
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
        { x: 1, y: 1, z: 0 },
        { x: 0, y: 1, z: 0 },
      ],
      faces: [
        [0, 1, 2],
        [0, 2, 3],
      ],
    };
    expect(() => assertGenusZero(quad, buildTopology(quad))).not.toThrow();
  });

  it("rejects a torus (genus 1) with a diagnostic", () => {
    // Coarse torus: 4x4 grid of quads wrapped both ways.
    const N = 4;
    const R = 40;
    const r = 15;
    const vertices = [] as TriMesh["vertices"];
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const u = (2 * Math.PI * i) / N;
        const v = (2 * Math.PI * j) / N;
        vertices.push({
          x: (R + r * Math.cos(v)) * Math.cos(u),
          y: (R + r * Math.cos(v)) * Math.sin(u),
          z: r * Math.sin(v),
        });
      }
    }
    const faces: [number, number, number][] = [];
    const id = (i: number, j: number): number => ((i % N) + N) % N * N + (((j % N) + N) % N);
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        faces.push([id(i, j), id(i + 1, j), id(i + 1, j + 1)]);
        faces.push([id(i, j), id(i + 1, j + 1), id(i, j + 1)]);
      }
    }
    const torus: TriMesh = { vertices, faces };
    const topo = buildTopology(torus);
    expect(eulerCharacteristic(torus, topo)).toBe(0);
    // v1 scope: closed genus-1 (χ=0, no boundary loops) is rejected with the exact diagnostic.
    expect(() => assertGenusZero(torus, topo)).toThrow(
      "genus 1 > 0 unsupported in v1 (χ=0, boundary loops=0) — handle-loop cutting is deferred",
    );
  });
});
