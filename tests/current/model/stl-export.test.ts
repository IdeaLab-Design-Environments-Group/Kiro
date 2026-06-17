/**
 * FKLD → STL export: the 3D-printed tiles in the **foldable joinery** (`printed-joinery.ts`). Every
 * face is a rigid tile inset so there is a gap around it; a thin living-hinge bridge spans every shared
 * fold/facet edge (so the tiles fold about it) and "C" cuts stay open. Print flat, fold up.
 */
import { describe, it, expect } from "vitest";
import { buildStlExport } from "../../../src/model/stl-export.js";
import type { FoldFile } from "../../../src/model/fold-file.js";

type V3 = [number, number, number];
const countFacets = (stl: string): number => (stl.match(/facet normal/g) ?? []).length;
const verts = (stl: string): V3[] =>
  [...stl.matchAll(/vertex (\S+) (\S+) (\S+)/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
const zSet = (vs: V3[]): number[] => [...new Set(vs.map((v) => Math.round(v[2] * 1e4) / 1e4))].sort((a, b) => a - b);

/** Every closed solid uses each directed edge once and its reverse once (tiles + hinges are each closed). */
function allClosed(vs: V3[]): boolean {
  const dir = new Map<string, number>();
  const key = (p: V3): string => p.map((n) => Math.round(n * 1e3)).join(",");
  for (let i = 0; i < vs.length; i += 3)
    for (let e = 0; e < 3; e++) dir.set(`${key(vs[i + e])}|${key(vs[i + (e + 1) % 3])}`, (dir.get(`${key(vs[i + e])}|${key(vs[i + (e + 1) % 3])}`) ?? 0) + 1);
  for (const [e, n] of dir) {
    const [a, b] = e.split("|");
    if (n !== 1 || (dir.get(`${b}|${a}`) ?? 0) !== 1) return false;
  }
  return true;
}

describe("buildStlExport — foldable printed joinery", () => {
  it("wraps the tiles in solid/endsolid and names the file", () => {
    const fold: FoldFile = { vertices_coords: [[0, 0], [10, 0], [5, 8]], faces_vertices: [[0, 1, 2]] };
    const out = buildStlExport(fold, "sq", 3)!;
    expect(out.filename).toBe("sq.stl");
    expect(out.text.startsWith("solid sq")).toBe(true);
    expect(out.text.trimEnd().endsWith("endsolid sq")).toBe(true);
    expect(out.maxSubdiv).toBe(0);
  });

  it("a lone triangle is one closed inset prism: base at z=0, top at the height, strictly inside the face", () => {
    const fold: FoldFile = { vertices_coords: [[0, 0], [10, 0], [5, 8]], faces_vertices: [[0, 1, 2]] };
    const vs = verts(buildStlExport(fold, "t", 4)!.text);
    expect(allClosed(vs)).toBe(true);
    expect(zSet(vs)).toEqual([0, 4]); // a lone tile has no hinge → only base + top
    expect(countFacets(buildStlExport(fold, "t", 4)!.text)).toBe(8); // triangular prism
    for (const [x, y] of vs) { expect(x).toBeGreaterThan(0); expect(x).toBeLessThan(10); expect(y).toBeGreaterThan(0); expect(y).toBeLessThan(8); }
  });

  it("HINGES a shared fold edge with a thin bridge, seated on the inside of the fold per M/V/F", () => {
    const make = (assign: string): string => buildStlExport({
      vertices_coords: [[0, 0], [10, 0], [10, 10], [0, 10]],
      faces_vertices: [[0, 1, 2], [0, 2, 3]], // share edge 0–2
      edges_vertices: [[0, 1], [1, 2], [0, 2], [2, 3], [0, 3]],
      edges_assignment: ["B", "B", assign, "B", "B"],
    } as FoldFile, "t", 2)!.text;
    // height 2 → hinge slab thickness 0.35·2 = 0.7. Mountain seats at the bottom, valley at the top,
    // flat at mid — so the rigid tiles pivot about the hinge on the inside of the fold.
    expect(allClosed(verts(make("M")))).toBe(true);
    expect(countFacets(make("M"))).toBe(2 * 8 + 12); // 2 inset prisms + 1 hinge box
    expect(zSet(verts(make("M")))).toEqual([0, 0.7, 2]); // mountain → bottom band [0, 0.7]
    expect(zSet(verts(make("V")))).toEqual([0, 1.3, 2]); // valley → top band [1.3, 2]
    expect(zSet(verts(make("F")))).toEqual([0, 0.65, 1.35, 2]); // flat → mid band [0.65, 1.35]
  });

  it("does NOT hinge a cut edge: the gap stays open (no bridge, no mid-height layer)", () => {
    const fold: FoldFile = {
      vertices_coords: [[0, 0], [10, 0], [10, 10], [0, 10]],
      faces_vertices: [[0, 1, 2], [0, 2, 3]],
      edges_vertices: [[0, 1], [1, 2], [0, 2], [2, 3], [0, 3]],
      edges_assignment: ["B", "B", "C", "B", "B"], // 0–2 is a cut → stays open
    };
    const out = buildStlExport(fold, "t", 2)!;
    expect(countFacets(out.text)).toBe(2 * 8); // two inset tiles only, no hinge
    expect(zSet(verts(out.text))).toEqual([0, 2]); // no hinge layer
  });

  it("a wider Gap shrinks each tile (corners pull further toward the centroid)", () => {
    const fold: FoldFile = { vertices_coords: [[0, 0], [10, 0], [5, 8]], faces_vertices: [[0, 1, 2]] };
    const minCornerDistToCentroid = (gap: number): number => {
      const c: V3 = [5, 8 / 3, 0];
      return Math.min(...verts(buildStlExport(fold, "t", 1, null, gap)!.text).filter((v) => v[2] === 0).map((v) => Math.hypot(v[0] - c[0], v[1] - c[1])));
    };
    expect(minCornerDistToCentroid(0.4)).toBeLessThan(minCornerDistToCentroid(0.05)); // bigger gap → smaller tile
  });

  it("uses a size-relative default height when none is given (≈ 2% of the bbox diagonal)", () => {
    const fold: FoldFile = { vertices_coords: [[0, 0], [100, 0], [0, 100]], faces_vertices: [[0, 1, 2]] };
    const out = buildStlExport(fold)!;
    expect(out.height).toBeCloseTo(0.02 * Math.hypot(100, 100), 4);
    expect(zSet(verts(out.text))).toContain(0);
  });

  it("reports the unit label from frame_unit, defaulting to \"units\"", () => {
    const base = { vertices_coords: [[0, 0], [1, 0], [1, 1]], faces_vertices: [[0, 1, 2]] } as FoldFile;
    expect(buildStlExport(base)!.unit).toBe("units");
    expect(buildStlExport({ ...base, frame_unit: "mm" })!.unit).toBe("mm");
  });

  it("always uses the flat pattern (z base = 0), ignoring any declared foldedForm frame", () => {
    const fold = {
      vertices_coords: [[0, 0], [10, 0], [5, 8]],
      faces_vertices: [[0, 1, 2]],
      file_frames: [{ frame_classes: ["foldedForm"], vertices_coords: [[0, 0, 0], [10, 0, 0], [5, 4, 7]] }],
    } as unknown as FoldFile;
    expect(zSet(verts(buildStlExport(fold, "t", 2)!.text))).toEqual([0, 2]); // never the folded z=4/7
  });

  it("returns null when there are no faces", () => {
    expect(buildStlExport({ vertices_coords: [[0, 0]] })).toBeNull();
    expect(buildStlExport({ faces_vertices: [], vertices_coords: [[0, 0]] })).toBeNull();
  });
});
