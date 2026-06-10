import { describe, it } from "vitest";
import { kirigamizeText } from "../../../src/pipeline/kirigamize.js";
import { buildSceneFromFold } from "../../../src/sim/index.js";

function pyramidStl(L = 100, H = 70.7): string {
  const A = [L / 2, L / 2, H];
  const c = [[0, 0, 0], [L, 0, 0], [L, L, 0], [0, L, 0]];
  const tris: number[][][] = [
    [c[0], c[1], A], [c[1], c[2], A], [c[2], c[3], A], [c[3], c[0], A],
    [c[0], c[2], c[1]], [c[0], c[3], c[2]],
  ];
  const lines = ["solid pyr"];
  for (const t of tris) {
    lines.push(" facet normal 0 0 0", "  outer loop");
    for (const v of t) lines.push(`   vertex ${v[0]} ${v[1]} ${v[2]}`);
    lines.push("  endloop", " endfacet");
  }
  lines.push("endsolid pyr");
  return lines.join("\n");
}

describe("frame diag", () => {
  it("compare goal frame vs verify targetSim", { timeout: 120000 }, () => {
    const result = kirigamizeText(pyramidStl(), "stl", { verify: false });
    const fkld = result.fkld;
    const scene = buildSceneFromFold(fkld);
    console.log("meta.scale:", scene.net.meta.scale);
    // flat bbox center from fkld coords (what verify reconstructs)
    const raw = fkld.vertices_coords as number[][];
    let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity,minZ=Infinity,maxZ=-Infinity;
    for (const c of raw){ minX=Math.min(minX,c[0]);maxX=Math.max(maxX,c[0]);minY=Math.min(minY,c[1]);maxY=Math.max(maxY,c[1]); minZ=Math.min(minZ,c[2]??0);maxZ=Math.max(maxZ,c[2]??0);}
    const cx=(minX+maxX)/2, cy=(minY+maxY)/2, cz=(minZ+maxZ)/2;
    const span = Math.max(maxX-minX, maxY-minY, maxZ-minZ);
    console.log("flat bbox center:", cx.toFixed(2), cy.toFixed(2), cz.toFixed(2), "span:", span.toFixed(2), "TARGET/span:", (2/span).toFixed(6));
    // goal of vertex 0 in sim units vs verify's transform of Q vertex
    const goalFrame = (fkld.file_frames as {vertices_coords:number[][]}[])[0].vertices_coords;
    const driven = fkld["fkld:vertices_driven"] as number[];
    const i = driven.findIndex((d)=>d===1);
    console.log("sheet vertex", i, "goal_mm:", goalFrame[i].map(x=>x.toFixed(1)).join(","));
    console.log("model.goal_sim:", [scene.model.goal[3*i],scene.model.goal[3*i+1],scene.model.goal[3*i+2]].map(x=>x.toFixed(4)).join(","));
    const s = scene.net.meta.scale;
    console.log("verify targetSim of same point:", [(goalFrame[i][0]-cx)*s,(goalFrame[i][1]-cy)*s,(goalFrame[i][2]-cz)*s].map(x=>x.toFixed(4)).join(","));
  });
});
