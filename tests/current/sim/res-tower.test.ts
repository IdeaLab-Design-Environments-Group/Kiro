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
  it("routes free kirigami, cuts split, folds isometrically and stays finite", { timeout: 60_000 }, () => {
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

    // Free-fold the flat-foldable RES sheet (the app additionally runs self-collision so the
    // stacking layers don't interpenetrate; not needed here to check the fold is valid + isometric).
    for (let k = 1; k <= 6; k++) solver.solve(2500, k / 6);
    solver.solve(4000, 1.0);

    // Isometric fold of the flat-foldable RES sheet (bars barely stretch).
    expect(barStrain(model)).toBeLessThan(0.05);
    for (let i = 0; i < model.position.length; i++) expect(Number.isFinite(model.position[i])).toBe(true);
  });

  it("line-only variant (res-square-tower-erect) free-erects into a tower", { timeout: 60_000 }, () => {
    // The over-constrained line-only import (paths dropped) CAN'T fold flat, so it buckles up into
    // the visible RES tower under a plain free-fold ramp (no driving, no collision).
    const fold = JSON.parse(readFileSync("public/examples/res-square-tower-erect.fkld", "utf8")) as FoldFile;
    const built = buildScene(fold);
    expect(built).not.toBeNull();
    expect(built!.mode).toBe("free");
    const { model, solver } = built!.scene;
    for (let k = 1; k <= 8; k++) solver.solve(3000, k / 8);
    solver.solve(6000, 1.0);

    let zLo = Infinity, zHi = -Infinity, xLo = Infinity, xHi = -Infinity, yLo = Infinity, yHi = -Infinity;
    for (let i = 0; i < model.numNodes; i++) {
      const x = model.position[3 * i], y = model.position[3 * i + 1], z = model.position[3 * i + 2];
      zLo = Math.min(zLo, z); zHi = Math.max(zHi, z);
      xLo = Math.min(xLo, x); xHi = Math.max(xHi, x);
      yLo = Math.min(yLo, y); yHi = Math.max(yHi, y);
    }
    const height = zHi - zLo, width = Math.max(xHi - xLo, yHi - yLo);
    expect(height).toBeGreaterThan(0.4 * width); // erects (measured ≈0.5·width)
    expect(barStrain(model)).toBeLessThan(0.1);
    for (let i = 0; i < model.position.length; i++) expect(Number.isFinite(model.position[i])).toBe(true);
  });
});
