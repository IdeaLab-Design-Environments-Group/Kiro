# Source Structure

`src/` is the active application source. It is split by responsibility rather
than by file type.

For narrower subsystem docs, start at `docs/subsystems/index.md`.

## Tree

```text
src/
  main.ts
  styles.css
  controller/
    app-controller.ts
  model/
    app-store.ts
    derive-facts.ts
    fkld-metadata.ts
    fold-file.ts
    geometry.ts
    types.ts
  pipeline/
    conditioning.ts
    curvature.ts
    emit.ts
    import.ts
    index.ts
    kirigamize.ts
    mesh.ts
    plan-cuts.ts
    route-seams.ts
    types.ts
    unfold.ts
    verify.ts
  sim/
    build.ts
    fold-adapter.ts
    foldnet.ts
    forces.ts
    gpu/
      gpu-solver.ts
      pack.ts
      shaders.ts
    index.ts
    model.ts
    scene.ts
    solver.ts
    stabilize.ts
    vec3.ts
  view/
    convert-panel.ts
    dom.ts
    header-actions.ts
    metadata-panel.ts
    sim-canvas.ts
    sim-modal.ts
    viewer-frame.ts
```

## Composition Root

`src/main.ts`

- Imports CSS.
- Instantiates `AppStore`.
- Instantiates all views.
- Instantiates `AppController`.
- Loads the default sample.
- Should not contain business logic, parsing, geometry, solver code, or DOM
  update details beyond mounting views.

## Controller

`src/controller/app-controller.ts`

Responsibilities:

- Register view callbacks.
- Read dropped/selected files.
- Parse FOLD/FKLD JSON.
- Route mesh inputs to the future pipeline.
- Update `AppStore`.
- Push derived render data into views when state changes.
- Send FOLD/FKLD objects to `ViewerFrame`.
- Provide simulation scenes to `SimModal`.

It is intentionally the only app layer that imports both model and view
classes.

## Model

`src/model/`

| File | Responsibility |
| --- | --- |
| `app-store.ts` | Observable UI state: loaded model and status. |
| `fold-file.ts` | Minimal FOLD/FKLD types and `isFkld`. |
| `derive-facts.ts` | Loaded model to Derived panel rows. |
| `fkld-metadata.ts` | FOLD/FKLD object to metadata panel sections. |
| `geometry.ts` | AKDE/kirigami scalar geometry calculations. |
| `types.ts` | Kirigami input/derived/domain types. |

Rules:

- No DOM.
- No controller imports.
- No view imports.
- Pure calculations should stay deterministic and testable.

## View

`src/view/`

| File | Responsibility |
| --- | --- |
| `dom.ts` | Tiny DOM helpers shared by views. |
| `convert-panel.ts` | File dropzone, status line, Derived rows. |
| `metadata-panel.ts` | FKLD metadata rendering. |
| `viewer-frame.ts` | Embedded FKLD viewer iframe and postMessage bridge. |
| `header-actions.ts` | Header buttons and intent callbacks. |
| `sim-modal.ts` | 3D simulation modal shell and fold slider. |
| `sim-canvas.ts` | Three.js/WebGL simulation rendering and animation policy. |

Rules:

- Views emit intents via callbacks.
- Views render data they are given.
- Views do not parse files.
- Views do not mutate `AppStore`.
- `sim-canvas.ts` may call simulation solvers because it is the rendering
  adapter for live simulation scenes.

## Pipeline

`src/pipeline/`

| File | Stage | Responsibility |
| --- | --- | --- |
| `types.ts` | shared | DTOs, `PipelineError`, cross-stage contracts. |
| `import.ts` | M1 | Parse OBJ/ASCII STL text into `TriMesh`. |
| `conditioning.ts` | M1 | Weld, drop degenerates, orient, genus gate. |
| `mesh.ts` | M1 | Topology, edge keys, face angles, boundary loops, wedges. |
| `curvature.ts` | M2 | Angle defects and signed dihedral targets. |
| `plan-cuts.ts` | M2 | Cut terminals, shortest paths, wedge rule. |
| `unfold.ts` | M3 | Cut along edges, unfold patches, relief loop. |
| `route-seams.ts` | M4 | Pack patches and classify sheet edges/cuts. |
| `emit.ts` | M4 | Build FOLD/FKLD output and validate extension arrays. |
| `verify.ts` | M5 | Sim-based equilibrium verification metrics. |
| `kirigamize.ts` | driver | Full pipeline facade and retry schedule. |
| `index.ts` | barrel | Node-safe exports. |

Rules:

- No DOM.
- No view/controller imports.
- Stage files should expose pure functions where possible.
- Throw `PipelineError` with stage names.
- Preserve `origVertex` provenance.

## Simulation

`src/sim/`

| File | Responsibility |
| --- | --- |
| `vec3.ts` | Vector helpers. |
| `foldnet.ts` | FoldNet topology from AKDE/generic meshes. |
| `model.ts` | `BarHingeModel` struct-of-arrays assembly. |
| `forces.ts` | CPU force math and timestep calculation. |
| `solver.ts` | CPU reference solver. |
| `stabilize.ts` | Solver stabilization/settling helpers. |
| `build.ts` | Guided AKDE scene builder. |
| `fold-adapter.ts` | FOLD/FKLD to simulation scene adapter. |
| `scene.ts` | Guided/free scene selection. |
| `gpu/pack.ts` | Pack model into GPU textures. |
| `gpu/shaders.ts` | GLSL force/integration shaders. |
| `gpu/gpu-solver.ts` | Three.js GPU computation wrapper. |
| `index.ts` | Public simulation exports. |

Rules:

- Physics/math belongs here, not in views.
- Rendering belongs in `src/view/sim-canvas.ts`.
- CPU solver is the reference path.
- GPU solver is an acceleration path.

## Styling

`src/styles.css`

- Global app layout.
- Panel styles.
- Header action styles.
- Viewer frame styles.
- 3D simulation modal styles.

Keep class names aligned with view components. Avoid adding layout-specific
styles inside TypeScript files.
