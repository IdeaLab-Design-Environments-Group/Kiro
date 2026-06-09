# Kirigamizer — build plan (general cut + fold for any surface)

**Status:** Foundation in place. AKDE's full **creation** pipeline and **sim** are
transferred into this repo (`kirigami/`, `fkld/`), the simulator is restored to
AKDE-exact behavior, and the shell can already *create* an AKDE pyramid and fold
it. The **general** model→pattern conversion (the actual Kirigamizer) is the work
this plan lays out.

**Authority:** `kirigamizer_algorithms.tex` (Emre Dayangac) — the algorithm
proposal; `origamizer_algorithms.tex` — the reused Origamizer stages. AKDE is the
v1 special case (uniform-molecule pyramid). Building blocks: Demaine & Tachi,
*Origamizer* (SoCG 2017); Ghassaei, Demaine, Gershenfeld, GPU origami simulation
(7OSME 2018); Liu, Chuang, Sang, Sabin, *Programmable Kirigami* (DETC2019-97557).

**Last updated:** 2026-06-09.

---

## 1. Goal and non-goal

**Goal.** Given a 3D target surface, emit a flat sheet with **cuts + folds** that
folds into it, fabrication-ready (FKLD + SVG/DXF), verified by the bar-and-hinge
simulator. The defining move: a fold preserves $2\pi$ at every interior point, so
origami can only *subtract* angle (tuck convex surplus) and fails at negative
curvature; a **cut** lifts that, realizing both curvature signs exactly and
locally. Origamizer is the special case $\mathcal{C}=\varnothing$; the AKDE
uniform pyramid is the special case "one positive-curvature apex, uniform
molecules."

**Non-goal (for now).** A general computational-origami research tool. Every
stage earns its place on the path target surface → cut plan → flat pattern →
simulation → fabrication.

---

## 2. What already exists in this repo

| Area | Where | State |
|------|-------|-------|
| **Shell (MVC)** | `src/model`, `src/view`, `src/controller`, `src/main.ts` | ✅ three-column UI: Convert · FKLD metadata · viewer; header actions |
| **Creation (uniform pyramid)** | `kirigami/model/` (`geometry`, `pattern`, `constraints`, `svg-export`, `zip`, `fkld-export`, `validation`) | ✅ transferred from AKDE; **167 AKDE tests pass here** |
| **FKLD format** | `fkld/` (`spec`, `bridge`, `io`, `molecule`, `cut-types` — CoffeeScript) + `src/model/fkld-metadata.ts` | ✅ FOLD 1.2 superset; read + write + validate |
| **Simulation** | `src/sim/` (CPU core = AKDE-exact) + `src/sim/gpu/` + `src/view/sim-canvas.ts` | ✅ **fixed**: guided pyramid folds AKDE-faithfully; generic FKLD free-fold via `cutRatio` |
| **Viewer** | `public/viewer/` (+ `postMessage` bridge in `src/view/viewer-frame.ts`) | ✅ renders any FOLD/FKLD |
| **Examples** | `public/examples/` (`akde-hex`, `akde-square-pyramid`, `akde-circular`, `fold-upstream/*`) | ✅ |
| **Create-pyramid action** | header → `AppController.createPyramid()` → `@kirigami` creation → viewer + sim | ✅ end-to-end demo of the creation half |
| **Model → kirigami conversion** | `AppController.kirigamize()` for `.obj`/`.stl` | ⛔ **stub** — this plan fills it |

The simulator fix is the precondition for everything downstream (Stage 5 verifies
every pattern): `src/sim/{model,forces,solver}.ts` are now byte-identical to AKDE,
and cut edges are made free flaps via AKDE's `cutRatio` API instead of the earlier
diverged crease-exclusion / sign-flip. See `tests/current/kzr-sim.test.ts`.

---

## 3. The pipeline (algorithm → modules to build)

From `kirigamizer_algorithms.tex`, the driver is
`Kirigamizer(M, ε, λ)` = ImportAndCondition → PlanCuts → SeamedUnfold →
RouteSeams → EmitPattern → SimulateVerifyOptimize. Target module layout
(new code under `src/pipeline/`, reusing `kirigami/` + `fkld/`):

| Stage | Algorithm | New module | Reuses |
|-------|-----------|-----------|--------|
| **0. Import & condition** | STEP/mesh → coarse manifold $Q$ (weld, repair, decimate, units, clean/tuck side) | `src/pipeline/import.ts`, `src/pipeline/conditioning.ts` | — |
| **1. Plan cuts** | $\delta(v)=2\pi-\sum\alpha_i$; necessity ($v\in\mathcal{C}\iff\delta\neq0$), connection (cut-tree to a developable disk + $2g$ handle loops), routing ($\min\sum \mathrm{len}+\lambda\,\mathrm{vis}$); dart-vs-tuck | `src/pipeline/curvature.ts`, `src/pipeline/plan-cuts.ts` | `fkld:vertices_angleDefect/curvatureClass/reliefStrategy` |
| **2. Seamed unfold** | cut into developable patches, flatten isometrically; relief cuts until each patch embeds | `src/pipeline/unfold.ts` | Origamizer vertex-unfolding |
| **3. Route seams & tabs** | pack patches (Tutte); seam (brook) for sealed cuts, gusset/tab strip (river) to deliver material to $\delta<0$ | `src/pipeline/route-seams.ts` | Origamizer streams |
| **4. Emit pattern** | write M/V/F creases + cut edges as **FKLD**; tuck the chosen $\delta>0$ vertices via local Origamizer molecules | `src/pipeline/emit.ts` | `kirigami/model/pattern`, `fkld/bridge`, `kirigami/model/molecule` |
| **5. Simulate · verify · optimize** | GPU-fold (cuts first-class), check $d_H(Q,f(P))\le ε$, refine $\lambda$/dart-vs-tuck/angles/scale | `src/pipeline/verify.ts` | `src/sim/*` (now AKDE-exact) |

Half-edge mesh + adjacency is the shared substrate: `src/pipeline/mesh.ts`
(vertices/edges/faces, one-ring traversal, boundary detection).

---

## 4. Phased build order

Each milestone is shippable and testable on its own. ✅ = done, ▶ = next, ☐ = later.

- **M0 — Foundation (✅).** Transfer AKDE creation + sim + FKLD; fix the sim to
  AKDE-exact; wire Create-pyramid; green build + tests.
- **M1 — Mesh substrate (▶).** `mesh.ts` half-edge + adjacency; OBJ/PLY/OFF import
  (`import.ts`); conditioning (weld, manifold repair, decimate) (`conditioning.ts`).
  STEP import is later (M6) — start with meshes already in the repo's `fold-upstream`
  examples and OBJ test fixtures. *Test:* round-trip a cube/icosphere; angle defects
  sum to $2\pi\chi$.
- **M2 — Curvature & cut planning (☐).** `curvature.ts` (per-vertex $\delta$,
  classify ±/flat/boundary); `plan-cuts.ts` necessity + connection (cut-tree),
  routing v1 (shortest paths along edges, visibility weight $\lambda$); dart-vs-tuck
  decision. *Test:* a saddle gets exactly the cuts Gauss–Bonnet forces; a convex
  polytope reduces to Origamizer ($\mathcal{C}=\varnothing$ when all tucked).
- **M3 — Seamed unfold (☐).** `unfold.ts` BFS vertex-unfolding per patch + overlap
  relief cuts. *Test:* each patch flattens isometrically; no self-overlap; total cut
  length ≥ curvature minimum.
- **M4 — Emit FKLD (☐).** `route-seams.ts` (pack + seams/tabs) + `emit.ts` (creases,
  cut subtypes, local tucks) → FKLD via `fkld/bridge`. *Test:* output loads in the
  viewer; FKLD validates; cut subtypes (`major/minor/seam/dart/...`) correct.
- **M5 — Verify loop (☐).** `verify.ts`: fold the emitted FKLD with `src/sim`, measure
  $d_H$ to the goal, refine. Wire `AppController.kirigamize()` for `.obj`/`.stl` to run
  M1–M5. *Test:* a coarse target folds to within ε (e.g. Enneper patch, saddle roof).
- **M6 — Fabrication & STEP (☐).** STEP/B-rep import (feature edges, units); SVG/DXF
  export with cut/score/engrave layers (reuse `kirigami/model/svg-export`); kerf,
  tabs, multi-sheet nesting.

---

## 5. Testing strategy

- Keep the transferred AKDE suite as the regression floor for creation + sim
  (geometry, pattern, constraints, svg-export, zip, fkld/*, sim). The repo's active
  tests live under `tests/current/`; `tests/*.test.ts` are the transferred AKDE
  originals (move into `tests/current/` as they're adopted).
- Every pipeline stage gets a unit test with a hand-checkable target (cube, saddle,
  Enneper patch). Stage 5 is the integration gate: folded $d_H \le ε$.
- The simulator is the oracle: a pattern is "correct" when it folds to the target in
  `src/sim`, not when it merely looks right on paper.

---

## 6. Honest scope (from the proposal)

- **Coarse flat-faceted input required** — curvature must live at vertices; a dense
  mesh would force cuts everywhere. Conditioning (M1) sets where curvature concentrates.
- **Open kirigami is fully general; sealed (watertight gusset) is not** — no general
  non-crossing layer-ordering proof; treat sealed seams heuristically and verify in sim.
- **Unfolding may add relief cuts** beyond the curvature minimum (immersion ≠ embedding).
- **No constructive flat-foldability guarantee** — M/V assignment + layer order are
  validated by the simulator, not proven.
- **Stage 5 is a search, not a solver** — terminates at $d_H\le ε$ or a budget.
- **Zero-thickness model** — material thickness, kerf, score depth, joining tabs are M6.

---

## 7. References

- `kirigamizer_algorithms.tex` — the algorithm proposal (driver, PlanCuts, stages, sim, FKLD, limits).
- `origamizer_algorithms.tex` — pseudocode for the reused Origamizer stages.
- `FKLD-SPEC.md` (AKDE) and `fkld/spec.coffee` — the file format.
- AKDE `theory/plan.md` (uniform-pyramid v1) and `theory/sim-ecs.md` (the bar-and-hinge sim).
