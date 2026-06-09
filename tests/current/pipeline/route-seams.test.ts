import { describe, expect, it } from "vitest";
import { FLAT_EPS, angleDefects } from "../../../src/pipeline/curvature.js";
import { buildTopology, edgeKey } from "../../../src/pipeline/mesh.js";
import { planCuts } from "../../../src/pipeline/plan-cuts.js";
import { cutSubtypeFor, packPatches } from "../../../src/pipeline/route-seams.js";
import { seamedUnfold } from "../../../src/pipeline/unfold.js";
import type { DefectReport, MeshTopology, TriMesh } from "../../../src/pipeline/types.js";
import { makeCube, makeSaddleFan } from "./fixtures/targets.js";

function pipelineTo(mesh: TriMesh, strategy: "dart" | "tuck-all" = "dart") {
  const topo = buildTopology(mesh);
  const defects = angleDefects(mesh, topo);
  const plan = planCuts(mesh, topo, defects, { lambda: 0, strategy });
  const unfold = seamedUnfold(mesh, topo, plan);
  const sheet = packPatches(unfold, { mesh, topo, defects });
  return { topo, defects, plan, unfold, sheet };
}

describe("packPatches — cube", () => {
  it("carries all 12 faces; lips → C/dart; interior non-cut edges all M", () => {
    const cube = makeCube();
    const { sheet } = pipelineTo(cube);
    expect(sheet.faces.length).toBe(12);

    const cCount = sheet.assignment.filter((a) => a === "C").length;
    expect(cCount).toBe(14); // 7 cut edges × 2 lips
    for (let e = 0; e < sheet.edges.length; e++) {
      if (sheet.assignment[e] === "C") {
        expect(sheet.cutType[e]).toBe("dart"); // all cube tree vertices δ>0
        expect(sheet.foldAngle[e]).toBeNull();
      } else if (sheet.assignment[e] === "M") {
        expect(sheet.foldAngle[e]!).toBeCloseTo(Math.PI / 2, 9); // cube ridges
      } else if (sheet.assignment[e] === "F") {
        expect(Math.abs(sheet.foldAngle[e]!)).toBeLessThanOrEqual(FLAT_EPS); // face diagonals
      } else {
        expect(sheet.assignment[e]).not.toBe("V"); // a convex solid has no valleys
      }
    }
    // closed cube: no B edges (every boundary edge of the sheet is a lip)
    expect(sheet.assignment.filter((a) => a === "B").length).toBe(0);
    // edge counts: 5 fold ridges (M, uncut) + 6 diagonals (F) + 14 lips (C)
    expect(sheet.assignment.filter((a) => a === "M").length).toBe(5);
    expect(sheet.assignment.filter((a) => a === "F").length).toBe(6);
  });
});

describe("packPatches — saddle fan", () => {
  it("2 lips tagged minor; ring boundary stays B; patches packed apart", () => {
    const saddle = makeSaddleFan();
    const { sheet, unfold } = pipelineTo(saddle);
    const cEdges = sheet.assignment
      .map((a, e) => ({ a, e }))
      .filter((x) => x.a === "C");
    expect(cEdges.length).toBe(4); // 2 cut edges × 2 lips
    for (const { e } of cEdges) expect(sheet.cutType[e]).toBe("minor");
    expect(sheet.assignment.filter((a) => a === "B").length).toBe(6); // outer ring

    // patches translated apart: per-patch bboxes must not overlap
    expect(unfold.patchCount).toBe(2);
    const boxes = [0, 1].map((p) => {
      const verts = new Set<number>();
      sheet.faces.forEach((f, i) => {
        if (sheet.patchOfFace[i] === p) for (const v of f) verts.add(v);
      });
      const xs = [...verts].map((v) => sheet.vertices[v].x);
      const ys = [...verts].map((v) => sheet.vertices[v].y);
      return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
    });
    const disjoint =
      boxes[0].maxX < boxes[1].minX ||
      boxes[1].maxX < boxes[0].minX ||
      boxes[0].maxY < boxes[1].minY ||
      boxes[1].maxY < boxes[0].minY;
    expect(disjoint).toBe(true);
  });
});

describe("cutSubtypeFor — the deterministic mapping", () => {
  const syntheticTopo = (a: number, b: number): MeshTopology =>
    ({
      edges: [{ a, b, faces: [0, 1] }],
      edgeIndex: new Map([[edgeKey(a, b), 0]]),
      vertexFaces: [],
      vertexEdges: [],
      boundaryVertices: new Set(),
    }) as unknown as MeshTopology;
  const report = (defects: number[]): DefectReport =>
    ({
      defects,
      classes: defects.map((d) => (d > FLAT_EPS ? "positive" : d < -FLAT_EPS ? "negative" : "flat")),
      totalDefect: 0,
    }) as DefectReport;

  it("negative wins on mixed (minor); positive → dart; both flat → seam", () => {
    expect(cutSubtypeFor(syntheticTopo(0, 1), report([-0.5, 0.8]), 0)).toBe("minor");
    expect(cutSubtypeFor(syntheticTopo(0, 1), report([0.8, 0]), 0)).toBe("dart");
    expect(cutSubtypeFor(syntheticTopo(0, 1), report([0, 0]), 0)).toBe("seam");
  });
});

describe("sheet isometry survives packing", () => {
  it("translation only: every sheet edge keeps its flat length", () => {
    const saddle = makeSaddleFan();
    const topo = buildTopology(saddle);
    const defects = angleDefects(saddle, topo);
    const plan = planCuts(saddle, topo, defects, { lambda: 0, strategy: "dart" });
    const unfold = seamedUnfold(saddle, topo, plan);
    const sheet = packPatches(unfold, { mesh: saddle, topo, defects });
    for (const e of sheet.edges) {
      const flatLen = Math.hypot(
        unfold.flat[e.a].x - unfold.flat[e.b].x,
        unfold.flat[e.a].y - unfold.flat[e.b].y,
      );
      const sheetLen = Math.hypot(
        sheet.vertices[e.a].x - sheet.vertices[e.b].x,
        sheet.vertices[e.a].y - sheet.vertices[e.b].y,
      );
      expect(sheetLen).toBeCloseTo(flatLen, 9);
    }
  });
});
