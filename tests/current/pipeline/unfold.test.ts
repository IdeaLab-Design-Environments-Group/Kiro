import { describe, expect, it } from "vitest";
import { angleDefects } from "../../../src/pipeline/curvature.js";
import { buildTopology } from "../../../src/pipeline/mesh.js";
import { planCuts } from "../../../src/pipeline/plan-cuts.js";
import {
  RELIEF_MAX,
  cutAlongEdges,
  findSelfOverlap,
  seamedUnfold,
  trianglesOverlap,
  unfoldPatch,
} from "../../../src/pipeline/unfold.js";
import type { TriMesh, Vec2 } from "../../../src/pipeline/types.js";
import { makeCube, makeIcosphere, makePyramid, makeSaddleFan } from "./fixtures/targets.js";

const TAU = 2 * Math.PI;

const d3 = (mesh: TriMesh, a: number, b: number): number => {
  const p = mesh.vertices[a];
  const q = mesh.vertices[b];
  return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
};
const d2 = (flat: Vec2[], a: number, b: number): number =>
  Math.hypot(flat[a].x - flat[b].x, flat[a].y - flat[b].y);

function planFor(mesh: TriMesh, strategy: "dart" | "tuck-all" = "dart") {
  const topo = buildTopology(mesh);
  const defects = angleDefects(mesh, topo);
  return { topo, defects, plan: planCuts(mesh, topo, defects, { lambda: 0, strategy }) };
}

describe("trianglesOverlap (pure predicate)", () => {
  const T = (a: [number, number], b: [number, number], c: [number, number]): Vec2[] => [
    { x: a[0], y: a[1] },
    { x: b[0], y: b[1] },
    { x: c[0], y: c[1] },
  ];
  it("disjoint → false; overlapping → true", () => {
    expect(trianglesOverlap(T([0, 0], [1, 0], [0, 1]), T([3, 3], [4, 3], [3, 4]))).toBe(false);
    expect(trianglesOverlap(T([0, 0], [2, 0], [0, 2]), T([0.5, 0.5], [2.5, 0.5], [0.5, 2.5]))).toBe(true);
  });
  it("vertex-touching and edge-sharing → false (shrink kills contact)", () => {
    expect(trianglesOverlap(T([0, 0], [1, 0], [0, 1]), T([1, 0], [2, 0], [1, 1]))).toBe(false); // share vertex
    expect(trianglesOverlap(T([0, 0], [1, 0], [0, 1]), T([1, 0], [0, 1], [1, 1]))).toBe(false); // share edge
  });
});

describe("cutAlongEdges", () => {
  it("cube + 7-edge spanning tree → disk: V'=V+Σ(copies−1), χ=1, all lips recorded", () => {
    const cube = makeCube();
    const { topo, plan } = planFor(cube);
    const cut = cutAlongEdges(cube, topo, plan.cutEdges);
    expect(cut.lips.length).toBe(7);
    const cutTopo = buildTopology(cut.mesh);
    const chi = cut.mesh.vertices.length - cutTopo.edges.length + cut.mesh.faces.length;
    expect(chi).toBe(1); // disk
    expect(cut.mesh.faces.length).toBe(12);
    // provenance: every copy maps back to a real cube vertex
    for (const o of cut.origVertex) expect(o).toBeGreaterThanOrEqual(0);
    // lips have equal rest lengths (same source edge)
    for (const lip of cut.lips) {
      expect(d3(cut.mesh, lip.lipA[0], lip.lipA[1])).toBeCloseTo(d3(cut.mesh, lip.lipB[0], lip.lipB[1]), 12);
    }
  });

  it("ignores boundary edges handed in as cuts", () => {
    const pyr = makePyramid(4);
    const topo = buildTopology(pyr);
    const boundaryEdge = topo.edges.findIndex((e) => e.faces.length === 1);
    const cut = cutAlongEdges(pyr, topo, [boundaryEdge]);
    expect(cut.lips.length).toBe(0);
    expect(cut.mesh.vertices.length).toBe(pyr.vertices.length);
  });
});

describe("unfoldPatch — isometric layout", () => {
  it("cube net golden: isometry of every edge and angle, no self-overlap", () => {
    const cube = makeCube();
    const { topo, plan } = planFor(cube);
    const cut = cutAlongEdges(cube, topo, plan.cutEdges);
    const flat = unfoldPatch(cut, cut.mesh.faces.map((_, f) => f));

    // every flat edge length = 3D rest length (1e-9 relative)
    const cutTopo = buildTopology(cut.mesh);
    for (const e of cutTopo.edges) {
      const rel = Math.abs(d2(flat, e.a, e.b) - d3(cut.mesh, e.a, e.b)) / d3(cut.mesh, e.a, e.b);
      expect(rel).toBeLessThan(1e-9);
    }
    expect(findSelfOverlap(flat, cut.mesh.faces)).toBeNull();
  });

  it("open pyramid: dart gap at the apex = δ(apex)", () => {
    const pyr = makePyramid(4, 50, 30);
    const { topo, defects, plan } = planFor(pyr);
    const cut = cutAlongEdges(pyr, topo, plan.cutEdges);
    const flat = unfoldPatch(cut, cut.mesh.faces.map((_, f) => f));
    // The apex keeps ONE copy (slit endpoint): sum of its flat angles = 2π − δ.
    const apexCopies = cut.origVertex
      .map((src, v) => ({ src, v }))
      .filter((x) => x.src === 0)
      .map((x) => x.v);
    expect(apexCopies.length).toBe(1);
    let sum = 0;
    for (let f = 0; f < cut.mesh.faces.length; f++) {
      const corner = cut.mesh.faces[f].indexOf(apexCopies[0]);
      if (corner === -1) continue;
      const [i, j, k] = cut.mesh.faces[f];
      const at = [i, j, k][corner];
      const others = [i, j, k].filter((v) => v !== at);
      const u = { x: flat[others[0]].x - flat[at].x, y: flat[others[0]].y - flat[at].y };
      const w = { x: flat[others[1]].x - flat[at].x, y: flat[others[1]].y - flat[at].y };
      sum += Math.atan2(Math.abs(u.x * w.y - u.y * w.x), u.x * w.x + u.y * w.y);
    }
    expect(sum).toBeCloseTo(TAU - defects.defects[0], 9);
  });

  it("saddle fan: each wedge patch embeds; lips keep equal lengths", () => {
    const saddle = makeSaddleFan();
    const { topo, plan } = planFor(saddle);
    const result = seamedUnfold(saddle, topo, plan);
    // lips have equal flat lengths (same source edge, isometric layout)
    for (const lip of result.lips) {
      expect(d2(result.flat, lip.lipA[0], lip.lipA[1])).toBeCloseTo(
        d2(result.flat, lip.lipB[0], lip.lipB[1]),
        9,
      );
    }
  });

  it("audit negative test: dropping a cut edge from the cube tree throws (not developable)", () => {
    const cube = makeCube();
    const { topo, plan } = planFor(cube);
    const broken = plan.cutEdges.slice(0, -1); // corner left interior with δ=π/2
    const cut = cutAlongEdges(cube, topo, broken);
    expect(() => unfoldPatch(cut, cut.mesh.faces.map((_, f) => f))).toThrow(/developability|isometry/);
  });
});

/** Per-patch overlap check on a (possibly multi-patch) unfold result. */
function expectNoPatchOverlap(result: ReturnType<typeof seamedUnfold>): void {
  for (let p = 0; p < result.patchCount; p++) {
    const subset = result.faces.filter((_, f) => result.patchOfFace[f] === p);
    expect(findSelfOverlap(result.flat, subset)).toBeNull();
  }
}

describe("seamedUnfold (relief loop)", () => {
  it("cube: single patch, no relief needed, totalCutLength = plan length", () => {
    const cube = makeCube();
    const { topo, plan } = planFor(cube);
    const result = seamedUnfold(cube, topo, plan);
    expect(result.patchCount).toBe(1);
    expect(result.reliefEdges.length).toBe(0);
    expect(result.totalCutLength).toBeCloseTo(plan.cost.length, 9);
    expectNoPatchOverlap(result);
  });

  it("icosphere(1): terminates, overlap-free, relief bounded; cut length only grows", () => {
    const sphere = makeIcosphere(1);
    const { topo, plan } = planFor(sphere);
    const result = seamedUnfold(sphere, topo, plan);
    expectNoPatchOverlap(result);
    expect(result.reliefEdges.length).toBeLessThanOrEqual(RELIEF_MAX);
    expect(result.totalCutLength).toBeGreaterThanOrEqual(plan.cost.length - 1e-9);
  });

  it("saddle fan: splits into 2 patches (fan articulates only through the slit vertex)", () => {
    const saddle = makeSaddleFan();
    const { topo, plan } = planFor(saddle);
    const result = seamedUnfold(saddle, topo, plan);
    expect(result.patchCount).toBe(2);
    expect(result.totalCutLength).toBeGreaterThanOrEqual(plan.cost.length - 1e-9);
    expectNoPatchOverlap(result);
    // every Q vertex is still represented
    expect(new Set(result.origVertex).size).toBe(saddle.vertices.length);
  });
});
