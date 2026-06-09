# Import Boundaries

This document is the practical rulebook for keeping the code separated.

## Allowed Direction

```text
main
  -> controller
  -> model
  -> pipeline
  -> sim
  -> view
```

The actual dependency shape is:

```text
src/main.ts
  imports model + view + controller

src/controller/
  imports model + view + sim scene selection + pipeline facade when needed

src/view/
  imports model types/presenter result types
  imports sim scene/solver APIs only for simulation rendering

src/model/
  imports no view/controller
  may import shared types only

src/pipeline/
  imports model FoldFile type where FKLD emission/verification needs it
  imports sim math/adapter only at verification boundaries
  imports no view/controller

src/sim/
  imports model geometry/types only for AKDE scene construction
  imports no view/controller
```

## Explicitly Forbidden

Do not add these imports:

| From | Forbidden import | Reason |
| --- | --- | --- |
| `src/model/*` | `src/view/*` | Model must stay DOM-free. |
| `src/model/*` | `src/controller/*` | Model should not know orchestration. |
| `src/pipeline/*` | `src/view/*` | Pipeline must stay node-safe and testable. |
| `src/pipeline/*` | `src/controller/*` | Controller calls pipeline, not reverse. |
| `src/sim/*` | `src/view/*` | Rendering belongs in view. |
| `src/main.ts` | stage internals | Main should only compose. |

## Boundary Exceptions

Some dependencies are intentional:

- `src/view/sim-canvas.ts` imports simulation solvers because it renders live
  simulation state.
- `src/pipeline/emit.ts` imports FKLD spec/validators from `fkld/`.
- `src/pipeline/verify.ts` imports `buildSceneFromFold` because verification
  uses the same adapter as the UI.
- `src/sim/build.ts` imports `KirigamiState` and geometry-compatible types for
  guided AKDE scene construction.

Document any new exception in this file.

## Quick Audit Commands

Run these before large refactors:

```sh
rg "../view|./view" src/model src/pipeline src/sim
rg "../controller|./controller" src/model src/pipeline src/sim src/view
rg "document|window|HTMLElement|HTMLCanvasElement|FileReader" src/model src/pipeline
rg "AppStore" src/view src/model src/pipeline src/sim
```

Expected notes:

- `src/view/*` will naturally use DOM types.
- `src/controller/*` will naturally use `FileReader`.
- `src/sim/gpu/*` may use Three.js/WebGL infrastructure.

## Barrel Files

Use barrel files only when they preserve boundaries:

- `src/sim/index.ts` exports simulation domain APIs.
- `src/pipeline/index.ts` exports node-safe pipeline APIs.

Do not create a root `src/index.ts` that re-exports every layer. That makes
forbidden imports too easy.

## Adding a New File

Before creating a file, answer:

1. Does it render DOM/WebGL? Put it in `src/view/`.
2. Does it coordinate user intents/state/view updates? Put it in
   `src/controller/`.
3. Does it store app state or derive display data from state? Put it in
   `src/model/`.
4. Does it convert mesh data toward FKLD? Put it in `src/pipeline/`.
5. Does it simulate folding or build simulation meshes? Put it in `src/sim/`.
6. Is it global styling? Put it in `src/styles.css`.

If a file seems to need two layers, split it. For example, a "load mesh" feature
usually needs:

- a view change for the button/status;
- a controller handler for FileReader and status updates;
- a pipeline function for mesh conversion;
- model presenter updates for derived facts.

