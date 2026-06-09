/**
 * Picks the fold scene for a loaded model, routing by **file type** and always folding the
 * model's own loaded geometry (the 3D Sim shows exactly what the viewer shows):
 *
 *  - **FKLD → the kirigami sim.** Cuts are first-class: cut edges open (no crease across them) and
 *    the fold is guided to a goal mesh when the file carries one (`foldedForm` frame +
 *    `fkld:vertices_driven`, e.g. `akde-hex`), or via the AKDE pyramid pipeline on matching
 *    geometry (`akde-square-pyramid`, freshly created pyramids), else a cut-aware free fold.
 *  - **plain FOLD → Neil's normal origami sim.** The standard Gershenfeld forward fold: ramp the
 *    crease targets (from `edges_foldAngle`, else M/V defaults) flat → folded, free (no goal-mesh
 *    guidance, no pyramid recompute) — origami, not kirigami.
 *  - a non-foldable file we can still recognize as a pyramid spec: recompute as a last resort.
 */
import { type FoldFile, isFkld } from "../model/fold-file.js";
import type { KirigamiInputs } from "@kirigami/model/types.js";
import { computeState } from "@kirigami/model/geometry.js";
import { buildFoldScene } from "./build.js";
import { buildSceneFromFold, isFoldable } from "./fold-adapter.js";
import type { FoldScene } from "./build.js";

/** Which simulator handled the model: `kirigami` (cut-aware / guided) or `origami` (Neil's free fold). */
export type SimKind = "kirigami" | "origami";
/** Drive style: `guided` (boundary driven to a goal mesh) or `free` (crease-target forward fold). */
export type FoldMode = "guided" | "free";
export interface BuiltScene {
  scene: FoldScene;
  mode: FoldMode;
  sim: SimKind;
}

const num = (re: RegExp, s: string): number | null => {
  const m = re.exec(s);
  return m ? Number(m[1]) : null;
};

/** Recover AKDE pyramid inputs from the FKLD frame_title (e.g. "… (N=4, L=50mm, H=30mm, T=0.31mm)"). */
export function pyramidInputsFromFold(fold: FoldFile): KirigamiInputs | null {
  const title = fold.frame_title;
  if (typeof title !== "string" || !/pyramid/i.test(title)) return null;
  const edgeCount = num(/N=(\d+(?:\.\d+)?)/, title);
  const edgeLength = num(/L=(\d+(?:\.\d+)?)\s*mm/, title);
  const totalCurvature = num(/H=(\d+(?:\.\d+)?)\s*mm/, title);
  const materialThickness = num(/T=(\d+(?:\.\d+)?)\s*mm/, title);
  if (edgeCount == null || edgeLength == null || totalCurvature == null || materialThickness == null) return null;
  return { edgeCount, edgeLength, totalCurvature, materialThickness };
}

/** True when we can build a fold scene from this model (pyramid inputs or a foldable crease pattern). */
export function canSimulate(fold: FoldFile): boolean {
  return pyramidInputsFromFold(fold) !== null || isFoldable(fold);
}

const anyDriven = (driven: Uint8Array): boolean => {
  for (let i = 0; i < driven.length; i++) if (driven[i]) return true;
  return false;
};

/** Build the fold scene for a model, routed by file type (FKLD = kirigami, FOLD = origami). */
export function buildScene(fold: FoldFile): BuiltScene | null {
  if (isFoldable(fold)) {
    const scene = buildSceneFromFold(fold); // folds the loaded geometry (cut-aware; guided iff a goal frame is present)

    if (isFkld(fold)) {
      // KIRIGAMI SIM — cuts first-class, guided to a goal mesh when available.
      if (anyDriven(scene.model.driven)) return { scene, mode: "guided", sim: "kirigami" };
      // No embedded guidance: an AKDE pyramid whose geometry matches its recomputed net folds
      // crisply via the guided pipeline on that same geometry (no folded frame needed).
      const inputs = pyramidInputsFromFold(fold);
      if (inputs) {
        const guided = buildFoldScene(computeState(inputs));
        if (guided.net.vertices.length === (fold.vertices_coords?.length ?? -1)) {
          return { scene: guided, mode: "guided", sim: "kirigami" };
        }
      }
      // Cut-aware free fold of the loaded kirigami geometry.
      return { scene, mode: "free", sim: "kirigami" };
    }

    // NEIL'S NORMAL ORIGAMI SIM — plain FOLD: standard free crease-target forward fold. (Plain FOLD
    // carries no `fkld:vertices_driven`, so buildSceneFromFold never guided it; this is always free.)
    return { scene, mode: anyDriven(scene.model.driven) ? "guided" : "free", sim: "origami" };
  }

  // Not directly foldable, but recognizable as a pyramid spec → kirigami recompute as a last resort.
  const inputs = pyramidInputsFromFold(fold);
  if (inputs) return { scene: buildFoldScene(computeState(inputs)), mode: "guided", sim: "kirigami" };
  return null;
}
