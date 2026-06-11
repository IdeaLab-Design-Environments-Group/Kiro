import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildScene, canSimulate, pyramidInputsFromFold } from "../../../src/sim/scene.js";
import type { FoldFile } from "../../../src/model/fold-file.js";

function loadExample(name: string): FoldFile {
  const url = new URL(`../../../public/examples/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as FoldFile;
}

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

  it("rejects incomplete titles and reads sourcePyramid metadata", () => {
    expect(pyramidInputsFromFold({ frame_title: "not a pyramid" })).toBeNull();
    expect(pyramidInputsFromFold({ frame_title: "pyramid (N=6, L=100mm)" })).toBeNull();
    expect(
      pyramidInputsFromFold({
        frame_title: "AKDE decagon kirigami (N=10, L=100mm, H=100mm, T=1mm)",
      }),
    ).toEqual({ edgeCount: 10, edgeLength: 100, totalCurvature: 100, materialThickness: 1 });
    expect(pyramidInputsFromFold(loadExample("akde-hex.fkld"))).toEqual({
      edgeCount: 6,
      edgeLength: 100,
      totalCurvature: 100.00000000000001,
      materialThickness: 1,
    });
  });

  it("chooses guided simulation when pyramid inputs are recoverable", () => {
    const built = buildScene({
      frame_title: "Hex pyramid (N=6, L=100mm, H=80mm, T=1mm)",
    });

    expect(built?.mode).toBe("guided");
    expect(built?.scene.model.driven.some((value) => value === 1)).toBe(true);
  });

  it("AKDE preset with a declared folded-form is guided to a cone, cuts split open", { timeout: 20000 }, () => {
    const fold = loadExample("akde-hex.fkld");
    const inV = fold.vertices_coords!.length;
    const built = buildScene(fold);
    expect(built?.mode).toBe("guided"); // hex declares a foldedForm footprint → driven to it
    expect(built?.sim).toBe("kirigami");
    const { model, solver } = built!.scene;
    // kirigami: cuts were split, so the model has MORE nodes than the flat pattern's vertices.
    expect(model.numNodes).toBeGreaterThan(inV);
    expect(Array.from(model.driven).some((d) => d === 1)).toBe(true);
    solver.solve(16000, 1);
    // It rises into a cone: real z extent, footprint roughly round (x extent ≈ y extent).
    let zLo = Infinity, zHi = -Infinity, xLo = Infinity, xHi = -Infinity, yLo = Infinity, yHi = -Infinity;
    for (let i = 0; i < model.numNodes; i++) {
      const x = model.position[3 * i], y = model.position[3 * i + 1], z = model.position[3 * i + 2];
      zLo = Math.min(zLo, z); zHi = Math.max(zHi, z);
      xLo = Math.min(xLo, x); xHi = Math.max(xHi, x);
      yLo = Math.min(yLo, y); yHi = Math.max(yHi, y);
    }
    expect(zHi - zLo).toBeGreaterThan(0.2 * (xHi - xLo)); // genuinely 3D, not flat
    expect(Math.min(xHi - xLo, yHi - yLo) / Math.max(xHi - xLo, yHi - yLo)).toBeGreaterThan(0.6); // round-ish
    for (let i = 0; i < model.position.length; i++) expect(Number.isFinite(model.position[i])).toBe(true);
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
