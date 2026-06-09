/**
 * Seam routing & packing (M4): the flattened cut mesh → one classified sheet.
 *
 * Pattern: functional core — packing is a pure function of patch bboxes;
 * classification is a deterministic mapping pinned by tests.
 *
 * Packing decision: bbox shelf packing (sort by height, fill rows).
 * (Rejected: Tutte embedding of the patch-adjacency graph — a whole module
 * for the usually-1-patch case; revisit if multi-sheet nesting lands.)
 *
 * Cut-subtype mapping (deterministic): for a cut edge, look at its source
 * endpoints' defects —
 *   min δ < −FLAT_EPS → "minor"  (negative wins on mixed: the slit exists to
 *                                 ADD angle at a δ<0 vertex)
 *   max δ > +FLAT_EPS → "dart"   (cut+overlap discards surplus angle)
 *   otherwise         → "seam"   (pure connection/relief through flat verts)
 * "major"/"tab" are not emitted by the general pipeline (major stays
 * AKDE-pyramid-specific; sealed gusset strips are deferred — open slits
 * realize δ<0, per the proposal's honest scope). In the FOLDED state every
 * v1 cut seals (its lips return to the shared source edge); openness is a
 * flat-state property.
 */

import { buildTopology, edgeKey } from "./mesh.js";
import { FLAT_EPS } from "./curvature.js";
import { targetFoldAngles } from "./curvature.js";
import {
  PipelineError,
  type CutType,
  type DefectReport,
  type MeshTopology,
  type Sheet,
  type TriMesh,
  type UnfoldResult,
  type Vec2,
} from "./types.js";

export interface PackContext {
  /** Conditioned source mesh Q (mm). */
  mesh: TriMesh;
  /** Topology of Q. */
  topo: MeshTopology;
  /** Defect report of Q (drives cut subtypes). */
  defects: DefectReport;
}

/**
 * Translate patches apart (shelf packing), derive sheet edges, classify
 * every edge (M/V/F/B/C), attach fold-angle targets and cut subtypes.
 */
export function packPatches(unfold: UnfoldResult, ctx: PackContext, marginMm = 5): Sheet {
  const { mesh, topo, defects } = ctx;

  // --- vertex → patch (each cut-mesh vertex belongs to exactly one patch) --
  const patchOfVertex = new Array<number>(unfold.flat.length).fill(-1);
  for (let f = 0; f < unfold.faces.length; f++) {
    for (const v of unfold.faces[f]) patchOfVertex[v] = unfold.patchOfFace[f];
  }

  // --- shelf packing of patch bboxes ---------------------------------------
  const boxes = Array.from({ length: unfold.patchCount }, () => ({
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  }));
  for (let v = 0; v < unfold.flat.length; v++) {
    const p = patchOfVertex[v];
    if (p === -1) continue;
    const b = boxes[p];
    b.minX = Math.min(b.minX, unfold.flat[v].x);
    b.maxX = Math.max(b.maxX, unfold.flat[v].x);
    b.minY = Math.min(b.minY, unfold.flat[v].y);
    b.maxY = Math.max(b.maxY, unfold.flat[v].y);
  }
  const order = boxes
    .map((b, p) => ({ p, w: b.maxX - b.minX, h: b.maxY - b.minY }))
    .sort((a, b) => b.h - a.h);
  const sheetWidth = Math.max(...order.map((o) => o.w)) * 2 + 4 * marginMm; // 2 widest per row
  const offsets: Vec2[] = new Array(unfold.patchCount);
  let cursorX = marginMm;
  let cursorY = marginMm;
  let rowH = 0;
  for (const { p, w, h } of order) {
    if (cursorX > marginMm && cursorX + w + marginMm > sheetWidth) {
      cursorX = marginMm;
      cursorY += rowH + marginMm;
      rowH = 0;
    }
    offsets[p] = { x: cursorX - boxes[p].minX, y: cursorY - boxes[p].minY };
    cursorX += w + marginMm;
    rowH = Math.max(rowH, h);
  }

  const vertices: Vec2[] = unfold.flat.map((pt, v) => {
    const off = offsets[patchOfVertex[v]] ?? { x: 0, y: 0 };
    return { x: pt.x + off.x, y: pt.y + off.y };
  });

  // --- sheet edges from the cut-mesh faces (z=0 lift reuses buildTopology) --
  const sheetTopo = buildTopology({
    vertices: vertices.map((p) => ({ x: p.x, y: p.y, z: 0 })),
    faces: unfold.faces,
  });

  // Lip edge lookup: cut-mesh vertex pair key → its lip (cut subtype source).
  const lipEdge = new Map<string, number>(); // key → source edge id
  for (const lip of unfold.lips) {
    lipEdge.set(edgeKey(lip.lipA[0], lip.lipA[1]), lip.sourceEdge);
    lipEdge.set(edgeKey(lip.lipB[0], lip.lipB[1]), lip.sourceEdge);
  }

  const sourceTargets = targetFoldAngles(mesh, topo);

  const assignment: Sheet["assignment"] = [];
  const foldAngle: Sheet["foldAngle"] = [];
  const cutType: Sheet["cutType"] = [];

  for (let e = 0; e < sheetTopo.edges.length; e++) {
    const edge = sheetTopo.edges[e];
    const key = edgeKey(edge.a, edge.b);
    if (edge.faces.length === 1) {
      const src = lipEdge.get(key);
      if (src !== undefined) {
        assignment.push("C");
        foldAngle.push(null);
        cutType.push(cutSubtypeFor(topo, defects, src));
      } else {
        assignment.push("B"); // original ∂Q boundary
        foldAngle.push(null);
        cutType.push(null);
      }
    } else {
      // Interior sheet edge ↔ un-cut interior source edge.
      const srcA = unfold.origVertex[edge.a];
      const srcB = unfold.origVertex[edge.b];
      const srcE = topo.edgeIndex.get(edgeKey(srcA, srcB));
      if (srcE === undefined) {
        throw new PipelineError("route-seams", `interior sheet edge ${key} has no source edge ${srcA}-${srcB}`);
      }
      const theta = sourceTargets[srcE];
      if (theta === null) {
        throw new PipelineError("route-seams", `source edge ${srcE} unexpectedly boundary`);
      }
      assignment.push(theta > FLAT_EPS ? "M" : theta < -FLAT_EPS ? "V" : "F");
      foldAngle.push(theta);
      cutType.push(null);
    }
  }

  return {
    vertices,
    faces: unfold.faces,
    edges: sheetTopo.edges,
    assignment,
    foldAngle,
    cutType,
    origVertex: unfold.origVertex,
    lips: unfold.lips,
    patchOfFace: unfold.patchOfFace,
  };
}

/** The deterministic cut-subtype rule (see module doc). Exported for tests. */
export function cutSubtypeFor(topo: MeshTopology, defects: DefectReport, sourceEdge: number): CutType {
  const { a, b } = topo.edges[sourceEdge];
  const da = defects.defects[a];
  const db = defects.defects[b];
  if (Math.min(da, db) < -FLAT_EPS) return "minor";
  if (Math.max(da, db) > FLAT_EPS) return "dart";
  return "seam";
}
