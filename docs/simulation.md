# Simulation

The simulation subsystem implements the explicit bar-and-hinge origami model
from Ghassaei, Demaine, and Gershenfeld, with kirigami-specific scene builders.
It is intentionally split from the Three.js view.

## Core Model

`src/sim/model.ts` builds a struct-of-arrays `BarHingeModel`:

- Nodes: position, rest position, velocity, force, mass, fixed/driven flags.
- Beams: axial springs on mesh edges.
- Creases: torsional springs on foldable interior edges.
- Faces: interior-angle springs to resist shearing.

The paper convention is:

- Mountain targets are negative fold angles.
- Valley targets are positive fold angles.
- Crease stiffness is proportional to nominal edge length.
- Axial stiffness uses `EA / l0`.

`src/sim/forces.ts` computes the solver passes:

1. Face normals.
2. Signed fold angles.
3. Axial, crease, face, and damping forces.
4. Explicit Euler integration.

`src/sim/solver.ts` is the CPU reference solver. `src/sim/gpu/` packs the same
model into textures and runs an equivalent Three.js `GPUComputationRenderer`
path where available.

## Scene Builders

There are two ways to build a simulation scene:

| Mode | Entry | Behavior |
| --- | --- | --- |
| Guided | `buildFoldScene(computeState(inputs))` | Rebuilds an AKDE pyramid and drives boundary nodes to a goal mesh. |
| Free | `buildSceneFromFold(fold)` | Uses FOLD/FKLD topology and crease targets directly. |

`src/sim/scene.ts` chooses the mode:

- If an FKLD frame title encodes pyramid inputs (`N`, `L`, `H`, `T`), it uses
  guided mode.
- Otherwise, if the object has vertices, faces, and edges, it uses free mode.

## Rendering Boundary

`src/view/sim-canvas.ts` owns rendering and animation policy:

- It renders faces and colored crease/cut lines with Three.js.
- It picks GPU for guided scenes when available.
- It falls back to CPU when GPU support is unavailable.
- It uses extra damping/freeze behavior for unguided free folds, because a free
  explicit mesh can drift and ring.

The simulation domain does not import Three.js or DOM APIs except inside
`src/sim/gpu/*`, which is GPU solver infrastructure rather than UI.

## Practical Debugging

When a fold goes the wrong direction:

1. Check `edges_assignment`: `M` should produce negative target theta, `V`
   positive target theta.
2. Check `edges_foldAngle`: FOLD stores degrees; `fold-adapter.ts` converts to
   radians.
3. Check crease orientation: `model.ts` orients the shared edge from face1's
   winding so signed theta is stable.
4. Use a two-triangle hinge case before debugging a full pattern.

When a fold jitters:

1. Confirm cut edges are not being converted into crease hinges.
2. Confirm the timestep comes from `computeDt`.
3. Lower stiffness or add damping only after checking topology.
4. For free FOLD patterns, expect more damping than guided AKDE pyramids.

