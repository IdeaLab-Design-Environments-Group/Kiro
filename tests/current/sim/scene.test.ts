import { describe, expect, it } from "vitest";
import { buildScene, canSimulate, pyramidInputsFromFold } from "../../../src/sim/scene.js";

describe("sim/scene", () => {
  it("parses AKDE-style pyramid parameters from frame_title", () => {
    const inputs = pyramidInputsFromFold({
      frame_title: "Hex pyramid (N=6, L=100mm, H=80mm, T=1mm)",
    });

    expect(inputs).toEqual({
      edgeCount: 6,
      edgeLength: 100,
      totalCurvature: 80,
      materialThickness: 1,
    });
  });

  it("rejects non-pyramid titles and incomplete titles", () => {
    expect(pyramidInputsFromFold({ frame_title: "not a pyramid" })).toBeNull();
    expect(pyramidInputsFromFold({ frame_title: "pyramid (N=6, L=100mm)" })).toBeNull();
  });

  it("chooses guided simulation when pyramid inputs are recoverable", () => {
    const built = buildScene({
      frame_title: "Hex pyramid (N=6, L=100mm, H=80mm, T=1mm)",
    });

    expect(built?.mode).toBe("guided");
    expect(built?.scene.model.driven.some((value) => value === 1)).toBe(true);
  });

  it("falls back to free simulation for generic foldable data and refuses non-simulable input", () => {
    const free = buildScene({
      vertices_coords: [
        [0, 0],
        [1, 0],
        [0, 1],
      ],
      faces_vertices: [[0, 1, 2]],
      edges_vertices: [
        [0, 1],
        [1, 2],
        [2, 0],
      ],
    });
    expect(free?.mode).toBe("free");

    expect(canSimulate({})).toBe(false);
    expect(buildScene({})).toBeNull();
  });
});
