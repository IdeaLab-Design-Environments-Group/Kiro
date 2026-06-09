/**
 * Picks the fold scene for a loaded model — always folding the model's **own loaded geometry** so
 * the 3D Sim shows exactly what the viewer shows:
 *  - foldable file with embedded guidance (a `foldedForm` goal frame + `fkld:vertices_driven`, e.g.
 *    `akde-hex`): guided fold on the real geometry (crisp, what-you-see);
 *  - foldable AKDE pyramid with no embedded guidance whose geometry matches its recomputed net
 *    (e.g. `akde-square-pyramid`, or a freshly created pyramid): the guided pipeline on that same
 *    geometry, so it still closes crisply;
 *  - any other foldable crease pattern: the generic crease-target free fold on its real geometry;
 *  - a non-foldable file we can still recognize as a pyramid: recompute as a last resort.
 */
import type { FoldFile } from "../model/fold-file.js";
import type { KirigamiInputs } from "../model/types.js";
import { computeState } from "../model/geometry.js";
import { buildFoldScene } from "./build.js";
import { buildSceneFromFold, isFoldable } from "./fold-adapter.js";
import type { FoldScene } from "./build.js";

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

/** Build the best available fold scene, plus a human label of the path taken. */
export function buildScene(fold: FoldFile): { scene: FoldScene; mode: "guided" | "free" } | null {
  if (isFoldable(fold)) {
    // Fold the ACTUAL loaded geometry. If the file ships a folded goal frame, it folds guided.
    const scene = buildSceneFromFold(fold);
    if (anyDriven(scene.model.driven)) return { scene, mode: "guided" };

    // Foldable but no embedded guidance: a recognizable AKDE pyramid whose geometry matches its
    // recomputed net folds crisply via the guided pipeline on that same geometry. (createPyramid
    // and akde-square-pyramid have no folded frame; this keeps them crisp without ignoring the
    // viewer's model — the recomputed net is identical to the loaded one.)
    const inputs = pyramidInputsFromFold(fold);
    if (inputs) {
      const guided = buildFoldScene(computeState(inputs));
      if (guided.net.vertices.length === (fold.vertices_coords?.length ?? -1)) {
        return { scene: guided, mode: "guided" };
      }
    }
    // Anything else: free-fold the loaded geometry as-is.
    return { scene, mode: "free" };
  }

  // Not directly foldable, but recognizable as a pyramid → recompute as a last resort.
  const inputs = pyramidInputsFromFold(fold);
  if (inputs) return { scene: buildFoldScene(computeState(inputs)), mode: "guided" };
  return null;
}
