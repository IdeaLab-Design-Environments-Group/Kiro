/**
 * The kirigami-fit settle: the **global Otter quench** (zero all velocity each time total kinetic
 * energy stops rising) drives a frustrated guided fold to a TRUE static rest, where the bare
 * ζ-damped integrator only limit-cycles. This is exactly the algorithm `GpuFoldSolver.relax()`
 * runs on-device (per-frame velocity read-back + a uReset zeroing pass); the CPU `FoldSolver` is the
 * unit-tested twin of the GPU, so validating it here validates the GPU settle by proxy.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildScene, totalKineticEnergy, kineticDamp } from "../../../src/sim/index.js";
import type { FoldFile } from "../../../src/model/fold-file.js";

const load = (n: string): FoldFile =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../public/examples/${n}`, import.meta.url)), "utf8")) as FoldFile;

describe("global Otter quench settles a frustrated guided kirigami fold", () => {
  it("drains the guided pyramid to a true rest, far below the bare ζ-damped residual", () => {
    // Ramp to the target under bare ζ (the fold itself), THEN settle with the global quench — the
    // exact order the view uses (quench only at target), and the algorithm gpu.relax() mirrors.
    const q = buildScene(load("akde-hex.fkld"))!.scene;
    q.solver.solve(8000, 1); // ramp to foldPercent = 1
    let prevKE = Infinity;
    for (let i = 0; i < 6000; i++) {
      q.solver.step();
      prevKE = kineticDamp(q.model, prevKE);
    }
    const keQuench = totalKineticEnergy(q.model);

    // Bare ζ-damped baseline over the same step budget (what the GPU did before → the jitter).
    const b = buildScene(load("akde-hex.fkld"))!.scene;
    b.solver.solve(14000, 1);
    const keBare = totalKineticEnergy(b.model);

    for (let i = 0; i < q.model.position.length; i++) {
      expect(Number.isFinite(q.model.position[i])).toBe(true);
    }
    expect(keQuench, `keQuench=${keQuench} keBare=${keBare}`).toBeLessThan(1e-3); // true rest
    expect(keQuench).toBeLessThan(keBare); // strictly better than bare ζ damping
  });
});
