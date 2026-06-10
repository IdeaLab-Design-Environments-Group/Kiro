/** Scratch test (agent A) — DELETE BEFORE MERGE. */
import { describe, expect, it } from "vitest";
import { kirigamize } from "../../../src/pipeline/kirigamize.js";
import { findSelfOverlap } from "../../../src/pipeline/unfold.js";
import type { TriMesh, Vec2 } from "../../../src/pipeline/types.js";
import { makeCube, makeEnneper, makeSaddleFan, makeSaddleRoof } from "./fixtures/targets.js";

const TAU = 2 * Math.PI;

/** Σ flat corner angles per vertex + boundary-vertex set of the flat sheet. */
function flatAngleAudit(flat: Vec2[], faces: [number, number, number][]) {
  const sum = new Array<number>(flat.length).fill(0);
  const edgeCount = new Map<string, number>();
  for (const [i, j, k] of faces) {
    for (const [at, u, w] of [[i, j, k], [j, k, i], [k, i, j]] as const) {
      const ax = flat[u].x - flat[at].x;
      const ay = flat[u].y - flat[at].y;
      const bx = flat[w].x - flat[at].x;
      const by = flat[w].y - flat[at].y;
      sum[at] += Math.atan2(Math.abs(ax * by - ay * bx), ax * bx + ay * by);
    }
    for (const [a, b] of [[i, j], [j, k], [k, i]] as const) {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
    }
  }
  const onBoundary = new Set<number>();
  for (const [key, c] of edgeCount) {
    if (c === 1) for (const v of key.split("_")) onBoundary.add(Number(v));
  }
  return { sum, onBoundary };
}

function checkTarget(name: string, mesh: TriMesh, minVents: number) {
  const res = kirigamize(mesh, { verify: false });
  const { unfold } = res;
  console.log(
    `${name}: patchCount=${unfold.patchCount} vents=${unfold.vents.length} ` +
      `ventAngles=[${unfold.vents.map((v) => v.angle.toFixed(4)).join(", ")}] ` +
      `faces=${unfold.faces.length} lips=${unfold.lips.length} relief=${unfold.reliefEdges.length}`,
  );
  expect(unfold.patchCount).toBe(1);
  expect(unfold.vents.length).toBeGreaterThanOrEqual(minVents);
  const { sum, onBoundary } = flatAngleAudit(unfold.flat, unfold.faces);
  for (let v = 0; v < unfold.flat.length; v++) {
    if (onBoundary.has(v) || sum[v] === 0) continue;
    expect(Math.abs(sum[v] - TAU)).toBeLessThan(1e-6);
  }
  expect(findSelfOverlap(unfold.flat, unfold.faces)).toBeNull();
  return res;
}

describe("agent-a scratch: vent placement on multi-vent grids", () => {
  it("saddle roof: 9 interior δ<0 vertices vent into one sheet", () => {
    checkTarget("saddleRoof", makeSaddleRoof(), 7);
  });

  it("enneper: 9 interior δ<0 vertices vent into one sheet", () => {
    checkTarget("enneper", makeEnneper(), 7);
  });

  it("regressions: saddle fan and cube still work", () => {
    const fan = kirigamize(makeSaddleFan(), { verify: false });
    expect(fan.unfold.patchCount).toBe(1);
    expect(fan.unfold.vents.length).toBe(1);
    expect(findSelfOverlap(fan.unfold.flat, fan.unfold.faces)).toBeNull();
    const cube = kirigamize(makeCube(), { verify: false });
    expect(cube.unfold.patchCount).toBe(1);
    expect(findSelfOverlap(cube.unfold.flat, cube.unfold.faces)).toBeNull();
  });
});
