/**
 * Regression for the guided-fold target rule (see fold-adapter.ts): a goal
 * frame is only trusted as far as it is isometrically consistent. The AKDE
 * pyramid examples ship chimera goal frames (real positions only for driven
 * vertices, flat coords for the rest) — measuring crease targets against
 * them poisoned the fold (decagon collapsed flat with overlapping flaps).
 * With the rule, those files keep the AKDE assignment defaults and tuck
 * properly; complete goal frames (Kirigamizer-emitted) still get exact
 * goal-measured targets.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildScene } from "../../../src/sim/scene.js";
import type { FoldFile } from "../../../src/model/fold-file.js";

function foldExample(path: string) {
  const fold = JSON.parse(readFileSync(path, "utf8")) as FoldFile;
  const built = buildScene(fold);
  expect(built).not.toBeNull();
  expect(built!.mode).toBe("guided");
  const { model, solver } = built!.scene;
  solver.solve(16000, 1);
  return { fold, model };
}

/**
 * Mean strain over bars NOT between two driven nodes. Bars between driven
 * pairs are excluded because the AKDE design deliberately collapses some of
 * them: each molecule's outer corner pair is driven to MERGE at a base-ring
 * vertex (goal distance 0 vs rest w), so those bars read ≈0.52 "strain" at
 * the goal pose by design (identical on the original and regenerated
 * decagon). The free bars are the material that must fold isometrically.
 */
function freeBarStrain(model: {
  beams: { count: number; n0: Int32Array; n1: Int32Array; rest: Float32Array };
  position: Float32Array;
  driven: Uint8Array;
}): number {
  let s = 0;
  let n = 0;
  for (let i = 0; i < model.beams.count; i++) {
    const a = model.beams.n0[i];
    const b = model.beams.n1[i];
    if (model.driven[a] && model.driven[b]) continue;
    const l = Math.hypot(
      model.position[3 * a] - model.position[3 * b],
      model.position[3 * a + 1] - model.position[3 * b + 1],
      model.position[3 * a + 2] - model.position[3 * b + 2],
    );
    s += Math.abs(l / model.beams.rest[i] - 1);
    n++;
  }
  return s / Math.max(1, n);
}

describe("bundled AKDE guided examples fold cleanly (chimera goal frames)", () => {
  for (const name of ["akde-decagon-pyramid", "akde-hex"]) {
    it(`${name}: assignment-design targets, folds 3D with low strain`, { timeout: 60_000 }, () => {
      const { model } = foldExample(`public/examples/${name}.fkld`);

      // Targets must be the AKDE design (M:+1.2, V:−2.9, F:0) — uniform signs,
      // no chimera-measured garbage (the overlap bug showed M≈0 and F≈±1.5).
      for (let c = 0; c < model.creases.count; c++) {
        const t = model.creases.targetTheta[c];
        const a = model.creases.assignment[c];
        if (a === "M") expect(t).toBeGreaterThan(0.5);
        else if (a === "V") expect(t).toBeLessThan(-0.5);
        else expect(Math.abs(t)).toBeLessThan(0.2);
      }

      // The net must actually rise into a cone: z extent ≈ goal z extent.
      let zLo = Infinity, zHi = -Infinity, gLo = Infinity, gHi = -Infinity;
      for (let i = 0; i < model.numNodes; i++) {
        zLo = Math.min(zLo, model.position[3 * i + 2]);
        zHi = Math.max(zHi, model.position[3 * i + 2]);
        gLo = Math.min(gLo, model.goal[3 * i + 2]);
        gHi = Math.max(gHi, model.goal[3 * i + 2]);
      }
      expect(zHi - zLo).toBeGreaterThan(0.8 * (gHi - gLo));
      expect(freeBarStrain(model)).toBeLessThan(0.1); // near-isometric tuck
      for (let i = 0; i < model.position.length; i++) expect(Number.isFinite(model.position[i])).toBe(true);
    });
  }
});
