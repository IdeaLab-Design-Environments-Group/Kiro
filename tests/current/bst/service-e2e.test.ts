import { describe, it, expect } from "vitest";
import { bstSurfaceProgram } from "../../../src/services/pattern-service.js";
import { buildScene } from "../../../src/sim/scene.js";
import type { FoldFile } from "../../../src/model/fold-file.js";

/** Serialize a paraboloid-dome patch to OBJ text (the service consumes mesh text like the UI). */
function domeObj(A: number, n: number, H: number): string {
  const lines: string[] = [];
  const f = (x: number, y: number): number => H * Math.max(0, 1 - (x * x + y * y) / (A * A));
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const x = -A + (2 * A * i) / n, y = -A + (2 * A * j) / n;
    lines.push(`v ${x} ${y} ${f(x, y)}`);
  }
  const id = (i: number, j: number): number => j * (n + 1) + i + 1; // OBJ is 1-indexed
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    lines.push(`f ${id(i, j)} ${id(i + 1, j)} ${id(i + 1, j + 1)}`);
    lines.push(`f ${id(i, j)} ${id(i + 1, j + 1)} ${id(i, j + 1)}`);
  }
  return lines.join("\n");
}

describe("BST end-to-end via the service (what the Kirigamize ▶ 'bst' option runs)", () => {
  it("produces a named, deployable PatternOutcome from OBJ text", { timeout: 30000 }, () => {
    const outcome = bstSurfaceProgram(domeObj(100, 8, 30), "obj", "dome.obj");
    expect(outcome.name).toBe("dome-bst.fkld");
    expect(outcome.summary).toMatch(/tiles/);
    // the FKLD deploys through the real sim (guided foldedForm)
    const built = buildScene(outcome.fkld as FoldFile);
    expect(built).not.toBeNull();
    expect(built!.mode).toBe("guided");
    expect([...built!.scene.model.position].every((x) => Number.isFinite(x))).toBe(true);
  });
});
