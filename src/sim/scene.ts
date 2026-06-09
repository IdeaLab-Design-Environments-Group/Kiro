/**
 * Picks the right fold scene for a loaded model:
 *  - if the FKLD is a recognizable AKDE pyramid, recover its inputs and run
 *    AKDE's exact guided pipeline (`computeState` → `buildFoldScene`), which is
 *    why the pyramid folds crisply;
 *  - otherwise fall back to the generic crease-target fold (`buildSceneFromFold`).
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

/** Build the best available fold scene, plus a human label of the path taken. */
export function buildScene(fold: FoldFile): { scene: FoldScene; mode: "guided" | "free" } | null {
  const inputs = pyramidInputsFromFold(fold);
  if (inputs) return { scene: buildFoldScene(computeState(inputs)), mode: "guided" };
  if (isFoldable(fold)) return { scene: buildSceneFromFold(fold), mode: "free" };
  return null;
}
