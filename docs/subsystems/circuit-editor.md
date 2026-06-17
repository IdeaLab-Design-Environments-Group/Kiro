# Subsystem: Circuit Editor and Circuit STL Export

The circuit subsystem lets users place simple SMD parts on kirigami tiles in the
3D Sim, route traces through cloth gaps, save the circuit onto app state, and
export a separate circuit STL.

## Purpose

The circuit editor is a fabrication overlay for printed kirigami builds. Parts
are pinned to faces by barycentric coordinates so they ride the fold with the
tile. Traces are routed through exposed membrane/gap paths instead of jumping
over hinges.

The conductor layer is exported separately from the tile STL. This lets a user
print or fabricate the mechanical kirigami first, then print/deposit conductive
ribs and SMD footprints in the same flat coordinate system.

## Files

| File | Role |
| --- | --- |
| `src/model/circuit.ts` | Pure circuit DTOs, component kinds, and fab.pretty-inspired footprint specs. |
| `src/model/circuit-geometry.ts` | Resolves parts, pads, traces, crossed edges, and folded/flat positions. |
| `src/model/circuit-export.ts` | Builds the separate ASCII STL for traces, pads, and component bodies. |
| `src/model/app-store.ts` | Stores the saved `Circuit` and tile subdivision setting. |
| `src/view/sim-modal.ts` | Circuit tab, palette, save/download shortcuts, and circuit STL export. |
| `src/view/sim-canvas.ts` | Flat 2D circuit authoring mode, picking, placement, routing, and overlay rendering. |
| `src/model/tile-subdiv.ts` | Shared tile inset/subdivision constants used by sim rendering and STL export. |
| `src/model/stl-export.ts` | Tile STL export path that aligns with circuit export coordinates. |

## User Flow

```text
Open 3D Sim
  -> Circuit tab
  -> modal switches to printed-tile material
  -> canvas enters flat orthographic authoring view
  -> choose part or wire tool
  -> place components on faces / route pad-to-pad traces
  -> Cmd/Ctrl+T saves circuit to AppStore
  -> export circuit STL from the modal
```

## Data Model

`PlacedComponent` stores:

- `kind`: `led`, `switch`, `resistor`, or `battery`;
- `face`: face index in the simulated mesh;
- `bary`: barycentric coordinates within that face;
- `rot`: in-plane part rotation.

`Trace` stores two pad references. Geometry is resolved later against either
flat coordinates or folded coordinates, so the saved circuit is independent of
the current fold slider.

## Footprints

`COMPONENT_SPECS` models two-terminal SMD footprints based on fab.pretty
dimensions:

- `LED_1206`
- `R_1206`
- `Switch_Slide_Top_CnK_JS102011JCQN_8.5x3.5mm`
- `Battery-Holder_Coin-Cell_CR2032_Linx_BAT-HLD-001`

Sizes are stored as fractions of the model bounding-box diagonal. This keeps
parts visible across small and large patterns while preserving each footprint's
internal proportions.

## Routing and Export Contract

- Circuit rendering can use folded coordinates for the live overlay.
- Circuit STL export uses the flat XY pattern coordinates.
- Traces become low rectangular ribs.
- Pads and component bodies become flat extruded boxes.
- Export returns `null` for an empty circuit.
- `buildCircuitStl` does not modify the tile STL.

## Failure Modes

| Failure | Cause | Fix |
| --- | --- | --- |
| Cannot pick parts/pads | Circuit mode is off or geometry cache is stale. | Re-enter Circuit tab or rebuild the scene. |
| Export is empty | No saved components/traces. | Place parts and save with Cmd/Ctrl+T. |
| Circuit misaligns with tiles | Export used a different scene/model than the tile STL. | Use the same viewer-shown model and export both from the same sim session. |
| Trace crosses a hinge visually | Route path crossed an edge classified as unavailable. | Check `resolveCircuit` crossed-edge output and bridge suppression. |
