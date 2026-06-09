# Kirigamize Pipeline

`src/pipeline/` is the general mesh-to-kirigami conversion scaffold. It is
separate from the app MVC shell and from the origami simulator. The controller
will eventually call this pipeline for `.obj` and `.stl` inputs; the current app
still treats mesh conversion as a stub.

## Scope

Pipeline code is a pure TypeScript functional core:

- No DOM access.
- No file picker or `FileReader` access.
- No Three.js rendering.
- No app store mutation.
- No Vite/browser assumptions.

Inputs and outputs are plain DTOs from `src/pipeline/types.ts`.

## Stage Map

| Stage | File | Purpose |
| --- | --- | --- |
| M1 import | `src/pipeline/import.ts` | Parse OBJ or ASCII STL text into `TriMesh`. |
| M1 conditioning | `src/pipeline/conditioning.ts` | Weld coincident vertices, drop degenerates, orient faces, reject unsupported genus. |
| M1 topology | `src/pipeline/mesh.ts` | Build edges, one-ring fans, boundary sets, Euler/boundary helpers. |
| M2 curvature | `src/pipeline/curvature.ts` | Compute angle defects and signed dihedral targets. |
| M2 cut planning | `src/pipeline/plan-cuts.ts` | Choose cut terminals/routes using greedy graph algorithms and wedge rules. |
| M3-M5 future | DTOs in `src/pipeline/types.ts` | Unfolding, seam routing, emission, and verification contracts. |

## DTO Contracts

The main cross-stage DTOs are:

- `TriMesh`: target triangle mesh in millimetres.
- `MeshTopology`: derived adjacency and boundary information.
- `DefectReport`: per-vertex angle defects and curvature classes.
- `CutPlan`: cut edge ids, per-vertex actions, and cost.
- `UnfoldResult`: future flattened patches.
- `Sheet`: future packed flat pattern with assignments/cut types.
- `VerifyReport`: future simulator verification result.

All lengths are millimetres. All angles are radians except at FOLD/FKLD emission
boundaries where `edges_foldAngle` is stored in degrees.

## Import Rules

OBJ support:

- Reads `v x y z` vertices.
- Reads `f` polygon faces.
- Accepts `v/vt/vn` face tokens.
- Accepts negative relative OBJ indices.
- Fan-triangulates n-gons.

STL support:

- ASCII STL only.
- Binary STL is rejected with a `PipelineError`.
- STL imports as triangle soup and must be conditioned/welded afterward.

## Conditioning Rules

`condition(mesh)` runs:

1. `weldVertices`: quantized vertex welding.
2. `dropDegenerates`: removes zero-area faces and unused vertices.
3. `orientFaces`: BFS face-winding consistency pass.

`assertGenusZero(mesh, topo)` enforces v1 scope. Handles are rejected because
handle-loop cutting is deferred.

## Curvature Rules

Angle defect:

```text
delta(v) = 2*pi - sum(interior angles around v)
```

Boundary vertices report zero defect and class `boundary`, because boundary
defect sign is not meaningful for the planner.

Signed dihedral targets use:

```text
theta = atan2((n1 x ehat) dot n2, n1 dot n2)
```

The pipeline currently documents the AKDE solver convention in
`curvature.ts`: mountain-positive at the target-mesh stage. The simulation
adapter converts FOLD/FKLD conventions at the boundary. Keep this distinction
explicit when wiring pipeline output into FKLD emission.

## Cut Planning Rules

`planCuts(mesh, topo, defects, opts)` follows three steps:

1. Necessity: non-flat curvature vertices become cut terminals unless tucked.
2. Connection: terminals are connected by shortest paths on the mesh graph,
   approximating the Steiner-tree problem with an MST over the metric closure.
3. Wedge rule: negative curvature vertices need enough separators so every
   wedge angle is below `2*pi`.

The cut set is pruned to a forest so genus-0 surfaces stay disk-like after
cutting.

## Error Handling

Pipeline stages throw `PipelineError`, not bare `Error`, so UI/controller code
can report:

```text
<stage>: <message>
```

Known stages are listed in `PipelineError["stage"]`. Add a new stage value
before adding a new stage file.

## Implementation Rules

- Rebuild topology after any stage that changes mesh connectivity.
- Do not mutate input DTOs unless a function documents that it does.
- Keep algorithm constants near the stage that owns them.
- Preserve provenance fields such as `origVertex`; later guided simulation and
  verification depend on source-target vertex mapping.
- Add tests for each stage before wiring it into the controller.

