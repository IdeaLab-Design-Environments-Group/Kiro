import { describe, it } from "vitest";
import { kirigamize } from "../../../src/pipeline/kirigamize.js";
import { buildSceneFromFold, measureTheta, FoldSolver } from "../../../src/sim/index.js";
import { makeCube } from "./fixtures/targets.js";

function rescale(scene: ReturnType<typeof buildSceneFromFold>): void {
  const net = scene.net;
  let mn = Infinity, mx = -Infinity;
  for (const v of net.vertices) { mn = Math.min(mn, v.x, v.y, v.z); mx = Math.max(mx, v.x, v.y, v.z); }
  const s = 2 / Math.max(mx - mn, 1e-9);
  const m = scene.model;
  for (let i = 0; i < m.position.length; i++) { m.position[i] *= s; m.rest[i] *= s; m.goal[i] *= s; }
  for (let i = 0; i < m.beams.count; i++) { m.beams.rest[i] *= s; m.beams.k[i] /= s; }
  for (let i = 0; i < m.creases.count; i++) m.creases.k[i] *= s;
}

describe("isolation", () => {
  it("cube: zero targets, then single crease", { timeout: 300000 }, () => {
    const result = kirigamize(makeCube(), { verify: false });
    for (const mode of ["allZero", "singleM", "allOn"] as const) {
      const scene = buildSceneFromFold(result.fkld);
      rescale(scene);
      const m = scene.model;
      m.driven.fill(0); m.fixed.fill(0); m.params.zeta = 0.45;
      const saved = Array.from(m.creases.targetTheta);
      if (mode === "allZero") m.creases.targetTheta.fill(0);
      if (mode === "singleM") {
        m.creases.targetTheta.fill(0);
        const mc = Array.from({ length: m.creases.count }, (_, c) => c).find((c) => m.creases.assignment[c] === "M")!;
        m.creases.targetTheta[mc] = saved[mc];
      }
      scene.solver = new FoldSolver(m);
      scene.solver.solve(12000, 1);
      let ke = 0;
      for (let i = 0; i < m.velocity.length; i++) ke += 0.5 * m.velocity[i] * m.velocity[i];
      let cres = 0;
      for (let c = 0; c < m.creases.count; c++) {
        cres += Math.abs(measureTheta(m, m.creases.face1[c], m.creases.face2[c], m.creases.n3[c], m.creases.n4[c]) - m.creases.targetTheta[c]);
      }
      cres /= m.creases.count;
      let maxP = 0;
      for (let i = 0; i < m.position.length; i++) maxP = Math.max(maxP, Math.abs(m.position[i]));
      console.log(`${mode}: ke=${ke.toExponential(1)} creaseRes=${cres.toFixed(3)} maxPos=${maxP.toFixed(2)} masses=${Array.from(new Set(Array.from(m.mass))).join(",")}`);
    }
  });
});
