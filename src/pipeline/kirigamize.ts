/**
 * The Kirigamizer driver (M5): mesh → cut+fold FKLD, verified in the sim.
 *
 * Pattern: facade/orchestrator returning ALL intermediates (AKDE
 * computeState-chain precedent) — every stage artifact is in the result so
 * tests and the UI can introspect without re-running.
 *
 * Stage order (kirigamizer_algorithms.tex driver):
 *   condition → topology/genus gate → angle defects → plan cuts →
 *   seamed unfold → pack & classify → emit FKLD → verify (fold + dH).
 *
 * Optimize schedule (budget = 3 attempts; "Stage 5 is a search, not a
 * solver"): (1) solve at `iterations`; if dH > ε → (2) add the worst source
 * vertex as an extra relief terminal and re-run plan→emit once; if still
 * failing → (3) re-solve at 3× iterations. Returns the best report with an
 * honest `converged` flag.
 */

import { condition, assertGenusZero } from "./conditioning.js";
import { angleDefects } from "./curvature.js";
import { emitFkld } from "./emit.js";
import { parseMesh } from "./import.js";
import { buildTopology } from "./mesh.js";
import { planCuts } from "./plan-cuts.js";
import { placeSheet } from "./route-seams.js";
import { seamedUnfold } from "./unfold.js";
import { DEFAULT_VERIFY, verifyFold } from "./verify.js";
import type { FoldFile } from "../model/fold-file.js";
import {
  PipelineError,
  type ConditionReport,
  type CutPlan,
  type DefectReport,
  type Sheet,
  type TriMesh,
  type UnfoldResult,
  type VerifyReport,
} from "./types.js";

export interface KirigamizeOptions {
  /** Seam-visibility weight λ (cost plumbing; vis ≡ 0 in v1). */
  lambda: number;
  /** Cut every defect vertex ("dart") or tuck the positive ones ("tuck-all"). */
  strategy: "dart" | "tuck-all";
  /** ε as a fraction of Q's bbox diagonal. */
  epsilonRel: number;
  /** Run the simulator verification (M5). */
  verify: boolean;
  /** Solver iteration cap per attempt. */
  iterations: number;
}

export const DEFAULT_KIRIGAMIZE: KirigamizeOptions = {
  lambda: 0,
  strategy: "dart",
  epsilonRel: DEFAULT_VERIFY.epsilonRel,
  verify: true,
  iterations: DEFAULT_VERIFY.iterations,
};

export interface KirigamizeResult {
  fkld: FoldFile;
  conditioning: ConditionReport[];
  defects: DefectReport;
  plan: CutPlan;
  unfold: UnfoldResult;
  sheet: Sheet;
  report: VerifyReport | null;
}

export function kirigamize(input: TriMesh, options: Partial<KirigamizeOptions> = {}): KirigamizeResult {
  const opts = { ...DEFAULT_KIRIGAMIZE, ...options };

  // Stage 0: condition + gates.
  const { mesh, reports } = condition(input);
  const topo = buildTopology(mesh);
  assertGenusZero(mesh, topo);

  // Stage 1: curvature.
  const defects = angleDefects(mesh, topo);

  // Stages 2–4 as a re-runnable unit (the optimize schedule re-plans once).
  const runPipeline = (extraTerminals: number[]) => {
    const plan = planCuts(mesh, topo, defects, {
      lambda: opts.lambda,
      strategy: opts.strategy,
      extraTerminals,
    });
    const tuckSet = plan.perVertexAction
      .map((a, v) => ({ a, v }))
      .filter((x) => x.a === "tuck")
      .map((x) => x.v);
    let unfold: UnfoldResult;
    try {
      unfold = seamedUnfold(mesh, topo, plan, defects);
    } catch (err) {
      if (err instanceof PipelineError && err.stage === "unfold" && tuckSet.length > 0) {
        // Honest scope: tucked δ>0 vertices stay interior, so the patch is not
        // developable — full Origamizer tuck crease generation is deferred.
        throw new PipelineError(
          "unfold",
          `tuck-all left ${tuckSet.length} positive-curvature vertices uncut and Origamizer tuck crease generation is deferred — use strategy "dart" for non-developable targets`,
          { tuckSet },
        );
      }
      throw err;
    }
    const sheet = placeSheet(unfold, { mesh, topo, defects });
    const fkld = emitFkld(sheet, {
      defects,
      target: mesh,
      topo,
      tuckSet,
      actions: plan.perVertexAction,
      lambda: opts.lambda,
      strategy: opts.strategy,
    });
    return { plan, unfold, sheet, fkld };
  };

  let stages = runPipeline([]);
  if (!opts.verify) {
    return { ...stages, conditioning: reports, defects, report: null };
  }

  // Stage 5: fold-from-flat verification with the bounded optimize schedule
  // (K4): (1) free fold; (2) free fold at 3× iterations; (3) re-plan with the
  // worst-fitting vertex as an extra terminal and free-fold again.
  let report = verifyFold(stages.fkld, mesh, {
    epsilonRel: opts.epsilonRel,
    iterations: opts.iterations,
  });
  let attempts = 1;

  if (!report.converged) {
    // Attempt 2: same pattern, triple the iteration budget.
    const longReport = verifyFold(stages.fkld, mesh, {
      epsilonRel: opts.epsilonRel,
      iterations: 3 * opts.iterations,
    });
    attempts = 2;
    if (longReport.foldFromFlat.dH <= report.foldFromFlat.dH) report = longReport;
  }

  if (!report.converged) {
    // Attempt 3: free the worst-fitting region with an extra relief terminal.
    const retried = runPipeline([report.worstSourceVertex]);
    const retriedReport = verifyFold(retried.fkld, mesh, {
      epsilonRel: opts.epsilonRel,
      iterations: opts.iterations,
    });
    attempts = 3;
    if (retriedReport.foldFromFlat.dH <= report.foldFromFlat.dH) {
      stages = retried;
      report = retriedReport;
    }
  }

  return {
    ...stages,
    conditioning: reports,
    defects,
    report: { ...report, attempts },
  };
}

/** Convenience wrapper for the controller: raw OBJ/STL text in, result out. */
export function kirigamizeText(
  text: string,
  ext: "obj" | "stl",
  options: Partial<KirigamizeOptions> = {},
): KirigamizeResult {
  return kirigamize(parseMesh(text, ext), options);
}
