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

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

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
];
for (const [file, name, mesh] of samples) {
  writeFileSync(out(file), toStl(name, mesh));
  console.log(`wrote public/examples/${file} (${mesh.f.length} facets)`);
}
