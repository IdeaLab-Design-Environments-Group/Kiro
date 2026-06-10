import { describe, it } from "vitest";
import { kirigamize } from "../../../src/pipeline/kirigamize.js";
import { buildSceneFromFold, measureTheta } from "../../../src/sim/index.js";
import { makeCube, makeTent } from "./fixtures/targets.js";

// replicate verify's rescale
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

describe("keEps sweep", () => {
  it("cube + tent", { timeout: 600000 }, async () => {
    const { FoldSolver } = await import("../../../src/sim/index.js");
    for (const [name, mesh] of [["cube", makeCube()], ["tent", makeTent()]] as const) {
      const result = kirigamize(mesh, { verify: false });
      for (const [label, keEps, iters] of [["damp90", 1e-8, 48000], ["damp95", 1e-8, 48000], ["damp99", 1e-8, 96000]] as const) {
        const scene = buildSceneFromFold(result.fkld);
        rescale(scene);
        const m = scene.model;
        m.driven.fill(0); m.fixed.fill(0); m.params.zeta = 0.45;
        scene.solver = new FoldSolver(m);
        const damp = label === "damp90" ? 0.9 : label === "damp95" ? 0.95 : 0.99;
        const r = scene.solver.solveUntilSettled({ target: 1, maxIters: iters, keEps, minSettleIters: 2000, damp, guard: true, removeRigidBody: true });
        let cres = 0;
        for (let c = 0; c < m.creases.count; c++) {
          cres += Math.abs(measureTheta(m, m.creases.face1[c], m.creases.face2[c], m.creases.n3[c], m.creases.n4[c]) - m.creases.targetTheta[c]);
        }
        cres /= Math.max(1, m.creases.count);
        console.log(`${name} ${label}: settled=${r.converged} iters=${r.iters} ke=${r.ke.toExponential(1)} creaseRes=${cres.toFixed(3)}`);
      }
    }
  });
});
