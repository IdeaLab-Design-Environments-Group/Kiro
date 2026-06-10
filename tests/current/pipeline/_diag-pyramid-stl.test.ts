import { describe, it } from "vitest";
import { kirigamizeText } from "../../../src/pipeline/kirigamize.js";

function pyramidStl(L = 100, H = 70.7): string {
  // closed square pyramid: base at z=0 (corners 0..L, NOT centered), apex on top
  const A = [L / 2, L / 2, H];
  const c = [[0, 0, 0], [L, 0, 0], [L, L, 0], [0, L, 0]];
  const tris: number[][][] = [
    [c[0], c[1], A], [c[1], c[2], A], [c[2], c[3], A], [c[3], c[0], A], // lateral
    [c[0], c[2], c[1]], [c[0], c[3], c[2]], // base (down-facing)
  ];
  const lines = ["solid pyr"];
  for (const t of tris) {
    lines.push(" facet normal 0 0 0", "  outer loop");
    for (const v of t) lines.push(`   vertex ${v[0]} ${v[1]} ${v[2]}`);
    lines.push("  endloop", " endfacet");
  }
  lines.push("endsolid pyr");
  return lines.join("\n");
}

describe("pyramid.stl repro", () => {
  it("kirigamize closed pyramid STL", { timeout: 120000 }, () => {
    const result = kirigamizeText(pyramidStl(), "stl", { verify: true });
    const r = result.report!;
    console.log(JSON.stringify({
      cuts: result.plan.cutEdges.length, relief: result.unfold.reliefEdges.length,
      faces: result.sheet.faces.length, patches: result.unfold.patchCount,
      dH: +r.dH.toFixed(2), eps: +r.epsilon.toFixed(2), strain: +r.meanStrain.toFixed(4),
      creaseRes: +r.creaseResidual.toFixed(4), freeV: r.freeVertices,
      converged: r.converged, attempts: r.attempts, iters: r.iterations,
    }));
  });
});
