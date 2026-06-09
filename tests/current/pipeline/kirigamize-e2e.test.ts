/**
 * The M5 integration gate: full pipeline (condition → plan → unfold → emit →
 * sim-verify) on the acceptance targets. The simulator is the oracle —
 * equilibrium verification: the folded goal pose must be a stable
 * equilibrium of the emitted pattern (d_H ≤ ε, bars unstrained, creases at
 * their goal dihedrals after settling). See src/pipeline/verify.ts for why
 * v1 verifies equilibrium rather than the fold path.
 */
import { describe, expect, it } from "vitest";
import { kirigamize } from "../../../src/pipeline/kirigamize.js";
import { PipelineError } from "../../../src/pipeline/types.js";
import { makeCube, makeEnneper, makeOctahedron, makeSaddleRoof, makeTent } from "./fixtures/targets.js";

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
