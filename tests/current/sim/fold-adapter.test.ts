import { describe, expect, it } from "vitest";
import { buildSceneFromFold, isFoldable } from "../../../src/sim/fold-adapter.js";

const foldable = {
  vertices_coords: [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
  ],
  faces_vertices: [[0, 1, 2, 3]],
  edges_vertices: [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [0, 2],
  ] as [number, number][],
  edges_assignment: ["B", "B", "B", "B", "M"],
  edges_foldAngle: [0, 0, 0, 0, 180],
};

describe("sim/fold-adapter", () => {
  it("recognizes foldable crease-pattern data", () => {
    expect(isFoldable({})).toBe(false);
    expect(isFoldable(foldable)).toBe(true);
  });

  it("builds a normalized free-fold scene; plain FOLD keeps the exact fold angle", () => {
    const { net, model, solver } = buildSceneFromFold(foldable);

    expect(net.faces).toHaveLength(2);
    expect(model.creases.count).toBe(1);
    // Paper-exact path (Ghassaei et al. §2.3): the file's angle passes through
    // unclamped — 180° stays π, signed per the FOLD spec.
    expect(Math.abs(model.creases.targetTheta[0])).toBeCloseTo(Math.PI, 6);
    expect(solver.theta.length).toBe(1);
  });

  it("FKLD files (kirigami sim) still clamp explicit fold angles to ±2.7", () => {
    const { model } = buildSceneFromFold({
      ...foldable,
      "fkld:edges_cutType": [null, null, null, null, null],
    });
    expect(Math.abs(model.creases.targetTheta[0])).toBeCloseTo(2.7, 6);
  });

  it("uses guided FKLD frames when folded-form and driven metadata are present", () => {
    const { model } = buildSceneFromFold({
      ...foldable,
      file_frames: [
        {
          frame_classes: ["foldedForm"],
          vertices_coords: [
            [0, 0, 1],
            [1, 0, 1],
            [1, 1, 1],
            [0, 1, 1],
          ],
        },
      ],
      "fkld:vertices_driven": [1, 0, 0, 1],
    });

    expect(Array.from(model.driven)).toEqual([1, 0, 0, 1]);
    expect(Array.from(model.fixed)).toEqual([1, 0, 0, 1]);
    expect(model.goal[2]).not.toBe(0);
  });

  it("throws on non-foldable input", () => {
    expect(() => buildSceneFromFold({ vertices_coords: [[0, 0, 0]] })).toThrow(
      /lacks vertices\/faces\/edges/i,
    );
  });
});
