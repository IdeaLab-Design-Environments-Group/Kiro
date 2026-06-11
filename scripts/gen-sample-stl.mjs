/**
 * Generate simple ASCII-STL test meshes for the Kirigamizer pipeline
 * (convert panel → Kirigamize ▶). Geometry mirrors the verified e2e fixtures
 * (cube = canonical target; tetrahedron = simplest closed manifold), so the
 * samples are guaranteed to fold. Run: `node scripts/gen-sample-stl.mjs`.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const out = (name) => fileURLToPath(new URL(`../public/examples/${name}`, import.meta.url));

const cube = (size = 100) => {
  const s = size / 2;
  const v = [
    [-s, -s, -s], [s, -s, -s], [s, s, -s], [-s, s, -s],
    [-s, -s, s], [s, -s, s], [s, s, s], [-s, s, s],
  ];
  const quads = [
    [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [3, 0, 4, 7],
  ];
  const f = [];
  for (const [a, b, c, d] of quads) f.push([a, b, c], [a, c, d]);
  return { v, f };
};

const tetra = (size = 100) => {
  const s = size / 2;
  const v = [[s, s, s], [s, -s, -s], [-s, s, -s], [-s, -s, s]];
  const f = [[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]];
  return { v, f };
};

// Regular octahedron — 6 vertices on the axes, 8 triangular faces. Every
// vertex carries positive curvature, so (like the cube) it darts and folds.
const octa = (size = 100) => {
  const s = size / 2;
  const v = [
    [s, 0, 0], [-s, 0, 0], [0, s, 0], [0, -s, 0], [0, 0, s], [0, 0, -s],
  ];
  const f = [
    [0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], // top apex (+z)
    [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5], // bottom apex (−z)
  ];
  return { v, f };
};

// n-gon pyramid: a regular n-sided base in the z=0 plane plus an apex at
// height `h`. Base is fan-triangulated; the apex is a single high-curvature
// cone vertex — the canonical kirigami target. n=4 reproduces pyramid.stl.
const pyramid = (n, radius = 50, h = 70) => {
  const v = [[0, 0, h]]; // 0 = apex
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    v.push([radius * Math.cos(t), radius * Math.sin(t), 0]);
  }
  const f = [];
  for (let i = 1; i <= n; i++) f.push([0, i, (i % n) + 1]);        // sides
  for (let i = 2; i < n; i++) f.push([1, i, i + 1]);               // base fan
  return { v, f };
};

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Flip any face whose normal points toward the centroid so the whole mesh is
// consistently outward-oriented (valid for the convex samples here). Keeps the
// STL a clean orientable manifold regardless of how each face was wound above.
const orient = ({ v, f }) => {
  const c = v.reduce((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]).map((x) => x / v.length);
  const out = f.map(([i, j, k]) => {
    const n = cross(sub(v[j], v[i]), sub(v[k], v[i]));
    const fc = [(v[i][0] + v[j][0] + v[k][0]) / 3 - c[0], (v[i][1] + v[j][1] + v[k][1]) / 3 - c[1], (v[i][2] + v[j][2] + v[k][2]) / 3 - c[2]];
    return dot(n, fc) >= 0 ? [i, j, k] : [i, k, j];
  });
  return { v, f: out };
};

function toStl(name, { v, f }) {
  const lines = [`solid ${name}`];
  for (const [i, j, k] of f) {
    const n = norm(cross(sub(v[j], v[i]), sub(v[k], v[i])));
    lines.push(`  facet normal ${n[0].toFixed(6)} ${n[1].toFixed(6)} ${n[2].toFixed(6)}`);
    lines.push("    outer loop");
    for (const idx of [i, j, k]) lines.push(`      vertex ${v[idx][0]} ${v[idx][1]} ${v[idx][2]}`);
    lines.push("    endloop", "  endfacet");
  }
  lines.push(`endsolid ${name}`, "");
  return lines.join("\n");
}

const samples = [
  ["sample-cube.stl", "cube", cube(100)],
  ["sample-tetrahedron.stl", "tetrahedron", tetra(100)],
  ["sample-octahedron.stl", "octahedron", orient(octa(100))],
  ["sample-hex-pyramid.stl", "hexPyramid", orient(pyramid(6, 50, 70))],
];
const dist = (name) => fileURLToPath(new URL(`../dist/examples/${name}`, import.meta.url));
for (const [file, name, mesh] of samples) {
  const stl = toStl(name, mesh);
  writeFileSync(out(file), stl);
  // dist/examples mirrors public/examples (the built site serves from dist).
  try { writeFileSync(dist(file), stl); } catch { /* dist/ may not exist yet */ }
  console.log(`wrote public/examples/${file} (${mesh.f.length} facets)`);
}
