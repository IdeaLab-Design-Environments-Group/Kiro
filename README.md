# Kirigamizer

Foundation of the Kirigamizer app — a **TypeScript + Vite** project that keeps
[AKDE](../AKDE)'s three-column UI and pairs a **model → kirigami converter**
with the **FKLD viewer** as the central preview.

This started as the **layout** stage, but the repo now has several working
generation paths:

- the general mesh pipeline (`.obj`/ASCII `.stl` → condition → curvature/cuts →
  unfold/pack → FKLD → sim verification);
- AKDE pyramid creation;
- 2.5D orthogonal cut-and-fold signage;
- bistable star tiling surface programming;
- a pattern editor and a circuit overlay/export path.

FKLD/FOLD files still flow straight into the viewer; mesh files are routed
through the selected creation method.

## Layout (mirrors AKDE)

```
┌──────────────────────────────────────────────────────────────┐
│ Kirigamizer                   [3D Sim] [Load sample] [Kirigamize ▶] │  header
├────────────────┬────────────────┬──────────────────────────────┤
│ Convert via    │ FKLD metadata  │                              │
│ Kirigamizer    │  · File header │     FKLD viewer (preview)     │
│  · drop model  │  · Topology    │   reused from FKLD/examples    │
│  · status      │  · assignments │       — central preview       │
│  · Derived     │  · cut types…  │                              │
├────────────────┴────────────────┴──────────────────────────────┤
│ Edge legend · viewer source                                    │  footer
└──────────────────────────────────────────────────────────────┘
```

- **Convert** (`src/view/convert-panel.ts` + `src/controller/app-controller.ts`):
  drop/pick a model → see Derived facts → header **Kirigamize ▶**.
- **FKLD metadata** (`src/model/fkld-metadata.ts`, adapted from AKDE): File header,
  Topology, `edges_assignment`, `fkld:edges_cutType`, Molecules, architecture —
  read straight from the loaded object.
- **Viewer** (`public/viewer/index.html`): the dependency-free FKLD viewer
  copied from `FKLD/examples/viewer/`, plus a `postMessage` bridge
  (`{ type:'kirigamizer:load', fkld, name }`) so the shell hands it a model.
- **3D Sim** (`src/sim/`, `src/view/sim-modal.ts`): a header button opens a
  Three.js modal that **folds the loaded crease pattern**, using AKDE's sim
  ported here (copied from AKDE, which is left untouched):
  - `src/sim/model`/`forces`/`solver`/`vec3`/`foldnet`/`build`/`gpu/` — the
    Gershenfeld bar-and-hinge simulation domain, GPU solver
    (`GPUComputationRenderer`) with CPU fallback.
  - `src/view/sim-canvas.ts` — the Three.js/WebGL view for the simulation.
  - **Guided mode** (`scene.ts`): when the model is a recognizable AKDE pyramid,
    its inputs (N, L, H, T) are recovered from `frame_title`, rebuilt into a
    `KirigamiState` via `model/geometry.computeState`, and folded with AKDE's
    exact `buildFoldScene` (boundary driven to the goal cone) — so it looks
    identical to AKDE.
  - **Free mode** (`fold-adapter.ts`): any other FOLD/FKLD file folds generically
    from `edges_foldAngle`, with quasi-static easing + velocity damping +
    rigid-body-motion removal + freeze (anti-jitter an unguided fold needs).
  The Three.js canvas is a lazy-loaded chunk.
- **Circuit editor** (`src/model/circuit*`, `src/view/sim-modal.ts`,
  `src/view/sim-canvas.ts`): in the 3D Sim, the Circuit tab lets users place
  SMD parts on tiles, route traces through membrane gaps, save the circuit, and
  export a separate circuit STL aligned to the flat tile print.

## Develop

```sh
npm install
npm run dev       # Vite dev server (opens the browser)
```

Drop a `.fold`/`.fkld` file (or click **Load sample**), then **Kirigamize ▶**
to render it in the viewer.

```sh
npm run build     # tsc --noEmit + vite build → dist/
npm run preview   # serve the production build
```

## Documentation

| Doc | Purpose |
|------|---------|
| `docs/architecture.md` | MVC boundaries, data flow, and file ownership. |
| `docs/repository-structure.md` | Top-level folders, generated files, public assets, and reference code. |
| `docs/source-structure.md` | Detailed `src/` file-by-file responsibility map. |
| `docs/import-boundaries.md` | Allowed/forbidden imports and boundary audit commands. |
| `docs/subsystems/index.md` | Subsystem-specific docs grouped by working area. |
| `docs/simulation.md` | Bar-and-hinge solver structure, guided/free modes, and debugging notes. |
| `docs/pipeline.md` | Mesh import, conditioning, curvature, and cut-planning pipeline contracts. |
| `docs/testing.md` | Build/test checks and troubleshooting checklists. |
| `docs/development.md` | Local commands, feature-placement rules, testing expectations, and generated-file notes. |
| `docs/subsystems/cutfold25d.md` | 2.5D orthogonal cut-and-fold signage generator. |
| `docs/subsystems/bst-pipeline.md` | Bistable star tiling pipeline and surface-fit route. |
| `docs/subsystems/circuit-editor.md` | Circuit authoring, trace routing, and circuit STL export. |

## Files

| Path | Role |
|------|------|
| `index.html` | Vite entry (header + `#app` grid + footer) |
| `src/main.ts` | MVC composition root only |
| `src/controller/app-controller.ts` | controller: view intents, file IO/parsing, store updates, viewer actions |
| `src/model/app-store.ts` | observable application state |
| `src/model/fold-file.ts` | minimal FOLD/FKLD typings |
| `src/model/derive-facts.ts` | loaded model → Derived rows presenter |
| `src/model/fkld-metadata.ts` | FKLD/FOLD → metadata sections presenter |
| `src/model/pattern-grid.ts` | pattern editor model: paintable lattice → triangulated FOLD draft (`gridToFold`) + presets |
| `src/model/circuit*.ts` | SMD part/trace model, circuit geometry resolver, and separate circuit STL export. |
| `src/model/tile-subdiv.ts` | shared printed-tile inset/subdivision constants for sim and STL export. |
| `kirigami/model/geometry.ts` · `kirigami/model/types.ts` | transferred AKDE kirigami geometry/domain calculations exposed through `@kirigami/model`. |
| `src/view/` | DOM/WebGL views: convert panel, metadata panel, viewer frame, header actions, sim modal/canvas, pattern-editor modal |
| `src/styles.css` | AKDE-derived theme (incl. 3D-sim modal) |
| `src/pipeline/` | pure mesh-to-kirigami conversion stages and DTO contracts |
| `src/pipeline/cutfold25d.ts` | 2.5D signage generator from pixel/text height maps. |
| `src/pipeline/bst/` | bistable star tiling generation and surface-fit pipeline. |
| `src/sim/` | simulation domain: bar-and-hinge fold engine + `fold-adapter`/`scene` builders |
| `docs/` | architecture, simulation, and development notes |
| `public/viewer/index.html` | FKLD viewer (copied from FKLD, + host bridge) |
| `public/examples/` | bundled `.fkld` / `.fold` samples |
| `*_algorithms.tex` · `*_algorithms.pdf` | Origamizer / Kirigamizer algorithm diagrams (reference) |

## Next steps

- Continue improving robustness of the general `.obj`/`.stl` mesh pipeline.
- Expand the BST star-regime/bar population path beyond the current square-safe
  defaults.
- Keep new feature docs under `docs/subsystems/` when adding source areas.
