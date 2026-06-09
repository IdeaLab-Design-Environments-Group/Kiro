/**
 * Simulator verification (M5): fold the emitted FKLD with the AKDE
 * bar-and-hinge solver and measure how close the folded sheet lands to Q.
 *
 * Pattern: imperative orchestrator around pure metric functions, with the
 * CPU solver as reference (tests run only the CPU `FoldSolver`; the GPU path
 * stays a UI accelerator). The simulator is the oracle: a pattern is correct
 * when it folds to the target, not when it merely looks right on paper.
 *
 * What "verified" means here (v1): EQUILIBRIUM verification. The model is
 * initialized AT the goal pose (driven boundary held there by the DETC
 * forward process at foldPercent = 1, free vertices placed at their goals)
 * and relaxed until settled. A correct pattern is a stable equilibrium —
 * bars at rest length, creases at their goal dihedrals — so it stays; a
 * wrong pattern (non-isometric unfold, wrong lips/packing, M/V or angle
 * errors) pushes itself away and fails on d_H, strain, or crease residual.
 *
 * Why not fold-path simulation from flat: with the scaffold driven, the
 * solver's momentum-conserving crease reactions act on free crease nodes in
 * the direction OPPOSITE their wings — with wings pinned this actively
 * pushes free fold lines toward the mirror side, a structural limitation of
 * driving + the bar-and-hinge torque model (verified empirically on a tent
 * ridge). Path verification needs collision handling / a constraint solver —
 * future work, per the proposal's honest scope ("no constructive
 * flat-foldability guarantee").
 *
 * d_H decision: sampled symmetric Hausdorff over vertices ∪ edge midpoints ∪
 * face centroids, brute-force min point–triangle distance (coarse meshes —
 * no BVH). Vertex-only sampling would miss interior bulge, the very failure
 * mode the sim must catch; exact Hausdorff is overkill.
 *
 * Frame alignment: buildSceneFromFold normalizes the flat pattern by its
 * bbox centroid and scale = TARGET_SIZE/span, and applyGuidedFold transforms
 * the goal frame with the SAME numbers — so Q's samples are mapped into sim
 * space by reproducing that transform (deterministic; the driven boundary
 * pins the global pose, so no ICP is needed). ε_sim = ε_mm · scale.
 */

import { buildSceneFromFold, measureTheta } from "../sim/index.js";
import type { FoldFile } from "../model/fold-file.js";
import type { TriMesh, Vec3, VerifyReport } from "./types.js";
import { PipelineError } from "./types.js";

export interface VerifyOptions {
  /** ε as a fraction of Q's bbox diagonal. */
  epsilonRel: number;
  /** Iteration cap for the settled solve. */
  iterations: number;
  /** Max acceptable mean bar strain (isometry oracle). */
  strainTol: number;
  /** Max acceptable mean crease-angle residual (rad). */
  creaseTol: number;
}

export const DEFAULT_VERIFY: VerifyOptions = {
  epsilonRel: 0.05,
  iterations: 16000,
  strainTol: 0.1,
  creaseTol: 0.15,
};

/** Sample set: vertices ∪ edge midpoints ∪ face centroids. */
export function samplePoints(vertices: Vec3[], faces: [number, number, number][]): Vec3[] {
  const samples: Vec3[] = vertices.map((v) => ({ ...v }));
  const seen = new Set<string>();
  for (const [i, j, k] of faces) {
    for (const [a, b] of [[i, j], [j, k], [k, i]] as [number, number][]) {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      samples.push({
        x: (vertices[a].x + vertices[b].x) / 2,
        y: (vertices[a].y + vertices[b].y) / 2,
        z: (vertices[a].z + vertices[b].z) / 2,
      });
    }
    samples.push({
      x: (vertices[i].x + vertices[j].x + vertices[k].x) / 3,
      y: (vertices[i].y + vertices[j].y + vertices[k].y) / 3,
      z: (vertices[i].z + vertices[j].z + vertices[k].z) / 3,
    });
  }
  return samples;
}

/** Euclidean distance from point p to triangle (a,b,c). */
export function pointTriangleDistance(p: Vec3, a: Vec3, b: Vec3, c: Vec3): number {
  // Ericson, Real-Time Collision Detection §5.1.5 (closest point on triangle).
  const sub = (u: Vec3, v: Vec3): Vec3 => ({ x: u.x - v.x, y: u.y - v.y, z: u.z - v.z });
  const dot = (u: Vec3, v: Vec3): number => u.x * v.x + u.y * v.y + u.z * v.z;
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  const dist = (q: Vec3): number => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
  if (d1 <= 0 && d2 <= 0) return dist(a);
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return dist(b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return dist({ x: a.x + v * ab.x, y: a.y + v * ab.y, z: a.z + v * ab.z });
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return dist(c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return dist({ x: a.x + w * ac.x, y: a.y + w * ac.y, z: a.z + w * ac.z });
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return dist({ x: b.x + w * (c.x - b.x), y: b.y + w * (c.y - b.y), z: b.z + w * (c.z - b.z) });
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return dist({
    x: a.x + ab.x * v + ac.x * w,
    y: a.y + ab.y * v + ac.y * w,
    z: a.z + ab.z * v + ac.z * w,
  });
}

interface SampledMesh {
  v: Vec3[];
  f: [number, number, number][];
}

function supDistance(from: SampledMesh, to: SampledMesh): { d: number; worstSample: Vec3 } {
  let worst = 0;
  let worstSample = from.v[0];
  for (const p of samplePoints(from.v, from.f)) {
    let best = Infinity;
    for (const [i, j, k] of to.f) {
      const d = pointTriangleDistance(p, to.v[i], to.v[j], to.v[k]);
      if (d < best) best = d;
      if (best === 0) break;
    }
    if (best > worst) {
      worst = best;
      worstSample = p;
    }
  }
  return { d: worst, worstSample };
}

/** Sampled symmetric Hausdorff distance (max of both directed sups). */
export function sampledHausdorff(A: SampledMesh, B: SampledMesh): number {
  return Math.max(supDistance(A, B).d, supDistance(B, A).d);
}

/**
 * Fold the FKLD (guided by its foldedForm frame) and measure dH to `target`.
 * Single-shot: the retry schedule lives in kirigamize.ts.
 */
export function verifyFold(
  fkld: FoldFile,
  target: TriMesh,
  opts: Partial<VerifyOptions> = {},
): VerifyReport {
  const { epsilonRel, iterations, strainTol, creaseTol } = { ...DEFAULT_VERIFY, ...opts };

  const scene = buildSceneFromFold(fkld);

  // Equilibrium verification: start AT the goal pose (free vertices included)
  // with foldPercent already 1, then relax. Stability ⇒ the pattern realizes
  // the target; any geometric inconsistency shows up as drift.
  scene.model.position.set(scene.model.goal);
  scene.model.velocity.fill(0);
  scene.solver.foldPercent = 1;
  const settle = scene.solver.solveUntilSettled({
    target: 1,
    maxIters: iterations,
    keEps: 1e-2,
    minSettleIters: 500, // give residual forces a real chance to push a wrong pattern away
    quench: true,
    guard: true,
  });

  // --- reconstruct the fold-adapter transform (flat bbox centroid + scale) --
  const raw = fkld.vertices_coords as number[][];
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const c of raw) {
    const [x, y, z] = [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0];
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  const scale = scene.net.meta.scale;

  // --- folded sheet in sim space ---------------------------------------------
  const pos = scene.model.position;
  const foldedV: Vec3[] = [];
  for (let i = 0; i < scene.net.vertices.length; i++) {
    const x = pos[3 * i];
    const y = pos[3 * i + 1];
    const z = pos[3 * i + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new PipelineError("verify", `solver produced non-finite position at node ${i}`);
    }
    foldedV.push({ x, y, z });
  }
  const folded: SampledMesh = { v: foldedV, f: scene.net.faces };

  // --- Q in sim space ---------------------------------------------------------
  const targetSim: SampledMesh = {
    v: target.vertices.map((p) => ({ x: (p.x - cx) * scale, y: (p.y - cy) * scale, z: (p.z - cz) * scale })),
    f: target.faces,
  };

  // --- metrics ----------------------------------------------------------------
  const toTarget = supDistance(folded, targetSim);
  const fromTarget = supDistance(targetSim, folded);
  const dHSim = Math.max(toTarget.d, fromTarget.d);
  const dH = dHSim / scale; // mm

  let qMin = { x: Infinity, y: Infinity, z: Infinity };
  let qMax = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of target.vertices) {
    qMin = { x: Math.min(qMin.x, p.x), y: Math.min(qMin.y, p.y), z: Math.min(qMin.z, p.z) };
    qMax = { x: Math.max(qMax.x, p.x), y: Math.max(qMax.y, p.y), z: Math.max(qMax.z, p.z) };
  }
  const bboxDiag = Math.hypot(qMax.x - qMin.x, qMax.y - qMin.y, qMax.z - qMin.z);
  const epsilon = epsilonRel * bboxDiag;

  // strain over beams (same formula as the kzr-sim regression test)
  const m = scene.model;
  let meanStrain = 0;
  let maxStrain = 0;
  for (let i = 0; i < m.beams.count; i++) {
    const a = m.beams.n0[i];
    const b = m.beams.n1[i];
    const l = Math.hypot(
      pos[3 * a] - pos[3 * b],
      pos[3 * a + 1] - pos[3 * b + 1],
      pos[3 * a + 2] - pos[3 * b + 2],
    );
    const strain = Math.abs(l / m.beams.rest[i] - 1);
    meanStrain += strain;
    maxStrain = Math.max(maxStrain, strain);
  }
  meanStrain /= Math.max(1, m.beams.count);

  // crease residual: measured θ (actual face normals at the settled pose) vs
  // the goal-derived target — the drive cannot fake this; it catches M/V
  // misassignment, wrong dihedrals, and warped faces.
  let creaseResidual = 0;
  for (let c = 0; c < m.creases.count; c++) {
    const meas = measureTheta(m, m.creases.face1[c], m.creases.face2[c], m.creases.n3[c], m.creases.n4[c]);
    creaseResidual += Math.abs(meas - m.creases.targetTheta[c]);
  }
  creaseResidual /= Math.max(1, m.creases.count);

  // free (non-driven) vertices — when 0, dH is kinematically trivial
  let freeVertices = 0;
  for (let i = 0; i < m.numNodes; i++) if (!m.driven[i]) freeVertices++;

  // worst source vertex: Q vertex nearest the worst folded sample (sim space)
  let worstSourceVertex = 0;
  let best = Infinity;
  for (let v = 0; v < targetSim.v.length; v++) {
    const q = targetSim.v[v];
    const d = Math.hypot(q.x - toTarget.worstSample.x, q.y - toTarget.worstSample.y, q.z - toTarget.worstSample.z);
    if (d < best) {
      best = d;
      worstSourceVertex = v;
    }
  }

  return {
    dH,
    dHRel: bboxDiag > 0 ? dH / bboxDiag : 0,
    epsilon,
    meanStrain,
    maxStrain,
    creaseResidual,
    freeVertices,
    iterations: settle.iters,
    attempts: 1,
    converged: settle.converged && dH <= epsilon && meanStrain <= strainTol && creaseResidual <= creaseTol,
    worstSourceVertex,
  };
}
