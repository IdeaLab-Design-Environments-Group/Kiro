# Subsystem: Export Modal Routing

The export modal is the shared download surface for cutter SVGs, printed tile
STLs, and circuit STLs. It owns DOM state and downloads only; source selection
and payload construction stay in services/model modules.

## Files

| File | Role |
| --- | --- |
| `src/view/export-modal.ts` | Modal UI, previews, input controls, download buttons. |
| `src/controller/app-controller.ts` | Wires providers and keeps export enablement in sync with app state. |
| `src/services/svg-export-service.ts` | Selects the FOLD/FKLD pattern for cut/score SVG export. |
| `src/services/stl-export-service.ts` | Selects the FOLD/FKLD pattern for printed tile STL export. |
| `src/model/fkld-svg-export.ts` | Builds SVG previews, combined SVG, and cut/score ZIP payload. |
| `src/model/stl-export.ts` | Builds separated, extruded tile STL text. |
| `src/model/circuit-export.ts` | Builds the separate trace/component circuit STL. |

## Provider Contract

`ExportModal` accepts three providers:

| Provider | Type | Purpose |
| --- | --- | --- |
| `ExportProvider` | `() => SvgExportPayload | null` | Cut/score SVG payload. |
| `StlProvider` | `(heightUnits, maxSubdiv) => StlExport | null` | Printed tile STL payload. |
| `CircuitProvider` | `() => CircuitStl | null` | Separate circuit STL payload. |

Providers are called when the modal opens or when a download is requested. Do
not precompute and cache payloads in the controller; the modal must reflect the
current viewer model, sim detail, tile gap, and circuit placement.

## Source Selection

The controller wires every export through the same policy:

```text
viewerShown first, otherwise loaded fold model
```

This keeps the app invariant simple:

```text
what the viewer shows is what sim/export uses
```

The exception is circuit export: the circuit geometry comes from the live
`SimModal`/`SimCanvas` circuit state, while the filename base still comes from
`viewerShown` or the loaded fold model.

## Open Flow

```text
Export button click
  -> ExportModal.open()
  -> SVG provider builds previews/payload, if possible
  -> STL provider is probed with null inputs for default height/detail
  -> Circuit provider is probed for enablement
  -> modal renders status and enables only available downloads
```

`null` height/detail means "use the builder default". The controller passes the
current sim detail and sim tile gap into `resolveStlExport`, so the STL defaults
match the 3D Sim printed-tile view.

## Download Flow

| Button | Output | Notes |
| --- | --- | --- |
| `Cut + score (zip)` | Two registered SVG files in a ZIP. | Preferred cutter workflow: assign black to cut and blue to score. |
| `Single SVG` | One color-coded SVG. | Convenience workflow for inspection or single import. |
| `Tiles (STL)` | One ASCII STL for separated printed tiles. | Uses tile height and adaptive-detail controls. |
| `Circuit (STL)` | One ASCII STL for traces and parts. | Separate from tiles; requires circuit placement in the sim. |

Downloads create object URLs at click time and revoke them immediately after the
synthetic anchor click. The modal should not keep Blob URLs around.

## Enablement Rules

- The top-level Export trigger is enabled when there is a displayed fold
  pattern (`viewerShown`) or a loaded fold model.
- SVG buttons are enabled only when `buildFkldSvgExport` returns a payload.
- STL tile button is enabled when `resolveStlExport` can build an STL.
- Circuit STL button is enabled when `SimModal.getCircuitStl(...)` returns a
  payload.

This is intentionally more permissive than simulation enablement: a pattern may
be exportable even when it is not currently simulatable.

## Failure Modes

| Symptom | Likely cause | Check |
| --- | --- | --- |
| Export button disabled | No fold pattern in state/viewer. | `AppController.render`, `viewerShown`, loaded model kind. |
| SVG buttons disabled, STL enabled | Current fold has no SVG-exportable cut/score geometry. | `buildFkldSvgExport` return value. |
| STL defaults do not match sim | Sim detail/gap was not mirrored into store. | `onDetailChange`, `onGapChange`, `resolveStlExport` args. |
| Circuit button disabled | No saved/live circuit or no sim geometry for export. | `SimModal.getCircuitStl`, `CircuitProvider`. |
| Download has stale contents | Provider result cached too early. | Ensure payload is pulled on open/click. |

## Tests

Use view tests for DOM behavior and service/model tests for payload content:

- `tests/current/view/export-modal.test.ts`
- `tests/current/services/svg-export-service.test.ts`
- `tests/current/services/stl-export-service.test.ts`
- `tests/current/model/fkld-svg-export.test.ts`
- `tests/current/model/stl-export.test.ts`
- `tests/current/model/circuit.test.ts`

