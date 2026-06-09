/**
 * Pipeline DTO contracts (AKDE `kirigami/model/types.ts` precedent): every
 * cross-stage type of the general kirigamize pipeline lives here so each stage
 * states what it consumes/produces in one place. Pure data — no behavior.
 *
 * Units: millimetres for lengths, radians for angles (degrees only at the
 * FOLD `edges_foldAngle` boundary in emit.ts).
 *
 * The one cross-milestone contract that must never break is the provenance
 * chain `origVertex`: flat/sheet vertex index → source target-mesh (Q) vertex
 * index. M3 creates it (cutting duplicates vertices), M4 carries it on the
 * Sheet, and M5 uses it to build the guided-fold goal frame from Q.
 */

import type { Vec3 } from "../sim/vec3.js";

export type { Vec3 };

/** 2D point on the flat pattern (mm). */
export interface Vec2 {
  x: number;
  y: number;
}

/** Triangle mesh in mm. The substrate every pipeline stage operates on. */
export interface TriMesh {
  vertices: Vec3[];
  faces: [number, number, number][];
}

/** Undirected edge with incident faces (1 = boundary, 2 = interior). */
export interface MeshEdge {
  a: number; // min vertex id
  b: number; // max vertex id
  faces: number[];
}

/**
 * Derived adjacency for a TriMesh (see `mesh.ts#buildTopology`). Ordered
 * one-ring fans, not a half-edge structure — fans are all that defect math
 * (M2) and cut-splitting (M3) need.
 */
export interface MeshTopology {
  edges: MeshEdge[];
  /** "a_b" with a<b → edge index. */
  edgeIndex: Map<string, number>;
  /** Per vertex: incident faces ordered as a fan (boundary fans start at the boundary). */
  vertexFaces: number[][];
  /** Per vertex: incident edge ids (unordered). */
  vertexEdges: number[][];
  boundaryVertices: Set<number>;
}

/** Audit record for one conditioning pass. */
export interface ConditionReport {
  pass: "weld" | "orient" | "degenerate";
  changed: number;
  notes?: string;
}

/** Per-vertex discrete curvature report (M2, `curvature.ts`). */
export interface DefectReport {
  /** Signed angle defect δ(v) = 2π − Σαᵢ(v) in rad; 0 for boundary vertices. */
  defects: number[];
  /** Matches the fkld:vertices_curvatureClass enum. */
  classes: ("positive" | "negative" | "flat" | "boundary")[];
  /** Σδ over interior vertices — equals 2πχ for a closed mesh (Gauss–Bonnet). */
  totalDefect: number;
}

/** Output of the cut planner (M2, `plan-cuts.ts`). */
export interface CutPlan {
  /** Edge ids into topo.edges — a forest on the mesh graph. */
  cutEdges: number[];
  perVertexAction: ("dart" | "slit" | "tuck" | "none")[];
  cost: { length: number; visibility: number; lambda: number };
}

/** A cut edge's two boundary copies after splitting (M3). */
export interface LipPair {
  /** Source edge id in the target-mesh topology. */
  sourceEdge: number;
  /** [a-side, b-side] vertex ids per lip, in the cut/flat mesh. */
  lipA: [number, number];
  lipB: [number, number];
}

/**
 * Flattened cut mesh (M3, `unfold.ts`), globally indexed: one vertex/face
 * array for the whole cut mesh, with per-face patch labels. Cutting can
 * legitimately disconnect the surface (e.g. a saddle fan whose faces connect
 * only through the slit vertex), so `patchCount` may exceed 1; each patch is
 * laid out around its own origin and M4's packer translates patches apart.
 */
export interface UnfoldResult {
  /** Flat position per cut-mesh vertex (mm); patches laid out independently. */
  flat: Vec2[];
  /** Cut-mesh triangles (global vertex indices). */
  faces: [number, number, number][];
  /** Connected-component label per face. */
  patchOfFace: number[];
  patchCount: number;
  /** Provenance chain: cut-mesh vertex → Q vertex. */
  origVertex: number[];
  /** Cut-edge lip pairs (global cut-mesh vertex ids). */
  lips: LipPair[];
  /** Source-mesh edge ids added by the relief loop. */
  reliefEdges: number[];
  /** Sum of source-edge lengths over all cuts incl. relief (mm). */
  totalCutLength: number;
}

export type EdgeAssignment = "M" | "V" | "F" | "B" | "C";
export type CutType = "major" | "minor" | "seam" | "dart" | "auxetic" | "vent" | "tab";

/** Packed flat pattern with classification (M4, `route-seams.ts`). */
export interface Sheet {
  vertices: Vec2[];
  faces: [number, number, number][];
  edges: MeshEdge[];
  assignment: EdgeAssignment[];
  /** Signed dihedral target θ in rad (AKDE convention: mountain positive); null on B/C. */
  foldAngle: (number | null)[];
  cutType: (CutType | null)[];
  /** Provenance chain continues: sheet vertex → Q vertex. */
  origVertex: number[];
  lips: LipPair[];
  patchOfFace: number[];
}

/** Result of the simulator verification (M5, `verify.ts`). */
export interface VerifyReport {
  /** Sampled symmetric Hausdorff distance, mm. */
  dH: number;
  /** dH / bbox diagonal of Q. */
  dHRel: number;
  /** The ε actually used, mm. */
  epsilon: number;
  meanStrain: number;
  maxStrain: number;
  iterations: number;
  attempts: number;
  converged: boolean;
  /** Q vertex nearest the worst sample — the refine hook's terminal. */
  worstSourceVertex: number;
}

/**
 * Stage-tagged pipeline failure. Every stage throws this (never bare Error)
 * so the controller can show "<stage>: <message>" and tests can pin stages.
 */
export class PipelineError extends Error {
  readonly stage: "import" | "conditioning" | "mesh" | "curvature" | "plan-cuts" | "unfold" | "route-seams" | "emit" | "verify";
  readonly details?: unknown;

  constructor(stage: PipelineError["stage"], message: string, details?: unknown) {
    super(`${stage}: ${message}`);
    this.name = "PipelineError";
    this.stage = stage;
    this.details = details;
  }
}
