# Kirigamizer

Foundation of the Kirigamizer app — a **TypeScript + Vite** project that keeps
[AKDE](../AKDE)'s three-column UI and pairs a **model → kirigami converter**
with the **FKLD viewer** as the central preview.

This is the **layout** stage: the conversion is a passthrough stub. FKLD/FOLD
files flow straight into the viewer; mesh files (`.obj`/`.stl`) are the entry
point where the real pipeline (curvature → molecules/cuts → unfold → FKLD)
will plug in.

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
| `src/model/geometry.ts` · `src/model/types.ts` | kirigami geometry/domain calculations |
| `src/view/` | DOM/WebGL views: convert panel, metadata panel, viewer frame, header actions, sim modal/canvas |
| `src/styles.css` | AKDE-derived theme (incl. 3D-sim modal) |
| `src/sim/` | simulation domain: bar-and-hinge fold engine + `fold-adapter`/`scene` builders |
| `public/viewer/index.html` | FKLD viewer (copied from FKLD, + host bridge) |
| `public/examples/` | bundled `.fkld` / `.fold` samples |
| `*_algorithms.tex` · `*_algorithms.pdf` | Origamizer / Kirigamizer algorithm diagrams (reference) |

## Next steps (not in this foundation)

- Implement `.obj`/`.stl` import and the Kirigamizer conversion in `src/`.
- Replace the passthrough stub with curvature → molecule/cut → unfold.
- Reuse FKLD's `bridge`/`io` and AKDE's geometry where useful.
