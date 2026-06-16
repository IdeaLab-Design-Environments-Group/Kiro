/**
 * FKLD → STL export: the 3D-printed tiles. Each flat face is inset toward its centroid (separated
 * from neighbours) and extruded to a chosen height, producing one closed triangular prism per tile.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildStlExport } from "../../../src/model/stl-export.js";
import type { FoldFile } from "../../../src/model/fold-file.js";

const load = (n: string): FoldFile =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../public/examples/${n}`, import.meta.url)), "utf8")) as FoldFile;

const countFacets = (stl: string): number => (stl.match(/facet normal/g) ?? []).length;
const verts = (stl: string): V3[] =>
  [...stl.matchAll(/vertex (\S+) (\S+) (\S+)/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
type V3 = [number, number, number];

/** A single tile (triangular prism) is 8 facets: top + bottom + 3 side walls × 2. */
const FACETS_PER_TILE = 8;

/** True when the listed facets form a closed surface: every undirected edge used once each way. */
function isClosed(vs: V3[]): boolean {
  const dir = new Map<string, number>();
  const key = (p: V3): string => p.join(",");
  for (let i = 0; i < vs.length; i += 3) {
    const tri = [vs[i], vs[i + 1], vs[i + 2]];
    for (let e = 0; e < 3; e++) {
      const a = key(tri[e]), b = key(tri[(e + 1) % 3]);
      dir.set(`${a}|${b}`, (dir.get(`${a}|${b}`) ?? 0) + 1);
    }
  }
  for (const [e, n] of dir) {
    const [a, b] = e.split("|");
    if (n !== 1 || (dir.get(`${b}|${a}`) ?? 0) !== 1) return false; // each half-edge exactly once
  }
  return true;
}

describe("buildStlExport — extruded 3D-printed tiles (synthetic)", () => {
  it("emits one closed prism per face (8 facets), wrapped in solid/endsolid", () => {
    const fold: FoldFile = {
      vertices_coords: [[0, 0], [10, 0], [10, 10], [0, 10]],
      faces_vertices: [[0, 1, 2], [0, 2, 3]],
    };
    const out = buildStlExport(fold, "sq", 3)!;
    expect(out.filename).toBe("sq.stl");
    expect(out.text.startsWith("solid sq")).toBe(true);
    expect(out.text.trimEnd().endsWith("endsolid sq")).toBe(true);
    expect(countFacets(out.text)).toBe(2 * FACETS_PER_TILE);
  });

  it("each tile is a watertight prism: base at z=0, top at the chosen height", () => {
    const fold: FoldFile = {
      vertices_coords: [[0, 0], [10, 0], [5, 8]],
      faces_vertices: [[0, 1, 2]],
    };
    const out = buildStlExport(fold, "t", 4)!;
    const vs = verts(out.text);
    expect(isClosed(vs)).toBe(true);
    const zs = new Set(vs.map((v) => v[2]));
    expect([...zs].sort((a, b) => a - b)).toEqual([0, 4]); // exactly the base and the top plane
    expect(out.height).toBe(4);
  });

  it("insets each tile toward its centroid (separated, strictly inside the source face)", () => {
    const fold: FoldFile = {
      vertices_coords: [[0, 0], [10, 0], [10, 10]],
      faces_vertices: [[0, 1, 2]],
    };
    const vs = verts(buildStlExport(fold, "t", 2)!.text);
    for (const [x, y] of vs) {
      expect(x).toBeGreaterThan(0);
      expect(x).toBeLessThan(10);
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(10);
    }
  });

  it("separates tiles that shared an edge — the shared edge opens into a gap", () => {
    const fold: FoldFile = {
      vertices_coords: [[0, 0], [10, 0], [10, 10], [0, 10]],
      faces_vertices: [[0, 1, 2], [0, 2, 3]], // share edge 0–2
    };
    const xy = new Set(verts(buildStlExport(fold, "t", 1)!.text).map(([x, y]) => `${x},${y}`));
    expect(xy.size).toBe(6); // 3 inset corners per tile, none coincident across the two tiles
  });

  it("uses a size-relative default height when none is given (≈ 2% of the bbox diagonal)", () => {
    const fold: FoldFile = {
      vertices_coords: [[0, 0], [100, 0], [100, 100], [0, 100]],
      faces_vertices: [[0, 1, 2]],
    };
    const out = buildStlExport(fold)!; // diagonal ≈ 141.4 → default ≈ 2.83
    expect(out.height).toBeCloseTo(0.02 * Math.hypot(100, 100), 4);
    expect(new Set(verts(out.text).map((v) => v[2]))).toContain(0);
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
    const out = buildStlExport(fold, "t", 2)!;
    const zs = new Set(verts(out.text).map((v) => v[2]));
    expect([...zs].sort((a, b) => a - b)).toEqual([0, 2]); // flat base + height, never the folded z=4/7
  });

  it("returns null when there are no faces", () => {
    expect(buildStlExport({ vertices_coords: [[0, 0]] })).toBeNull();
    expect(buildStlExport({ faces_vertices: [], vertices_coords: [[0, 0]] })).toBeNull();
  });
});

describe("buildStlExport — fold-adaptive triangulation", () => {
  // face 0 touches a hard-folding crease (edge 0–1); face 1 is all-flat → only face 0 subdivides.
  const fold = {
    vertices_coords: [[0, 0], [10, 0], [0, 10], [20, 0], [30, 0], [20, 10]],
    faces_vertices: [[0, 1, 2], [3, 4, 5]],
    edges_vertices: [[0, 1], [1, 2], [2, 0], [3, 4], [4, 5], [5, 3]],
    "fkld:edges_dihedralTarget": [2.0, 0, 0, 0, 0, 0],
  } as unknown as FoldFile;

  it("subdivides the folded face but not the flat one (more folding → more tiles)", () => {
    const tiles = (stl: string): number => countFacets(stl) / FACETS_PER_TILE;
    expect(tiles(buildStlExport(fold, "f", 1, 0)!.text)).toBe(2); // detail 0 → uniform: 1 tile per face
    // detail 2 → folded face splits to 4^2 = 16 tiles, flat face stays 1 → 17 tiles
    expect(tiles(buildStlExport(fold, "f", 1, 2)!.text)).toBe(16 + 1);
    expect(buildStlExport(fold, "f", 1, 2)!.maxSubdiv).toBe(2);
  });

  it("scales with the detail cap (deeper cap → more tiles on the folded face)", () => {
    const tiles = (d: number): number => countFacets(buildStlExport(fold, "f", 1, d)!.text) / FACETS_PER_TILE;
    expect(tiles(1)).toBe(4 + 1); // folded face 4^1
    expect(tiles(3)).toBe(64 + 1); // folded face 4^3
  });

  it("does not subdivide a flat model regardless of detail", () => {
    const flat = {
      vertices_coords: [[0, 0], [10, 0], [0, 10]],
      faces_vertices: [[0, 1, 2]],
      edges_vertices: [[0, 1], [1, 2], [2, 0]],
      "fkld:edges_dihedralTarget": [0, 0, 0],
    } as unknown as FoldFile;
    expect(countFacets(buildStlExport(flat, "z", 1, 4)!.text)).toBe(FACETS_PER_TILE); // 1 tile
  });

  it("falls back to the folded-form dihedral when no crease targets are present", () => {
    // a ridge tent: two coplanar flat triangles, folded form lifts the shared edge → real dihedral
    const tent = {
      vertices_coords: [[0, 0], [10, 0], [5, -5], [5, 5]],
      faces_vertices: [[0, 1, 3], [0, 3, 2]], // share edge 0–3
      file_frames: [
        { frame_classes: ["foldedForm"], vertices_coords: [[0, 0, 0], [10, 0, 0], [5, -5, 6], [5, 5, 6]] },
      ],
    } as unknown as FoldFile;
    expect(countFacets(buildStlExport(tent, "t", 1, 2)!.text)).toBeGreaterThan(2 * FACETS_PER_TILE);
  });
});

describe("buildStlExport — real AKDE example", () => {
  it("exports a finite, watertight prism per face at uniform detail (detail 0)", () => {
    const fold = load("akde-hex.fkld");
    const out = buildStlExport(fold, "akde-hex", 5, 0)!;
    expect(countFacets(out.text)).toBe(fold.faces_vertices!.length * FACETS_PER_TILE);
    const vs = verts(out.text);
    for (const v of vs) for (const k of v) expect(Number.isFinite(k)).toBe(true);
    const zs = new Set(vs.map((v) => v[2]));
    expect([...zs].sort((a, b) => a - b)).toEqual([0, 5]); // every tile based at 0, extruded to 5
  });

  it("adds tiles around the mountain folds at the default detail", () => {
    const fold = load("akde-hex.fkld");
    const uniform = countFacets(buildStlExport(fold, "akde-hex", 5, 0)!.text);
    const adaptive = buildStlExport(fold, "akde-hex", 5)!; // default detail = 2
    expect(countFacets(adaptive.text)).toBeGreaterThan(uniform); // mountain-fold faces subdivided
    const zs = new Set(verts(adaptive.text).map((v) => v[2]));
    expect([...zs].sort((a, b) => a - b)).toEqual([0, 5]); // still flat-based prisms
  });
});
