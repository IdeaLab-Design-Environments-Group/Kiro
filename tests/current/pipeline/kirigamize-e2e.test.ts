/**
 * The M5 integration gate: full pipeline (condition → plan → unfold → emit →
 * sim-verify) on the acceptance targets. The simulator is the oracle —
 * equilibrium verification: the folded goal pose must be a stable
 * equilibrium of the emitted pattern (d_H ≤ ε, bars unstrained, creases at
 * their goal dihedrals after settling). See src/pipeline/verify.ts for why
 * v1 verifies equilibrium rather than the fold path.
 */
import { describe, expect, it } from "vitest";
import { kirigamize, kirigamizeText } from "../../../src/pipeline/kirigamize.js";
import { PipelineError } from "../../../src/pipeline/types.js";
import { makeCube, makeEnneper, makeOctahedron, makeSaddleRoof, makeTent, toAsciiStl, makePyramid } from "./fixtures/targets.js";

const E2E = { timeout: 120_000 };

describe("kirigamize end-to-end (sim as oracle)", () => {
  it("cube: classic 7-cut net verifies", E2E, () => {
    const result = kirigamize(makeCube(), { verify: true });
    const r = result.report!;
    expect(r.converged, `dH=${r.dH.toFixed(3)}mm ε=${r.epsilon.toFixed(3)}mm strain=${r.meanStrain} res=${r.creaseResidual}`).toBe(true);
    expect(r.dHRel).toBeLessThanOrEqual(0.05);
    expect(r.meanStrain).toBeLessThan(0.1);
    expect(r.creaseResidual).toBeLessThan(0.15);
  });

  it("saddle roof (acceptance): negative curvature realized by slits", E2E, () => {
    const result = kirigamize(makeSaddleRoof(), { verify: true });
    const r = result.report!;
    // the planner must have used minor slits (δ<0) somewhere
    const minors = result.sheet.cutType.filter((t) => t === "minor").length;
    expect(minors).toBeGreaterThan(0);
    expect(r.converged, `dH=${r.dH.toFixed(3)}mm ε=${r.epsilon.toFixed(3)}mm attempts=${r.attempts}`).toBe(true);
    expect(r.dHRel).toBeLessThanOrEqual(0.05);
    expect(r.meanStrain).toBeLessThan(0.1);
  });

  it("Enneper patch (acceptance): folds to within ε", E2E, () => {
    const result = kirigamize(makeEnneper(), { verify: true });
    const r = result.report!;
    expect(r.converged, `dH=${r.dH.toFixed(3)}mm ε=${r.epsilon.toFixed(3)}mm attempts=${r.attempts}`).toBe(true);
    expect(r.dHRel).toBeLessThanOrEqual(0.05);
    expect(r.creaseResidual).toBeLessThan(0.15);
  });

  it("tent: free interior ridge vertices are genuinely relaxed and stay put", E2E, () => {
    const result = kirigamize(makeTent(), { verify: true });
    const r = result.report!;
    expect(result.plan.cutEdges.length).toBe(0); // fold line is intrinsically flat — no cuts
    expect(r.freeVertices).toBeGreaterThan(0); // the solver really relaxes these
    expect(r.converged, `dH=${r.dH.toFixed(3)}mm strain=${r.meanStrain} res=${r.creaseResidual}`).toBe(true);
    expect(r.dHRel).toBeLessThanOrEqual(0.05);
  });

  it("closed pyramid via STL text: minimal cuts and verified (frame-map regression)", E2E, () => {
    // Closed square pyramid, base at 0..L (deliberately NOT origin-centered —
    // this is the case where verify's old flat-bbox frame reconstruction
    // diverged from the adapter's driven-centroid alignment and reported
    // d_H ≈ 1.3 bbox diagonals on a perfect fold).
    const L = 100;
    const H = 70.7;
    const A = { x: L / 2, y: L / 2, z: H };
    const c = [
      { x: 0, y: 0, z: 0 },
      { x: L, y: 0, z: 0 },
      { x: L, y: L, z: 0 },
      { x: 0, y: L, z: 0 },
    ];
    const closed = {
      vertices: [c[0], c[1], c[2], c[3], A],
      faces: [
        [0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4], // lateral
        [0, 2, 1], [0, 3, 2], // base
      ] as [number, number, number][],
    };
    const result = kirigamizeText(toAsciiStl(closed), "stl", { verify: true });
    const r = result.report!;
    // CUT MINIMALITY: 5 defect vertices on a closed solid need a spanning
    // tree — exactly V−1 = 4 cut edges, and no relief cuts on this target.
    expect(result.plan.cutEdges.length).toBe(4);
    expect(result.unfold.reliefEdges.length).toBe(0);
    expect(result.sheet.faces.length).toBe(6);
    expect(r.converged, `dH=${r.dH.toFixed(3)}mm ε=${r.epsilon.toFixed(3)}mm strain=${r.meanStrain}`).toBe(true);
    expect(r.dHRel).toBeLessThanOrEqual(0.05);
    expect(r.attempts).toBe(1); // no retries needed — a correct pattern verifies first try
  });

  it("open pyramid: a single slit to the boundary, nothing more", E2E, () => {
    const result = kirigamize(makePyramid(4, 50, 30), { verify: true });
    expect(result.plan.cutEdges.length).toBe(1); // apex dart: shortest path to ∂Q
    expect(result.unfold.reliefEdges.length).toBe(0);
    expect(result.report!.converged).toBe(true);
  });

  it("tuck-all on a non-developable target throws the honest deferral error", () => {
    expect(() => kirigamize(makeOctahedron(), { strategy: "tuck-all", verify: false })).toThrow(
      /tuck-all.*deferred/,
    );
    try {
      kirigamize(makeOctahedron(), { strategy: "tuck-all", verify: false });
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineError);
      expect((err as PipelineError).stage).toBe("unfold");
    }
  });

  it("verify:false emits the pattern without a report", () => {
    const result = kirigamize(makeCube(), { verify: false });
    expect(result.report).toBeNull();
    expect(result.fkld.file_creator).toBe("Kirigamizer");
    expect(result.plan.cutEdges.length).toBe(7);
  });
});
