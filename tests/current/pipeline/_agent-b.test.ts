import { describe, it } from "vitest";
import { kirigamize } from "../../../src/pipeline/kirigamize.js";
import { buildSceneFromFold } from "../../../src/sim/fold-adapter.js";
import { makeCube, makePyramid, makeSaddleFan, makeTent } from "./fixtures/targets.js";

describe("agent-b probe", () => {
  it("kinematic path strain at fp samples", { timeout: 120000 }, () => {
    for (const [name, mesh] of [
      ["cube", makeCube()],
      ["pyramid", makePyramid(4, 50, 30)],
      ["saddleFan", makeSaddleFan()],
      ["tent", makeTent()],
    ] as const) {
      const r = kirigamize(mesh, { verify: false });
      const probe = (fkld: typeof r.fkld, label: string): void => {
        const scene = buildSceneFromFold(fkld);
        const m = scene.model;
        const abs: number[] = [];
        const tens: number[] = [];
        for (const fp of [0.25, 0.5, 0.75, 1]) {
          for (let i = 0; i < m.position.length; i++) {
            m.position[i] = m.rest[i] + (m.goal[i] - m.rest[i]) * fp;
          }
          let meanAbs = 0;
          let meanTens = 0;
          for (let b = 0; b < m.beams.count; b++) {
            const a = m.beams.n0[b];
            const c = m.beams.n1[b];
            const l = Math.hypot(
              m.position[3 * a] - m.position[3 * c],
              m.position[3 * a + 1] - m.position[3 * c + 1],
              m.position[3 * a + 2] - m.position[3 * c + 2],
            );
            meanAbs += Math.abs(l / m.beams.rest[b] - 1);
            meanTens += Math.max(0, l / m.beams.rest[b] - 1);
          }
          abs.push(+(meanAbs / Math.max(1, m.beams.count)).toFixed(4));
          tens.push(+(meanTens / Math.max(1, m.beams.count)).toFixed(4));
        }
        console.log(label, "abs:", abs.join(" "), "| tensile:", tens.join(" "));
      };
      probe(r.fkld, name);
      if (name === "cube") {
        const corrupted = JSON.parse(JSON.stringify(r.fkld)) as typeof r.fkld;
        for (const c of corrupted.vertices_coords as number[][]) c[0] *= 1.5;
        probe(corrupted, "cube-CORRUPT");
      }
    }
  });
});
