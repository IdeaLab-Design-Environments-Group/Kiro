/**
 * The bundled sample STLs (public/examples/*.stl) must fold through the full
 * pipeline — they're the "load this to try it" fixtures, so this guards them
 * against pipeline regressions and proves they verify (sim as oracle).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { kirigamizeText } from "../../../src/pipeline/kirigamize.js";

const loadStl = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../public/examples/${name}`, import.meta.url)), "utf8");

const E2E = { timeout: 120_000 };

describe("sample STL files fold through the pipeline", () => {
  it("sample-cube.stl verifies (sim as oracle)", E2E, () => {
    const r = kirigamizeText(loadStl("sample-cube.stl"), "stl", { verify: true }).report!;
    expect(r.converged, `dH=${r.dH?.toFixed(3)} ε=${r.epsilon?.toFixed(3)} strain=${r.meanStrain}`).toBe(true);
    expect(r.dHRel).toBeLessThanOrEqual(0.05);
  });

  it("sample-tetrahedron.stl verifies (sim as oracle)", E2E, () => {
    const r = kirigamizeText(loadStl("sample-tetrahedron.stl"), "stl", { verify: true }).report!;
    expect(r.converged, `dH=${r.dH?.toFixed(3)} ε=${r.epsilon?.toFixed(3)} strain=${r.meanStrain}`).toBe(true);
    expect(r.dHRel).toBeLessThanOrEqual(0.05);
  });
});
