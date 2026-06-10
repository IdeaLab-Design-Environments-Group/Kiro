/**
 * FOLD/FKLD → fold simulation. Turns a loaded FOLD file into a runnable
 * bar-and-hinge `FoldScene`:
 *
 *   1. vertices_coords (2D or 3D) → normalized 3D points
 *   2. faces_vertices (any polygon) → fan-triangulated triangles
 *   3. edges_vertices + edges_assignment → per-edge crease classification
 *   4. edges_foldAngle → per-crease target dihedral (else assignment defaults)
 *
 * The crease targets drive the fold as `foldPercent` ramps 0→1 (the standard
 * Origami-Simulator forward fold), so no pyramid-style goal mesh is needed.
 *
 * PLAIN FOLD files (no `fkld:` keys) run the EXACT simulation of Ghassaei,
 * Demaine & Gershenfeld, "Fast, Interactive Origami Simulation using GPU
 * Computation" (7OSME 2018). The force core in forces.ts already implements
 * the paper's equations verbatim (axial Eq 1; crease Eqs 2–6 — the
 * projection weights coef/h are identical to the paper's cotangent weights
 * via proj₁ = h₁·cot α₃,₁₄ and l = h₁·(cot α₃,₁₄ + cot α₄,₃₁); face §2.4;
 * Euler + Δt Eqs 7–8; per-edge viscous damping c = 2ζ√(k·m)). What this
 * adapter adds for plain FOLD is the paper's CONVENTION layer (§2.3, §3):
 *   - θ_target sign per the FOLD spec: mountain NEGATIVE, valley POSITIVE
 *     (the engine measures mountains positive, so file angles are negated);
 *   - no explicit edges_foldAngle → full-fold defaults ±π (the simulator's
 *     fold-percent slider scales them), NOT the AKDE design angles;
 *   - k_crease = l₀·k_fold (M/V), l₀·k_facet (F), and **0 for boundary or
 *     undriven ("B"/"U"/missing) creases** — undriven hinges swing free;
 *   - no MAX_FOLD clamp (targets are exactly the file's angles);
 *   - ζ = 0.45, inside the paper's stable range 0.01 ≤ ζ ≤ 0.5 (Fig. 5
 *     constants EA = 20, k_fold = k_facet = 0.7, k_face = 0.2 are the
 *     engine defaults already).
 * FKLD files keep the kirigami/AKDE conventions (guided goal frames, design
 * angles, overdamping) unchanged.
 */
import { isFkld, type FoldFile } from "../model/fold-file.js";
import { type Vec3, vec3 } from "./vec3.js";
import { type EdgeAssignment, foldNetFromMesh } from "./foldnet.js";
import { type BarHingeModel, buildModel, DEFAULT_PARAMS, type SolverParams } from "./model.js";
import { FoldSolver, measureTheta } from "./solver.js";
import type { FoldScene } from "./build.js";

export type { FoldScene };

/**
 * Target bounding-box size after normalization. ~Unit scale (AKDE's own regime:
 * `buildFoldNet` normalizes to radius ≈ 1) — NOT 100. The explicit integrator's
 * `computeDt` bounds only the axial mode (k_axial = EA/l0); crease stiffness is
 * k_crease = 0.7·l0, so their ratio grows as l0² — at size-100 normalization
 * creases were ~70× stiffer than the dt bound assumed and a free vertex with
 * many hinges (e.g. a star apex, degree 10) went NaN. At unit scale the axial
 * mode is the binding one, matching the solver's assumption.
 */
const TARGET_SIZE = 2;

/** Paper-exact parameters for plain FOLD files (Fig. 5 + §2.5: ζ within [0.01, 0.5]). */
export const ORIGAMI_PARAMS: SolverParams = { ...DEFAULT_PARAMS, zeta: 0.45 };

/** FOLD assignment letters → engine assignment (U/unknown folds treated as flat facets). */
function mapAssignment(letter: string | undefined): EdgeAssignment {
  switch (letter) {
    case "M":
    case "V":
    case "F":
    case "B":
    case "C":
      return letter;
    default:
      return "F";
  }
}

/**
 * Largest target dihedral we drive a crease to. A full flat fold (±π) makes the
 * two faces coincide — a singular, unstable configuration for the bar-and-hinge
 * solver — so we clamp just short of it.
 */
const MAX_FOLD = 2.7; // ≈ 155°

/** Default target dihedral (rad) by assignment when the file has no edges_foldAngle.
 *  AKDE convention (matches buildModel): mountain folds positive, valley negative. */
function defaultTarget(a: EdgeAssignment): number {
  if (a === "M") return +1.6;
  if (a === "V") return -1.6;
  return 0;
}

const clampFold = (t: number): number => Math.max(-MAX_FOLD, Math.min(MAX_FOLD, t));

const ekey = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);

/** Mean |l/l₀ − 1| over beams at the model's CURRENT positions. Used to decide
 *  whether a goal pose is isometrically consistent (complete) or a chimera. */
function beamStrainAt(model: BarHingeModel): number {
  const p = model.position;
  let sum = 0;
  for (let i = 0; i < model.beams.count; i++) {
    const a = model.beams.n0[i];
    const b = model.beams.n1[i];
    const l = Math.hypot(p[3 * a] - p[3 * b], p[3 * a + 1] - p[3 * b + 1], p[3 * a + 2] - p[3 * b + 2]);
    sum += Math.abs(l / model.beams.rest[i] - 1);
  }
  return sum / Math.max(1, model.beams.count);
}

/** True when the file looks like a foldable crease pattern (has verts, faces, edges). */
export function isFoldable(fold: FoldFile): boolean {
  return (
    Array.isArray(fold.vertices_coords) &&
    fold.vertices_coords.length >= 3 &&
    Array.isArray(fold.faces_vertices) &&
    fold.faces_vertices.length >= 1 &&
    Array.isArray(fold.edges_vertices) &&
    fold.edges_vertices.length >= 1
  );
}

export function buildSceneFromFold(fold: FoldFile): FoldScene {
  if (!isFoldable(fold)) throw new Error("FOLD file lacks vertices/faces/edges to simulate.");

  // --- vertices: lift to 3D and normalize to TARGET_SIZE around the centroid ---
  const raw = fold.vertices_coords as number[][];
  const pts: Vec3[] = raw.map((c) => vec3(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0));
  const min = vec3(Infinity, Infinity, Infinity);
  const max = vec3(-Infinity, -Infinity, -Infinity);
  for (const p of pts) {
    min.x = Math.min(min.x, p.x); min.y = Math.min(min.y, p.y); min.z = Math.min(min.z, p.z);
    max.x = Math.max(max.x, p.x); max.y = Math.max(max.y, p.y); max.z = Math.max(max.z, p.z);
  }
  const cx = (min.x + max.x) / 2, cy = (min.y + max.y) / 2, cz = (min.z + max.z) / 2;
  const span = Math.max(max.x - min.x, max.y - min.y, max.z - min.z, 1e-9);
  const scale = TARGET_SIZE / span;
  const vertices: Vec3[] = pts.map((p) => vec3((p.x - cx) * scale, (p.y - cy) * scale, (p.z - cz) * scale));

  // --- faces: fan-triangulate any polygon into triangles ---
  const polys = fold.faces_vertices as number[][];
  const faces: [number, number, number][] = [];
  for (const poly of polys) {
    for (let i = 1; i + 1 < poly.length; i++) {
      faces.push([poly[0], poly[i], poly[i + 1]]);
    }
  }

  // --- per-edge assignment + fold-angle lookup from the FOLD arrays ---
  const ev = fold.edges_vertices as [number, number][];
  const ea = (fold.edges_assignment as string[] | undefined) ?? [];
  const fa = fold.edges_foldAngle as number[] | undefined; // degrees, per FOLD spec
  const assignOf = new Map<string, EdgeAssignment>();
  const rawAssignOf = new Map<string, string | undefined>(); // unmapped letters ("U" preserved)
  const explicitTarget = new Map<string, number>(); // only edges with a real edges_foldAngle
  for (let i = 0; i < ev.length; i++) {
    const [a, b] = ev[i];
    const key = ekey(a, b);
    assignOf.set(key, mapAssignment(ea[i]));
    rawAssignOf.set(key, ea[i]);
    const deg = fa?.[i];
    if (typeof deg === "number") explicitTarget.set(key, (deg * Math.PI) / 180); // unclamped rad
  }

  const interiorAssignment = (a: number, b: number): EdgeAssignment => assignOf.get(ekey(a, b)) ?? "F";

  const net = foldNetFromMesh(vertices, faces, interiorAssignment, {
    s: TARGET_SIZE / 2,
    H: TARGET_SIZE / 2,
    scale,
  });

  // Cut ("C") edges become free flaps via AKDE's cutRatio API (DETC Eq 6: cutRatio=1 ⇒
  // k_crease=0), so kirigami cuts open instead of being glued flat by a θ=0 hinge.
  const plainFold = !isFkld(fold);
  const model = buildModel(net, plainFold ? ORIGAMI_PARAMS : DEFAULT_PARAMS, (e) =>
    e.assignment === "C" ? 1 : 0,
  );

  // Guided fold (DETC forward process): if the FKLD ships a folded-form goal frame +
  // fkld:vertices_driven, drive the boundary to the designed shape M0 so the fold lands
  // crisply and *settles* (this is why AKDE's pyramid never jitters). Otherwise fall back to a
  // free fold driven only by crease targets.
  const guided = applyGuidedFold(fold, model, pts.length, cx, cy, cz, scale);

  // Crease targets.
  //
  // Guided: derive a crease's design angle from the GOAL POSE where the goal
  // can be trusted (DETC forward process — M0 defines the targets). This is
  // sign-robust: a file's edges_foldAngle sign convention cannot be trusted
  // to match the model's internal per-crease frame (face1/face2 and n3→n4
  // ordering are buildModel's choice), and a single flipped crease folds a
  // limb to the mirror side.
  //
  // BUT a goal frame is only trustworthy as far as it is isometrically
  // consistent: some generators (e.g. the AKDE pyramid examples) fill real
  // folded positions only for DRIVEN vertices and leave the rest at flat
  // coords — measuring θ against that chimera poisons the targets (facet
  // creases read ±1.5 rad, mountains read 0) and the fold crumples flat.
  // So: if the whole goal pose is consistent (near-zero bar strain), measure
  // every crease there; otherwise measure only creases whose four nodes are
  // all driven (their goals are real), and keep the explicit edges_foldAngle
  // or the AKDE assignment defaults (M:+, V:−) for the rest.
  //
  // Free fold: explicit edges_foldAngle when present, else the defaults.
  if (guided) {
    const flat = model.position.slice();
    model.position.set(model.goal);
    const goalConsistent = beamStrainAt(model) < 0.05;
    for (let i = 0; i < model.creases.count; i++) {
      const c = model.creases;
      const trustworthy =
        goalConsistent ||
        (model.driven[c.n1[i]] === 1 &&
          model.driven[c.n2[i]] === 1 &&
          model.driven[c.n3[i]] === 1 &&
          model.driven[c.n4[i]] === 1);
      if (trustworthy) {
        c.targetTheta[i] = clampFold(measureTheta(model, c.face1[i], c.face2[i], c.n3[i], c.n4[i]));
      } else {
        const key = ekey(c.n3[i], c.n4[i]);
        const t = explicitTarget.get(key);
        if (t !== undefined) c.targetTheta[i] = clampFold(t);
        // else: keep buildModel's assignment-based default (the AKDE design)
      }
    }
    model.position.set(flat);
  } else if (plainFold) {
    // EXACT paper conventions (Ghassaei–Demaine–Gershenfeld §2.3, §3) for
    // plain FOLD files — see the module doc. The engine's per-crease frame
    // (foldNetFromMesh face1 / n3→n4 ordering over a consistently-wound net)
    // measures fold angles in the SAME sign convention as the FOLD spec —
    // mountain negative, valley positive — verified empirically by the
    // pinned-hinge tests in tests/current/sim/origami-exact.test.ts. File
    // angles therefore pass through unchanged. No MAX_FOLD clamp: targets
    // are the file's exact angles (full flat folds ±π included), scaled
    // live by foldPercent.
    const c = model.creases;
    for (let i = 0; i < c.count; i++) {
      const key = ekey(c.n3[i], c.n4[i]);
      const raw = rawAssignOf.get(key);
      const t = explicitTarget.get(key); // already rad; FOLD sign convention
      switch (raw) {
        case "M":
          c.targetTheta[i] = t !== undefined ? t : -Math.PI; // mountain: −
          break;
        case "V":
          c.targetTheta[i] = t !== undefined ? t : Math.PI; // valley: +
          break;
        case "F":
          c.targetTheta[i] = 0; // facet crease driven flat (k = l₀·k_facet)
          break;
        case "C":
          break; // cut: k already 0 via cutRatio
        default:
          // "B", "U", or no assignment: boundary/undriven crease → k = 0
          // (paper §2.3) — a free frictionless hinge, not a flat-driven facet.
          c.k[i] = 0;
          c.targetTheta[i] = 0;
          break;
      }
    }
  } else {
    for (let i = 0; i < model.creases.count; i++) {
      const key = ekey(model.creases.n3[i], model.creases.n4[i]);
      const t = explicitTarget.get(key);
      model.creases.targetTheta[i] = t !== undefined ? clampFold(t) : clampFold(defaultTarget(assignOf.get(key) ?? "F"));
    }
  }

  if (!guided) {
    // Free fold: pin the vertex nearest the centroid so it doesn't drift off-camera.
    let anchor = 0, best = Infinity;
    for (let i = 0; i < vertices.length; i++) {
      const d = Math.hypot(vertices[i].x, vertices[i].y, vertices[i].z);
      if (d < best) { best = d; anchor = i; }
    }
    model.fixed[anchor] = 1;
  }

  const solver = new FoldSolver(model); // AKDE-exact solver (dt from computeDt, 0.9 margin)
  return { net, model, solver };
}

/**
 * Wire AKDE's guided fold from an FKLD that carries a folded-form goal frame. Reads the
 * `foldedForm` frame's 3D `vertices_coords` (the goal mesh M0) and `fkld:vertices_driven`,
 * scales the goal into sim units, and **rigid-aligns it onto the rest pose** by matching the
 * driven nodes' centroids. The flat sheet and the goal need NOT share a coordinate frame:
 * pipeline-emitted FKLDs pack the flat pattern into sheet coordinates while the goal stays in
 * the target's (Q's) frame — mapping the goal through the flat centroid (the old behaviour)
 * teleported the driven boundary far from the rest pose, stretching the free vertices' beams
 * until the explicit integrator went NaN (symptom: only boundary lines render — every face
 * incident to the exploded free vertex vanishes). Centroid alignment is exact for the
 * hand-made AKDE examples too (their frames already coincide, so the shift is ~0).
 * Marks driven nodes (pinned, so force passes leave them where driveBoundary puts them).
 * Returns true when at least one node is driven; false keeps the free-fold path.
 */
function applyGuidedFold(
  fold: FoldFile,
  model: BarHingeModel,
  nPts: number,
  _cx: number,
  _cy: number,
  _cz: number,
  scale: number,
): boolean {
  const f = fold as {
    file_frames?: Array<{ frame_classes?: string[]; vertices_coords?: number[][] }>;
    "fkld:vertices_driven"?: number[];
  };
  const driven = f["fkld:vertices_driven"];
  const folded = f.file_frames?.find(
    (fr) =>
      Array.isArray(fr.vertices_coords) &&
      fr.vertices_coords.length === nPts &&
      (fr.frame_classes ?? []).includes("foldedForm"),
  );
  if (!folded?.vertices_coords || !Array.isArray(driven)) return false;
  if (!driven.some((d) => d)) return false;

  // Centroids of the driven set: goal (mm, scaled to sim units) vs rest (already sim units).
  let gx = 0, gy = 0, gz = 0, rx = 0, ry = 0, rz = 0, n = 0;
  for (let i = 0; i < nPts; i++) {
    if (!driven[i]) continue;
    const g = folded.vertices_coords[i] ?? [0, 0, 0];
    gx += (g[0] ?? 0) * scale; gy += (g[1] ?? 0) * scale; gz += (g[2] ?? 0) * scale;
    rx += model.rest[3 * i]; ry += model.rest[3 * i + 1]; rz += model.rest[3 * i + 2];
    n++;
  }
  // Translation that brings the goal's driven centroid onto the rest pose's.
  const tx = rx / n - gx / n, ty = ry / n - gy / n, tz = rz / n - gz / n;

  for (let i = 0; i < nPts; i++) {
    const g = folded.vertices_coords[i] ?? [0, 0, 0];
    model.goal[3 * i] = (g[0] ?? 0) * scale + tx;
    model.goal[3 * i + 1] = (g[1] ?? 0) * scale + ty;
    model.goal[3 * i + 2] = (g[2] ?? 0) * scale + tz;
    if (driven[i]) {
      model.driven[i] = 1;
      model.fixed[i] = 1;
    }
  }
  return true;
}
