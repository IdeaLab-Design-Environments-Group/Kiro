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
 */
import type { FoldFile } from "../model/fold-file.js";
import { type Vec3, vec3 } from "./vec3.js";
import { type EdgeAssignment, foldNetFromMesh } from "./foldnet.js";
import { type BarHingeModel, buildModel, DEFAULT_PARAMS } from "./model.js";
import { FoldSolver, measureTheta } from "./solver.js";
import type { FoldScene } from "./build.js";

export type { FoldScene };

/** Target bounding-box size after normalization (keeps the solver dt + camera framing sane). */
const TARGET_SIZE = 100;

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
  const explicitTarget = new Map<string, number>(); // only edges with a real edges_foldAngle
  for (let i = 0; i < ev.length; i++) {
    const [a, b] = ev[i];
    const key = ekey(a, b);
    assignOf.set(key, mapAssignment(ea[i]));
    const deg = fa?.[i];
    if (typeof deg === "number") explicitTarget.set(key, clampFold((deg * Math.PI) / 180));
  }

  const interiorAssignment = (a: number, b: number): EdgeAssignment => assignOf.get(ekey(a, b)) ?? "F";

  const net = foldNetFromMesh(vertices, faces, interiorAssignment, {
    s: TARGET_SIZE / 2,
    H: TARGET_SIZE / 2,
    scale,
  });

  // Cut ("C") edges become free flaps via AKDE's cutRatio API (DETC Eq 6: cutRatio=1 ⇒
  // k_crease=0), so kirigami cuts open instead of being glued flat by a θ=0 hinge.
  const model = buildModel(net, DEFAULT_PARAMS, (e) => (e.assignment === "C" ? 1 : 0));

  // Guided fold (DETC forward process): if the FKLD ships a folded-form goal frame +
  // fkld:vertices_driven, drive the boundary to the designed shape M0 so the fold lands
  // crisply and *settles* (this is why AKDE's pyramid never jitters). Otherwise fall back to a
  // free fold driven only by crease targets.
  const guided = applyGuidedFold(fold, model, pts.length, cx, cy, cz, scale);

  // Crease targets.
  //
  // Guided: derive every crease's design angle from the GOAL POSE itself
  // (DETC forward process — M0 defines the targets). This is sign-robust: a
  // file's edges_foldAngle sign convention cannot be trusted to match the
  // model's internal per-crease frame (face1/face2 and n3→n4 ordering are
  // buildModel's choice), and a single flipped crease folds a limb to the
  // mirror side. Measuring θ at the goal yields the exact angle in the
  // model's own frame; a file with consistent signs gets identical values.
  //
  // Free fold: honour an explicit edges_foldAngle when present, else the
  // AKDE-convention defaults (M:+, V:−).
  if (guided) {
    const flat = model.position.slice();
    model.position.set(model.goal);
    for (let i = 0; i < model.creases.count; i++) {
      model.creases.targetTheta[i] = clampFold(
        measureTheta(model, model.creases.face1[i], model.creases.face2[i], model.creases.n3[i], model.creases.n4[i]),
      );
    }
    model.position.set(flat);
  } else {
    for (let i = 0; i < model.creases.count; i++) {
      const key = ekey(model.creases.n3[i], model.creases.n4[i]);
      const t = explicitTarget.get(key);
      model.creases.targetTheta[i] = t !== undefined ? t : clampFold(defaultTarget(assignOf.get(key) ?? "F"));
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
 * normalizes the goal with the *same* centroid/scale transform as the flat net, and marks the
 * driven boundary nodes (pinned, so the solver's force passes leave them where driveBoundary
 * puts them). Returns true when at least one node is driven. No-op (returns false) for plain
 * crease patterns, which keep the free-fold path.
 */
function applyGuidedFold(
  fold: FoldFile,
  model: BarHingeModel,
  nPts: number,
  cx: number,
  cy: number,
  cz: number,
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

  let any = false;
  for (let i = 0; i < nPts; i++) {
    const g = folded.vertices_coords[i] ?? [0, 0, 0];
    model.goal[3 * i] = ((g[0] ?? 0) - cx) * scale;
    model.goal[3 * i + 1] = ((g[1] ?? 0) - cy) * scale;
    model.goal[3 * i + 2] = ((g[2] ?? 0) - cz) * scale;
    if (driven[i]) {
      model.driven[i] = 1;
      model.fixed[i] = 1;
      any = true;
    }
  }
  return any;
}
