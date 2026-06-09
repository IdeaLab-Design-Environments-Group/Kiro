import { describe, expect, it } from "vitest";
import { pointTriangleDistance, sampledHausdorff, samplePoints } from "../../../src/pipeline/verify.js";
import { buildSceneFromFold } from "../../../src/sim/fold-adapter.js";
import { measureTheta } from "../../../src/sim/solver.js";
import type { FoldFile } from "../../../src/model/fold-file.js";
import type { Vec3 } from "../../../src/pipeline/types.js";
import { makeCube } from "./fixtures/targets.js";

const V = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

describe("pointTriangleDistance", () => {
  const a = V(0, 0, 0);
  const b = V(2, 0, 0);
  const c = V(0, 2, 0);
  it("face region: perpendicular distance", () => {
    expect(pointTriangleDistance(V(0.5, 0.5, 3), a, b, c)).toBeCloseTo(3, 12);
  });
  it("vertex region: distance to the corner", () => {
    expect(pointTriangleDistance(V(-1, -1, 0), a, b, c)).toBeCloseTo(Math.SQRT2, 12);
  });
  it("edge region: distance to the closest edge point", () => {
    expect(pointTriangleDistance(V(1, -2, 0), a, b, c)).toBeCloseTo(2, 12);
    expect(pointTriangleDistance(V(2, 2, 0), a, b, c)).toBeCloseTo(Math.SQRT2, 12); // hypotenuse
  });
});

describe("sampledHausdorff", () => {
  const cube = makeCube();
  const mesh = { v: cube.vertices, f: cube.faces };
  it("identical meshes → 0", () => {
    expect(sampledHausdorff(mesh, mesh)).toBeCloseTo(0, 12);
  });
  it("known offset copy → exactly the offset", () => {
    const h = 7;
    const moved = { v: cube.vertices.map((p) => V(p.x, p.y, p.z + h)), f: cube.faces };
    expect(sampledHausdorff(mesh, moved)).toBeCloseTo(h, 9);
  });
  it("samples include vertices, edge midpoints, and centroids", () => {
    const tri = { v: [V(0, 0, 0), V(1, 0, 0), V(0, 1, 0)], f: [[0, 1, 2]] as [number, number, number][] };
    const samples = samplePoints(tri.v, tri.f);
    expect(samples.length).toBe(3 + 3 + 1);
  });
});

describe("the equilibrium oracle bites (negative test)", () => {
  it("a non-isometric flat pattern fails verification", { timeout: 60_000 }, async () => {
    const { kirigamize } = await import("../../../src/pipeline/kirigamize.js");
    const { verifyFold } = await import("../../../src/pipeline/verify.js");
    const { makeTent } = await import("./fixtures/targets.js");
    const tent = makeTent();
    const result = kirigamize(tent, { verify: false });
    // Corrupt the PATTERN: stretch the flat sheet 50% in x. Bar rest lengths
    // derive from the flat net, so no pose matching the goal can be
    // unstrained — the folded state is not an equilibrium of this pattern.
    // (A tampered goal frame is healed by the solver — it relaxes back to
    // the true shape; and the loader's uniform normalization absorbs small
    // anisotropy into sub-tolerance mean strain, so the corruption must be
    // decisive.)
    const coords = result.fkld.vertices_coords as number[][];
    for (const c of coords) c[0] *= 1.5;
    const report = verifyFold(result.fkld, tent);
    expect(report.converged).toBe(false);
    expect(report.meanStrain > 0.01 || report.dH > report.epsilon || report.creaseResidual > 0.15).toBe(true);
  });
});

describe("sign-convention pin (R7): edges_foldAngle M+ folds mountain end-to-end", () => {
  it("a single +90° M hinge develops positive measured θ in the solver", () => {
    // Two unit triangles hinged on edge (1,2); explicit +90° mountain target.
    const hinge: FoldFile = {
      file_spec: 1.2,
      frame_unit: "mm",
      vertices_coords: [
        [0, 0],
        [50, 0],
        [50, 50],
        [100, 50],
      ],
      edges_vertices: [
        [0, 1],
        [1, 2],
        [2, 0],
        [1, 3],
        [3, 2],
      ],
      edges_assignment: ["B", "B", "B", "B", "B"].map((a, i) => (i === 1 ? "M" : a)),
      edges_foldAngle: [null, 90, null, null, null] as unknown as number[],
      faces_vertices: [
        [0, 1, 2],
        [1, 3, 2],
      ],
    };
    const scene = buildSceneFromFold(hinge);
    scene.solver.solve(4000, 1);
    // find the crease and read its measured angle
    expect(scene.model.creases.count).toBe(1);
    const cr = scene.model.creases;
    const theta = measureTheta(scene.model, cr.face1[0], cr.face2[0], cr.n3[0], cr.n4[0]);
    expect(theta).toBeGreaterThan(0.5); // folded decisively in the mountain direction
  });
});
