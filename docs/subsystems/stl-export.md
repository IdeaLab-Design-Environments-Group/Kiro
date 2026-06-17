# Subsystem: Printed Tile STL Export

Printed tile STL export turns the currently displayed FOLD/FKLD flat pattern
into the **foldable printed joinery**: rigid tiles you fold up from flat
(rotating units). It is the mechanical counterpart to SVG cut/score export.

## Purpose

The export path produces an ASCII STL for 3D-printing the flat pattern as rigid
tiles joined by thin living hinges. Each triangular face becomes a rigid tile,
**inset** (scaled about its incentre by the gap) so there is a gap around every
tile; a thin **living-hinge bridge** spans every shared fold/facet edge so the
tiles rotate about it, and `C` cuts stay open. Print flat, fold up to the 3D
shape. Tiles and hinges are individually closed solids (they overlap at the hinge
welds, which the slicer unions).

The joinery geometry lives in `src/model/printed-joinery.ts` and is shared with
the 3D Sim printed render and the house/door generator, so the rule holds:

```text
what you see as printed tiles is what you export as STL
```

## Files

| File | Role |
| --- | --- |
| `src/model/stl-export.ts` | Pure FOLD/FKLD to ASCII-STL tile export. |
| `src/model/printed-joinery.ts` | Connected-joinery tile geometry, shared with the sim render + generator. |
| `src/model/tile-subdiv.ts` | Shared tile-gap constant (`TILE_INSET_FRAC`); subdivision unused by the export. |
| `src/model/stl-ascii.ts` | Shared low-level ASCII-STL box/triangle helpers. |
| `src/services/stl-export-service.ts` | Resolves the export target. |
| `src/view/export-modal.ts` | Tile-height/detail controls and STL download UI. |
| `src/view/sim-modal.ts` | Owns the live printed-tile detail state. |
| `src/view/sim-canvas.ts` | Uses the same tile subdivision/inset values for rendering. |

## Export Policy

STL export targets:

```text
viewerShown first, otherwise loaded fold model
```

This matches 3D Sim and SVG export: export the pattern currently shown in the
viewer when it differs from the file sitting in the convert panel.

## Edge Classification

`buildStlExport` reads `edges_assignment` and counts how many faces share each
edge, then classifies every face edge (`edgeRole` in `printed-joinery.ts`):

1. assignment `C` → **cut** (gap stays open — no hinge);
2. else shared by one face → **boundary** (free outer edge, incl. `B` — no hinge);
3. else (`M`/`V`/`F`, shared by two faces) → **merge** (bridged by a thin hinge).

There is no adaptive subdivision; the `Detail` control is inert (the export
reports `maxSubdiv = 0`).

## Geometry Contract

- Input coordinates are flat `vertices_coords`; z is read if present but the
  normal case is z = 0, extruded +height.
- N-gon faces fan-triangulate; the inner fan edges are interior → `merge`.
- Each face becomes a rigid tile inset (scaled about its incentre by `1 − gap`).
- A thin living-hinge bridge spans every `merge` edge (`hingeThickness`,
  `hingeSpan`, `hingeOverlap` in `stl-export.ts`); `cut`/`boundary` get none.
- The export is ASCII STL; tiles + hinges are individually closed solids that
  overlap at the hinge welds (the slicer unions them).
- Returns `null` when the fold has no faces or no coordinates.

## Controls

| Control | Meaning |
| --- | --- |
| Tile height | Extrusion height in model units. Null or <= 0 uses a bbox-relative default. |
| Detail | Inert for the connected joinery (no subdivision); kept for API compatibility. |
| Gap/inset | Tile inset / hinge-gap (tiles scale about their incentre by `1 − gap`), shared with the printed sim. |

## Failure Modes

| Failure | Cause | Fix |
| --- | --- | --- |
| STL export disabled | No viewer-shown or loaded fold model. | Load/show a FOLD/FKLD pattern first. |
| Export returns null | Pattern lacks faces or vertices. | Validate the source FKLD/FOLD. |
| Cuts do not open / no gaps | Source FKLD has no `C` edges (or missing `edges_assignment`). | Kirigamize so cut edges are assigned `C`. |
| Export does not match sim | Sim and export used a different Gap. | Use the same Gap slider value; both read `simTileGap`. |
