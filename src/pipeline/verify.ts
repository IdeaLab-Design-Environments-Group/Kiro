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
 * Optimal rigid alignment (Kabsch/Horn, NO reflection) of corresponding
 * point pairs: returns R (row-major 3×3) and t minimizing Σ|R·p + t − q|².
 * Quaternion (Horn) method with Gershgorin-shifted power iteration on the
 * symmetric 4×4 N matrix — deterministic, Math-only. Reflections are
 * impossible by construction (quaternions parameterize SO(3) only), so a
 * mirror-folded sheet shows up as large d_H instead of being "aligned away".
 */
export function kabsch(
  from: Vec3[],
  to: Vec3[],
): { R: number[]; t: Vec3 } {
  const n = Math.min(from.length, to.length);
  if (n < 3) throw new PipelineError("verify", "kabsch needs ≥3 point pairs");
  // Centroids.
  const cf = { x: 0, y: 0, z: 0 };
  const ct = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < n; i++) {
    cf.x += from[i].x; cf.y += from[i].y; cf.z += from[i].z;
    ct.x += to[i].x; ct.y += to[i].y; ct.z += to[i].z;
  }
  cf.x /= n; cf.y /= n; cf.z /= n;
  ct.x /= n; ct.y /= n; ct.z /= n;
  // Cross-covariance H = Σ (p−cf)(q−ct)ᵀ.
  const H = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const px = from[i].x - cf.x, py = from[i].y - cf.y, pz = from[i].z - cf.z;
    const qx = to[i].x - ct.x, qy = to[i].y - ct.y, qz = to[i].z - ct.z;
    H[0] += px * qx; H[1] += px * qy; H[2] += px * qz;
    H[3] += py * qx; H[4] += py * qy; H[5] += py * qz;
    H[6] += pz * qx; H[7] += pz * qy; H[8] += pz * qz;
  }
  // Horn's symmetric 4×4 N matrix.
  const [Sxx, Sxy, Sxz, Syx, Syy, Syz, Szx, Szy, Szz] = H;
  const N = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
  ];
  // Dominant eigenvector via power iteration on N + μI (Gershgorin shift).
  let mu = 0;
  for (let r = 0; r < 4; r++) {
    mu = Math.max(mu, Math.abs(N[r][0]) + Math.abs(N[r][1]) + Math.abs(N[r][2]) + Math.abs(N[r][3]));
  }
  let q = [1, 0.1, 0.2, 0.3]; // deterministic, not an eigenvector of typical N
  for (let iter = 0; iter < 200; iter++) {
    const next = [0, 0, 0, 0];
    for (let r = 0; r < 4; r++) {
      next[r] = mu * q[r];
      for (let c = 0; c < 4; c++) next[r] += N[r][c] * q[c];
    }
    const l = Math.hypot(next[0], next[1], next[2], next[3]) || 1;
    q = next.map((x) => x / l);
  }
  const [w, x, y, z] = q;
  // Quaternion → rotation matrix (row-major).
  const R = [
    w * w + x * x - y * y - z * z, 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), w * w - x * x + y * y - z * z, 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), w * w - x * x - y * y + z * z,
  ];
  const rot = (p: Vec3): Vec3 => ({
    x: R[0] * p.x + R[1] * p.y + R[2] * p.z,
    y: R[3] * p.x + R[4] * p.y + R[5] * p.z,
    z: R[6] * p.x + R[7] * p.y + R[8] * p.z,
  });
  const rc = rot(cf);
  const t = { x: ct.x - rc.x, y: ct.y - rc.y, z: ct.z - rc.z };
  return { R, t };
}

/** Apply a kabsch result to a point. */
export function applyRigid(R: number[], t: Vec3, p: Vec3): Vec3 {
  return {
    x: R[0] * p.x + R[1] * p.y + R[2] * p.z + t.x,
    y: R[3] * p.x + R[4] * p.y + R[5] * p.z + t.y,
    z: R[6] * p.x + R[7] * p.y + R[8] * p.z + t.z,
  };
}

interface SceneMetrics {
  metrics: import("./types.js").FoldMetrics;
  worstSample: Vec3;
}

/** Strain + crease residual + aligned d_H of a settled scene vs targetSim. */
function measureScene(
  scene: ReturnType<typeof buildSceneFromFold>,
  targetSim: SampledMesh,
  scale: number,
  bboxDiag: number,
  iterations: number,
  settled: boolean,
): SceneMetrics {
  const m = scene.model;
  const pos = m.position;
  for (let i = 0; i < pos.length; i++) {
    if (!Number.isFinite(pos[i])) {
      throw new PipelineError("verify", `solver produced non-finite position at component ${i}`);
    }
  }

  // strain over beams (isometry oracle)
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

  // crease residual vs goal-derived targets (rotation-invariant)
  let creaseResidual = 0;
  for (let c = 0; c < m.creases.count; c++) {
    const meas = measureTheta(m, m.creases.face1[c], m.creases.face2[c], m.creases.n3[c], m.creases.n4[c]);
    creaseResidual += Math.abs(meas - m.creases.targetTheta[c]);
  }
  creaseResidual /= Math.max(1, m.creases.count);

  // Kabsch-align the folded pose onto the goal using the KNOWN per-vertex
  // correspondence (position[i] ↔ model.goal[i]) — a free fold ends in an
  // arbitrary rigid pose; alignment must not absorb a mirror (see kabsch).
  const foldedRaw: Vec3[] = [];
  const goalPts: Vec3[] = [];
  for (let i = 0; i < m.numNodes; i++) {
    foldedRaw.push({ x: pos[3 * i], y: pos[3 * i + 1], z: pos[3 * i + 2] });
    goalPts.push({ x: m.goal[3 * i], y: m.goal[3 * i + 1], z: m.goal[3 * i + 2] });
  }
  const { R, t } = kabsch(foldedRaw, goalPts);
  const folded: SampledMesh = { v: foldedRaw.map((p) => applyRigid(R, t, p)), f: scene.net.faces };

  const toTarget = supDistance(folded, targetSim);
  const fromTarget = supDistance(targetSim, folded);
  const dH = Math.max(toTarget.d, fromTarget.d) / scale; // mm

  return {
    metrics: {
      dH,
      dHRel: bboxDiag > 0 ? dH / bboxDiag : 0,
      meanStrain,
      maxStrain,
      creaseResidual,
      iterations,
      settled,
    },
    worstSample: toTarget.worstSample,
  };
}

/**
 * Verify the emitted FKLD against Q two ways (single-shot; the retry
 * schedule lives in kirigamize.ts):
 *
 * 1. FOLD-FROM-FLAT (primary gate): free the model (no driven boundary),
 *    start at the flat rest pose, ramp foldPercent 0→1 driven only by the
 *    goal-derived crease targets — the pattern must actually fold itself up
 *    from the sheet. Kabsch-aligned d_H + strain + crease residual.
 * 2. EQUILIBRIUM (secondary, reported): start at the goal pose, relax, and
 *    measure drift — a cheap consistency check that can never pass alone.
 */
export function verifyFold(
  fkld: FoldFile,
  target: TriMesh,
  opts: Partial<VerifyOptions> = {},
): VerifyReport {
  const { epsilonRel, iterations, strainTol, creaseTol } = { ...DEFAULT_VERIFY, ...opts };

  // --- shared frame: targetSim via the model's own mm → sim map --------------
  const probe = buildSceneFromFold(fkld);
  const scale = probe.net.meta.scale;
  const frames = fkld.file_frames as
    | { frame_classes?: string[]; vertices_coords?: number[][] }[]
    | undefined;
  const goalMm = frames?.find((fr) => (fr.frame_classes ?? []).includes("foldedForm"))?.vertices_coords;
  if (!goalMm || goalMm.length === 0) {
    throw new PipelineError("verify", "fkld lacks a foldedForm goal frame — emit must run first");
  }
  let tx = 0, ty = 0, tz = 0;
  for (let i = 0; i < goalMm.length; i++) {
    tx += probe.model.goal[3 * i] - (goalMm[i][0] ?? 0) * scale;
    ty += probe.model.goal[3 * i + 1] - (goalMm[i][1] ?? 0) * scale;
    tz += probe.model.goal[3 * i + 2] - (goalMm[i][2] ?? 0) * scale;
  }
  tx /= goalMm.length;
  ty /= goalMm.length;
  tz /= goalMm.length;
  const targetSim: SampledMesh = {
    v: target.vertices.map((p) => ({ x: p.x * scale + tx, y: p.y * scale + ty, z: p.z * scale + tz })),
    f: target.faces,
  };
  let qMin = { x: Infinity, y: Infinity, z: Infinity };
  let qMax = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of target.vertices) {
    qMin = { x: Math.min(qMin.x, p.x), y: Math.min(qMin.y, p.y), z: Math.min(qMin.z, p.z) };
    qMax = { x: Math.max(qMax.x, p.x), y: Math.max(qMax.y, p.y), z: Math.max(qMax.z, p.z) };
  }
  const bboxDiag = Math.hypot(qMax.x - qMin.x, qMax.y - qMin.y, qMax.z - qMin.z);
  const epsilon = epsilonRel * bboxDiag;

  // free (non-driven) vertices in the guided model — diagnostic only
  let freeVertices = 0;
  for (let i = 0; i < probe.model.numNodes; i++) if (!probe.model.driven[i]) freeVertices++;

  // --- 1. fold-from-flat (primary) -------------------------------------------
  // Fresh scene: free every node (no drive, no pins) and let removeRigidBody
  // keep the free fold from drifting; targets are the goal-derived dihedrals.
  const flatScene = buildSceneFromFold(fkld);
  flatScene.model.driven.fill(0);
  flatScene.model.fixed.fill(0);
  flatScene.model.velocity.fill(0);
  const flatSettle = flatScene.solver.solveUntilSettled({
    target: 1,
    maxIters: iterations,
    keEps: 1e-2,
    minSettleIters: 500,
    quench: true,
    guard: true,
    removeRigidBody: true,
  });
  const flat = measureScene(flatScene, targetSim, scale, bboxDiag, flatSettle.iters, flatSettle.converged);

  // --- 2. equilibrium (secondary) ---------------------------------------------
  const eqScene = buildSceneFromFold(fkld);
  eqScene.model.position.set(eqScene.model.goal);
  eqScene.model.velocity.fill(0);
  eqScene.solver.foldPercent = 1;
  const eqSettle = eqScene.solver.solveUntilSettled({
    target: 1,
    maxIters: iterations,
    keEps: 1e-2,
    minSettleIters: 500,
    quench: true,
    guard: true,
  });
  const eq = measureScene(eqScene, targetSim, scale, bboxDiag, eqSettle.iters, eqSettle.converged);

  // worst source vertex: Q vertex nearest the worst fold-from-flat sample
  let worstSourceVertex = 0;
  let best = Infinity;
  for (let v = 0; v < targetSim.v.length; v++) {
    const q = targetSim.v[v];
    const d = Math.hypot(
      q.x - flat.worstSample.x,
      q.y - flat.worstSample.y,
      q.z - flat.worstSample.z,
    );
    if (d < best) {
      best = d;
      worstSourceVertex = v;
    }
  }

  return {
    foldFromFlat: flat.metrics,
    equilibrium: eq.metrics,
    epsilon,
    freeVertices,
    attempts: 1,
    converged:
      flat.metrics.settled &&
      flat.metrics.dH <= epsilon &&
      flat.metrics.meanStrain <= strainTol &&
      flat.metrics.creaseResidual <= creaseTol,
    worstSourceVertex,
  };
}
