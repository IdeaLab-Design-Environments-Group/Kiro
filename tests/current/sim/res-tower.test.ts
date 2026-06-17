/**
 * Miyamoto RES (Rotational Erection System) square tower — the bundled
 * `res-square-tower.fkld`, regenerated from the original Origami Simulator SVG
 * (`public/examples/miyamotoTower.svg`) by the 1:1 loadSVG port in
 * `src/sim/svg-import.ts` (see `scripts/gen-res-tower.ts`).
 *
 * It carries the full RES crease set — M/V/F/C with the ±90° fold angles the SVG
 * stroke opacities (0.5) encode. With no driven footprint it free-folds exactly
 * like Origami Simulator's dynamic solver: the cuts split open and the flat-foldable
 * sheet folds nearly ISOMETRICALLY (layers stack). The tall erected tower is a
 * separate rigid-kinematic branch that needs guided actuation, not free fold — so
 * this test guards the faithful behaviour (clean import, cuts open, isometric,
 * finite under self-collision), not a tower height.
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

describe("Miyamoto RES square tower (faithful OS import, free fold)", () => {
  it("routes free kirigami, cuts split, folds isometrically and stays finite", { timeout: 120_000 }, () => {
    const fold = JSON.parse(readFileSync("public/examples/res-square-tower.fkld", "utf8")) as FoldFile;
    const inV = fold.vertices_coords!.length;

    const built = buildScene(fold);
    expect(built).not.toBeNull();
    // No declared footprint → the OS free-fold path, not a driven morph.
    expect(built!.mode).toBe("free");
    expect(built!.sim).toBe("kirigami");

    const { model, solver } = built!.scene;
    // Kirigami cuts ("C") split into independent lips → more nodes than the flat sheet.
    expect(model.numNodes).toBeGreaterThan(inV);
    // Truly free: nothing is kinematically driven.
    expect(Array.from(model.driven).every((d) => d === 0)).toBe(true);

    // Free-fold with self-collision (layers can't interpenetrate), exactly as the app's 3D Sim.
    solver.enableCollision();
    for (let k = 1; k <= 10; k++) solver.solve(4000, k / 10);
    solver.solve(8000, 1.0);

    // Isometric fold of the flat-foldable RES sheet (bars barely stretch).
    expect(barStrain(model)).toBeLessThan(0.05);
    for (let i = 0; i < model.position.length; i++) expect(Number.isFinite(model.position[i])).toBe(true);
  });
});
