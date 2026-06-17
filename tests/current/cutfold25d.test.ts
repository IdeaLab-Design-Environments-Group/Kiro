import { describe, it, expect } from "vitest";
import { create25dSign } from "../../src/services/pattern-service.js";
import { buildScene } from "../../src/sim/scene.js";
import type { FoldFile } from "../../src/model/fold-file.js";

describe("2.5D cut-fold end-to-end", () => {
  it("invader: ships a guided foldedForm and folds into a relief that reads the height map", { timeout: 60000 }, () => {
    const fkld = create25dSign({}).fkld as FoldFile; // Space Invader, via the real generator
    // guided footprint present
    const frames = fkld.file_frames as Array<{ frame_classes?: string[]; vertices_coords?: number[][] }>;
    expect(frames?.[0]?.frame_classes).toContain("foldedForm");
    const driven = fkld["fkld:vertices_driven"] as number[];
    expect(driven.length).toBe((fkld.vertices_coords as number[][]).length);

    const built = buildScene(fkld)!;
    expect(built.mode).toBe("guided");
    const { model, solver } = built.scene;
    solver.solve(20000, 1);

    const ext = (d: number) => {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < model.numNodes; i++) { const v = model.position[3 * i + d]; if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
      return { lo, hi, span: hi - lo };
    };
    const x = ext(0), z = ext(2);
    // relief ≈ one pixel unit tall on an 11-wide sheet → z/x ≈ 1/11
    expect(z.span / x.span).toBeGreaterThan(0.06);

    // the relief must READ the height map: split z at its midpoint; the "raised" cluster
    // should be ~a full unit above the "flat" cluster (not noise).
    const zs: number[] = [];
    for (let i = 0; i < model.numNodes; i++) zs.push(model.position[3 * i + 2]);
    const mid = (z.lo + z.hi) / 2;
    const hi = zs.filter((v) => v > mid), lo = zs.filter((v) => v <= mid);
    const meanHi = hi.reduce((a, b) => a + b, 0) / hi.length;
    const meanLo = lo.reduce((a, b) => a + b, 0) / lo.length;
    console.log(`relief: z.span=${z.span.toFixed(3)} z/x=${(z.span / x.span).toFixed(3)} raised=${hi.length} flat=${lo.length} gap=${(meanHi - meanLo).toFixed(3)}`);
    expect(meanHi - meanLo).toBeGreaterThan(0.5 * z.span); // a clear two-level relief
    expect(hi.length).toBeGreaterThan(10); // a substantial raised region (the invader body)
  });

  it("text sign 'HI' builds and is guided", () => {
    const fkld = create25dSign({ text: "HI" }).fkld as FoldFile;
    expect((fkld.file_frames as unknown[])?.length).toBe(1);
    expect(buildScene(fkld)!.mode).toBe("guided");
  });
});
