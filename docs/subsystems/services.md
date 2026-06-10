# Subsystem: Services

Services hold stateless use-case logic between the controller and domain
modules. They keep `AppController` thin and testable.

## Files

| File | Role |
| --- | --- |
| `src/services/model-loader.ts` | File text parsing, `FileReader` wrapper, sample fetch, loaded-status messages. |
| `src/services/pattern-service.ts` | Facade for mesh kirigamizing and AKDE pyramid creation. |
| `src/services/sim-scene-service.ts` | Resolve what 3D Sim should fold. |
| `src/services/svg-export-service.ts` | Resolve what SVG export should target. |
| `src/core/errors.ts` | Shared `AppError` and status conversion used by services/controller. |

## Service Rules

Services may:

- call model presenters or domain APIs;
- return narrow outcome objects for the controller;
- throw `AppError` or pass through `PipelineError`;
- be tested in plain Node.

Services must not:

- create DOM nodes;
- mutate `AppStore`;
- call view methods;
- read component state directly;
- import `src/view/*`.

## Model Loader

`model-loader.ts` owns:

- extension-based parsing;
- JSON parse errors;
- OBJ/STL mesh wrapping;
- unsupported extension errors;
- callback-style `FileReader`;
- bundled sample fetch;
- standard loaded status messages.

Important distinction:

- parse errors clear the model in the controller;
- IO errors leave the current model untouched.

## Pattern Service

`pattern-service.ts` has two creation paths:

- `kirigamizeMesh`: general OBJ/STL mesh-to-FKLD pipeline;
- `createAkdePyramid`: transferred AKDE parametric pyramid path.

Both return `PatternOutcome`:

```ts
interface PatternOutcome {
  fkld: FoldFile;
  name: string;
  summary: string;
  ok: boolean;
}
```

The controller should not inspect full `KirigamizeResult` internals. Tests and
pipeline UI can inspect those later through dedicated APIs.

## Sim Scene Service

`resolveSimScene(model, shown)` implements the policy:

```text
simulate viewerShown first, otherwise loaded fold model
```

This preserves "what you see is what gets simulated".

## SVG Export Service

`resolveSvgExport(model, shown)` implements the equivalent export policy:

```text
export viewerShown first, otherwise loaded fold model
```

This preserves "what you see is what you cut".

## Adding a Service

Add a service when logic is:

- too specific for a generic model presenter;
- not a view concern;
- not pure domain math;
- useful to test without instantiating the controller.

Keep the controller call shape narrow: service in, outcome out.

