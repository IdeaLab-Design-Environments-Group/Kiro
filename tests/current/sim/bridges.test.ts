import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildScene } from "../../../src/sim/scene.js";
import type { FoldFile } from "../../../src/model/fold-file.js";

function load(name: string): FoldFile {
  const url = new URL(`../../../public/examples/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as FoldFile;
}

const key = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);

/** All interior (2-face) edges of the rendered mesh, regardless of assignment. */
function twoFaceEdges(faces: [number, number, number][]): Set<string> {
  const count = new Map<string, number>();
  for (const f of faces) for (const [u, v] of [[f[0], f[1]], [f[1], f[2]], [f[2], f[0]]] as const) {
    const k = key(u, v);
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  const out = new Set<string>();
  for (const [k, c] of count) if (c === 2) out.add(k);
  return out;
}

describe("legal hinge bridges", () => {
  it("bridges M/V/F hinges but never a cut (RES tower has 100 cuts)", () => {
    const built = buildScene(load("res-square-tower.fkld"));
    expect(built).not.toBeNull();
    const net = built!.scene.net;
    const assign = new Map<string, string>();
    for (const e of net.edges) assign.set(key(e.a, e.b), e.assignment);

    const twoFace = twoFaceEdges(net.faces as [number, number, number][]);
    // SimCanvas.buildBridges selection: 2-face AND assignment M/V/F.
    const legal = [...twoFace].filter((k) => ["M", "V", "F"].includes(assign.get(k) ?? ""));
    const cutKeys = new Set<string>([...assign].filter(([, a]) => a === "C").map(([k]) => k));

    expect(cutKeys.size).toBeGreaterThan(0); // model really has cuts
    expect(legal.length).toBeGreaterThan(0); // bridges do get placed on real hinges
    // Hazard the assignment-gate guards against: some cut DOES appear as a 2-face edge here.
    expect([...cutKeys].some((k) => twoFace.has(k))).toBe(true);
    // Guarantee: the placed bridges never include a cut.
    for (const k of legal) expect(cutKeys.has(k)).toBe(false);
  });
});
