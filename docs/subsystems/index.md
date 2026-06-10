# Subsystem Docs

Subsystem docs are narrower than the architecture docs. Each page describes a
single working area: files, data flow, extension points, and failure modes.

| Subsystem | Doc | Covers |
| --- | --- | --- |
| Core | `core.md` | Dependency-free errors and vector primitives. |
| Services | `services.md` | Use-case facades between controller and domain modules. |
| App shell/controller | `app-shell.md` | MVC orchestration, intents, app state, controller failure handling. |
| App state | `app-state.md` | Store shape, mutation rules, render derivation. |
| UI components | `ui-components.md` | View contracts, callback/render methods, component test expectations. |
| Viewer bridge | `viewer-bridge.md` | iframe `postMessage` contract and current-viewer model tracking. |
| Metadata/presenters | `metadata-presenters.md` | Derived facts and FKLD metadata presenters. |
| Creation pipeline | `creation-pipeline.md` | Transferred AKDE pyramid generation path. |
| General pipeline | `../pipeline.md` | Mesh-to-FKLD conversion stages M1-M5. |
| Pipeline stage contracts | `pipeline-stage-contracts.md` | Input/output/throw contract for each pipeline stage. |
| Simulation | `../simulation.md` | Bar-and-hinge solver and guided/free simulation modes. |
| CPU simulation | `simulation-cpu.md` | Reference solver, model arrays, stabilization, debugging. |
| GPU simulation | `simulation-gpu.md` | Texture packing, shaders, readback, CPU parity. |
| FKLD validation | `fkld-validation.md` | Extension keys, validators, emission checks. |
| SVG export | `svg-export.md` | Cut/score layer export, ZIP payloads, export modal. |
| Static assets/examples | `static-assets-and-examples.md` | `public/`, samples, viewer asset source of truth. |
| Test suite | `test-suite.md` | Test folders, patterns, architecture checks. |

Use this directory when changing one subsystem and you need local rules without
reading the full architecture document.
