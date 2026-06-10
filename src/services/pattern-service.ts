/**
 * **Service** — the single facade over BOTH pattern-creation paths:
 *   1. the general mesh→pattern pipeline (M1–M5, `src/pipeline/`), and
 *   2. the transferred AKDE creation pipeline (`@kirigami/model`).
 *
 * Both return the same narrow `PatternOutcome`, so the controller (and any
 * future caller) never touches `KirigamizeResult`'s stage intermediates —
 * that shape stays a pipeline/test contract, narrowed here.
 */
import { AppError } from "../core/errors.js";
import type { FoldFile } from "../model/fold-file.js";
// General mesh→pattern pipeline (M1–M5).
import { kirigamizeText } from "../pipeline/kirigamize.js";
// Transferred AKDE creation pipeline: inputs → KirigamiState → FKLD pattern.
import { computeState, defaultInputs } from "@kirigami/model/geometry.js";
import { buildFkldFile } from "@kirigami/model/fkld-export.js";

export interface PatternOutcome {
  fkld: FoldFile;
  name: string;
  /** Human-readable result line for the status channel. */
  summary: string;
  /** False when verification ran and did NOT converge. */
  ok: boolean;
}

/**
 * Run the general pipeline on mesh text: condition → curvature → plan cuts →
 * seamed unfold → pack/classify → emit FKLD → fold in the sim and verify d_H.
 * Throws PipelineError (an AppError) on stage failure.
 */
export function kirigamizeMesh(text: string, ext: "obj" | "stl", sourceName: string): PatternOutcome {
  const result = kirigamizeText(text, ext, { verify: true });
  const name = sourceName.replace(/\.(obj|stl)$/i, "") + ".fkld";
  const r = result.report;
  const cuts = result.plan.cutEdges.length + result.unfold.reliefEdges.length;
  const vents = result.unfold.vents.length;
  const verdict = r
    ? `${r.converged ? "folds from flat" : "does NOT fold from flat"}: ` +
      `d_H = ${r.foldFromFlat.dH.toFixed(2)} mm (ε = ${r.epsilon.toFixed(2)} mm), ` +
      `strain ${(100 * r.foldFromFlat.meanStrain).toFixed(1)}% · ` +
      `equilibrium d_H = ${r.equilibrium.dH.toFixed(2)} mm, ${r.attempts} attempt(s)`
    : "unverified";
  return {
    fkld: result.fkld,
    name,
    summary:
      `Kirigamized "${sourceName}" → ${cuts} cuts${vents ? `, ${vents} vent(s)` : ""}, ` +
      `${result.sheet.faces.length} faces — ${verdict}.`,
    ok: !(r && !r.converged),
  };
}

/**
 * Generate an AKDE uniform-molecule pyramid via the transferred creation
 * pipeline: default inputs → KirigamiState → FKLD crease+cut pattern. The
 * result loads exactly like an imported FKLD (its `frame_title` carries the
 * N/L/H/T the guided sim recovers). Throws AppError("create") on failure.
 */
export function createAkdePyramid(): PatternOutcome {
  const fkld = buildFkldFile(computeState(defaultInputs())) as FoldFile | null;
  if (!fkld) throw new AppError("create", "Could not create the pyramid pattern.");
  return {
    fkld,
    name: "akde-pyramid.fkld",
    summary: "Created AKDE pyramid via the transferred creation pipeline. Open 3D Sim to fold it.",
    ok: true,
  };
}
