/**
 * Architecture test — the executable version of docs/import-boundaries.md.
 *
 * Walks every src/**\/*.ts file, extracts its import/export specifiers, and
 * checks them against the RULES table. A failure here means a layering
 * violation: fix the import, don't loosen the rule (loosening requires a
 * conscious docs/import-boundaries.md update in the same change).
 *
 * Phase-1 rule set (ratchets tighter in later phases):
 *   R1  `three` only from src/view/** and src/sim/gpu/**
 *   R2  kirigami/ and fkld/ only via the @kirigami / @fkld aliases
 *   R3  outside src/sim/, sim modules only via sim/index.js or sim/gpu/index.js
 *   R4  src/core/** imports nothing from other src layers (and no three)
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, dirname, sep } from "node:path";

const SRC = resolve(__dirname, "../../../src");

/** All .ts files under src/, as paths relative to src/ with forward slashes. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Extract every module specifier: import/export ... from "x", await import("x"). */
function specifiers(source: string): string[] {
  const out: string[] = [];
  const fromRe = /(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g;
  const bareRe = /import\s+["']([^"']+)["']/g;
  const dynRe = /import\(\s*["']([^"']+)["']\s*\)/g;
  for (const re of [fromRe, bareRe, dynRe]) {
    for (let m = re.exec(source); m; m = re.exec(source)) out.push(m[1]);
  }
  return out;
}

interface ImportEdge {
  /** Importing file, relative to src/ (posix slashes). */
  file: string;
  /** Raw specifier as written. */
  spec: string;
  /** Specifier resolved to a src-relative path (posix), or null for bare/aliased imports. */
  resolved: string | null;
}

function collectEdges(): ImportEdge[] {
  const edges: ImportEdge[] = [];
  for (const abs of walk(SRC)) {
    const file = relative(SRC, abs).split(sep).join("/");
    const source = readFileSync(abs, "utf8");
    for (const spec of specifiers(source)) {
      let resolved: string | null = null;
      if (spec.startsWith(".")) {
        const target = resolve(dirname(abs), spec);
        resolved = relative(SRC, target).split(sep).join("/");
      }
      edges.push({ file, spec, resolved });
    }
  }
  return edges;
}

const edges = collectEdges();

const violations = (
  pred: (e: ImportEdge) => boolean,
): string[] => edges.filter(pred).map((e) => `${e.file} → ${e.spec}`);

describe("architecture: import boundaries (docs/import-boundaries.md)", () => {
  it("R1: `three` is only imported by src/view/** and src/sim/gpu/**", () => {
    const bad = violations(
      (e) =>
        (e.spec === "three" || e.spec.startsWith("three/")) &&
        !e.file.startsWith("view/") &&
        !e.file.startsWith("sim/gpu/"),
    );
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("R2: kirigami/ and fkld/ are only reached via @kirigami / @fkld aliases", () => {
    const bad = violations(
      (e) =>
        e.resolved !== null &&
        (e.resolved.startsWith("../kirigami/") || e.resolved.startsWith("../fkld/")),
    );
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("R3: outside src/sim/, sim is only imported via sim/index.js or sim/gpu/index.js", () => {
    const bad = violations(
      (e) =>
        e.resolved !== null &&
        e.resolved.startsWith("sim/") &&
        !e.file.startsWith("sim/") &&
        e.resolved !== "sim/index.js" &&
        e.resolved !== "sim/gpu/index.js",
    );
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("R4: src/core/** imports nothing from other src layers (and never three)", () => {
    const bad = violations(
      (e) =>
        e.file.startsWith("core/") &&
        // allow only intra-core relative imports and node builtins
        ((e.resolved !== null && !e.resolved.startsWith("core/")) ||
          e.spec === "three" ||
          e.spec.startsWith("three/") ||
          e.spec.startsWith("@kirigami") ||
          e.spec.startsWith("@fkld")),
    );
    expect(bad, bad.join("\n")).toEqual([]);
  });
});
