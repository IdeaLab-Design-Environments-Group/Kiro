# Architecture

Kirigamizer is organized as a small MVC app with a separate simulation domain.
The goal is to keep DOM/WebGL code, app state, and geometry/simulation logic
independently testable.

Related structure docs:

- `docs/repository-structure.md` maps the top-level repository.
- `docs/source-structure.md` maps every active source file by responsibility.
- `docs/import-boundaries.md` gives allowed/forbidden dependency rules.

## Layers

| Layer | Path | Responsibility |
| --- | --- | --- |
| Composition root | `src/main.ts` | Construct model, views, controller, and mount them. No app behavior. |
| Controller | `src/controller/` | Translate user intents into model updates and viewer actions. Owns file IO/parsing. |
| Model | `src/model/` | Application state, FOLD/FKLD data types, geometry math, and pure presenters. No DOM. |
| View | `src/view/` | DOM/WebGL rendering and event emission. No parsing or durable app state. |
| Simulation domain | `src/sim/` | Bar-and-hinge topology, physics, solvers, and scene builders. No DOM. |
| Conversion pipeline | `src/pipeline/` | Pure mesh-to-kirigami conversion stages and DTO contracts. No DOM/app state. |

## Data Flow

```text
User event
  -> View emits intent
  -> AppController handles intent
  -> AppStore updates state
  -> Controller render subscription derives view data
  -> Views render new state
```

Example: loading a file.

```text
ConvertPanel.onFileChosen(file)
  -> AppController.loadFromFile(file)
  -> JSON parse or mesh text read
  -> AppStore.update({ model, status })
  -> render(state)
  -> ConvertPanel.renderFacts(...)
  -> MetadataPanel.render(...)
  -> HeaderActions.setKirigamizeEnabled(...)
  -> SimModal.setEnabled(...)
```

## Boundary Rules

- `src/view/*` may import types from `src/model/*` and domain APIs from
  `src/sim/*`, but must not mutate `AppStore` directly.
- `src/model/*` must not import from `src/view/*` or access the DOM.
- `src/controller/*` is the only app layer that knows about both model and view.
- `src/sim/*` must not import from `src/view/*`; rendering belongs in
  `src/view/sim-canvas.ts`.
- `src/pipeline/*` must not import from `src/view/*` or `src/controller/*`;
  controller code calls pipeline code, never the reverse.
- `src/main.ts` should stay boring: instantiate and wire objects only.

## File Ownership

Model files:

- `src/model/app-store.ts` stores observable UI state.
- `src/model/fold-file.ts` defines FOLD/FKLD shell types.
- `src/model/derive-facts.ts` maps loaded models to "Derived" rows.
- `src/model/fkld-metadata.ts` maps FKLD/FOLD objects to metadata sections.
- `src/model/geometry.ts` and `src/model/types.ts` hold kirigami math and types.

View files:

- `src/view/convert-panel.ts` owns the file dropzone and derived facts DOM.
- `src/view/metadata-panel.ts` owns the metadata DOM.
- `src/view/viewer-frame.ts` owns the embedded FKLD viewer iframe bridge.
- `src/view/header-actions.ts` owns header buttons.
- `src/view/sim-modal.ts` owns the simulation modal shell.
- `src/view/sim-canvas.ts` owns Three.js/WebGL rendering for simulation scenes.

Controller files:

- `src/controller/app-controller.ts` is the app orchestration point.

Simulation files:

- `src/sim/model.ts`, `forces.ts`, `solver.ts`, and `gpu/` implement the
  Ghassaei/Demaine/Gershenfeld bar-and-hinge simulator.
- `src/sim/foldnet.ts`, `build.ts`, `fold-adapter.ts`, and `scene.ts` build
  simulation scenes from kirigami state or FOLD/FKLD data.

Pipeline files:

- `src/pipeline/types.ts` defines cross-stage DTOs and `PipelineError`.
- `src/pipeline/import.ts` parses OBJ and ASCII STL text into `TriMesh`.
- `src/pipeline/conditioning.ts` repairs and gates imported meshes.
- `src/pipeline/mesh.ts` derives topology and one-ring fans.
- `src/pipeline/curvature.ts` computes defects and target dihedrals.
- `src/pipeline/plan-cuts.ts` routes cut forests over the mesh graph.
