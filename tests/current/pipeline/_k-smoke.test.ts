import { describe, it } from "vitest";
import { kirigamize } from "../../../src/pipeline/kirigamize.js";
import { makeCube, makeSaddleFan, makeSaddleRoof, makeTent, makeEnneper, makePyramid } from "./fixtures/targets.js";

describe("K smoke", () => {
  it("all targets", { timeout: 600000 }, () => {
    for (const [name, mesh] of [
      ["cube", makeCube()], ["saddleFan", makeSaddleFan()], ["saddleRoof", makeSaddleRoof()],
      ["tent", makeTent()], ["enneper", makeEnneper()], ["openPyr", makePyramid(4, 50, 30)],
    ] as const) {
      try {
        const r = kirigamize(mesh, { verify: true });
        const rep = r.report!;
        console.log(name, JSON.stringify({
          cuts: r.plan.cutEdges.length, vents: r.unfold.vents.length, patches: r.unfold.patchCount,
          fff_dH: +rep.foldFromFlat.dH.toFixed(2), fff_strain: +rep.foldFromFlat.meanStrain.toFixed(4),
          fff_res: +rep.foldFromFlat.creaseResidual.toFixed(3), fff_settled: rep.foldFromFlat.settled,
          eq_dH: +rep.equilibrium.dH.toFixed(2), eps: +rep.epsilon.toFixed(2),
          converged: rep.converged, attempts: rep.attempts,
        }));
      } catch (e) {
        console.log(name, "THREW:", (e as Error).message.slice(0, 140));
      }
    }
  });
});
