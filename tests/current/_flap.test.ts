import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildSceneFromFold, isFoldable } from "../../src/sim/fold-adapter.js";

describe("kirigami flap example", () => {
  it("guided-folds: surround stays flat, flap lifts, cut opens, finite", () => {
    const fold = JSON.parse(readFileSync("public/examples/kirigami-flap.fkld", "utf8"));
    expect(isFoldable(fold)).toBe(true);

    const { model, solver } = buildSceneFromFold(fold);
    // guided (all nodes driven) → interpolate flat→folded
    expect([...model.driven].some((d) => d === 1)).toBe(true);
    let fp = 0;
    for (let f = 0; f < 200; f++) {
      fp += (1 - fp) * 0.05;
      solver.foldPercent = fp;
      solver.step();
    }
    const P = (i: number) => [model.position[3 * i], model.position[3 * i + 1], model.position[3 * i + 2]];
    const z = (i: number) => P(i)[2];
    const gap = (i: number, j: number) =>
      Math.hypot(P(i)[0] - P(j)[0], P(i)[1] - P(j)[1], P(i)[2] - P(j)[2]);

    expect([...model.position].every(Number.isFinite)).toBe(true);
    // surround corners flat, flap corners lifted
    expect(Math.abs(z(6))).toBeLessThan(1e-3);
    expect(Math.abs(z(7))).toBeLessThan(1e-3);
    expect(Math.abs(z(8))).toBeGreaterThan(10);
    // the cut opens: coincident corners (8↔6, 9↔7) separate
    expect(gap(8, 6)).toBeGreaterThan(20);
    expect(gap(9, 7)).toBeGreaterThan(20);
  });
});
