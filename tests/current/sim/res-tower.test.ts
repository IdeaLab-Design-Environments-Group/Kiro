/**
 * Miyamoto RES (Rotational Erection System) square tower — free fold to the
 * authentic Origami Simulator angles.
 *
 * The bundled `res-square-tower.fkld` carries the M/V/F/C assignment from
 * Miyamoto's OS SVG (assets/Kirigami/miyamotoTower.svg) and the fold angles its
 * stroke opacities encode (every M/V at opacity 0.5 → ±90°). With no driven
 * footprint it free-folds exactly like the Origami Simulator: ramping the fold
 * percentage erects the sheet into a tower as the cuts open.
 *
 * (It previously shipped as an all-vertices-driven morph toward a non-isometric
 * baked `foldedForm`, which held it flat — see git history.)
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildScene } from "../../../src/sim/scene.js";
import type { FoldFile } from "../../../src/model/fold-file.js";

/** Mean |l/l₀ − 1| over bars (no driven nodes here, so this is the whole sheet). */
function barStrain(model: {
  beams: { count: number; n0: Int32Array; n1: Int32Array; rest: Float32Array };
  position: Float32Array;
}): number {
  let s = 0;
  for (let i = 0; i < model.beams.count; i++) {
    const a = model.beams.n0[i], b = model.beams.n1[i];
    const l = Math.hypot(
      model.position[3 * a] - model.position[3 * b],
      model.position[3 * a + 1] - model.position[3 * b + 1],
      model.position[3 * a + 2] - model.position[3 * b + 2],
    );
    s += Math.abs(l / model.beams.rest[i] - 1);
  }
  return s / Math.max(1, model.beams.count);
}

describe("Miyamoto RES square tower (free fold, authentic OS angles)", () => {
  it("routes free, cuts split, and erects into a low-strain tower", { timeout: 90_000 }, () => {
    const fold = JSON.parse(readFileSync("public/examples/res-square-tower.fkld", "utf8")) as FoldFile;
    const inV = fold.vertices_coords!.length;

    const built = buildScene(fold);
    expect(built).not.toBeNull();
    // No declared footprint anymore → the OS free-fold path, not a driven morph.
    expect(built!.mode).toBe("free");
    expect(built!.sim).toBe("kirigami");

    const { model, solver } = built!.scene;
    // Kirigami cuts ("C") split into independent lips → more nodes than the flat sheet.
    expect(model.numNodes).toBeGreaterThan(inV);
    // Truly free: nothing is kinematically driven.
    expect(Array.from(model.driven).every((d) => d === 0)).toBe(true);

    // Gradually ramp the fold (RES erection climbs into shape; a jump can trap it).
    for (let k = 1; k <= 10; k++) solver.solve(6000, k / 10);
    solver.solve(20000, 1.0);

    let zLo = Infinity, zHi = -Infinity, xLo = Infinity, xHi = -Infinity, yLo = Infinity, yHi = -Infinity;
    for (let i = 0; i < model.numNodes; i++) {
      const x = model.position[3 * i], y = model.position[3 * i + 1], z = model.position[3 * i + 2];
      zLo = Math.min(zLo, z); zHi = Math.max(zHi, z);
      xLo = Math.min(xLo, x); xHi = Math.max(xHi, x);
      yLo = Math.min(yLo, y); yHi = Math.max(yHi, y);
    }
    const height = zHi - zLo, width = Math.max(xHi - xLo, yHi - yLo);

    // Erects: real vertical extent (measured ≈0.57·width at full fold), not flat.
    expect(height).toBeGreaterThan(0.4 * width);
    // Isometric fold (the bars barely stretch — measured ≈2.5%).
    expect(barStrain(model)).toBeLessThan(0.1);
    for (let i = 0; i < model.position.length; i++) expect(Number.isFinite(model.position[i])).toBe(true);
  });
});
