# Subsystem Docs

Subsystem docs are narrower than the architecture docs. Each page describes a
single working area: files, data flow, extension points, and failure modes.

| Subsystem | Doc | Covers |
| --- | --- | --- |
| App shell/controller | `app-shell.md` | MVC orchestration, intents, app state, controller failure handling. |
| Viewer bridge | `viewer-bridge.md` | iframe `postMessage` contract and current-viewer model tracking. |
| Metadata/presenters | `metadata-presenters.md` | Derived facts and FKLD metadata presenters. |
| Creation pipeline | `creation-pipeline.md` | Transferred AKDE pyramid generation path. |
| General pipeline | `../pipeline.md` | Mesh-to-FKLD conversion stages M1-M5. |
| Simulation | `../simulation.md` | Bar-and-hinge solver and guided/free simulation modes. |
| FKLD validation | `fkld-validation.md` | Extension keys, validators, emission checks. |
| Static assets/examples | `static-assets-and-examples.md` | `public/`, samples, viewer asset source of truth. |

Use this directory when changing one subsystem and you need local rules without
reading the full architecture document.

