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
// Secondary "draw a crease pattern" path: a painted lattice → triangulated FOLD draft.
import { gridToFold, type FoldDraft, type PatternGrid } from "../model/pattern-grid.js";
// 2.5D cut-and-fold "signage" generator (Demaine et al. 2023, Theorem 1).
import { build25dPattern, SPACE_INVADER, textToBitmap } from "../pipeline/cutfold25d.js";
import { KEYS, serializeFkld } from "@dayangac/fkld";

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

/**
 * Generate a **2.5D cut-and-fold sign** (Demaine et al. 2023, Theorem 1): a pixel
 * height map → orthogonal **parallel-cut** columns + 90° mountain/valley creases
 * that pop up into the relief from one flat sheet. With `text`, the 3×5 pixel
 * font renders a textual sign; otherwise the classic Space Invader (the paper's
 * Fig. 1). The wall creases carry **±90° `edges_foldAngle`** so the 3D Sim folds
 * the true relief (not a flat ±180° fold). Throws AppError("create") on failure.
 */
export function create25dSign(input: { text?: string } = {}): PatternOutcome {
  const text = (input.text ?? "").trim();
  const bitmap = text ? textToBitmap(text) : SPACE_INVADER;
  const stem = text ? `sign-${text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "text"}` : "space-invader";
  let built;
  try {
    built = build25dPattern(bitmap, { cellMm: 12 });
  } catch (err) {
    throw new AppError("create", err instanceof Error ? err.message : String(err));
  }
  const { grid, stats, foldedForm } = built;
  const draft = gridToFold(grid);
  // Wall creases fold to 90°, not the default 180° — tag every M/V edge ±90° (deg).
  const foldAngle = draft.edges_assignment.map((a) => (a === "M" ? -90 : a === "V" ? 90 : null));
  const fkld = patternDraftToFkld(draft, grid, `${stem} (2.5D cut & fold)`, foldAngle);
  // A strip of parallel ±90° creases is a symmetric mechanism: free-folding from flat
  // can't choose a branch and stays flat. So ship the relief as a guided `foldedForm` +
  // `fkld:vertices_driven` (every vertex) — the 3D Sim drives the sheet into the relief as
  // the fold ramps, exactly as the (also-not-a-free-equilibrium) AKDE cone is handled.
  if (foldedForm.length === draft.vertices_coords.length) {
    fkld.file_frames = [
      { frame_classes: ["foldedForm"], frame_title: `${stem} relief`, vertices_coords: foldedForm },
    ];
    fkld["fkld:vertices_driven"] = draft.vertices_coords.map(() => 1);
  }
  return {
    fkld,
    name: `${stem}-25d.fkld`,
    ok: true,
    summary:
      `2.5D ${text ? `sign "${text.toUpperCase()}"` : "Space Invader"} → ` +
      `${stats.cols}×${stats.rows} pixels, V=${stats.variation} → ${stats.cols}×${stats.totalRows} sheet: ` +
      `${stats.interiorCuts} parallel cuts, ${stats.mountainCreases} mountain + ${stats.valleyCreases} valley (90°) creases. ` +
      `Open 3D Sim to pop it up.`,
  };
}

// ---- secondary path: pattern editor (a painted lattice → FKLD) -------------

/**
 * Wrap a pattern-editor lattice into a canonical FKLD `FoldFile`: the
 * triangulated FOLD draft from {@link gridToFold} plus the `fkld:` extensions
 * the rest of the shell understands (cut subtype on C edges, a minimal
 * architecture block). The standard FOLD subset is exactly what the viewer and
 * the free-fold 3D Sim consume — M/V default to ∓π, so it folds as drawn.
 */
export function fkldFromPatternGrid(grid: PatternGrid): PatternOutcome {
  const draft = gridToFold(grid);
  const stem = `pattern-${grid.cols}x${grid.rows}`;
  const fkld = patternDraftToFkld(draft, grid, stem);
  const { M, V, B, C, F } = draft.counts;
  return {
    fkld,
    name: `${stem}.fkld`,
    ok: true,
    summary:
      `Pattern editor → ${grid.cols}×${grid.rows} grid: ${M} mountain, ${V} valley, ` +
      `${C} cut, ${B} boundary, ${F} facet edges over ${draft.faces_vertices.length} faces. ` +
      `Open 3D Sim to fold it.`,
  };
}

/** Serialize the editor's pattern to a downloadable `.fkld` payload (filename + JSON text). */
export function serializePatternGrid(grid: PatternGrid): { filename: string; text: string } {
  const draft = gridToFold(grid);
  const stem = `pattern-${grid.cols}x${grid.rows}`;
  return { filename: `${stem}.fkld`, text: serializeFkld(patternDraftToFkld(draft, grid, stem)) };
}

function patternDraftToFkld(
  draft: FoldDraft,
  grid: PatternGrid,
  title: string,
  foldAngleDeg?: (number | null)[],
): FoldFile {
  const out: FoldFile = {
    file_spec: 1.2,
    file_creator: "Kiro pattern editor",
    file_classes: ["singleModel"],
    frame_title: title,
    frame_classes: ["creasePattern"],
    frame_unit: "mm",
    vertices_coords: draft.vertices_coords,
    edges_vertices: draft.edges_vertices,
    edges_assignment: draft.edges_assignment,
    faces_vertices: draft.faces_vertices,
  };
  // Explicit target fold angles (deg) — e.g. 2.5D walls fold to ±90°, not the
  // M/V default of ±180°. The sim reads `edges_foldAngle` over the assignment default.
  if (foldAngleDeg && foldAngleDeg.some((a) => a != null)) out.edges_foldAngle = foldAngleDeg;
  // Only emit the cut-subtype array when there are cuts to describe.
  if (draft.cutType.some((c) => c != null)) out[KEYS.edges.cutType] = draft.cutType;
  out[KEYS.meta.architecture] = {
    scaleMeters: 0.001,
    materialThickness: 0.3,
    sourcePattern: { cols: grid.cols, rows: grid.rows, cellLength: grid.cellMm },
  };
  return out;
}
