/**
 * Regenerate `public/examples/res-square-tower.fkld` from Yoshinobu Miyamoto's RES square-tower
 * crease pattern, by running the 1:1 Origami Simulator SVG importer (`src/sim/svg-import.ts`) over
 * the original asset `public/examples/miyamotoTower.svg` (copied verbatim from
 * amandaghassaei/OrigamiSimulator `assets/Kirigami/miyamotoTower.svg`).
 *
 * This replaces the old offline `svg2fold.py`: the example is now produced by the same ported
 * loadSVG logic the app uses, so "steal the sim 1:1 + steal the tower example from there" is
 * end-to-end faithful. Free-fold, authentic OS angles (opacity 0.5 ⇒ M −90° / V +90°).
 *
 * Run headless:  npx vite-node scripts/gen-res-tower.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { importOrigamiSimulatorSvg } from "../src/sim/svg-import.js";
import { buildScene } from "../src/sim/scene.js";
import type { FoldFile } from "../src/model/fold-file.js";

const root = resolve(import.meta.dirname, "..");
const svg = readFileSync(resolve(root, "public/examples/miyamotoTower.svg"), "utf8");

const imported = importOrigamiSimulatorSvg(svg, {
  recenter: true,
  title: "RES Square Tower — Yoshinobu Miyamoto (kirigami, free-fold)",
  creator: "kirigamizer: Origami Simulator SVG → FOLD (svg-import.ts, 1:1 loadSVG port)",
  author: "Yoshinobu Miyamoto (pattern); imported from Origami Simulator SVG",
  description:
    "RES Square Tower kirigami crease pattern by Yoshinobu Miyamoto. Source SVG: " +
    "amandaghassaei/OrigamiSimulator assets/Kirigami/miyamotoTower.svg. Imported via the kirigamizer " +
    "1:1 port of Origami Simulator's loadSVG; stroke opacity 0.5 → M −90° / V +90°; free-fold.",
  unit: "mm",
});

const { stats, ...fold } = imported;
// Mark as FKLD (kirigami) + record provenance.
(fold as Record<string, unknown>)["fkld:source"] = {
  origin: "amandaghassaei/OrigamiSimulator",
  asset: "assets/Kirigami/miyamotoTower.svg",
  importer: "src/sim/svg-import.ts (1:1 pattern.js loadSVG port)",
  foldMode: "free",
  angleEncoding: "stroke-opacity → ±opacity·π (0.5 ⇒ ±90°)",
};

const outPath = resolve(root, "public/examples/res-square-tower.fkld");
writeFileSync(outPath, JSON.stringify(fold), "utf8");

console.log("Imported Miyamoto RES tower from SVG:");
console.log("  vertices:", stats.vertices, " faces:", stats.faces);
console.log(`  M=${stats.mountains}  V=${stats.valleys}  F=${stats.facets}  C=${stats.cuts}  B=${stats.borders}`);
console.log("  wrote:", outPath);

// Quick fold sanity check — free fold with self-collision (exactly what the app's 3D Sim does).
const built = buildScene(fold as FoldFile);
if (!built) throw new Error("buildScene returned null — file not foldable");
const { model, solver } = built.scene;
solver.enableCollision();
console.log(`  scene: mode=${built.mode} sim=${built.sim}  nodes=${model.numNodes} (flat verts=${stats.vertices}; cuts split add ${model.numNodes - stats.vertices})`);

for (let k = 1; k <= 10; k++) solver.solve(6000, k / 10);
solver.solve(20000, 1.0);

let strain = 0;
let finite = true;
for (let i = 0; i < model.beams.count; i++) {
  const a = model.beams.n0[i], b = model.beams.n1[i];
  const l = Math.hypot(
    model.position[3 * a] - model.position[3 * b],
    model.position[3 * a + 1] - model.position[3 * b + 1],
    model.position[3 * a + 2] - model.position[3 * b + 2],
  );
  strain += Math.abs(l / model.beams.rest[i] - 1);
}
strain /= Math.max(1, model.beams.count);
for (let i = 0; i < model.position.length; i++) if (!Number.isFinite(model.position[i])) finite = false;
// The faithful full-RES crease set is flat-foldable: the explicit dynamic solver folds it
// ISOMETRICALLY (cuts open, layers stack) — exactly Origami Simulator's dynamic-solver behaviour.
// The tall erected tower is a separate rigid-kinematic branch (guided actuation / rigid solver).
console.log(`  folded isometrically: barStrain=${(strain * 100).toFixed(2)}%  finite=${finite}`);
console.log(strain < 0.05 && finite ? "  ✓ imports + folds isometrically (cuts open, layers stack)" : "  ✗ unexpected: non-isometric or non-finite");
