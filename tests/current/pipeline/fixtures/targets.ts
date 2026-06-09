/**
 * Programmatic target-mesh fixtures (pattern: fixture factory functions).
 * All return TriMesh in mm; no file I/O in unit tests. Grown per milestone:
 * M1 cube/tetrahedron/icosphere; M2 saddle fan/octahedron/pyramid;
 * M5 saddle roof/Enneper patch.
 */

import type { TriMesh, Vec3 } from "../../../../src/pipeline/types.js";

/** Axis-aligned cube, CCW-out winding, triangulated. V=8 E=18 F=12 χ=2. */
export function makeCube(size = 100): TriMesh {
  const s = size / 2;
  const vertices: Vec3[] = [
    { x: -s, y: -s, z: -s }, // 0
    { x: s, y: -s, z: -s }, // 1
    { x: s, y: s, z: -s }, // 2
    { x: -s, y: s, z: -s }, // 3
    { x: -s, y: -s, z: s }, // 4
    { x: s, y: -s, z: s }, // 5
    { x: s, y: s, z: s }, // 6
    { x: -s, y: s, z: s }, // 7
  ];
  // Quads with outward CCW winding, fan-triangulated.
  const quads: [number, number, number, number][] = [
    [0, 3, 2, 1], // z = -s (bottom, normal -z)
    [4, 5, 6, 7], // z = +s (top, normal +z)
    [0, 1, 5, 4], // y = -s
    [2, 3, 7, 6], // y = +s
    [1, 2, 6, 5], // x = +s
    [3, 0, 4, 7], // x = -s
  ];
  const faces: [number, number, number][] = [];
  for (const [a, b, c, d] of quads) faces.push([a, b, c], [a, c, d]);
  return { vertices, faces };
}

/** Regular tetrahedron. V=4 E=6 F=4 χ=2; δ(v) = π at every vertex. */
export function makeTetrahedron(size = 100): TriMesh {
  const s = size / 2;
  const vertices: Vec3[] = [
    { x: s, y: s, z: s },
    { x: s, y: -s, z: -s },
    { x: -s, y: s, z: -s },
    { x: -s, y: -s, z: s },
  ];
  const faces: [number, number, number][] = [
    [0, 1, 2],
    [0, 3, 1],
    [0, 2, 3],
    [1, 3, 2],
  ];
  return { vertices, faces };
}

/**
 * Icosphere: icosahedron with `subdiv` rounds of midpoint subdivision,
 * vertices projected to radius. subdiv=1: V=42 E=120 F=80 χ=2.
 */
export function makeIcosphere(subdiv = 1, radius = 50): TriMesh {
  const t = (1 + Math.sqrt(5)) / 2;
  let vertices: Vec3[] = [
    { x: -1, y: t, z: 0 }, { x: 1, y: t, z: 0 }, { x: -1, y: -t, z: 0 }, { x: 1, y: -t, z: 0 },
    { x: 0, y: -1, z: t }, { x: 0, y: 1, z: t }, { x: 0, y: -1, z: -t }, { x: 0, y: 1, z: -t },
    { x: t, y: 0, z: -1 }, { x: t, y: 0, z: 1 }, { x: -t, y: 0, z: -1 }, { x: -t, y: 0, z: 1 },
  ];
  let faces: [number, number, number][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  const project = (v: Vec3): Vec3 => {
    const l = Math.hypot(v.x, v.y, v.z);
    return { x: (v.x / l) * radius, y: (v.y / l) * radius, z: (v.z / l) * radius };
  };
  vertices = vertices.map(project);
  for (let r = 0; r < subdiv; r++) {
    const midCache = new Map<string, number>();
    const mid = (a: number, b: number): number => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      let id = midCache.get(key);
      if (id === undefined) {
        const va = vertices[a];
        const vb = vertices[b];
        id = vertices.length;
        vertices.push(project({ x: (va.x + vb.x) / 2, y: (va.y + vb.y) / 2, z: (va.z + vb.z) / 2 }));
        midCache.set(key, id);
      }
      return id;
    };
    const next: [number, number, number][] = [];
    for (const [a, b, c] of faces) {
      const ab = mid(a, b);
      const bc = mid(b, c);
      const ca = mid(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }
  return { vertices, faces };
}

/**
 * Saddle fan: one interior vertex with δ < 0 — a hexagonal fan whose ring
 * alternates ±zAmp so the apex angle sum exceeds 2π. Disk (χ=1), ring is
 * boundary, center (vertex 0) is the negative-curvature terminal.
 */
export function makeSaddleFan(ringR = 50, zAmp = 20): TriMesh {
  const vertices: Vec3[] = [{ x: 0, y: 0, z: 0 }];
  const N = 6;
  for (let i = 0; i < N; i++) {
    const a = (2 * Math.PI * i) / N;
    vertices.push({ x: ringR * Math.cos(a), y: ringR * Math.sin(a), z: i % 2 === 0 ? zAmp : -zAmp });
  }
  const faces: [number, number, number][] = [];
  for (let i = 0; i < N; i++) faces.push([0, 1 + i, 1 + ((i + 1) % N)]);
  return { vertices, faces };
}

/** Regular octahedron. V=6 F=8 E=12 χ=2; δ(v) = 2π/3 > 0 at every vertex. */
export function makeOctahedron(size = 100): TriMesh {
  const s = size / 2;
  const vertices: Vec3[] = [
    { x: s, y: 0, z: 0 },
    { x: -s, y: 0, z: 0 },
    { x: 0, y: s, z: 0 },
    { x: 0, y: -s, z: 0 },
    { x: 0, y: 0, z: s },
    { x: 0, y: 0, z: -s },
  ];
  const faces: [number, number, number][] = [
    [0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4],
    [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5],
  ];
  return { vertices, faces };
}

/**
 * Open N-gon pyramid (lateral faces only, no base): apex (vertex 0) carries
 * the positive defect; the base ring is boundary.
 */
export function makePyramid(N = 4, L = 50, H = 30): TriMesh {
  const R = L / (2 * Math.sin(Math.PI / N));
  const vertices: Vec3[] = [{ x: 0, y: 0, z: H }];
  for (let i = 0; i < N; i++) {
    const a = (2 * Math.PI * i) / N;
    vertices.push({ x: R * Math.cos(a), y: R * Math.sin(a), z: 0 });
  }
  const faces: [number, number, number][] = [];
  for (let i = 0; i < N; i++) faces.push([0, 1 + i, 1 + ((i + 1) % N)]);
  return { vertices, faces };
}

/** Flat planar grid patch: every interior vertex flat; only boundary remains. */
export function makeGrid(nx = 4, ny = 4, cell = 25): TriMesh {
  const vertices: Vec3[] = [];
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      vertices.push({ x: i * cell, y: j * cell, z: 0 });
    }
  }
  const id = (i: number, j: number): number => j * (nx + 1) + i;
  const faces: [number, number, number][] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      faces.push([id(i, j), id(i + 1, j), id(i + 1, j + 1)]);
      faces.push([id(i, j), id(i + 1, j + 1), id(i, j + 1)]);
    }
  }
  return { vertices, faces };
}

/** Serialize a TriMesh as minimal OBJ text (round-trip test helper). */
export function toObj(mesh: TriMesh): string {
  const lines: string[] = [];
  for (const v of mesh.vertices) lines.push(`v ${v.x} ${v.y} ${v.z}`);
  for (const [i, j, k] of mesh.faces) lines.push(`f ${i + 1} ${j + 1} ${k + 1}`);
  return lines.join("\n") + "\n";
}

/** Serialize a TriMesh as ASCII STL (triangle soup — exercises welding). */
export function toAsciiStl(mesh: TriMesh): string {
  const lines: string[] = ["solid fixture"];
  for (const [i, j, k] of mesh.faces) {
    lines.push("  facet normal 0 0 0", "    outer loop");
    for (const v of [mesh.vertices[i], mesh.vertices[j], mesh.vertices[k]]) {
      lines.push(`      vertex ${v.x} ${v.y} ${v.z}`);
    }
    lines.push("    endloop", "  endfacet");
  }
  lines.push("endsolid fixture");
  return lines.join("\n") + "\n";
}
