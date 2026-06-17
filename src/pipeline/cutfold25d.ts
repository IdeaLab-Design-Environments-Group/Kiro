/**
 * **Pipeline** — 2.5D cut-and-fold "signage" generator: a faithful port of the
 * universality algorithm (Theorem 1) of
 *
 *   Demaine, Demaine, Devadoss, Myers & Parra Rubio,
 *   "2.5D Signage from Sheet Material with Orthogonal Cuts and Folds",
 *   ASME IDETC/CIE 2023.
 *
 * Given a PIXELATED 2.5D surface (an integer height map — here `{0,1}` pixel art
 * or text), it paints a {@link PatternGrid} with the orthogonal cut-and-fold
 * pattern that pops up into that surface from a single flat sheet:
 *
 *   • PARALLEL CUTS — a cut at every interior column boundary, from just below a
 *     reserved top *connector row* down to the bottom. Each width-1 column then
 *     folds independently (a cantilever), which is why neighbouring heights can
 *     coexist.
 *   • 90° CREASES — each column is creased on its own: where the height is
 *     constant it stays flat; wherever it changes by Δ a pair of folds separated
 *     by |Δ| of material turns that |Δ| into a vertical wall — VALLEY then
 *     MOUNTAIN for Δ>0, MOUNTAIN then VALLEY for Δ<0.
 *
 * The folded shape of one column is exactly the rectilinear staircase of its
 * height function (treads = surface facets, risers = walls). All crease/cut
 * positions land on integer grid lines for `{0,1}` pixels, so the whole pattern
 * fits a `X × (eps + R + V)` unit lattice. The service layer
 * (`pattern-service.ts`) turns the painted grid into an FKLD `FoldFile`, tagging
 * the wall creases with ±90° `edges_foldAngle` so the 3D Sim folds the true
 * relief instead of a flat ±180° fold.
 *
 * Pure: no DOM, no FKLD keys. Depends only on {@link PatternGrid}.
 */
import { PatternGrid } from "../model/pattern-grid.js";

/** Reserved connector-row thickness, in grid units (a small flat z=0 band at the top). */
export const CONNECTOR_EPS = 1;

/** Stats describing a built 2.5D pattern (for the status line / report). */
export interface CutFold25dStats {
  cols: number; // X — image columns
  rows: number; // R — image rows (surface y-extent)
  totalRows: number; // eps + R + V — sheet height in units
  variation: number; // V — max column total variation
  interiorCuts: number; // X − 1
  mountainCreases: number;
  valleyCreases: number;
}

export interface CutFold25dResult {
  grid: PatternGrid;
  stats: CutFold25dStats;
  /**
   * Folded ("popped-up") 3D position of every grid vertex, parallel to the FKLD
   * `vertices_coords` (row-major `j*(cols+1)+i`). Shipped as a `foldedForm` frame +
   * `fkld:vertices_driven` so the 3D Sim is **guided** into the relief: a strip of
   * parallel ±90° creases is a symmetric mechanism the free fold can't break out of
   * flat, so — like the AKDE cone — it must be driven to its declared shape.
   */
  foldedForm: number[][];
}

/** Parse one bitmap row-string char to an integer height. `#`,`X`,`*`,`1`..`9` → level; else 0. */
function levelOf(ch: string): number {
  if (ch === "#" || ch === "X" || ch === "x" || ch === "*") return 1;
  if (ch >= "1" && ch <= "9") return Number(ch);
  return 0;
}

/** Bitmap (list of equal-or-ragged row strings) → integer height grid `L[row][col]`. */
export function parseBitmap(rows: string[]): number[][] {
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  return rows.map((r) => Array.from({ length: width }, (_, c) => levelOf(r[c] ?? ".")));
}

/** Total variation of one column (sum of |Δ| incl. entry/exit from the height-0 field). */
export function columnVariation(col: number[]): number {
  let prev = 0;
  let v = 0;
  for (const z of [...col, 0]) {
    v += Math.abs(z - prev);
    prev = z;
  }
  return v;
}

/**
 * Theorem-1 crease layout for one column, walking the material from the
 * connector (t=0) toward the tip. Returns the creases as `{ t, kind }` where `t`
 * is the material coordinate (grows away from the connector) and `kind` is the
 * fold direction. A height change Δ emits a pair separated by |Δ|:
 *   Δ>0 → VALLEY at t, MOUNTAIN at t+|Δ|;  Δ<0 → MOUNTAIN at t, VALLEY at t+|Δ|.
 */
export function columnCreases(levels: number[], eps: number): { t: number; kind: "M" | "V" }[] {
  const out: { t: number; kind: "M" | "V" }[] = [];
  let t = eps; // connector facet occupies [0, eps] at z=0
  let prev = 0;
  const seq = [...levels, 0]; // trailing 0 = exit back to the background field
  for (let i = 0; i < seq.length; i++) {
    const d = seq[i] - prev;
    if (d !== 0) {
      out.push({ t, kind: d > 0 ? "V" : "M" });
      t += Math.abs(d);
      out.push({ t, kind: d > 0 ? "M" : "V" });
    }
    prev = seq[i];
    if (i < levels.length) t += 1; // tread (one surface row, flat)
  }
  return out;
}

/**
 * Folded staircase position `(y, z)` of one column at material coordinate `t`
 * (t=0 at the connector). Treads (constant height) advance `y`; risers (height
 * change) hold `y` and ramp `z`. Units are grid units (multiply by cellMm).
 */
export function columnFoldedYZ(levels: number[], eps: number, t: number): [number, number] {
  if (t <= eps) return [t, 0]; // connector tread at z=0
  let cur = eps;
  let y = eps;
  let prev = 0;
  const seq = [...levels, 0];
  for (let i = 0; i < seq.length; i++) {
    const d = seq[i] - prev;
    if (d !== 0) {
      const a = cur;
      const b = cur + Math.abs(d);
      if (t <= a) return [y, prev];
      if (t <= b) return [y, prev + Math.sign(d) * (t - a)]; // on riser: y fixed, z ramps
      cur = b;
    }
    prev = seq[i];
    if (i < levels.length) {
      const a = cur;
      const b = cur + 1;
      if (t <= b) return [y + (t - a), seq[i]]; // on tread: y advances, z fixed
      cur = b;
      y += 1;
    }
  }
  return [y, 0]; // slack tongue at z=0
}

/**
 * The folded relief position of every grid vertex `(i,j)` (row-major), in mm. Each
 * shared boundary vertex takes the **average** of the two columns it borders, so
 * same-height neighbours align cleanly and only differing-height edges bridge.
 */
function foldedForm(L: number[][], cols: number, N: number, eps: number, cellMm: number): number[][] {
  const out: number[][] = [];
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= cols; i++) {
      const t = N - j;
      const neigh = [i - 1, i].filter((c) => c >= 0 && c < cols);
      const yz = neigh.map((c) => columnFoldedYZ(L.map((row) => row[c]), eps, t));
      const y = yz.reduce((s, v) => s + v[0], 0) / yz.length;
      const z = yz.reduce((s, v) => s + v[1], 0) / yz.length;
      out.push([i * cellMm, y * cellMm, z * cellMm]);
    }
  }
  return out;
}

/**
 * Build the 2.5D cut-and-fold pattern for a height map onto a {@link PatternGrid}.
 *
 * Layout: `cols = X` columns wide, `rows = eps + R + V` units tall, with the
 * connector band the top `eps` rows (j ∈ [N−eps, N]). Grid row `j` corresponds to
 * material `t = N − j`, so the image's top row sits just under the connector and
 * low-variation columns leave flat "slack" at the bottom.
 *
 *  - horizontal crease edges `(c,j)-(c+1,j)` get M/V at each column transition;
 *  - vertical cut edges `(cc,j)-(cc,j+1)` get "C" for every interior boundary
 *    `cc ∈ [1, X−1]`, `j ∈ [0, N−eps−1]` (stopping just below the connector);
 *  - everything else defaults (perimeter B, interior F) in `gridToFold`.
 */
export function build25dPattern(bitmap: string[], opts: { eps?: number; cellMm?: number } = {}): CutFold25dResult {
  const eps = opts.eps ?? CONNECTOR_EPS;
  const cellMm = opts.cellMm ?? 12;
  const L = parseBitmap(bitmap);
  const rows = L.length;
  const cols = rows ? L[0].length : 0;
  if (!rows || !cols) throw new Error("2.5D: empty bitmap");

  const colLevels = (c: number): number[] => L.map((row) => row[c]);
  const variation = Math.max(1, ...Array.from({ length: cols }, (_, c) => columnVariation(colLevels(c))));
  const N = eps + rows + variation; // total sheet height in units
  if (cols > 40 || N > 40) {
    throw new Error(`2.5D: pattern ${cols}×${N} exceeds the 40×40 grid limit — try fewer/shorter columns.`);
  }

  const grid = new PatternGrid(cols, N, cellMm);

  let mountains = 0;
  let valleys = 0;
  // Per-column creases (horizontal edges spanning the column width).
  for (let c = 0; c < cols; c++) {
    for (const { t, kind } of columnCreases(colLevels(c), eps)) {
      const j = N - t; // material → grid row
      grid.set(grid.vid(c, j), grid.vid(c + 1, j), kind);
      if (kind === "M") mountains++;
      else valleys++;
    }
  }
  // Parallel cuts: every interior column boundary, from the bottom up to just
  // below the connector band (leaving the top `eps` rows joined).
  for (let cc = 1; cc < cols; cc++) {
    for (let j = 0; j < N - eps; j++) {
      grid.set(grid.vid(cc, j), grid.vid(cc, j + 1), "C");
    }
  }

  return {
    grid,
    foldedForm: foldedForm(L, cols, N, eps, cellMm),
    stats: {
      cols,
      rows,
      totalRows: N,
      variation,
      interiorCuts: cols - 1,
      mountainCreases: mountains,
      valleyCreases: valleys,
    },
  };
}

// --------------------------------------------------------------------------- //
//  Built-in art + a 3×5 pixel font for text signage
// --------------------------------------------------------------------------- //

/** The classic 11×8 Space Invader "crab" — reproduces the paper's Figure 1. */
export const SPACE_INVADER: string[] = [
  "..#.....#..",
  "...#...#...",
  "..#######..",
  ".##.###.##.",
  "###########",
  "#.#######.#",
  "#.#.....#.#",
  "...##.##...",
];

/**
 * A compact 3×5 pixel font (uppercase A–Z, 0–9, space), in the spirit of the
 * paper's pixel font. Each glyph is 5 rows of 3 chars, top→bottom. Letters are
 * laid out with a 1-column blank separator (so a word costs 4 cuts/letter, as in
 * the paper). Approximate but legible — enough to fold real text signs.
 */
const FONT_3X5: Record<string, string[]> = {
  A: ["###", "#.#", "###", "#.#", "#.#"],
  B: ["##.", "#.#", "##.", "#.#", "##."],
  C: ["###", "#..", "#..", "#..", "###"],
  D: ["##.", "#.#", "#.#", "#.#", "##."],
  E: ["###", "#..", "##.", "#..", "###"],
  F: ["###", "#..", "##.", "#..", "#.."],
  G: ["###", "#..", "#.#", "#.#", "###"],
  H: ["#.#", "#.#", "###", "#.#", "#.#"],
  I: ["###", ".#.", ".#.", ".#.", "###"],
  J: ["..#", "..#", "..#", "#.#", "###"],
  K: ["#.#", "#.#", "##.", "#.#", "#.#"],
  L: ["#..", "#..", "#..", "#..", "###"],
  M: ["#.#", "###", "###", "#.#", "#.#"],
  N: ["#.#", "###", "###", "###", "#.#"],
  O: ["###", "#.#", "#.#", "#.#", "###"],
  P: ["###", "#.#", "###", "#..", "#.."],
  Q: ["###", "#.#", "#.#", "###", "..#"],
  R: ["##.", "#.#", "##.", "#.#", "#.#"],
  S: ["###", "#..", "###", "..#", "###"],
  T: ["###", ".#.", ".#.", ".#.", ".#."],
  U: ["#.#", "#.#", "#.#", "#.#", "###"],
  V: ["#.#", "#.#", "#.#", "#.#", ".#."],
  W: ["#.#", "#.#", "###", "###", "#.#"],
  X: ["#.#", "#.#", ".#.", "#.#", "#.#"],
  Y: ["#.#", "#.#", ".#.", ".#.", ".#."],
  Z: ["###", "..#", ".#.", "#..", "###"],
  "0": ["###", "#.#", "#.#", "#.#", "###"],
  "1": [".#.", "##.", ".#.", ".#.", "###"],
  "2": ["##.", "..#", ".#.", "#..", "###"],
  "3": ["###", "..#", ".##", "..#", "###"],
  "4": ["#.#", "#.#", "###", "..#", "..#"],
  "5": ["###", "#..", "###", "..#", "###"],
  "6": ["###", "#..", "###", "#.#", "###"],
  "7": ["###", "..#", ".#.", ".#.", ".#."],
  "8": ["###", "#.#", "###", "#.#", "###"],
  "9": ["###", "#.#", "###", "..#", "###"],
  " ": ["...", "...", "...", "...", "..."],
};

/**
 * Render a text string into a 5-row pixel bitmap using the 3×5 font, with a
 * 1-column gap between glyphs. Unknown characters become a blank glyph.
 */
export function textToBitmap(text: string): string[] {
  const chars = Array.from(text.toUpperCase());
  const glyphs = chars.map((ch) => FONT_3X5[ch] ?? FONT_3X5[" "]);
  const rows: string[] = [];
  for (let r = 0; r < 5; r++) {
    rows.push(glyphs.map((g) => g[r]).join("."));
  }
  return rows;
}
