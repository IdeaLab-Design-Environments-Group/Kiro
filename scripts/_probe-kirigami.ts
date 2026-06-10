/* Temporary probe — delete after test authoring. */
import { angleDefects } from "../src/pipeline/curvature.js";
import { buildTopology } from "../src/pipeline/mesh.js";
import { planCuts } from "../src/pipeline/plan-cuts.js";
import { seamedUnfold, findSelfOverlap } from "../src/pipeline/unfold.js";
import { placeSheet } from "../src/pipeline/route-seams.js";
import { makeCube, makeSaddleFan, makeIcosphere, makeOctahedron, makePyramid } from "../tests/current/pipeline/fixtures/targets.js";
import type { TriMesh } from "../src/pipeline/types.js";

function run(name: string, mesh: TriMesh, strategy: "dart" | "tuck-all" = "dart") {
  const topo = buildTopology(mesh);
  const defects = angleDefects(mesh, topo);
  const plan = planCuts(mesh, topo, defects, { lambda: 0, strategy });
  console.log(`\n=== ${name} ===`);
  console.log("cutEdges:", plan.cutEdges, "actions:", plan.perVertexAction.filter((a) => a !== "none"));
  const unfold = seamedUnfold(mesh, topo, plan, defects);
  console.log("patchCount:", unfold.patchCount, "relief:", unfold.reliefEdges.length);
  console.log("vents:", JSON.stringify(unfold.vents));
  console.log("lips:", JSON.stringify(unfold.lips));
  console.log("origVertex:", JSON.stringify(unfold.origVertex));
  console.log("overlap:", findSelfOverlap(unfold.flat, unfold.faces));
  const sheet = placeSheet(unfold, { mesh, topo, defects });
  const counts: Record<string, number> = {};
  sheet.assignment.forEach((a) => (counts[a] = (counts[a] ?? 0) + 1));
  console.log("assignment counts:", counts);
  console.log("cutTypes:", sheet.cutType.filter((c) => c !== null));
  console.log("sheetRect:", sheet.sheetRect);
  // flat angle sums per source vertex
  const TAU = 2 * Math.PI;
  const sums = new Map<number, number>();
  for (const f of unfold.faces) {
    for (let c = 0; c < 3; c++) {
      const at = f[c];
      const o1 = f[(c + 1) % 3];
      const o2 = f[(c + 2) % 3];
      const u = { x: unfold.flat[o1].x - unfold.flat[at].x, y: unfold.flat[o1].y - unfold.flat[at].y };
      const w = { x: unfold.flat[o2].x - unfold.flat[at].x, y: unfold.flat[o2].y - unfold.flat[at].y };
      const ang = Math.atan2(Math.abs(u.x * w.y - u.y * w.x), u.x * w.x + u.y * w.y);
      const src = unfold.origVertex[at];
      sums.set(src, (sums.get(src) ?? 0) + ang);
    }
  }
  for (const [src, s] of [...sums].sort((a, b) => a[0] - b[0])) {
    console.log(`  src ${src}: Σα = ${s.toFixed(6)} (2π−Σ = ${(TAU - s).toFixed(6)}), δ(Q) = ${src >= 0 ? defects.defects[src].toFixed(6) : "n/a"}`);
  }
  return { topo, defects, plan, unfold, sheet };
}

run("saddle fan", makeSaddleFan());
run("cube", makeCube());
run("pyramid", makePyramid(4, 50, 30));
const oct = makeOctahedron();
{
  const topo = buildTopology(oct);
  const defects = angleDefects(oct, topo);
  const plan = planCuts(oct, topo, defects, { lambda: 0, strategy: "dart" });
  console.log("\n=== octahedron plan ===", plan.cutEdges.length);
  const planT = planCuts(oct, topo, defects, { lambda: 0, strategy: "tuck-all" });
  console.log("octa tuck-all cutEdges:", planT.cutEdges.length);
}
{
  const saddle = makeSaddleFan();
  const topo = buildTopology(saddle);
  const defects = angleDefects(saddle, topo);
  const planT = planCuts(saddle, topo, defects, { lambda: 0, strategy: "tuck-all" });
  console.log("saddle tuck-all cutEdges:", planT.cutEdges, "action0:", planT.perVertexAction[0]);
}
{
  const sphere = makeIcosphere(1);
  const topo = buildTopology(sphere);
  const defects = angleDefects(sphere, topo);
  const plan = planCuts(sphere, topo, defects, { lambda: 0, strategy: "dart" });
  const unfold = seamedUnfold(sphere, topo, plan, defects);
  console.log("\n=== icosphere ===", "patches:", unfold.patchCount, "relief:", unfold.reliefEdges.length, "overlap:", findSelfOverlap(unfold.flat, unfold.faces));
}
