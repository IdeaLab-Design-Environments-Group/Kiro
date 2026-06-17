# Subsystem: Printed Tile STL Export

Printed tile STL export turns the currently displayed FOLD/FKLD flat pattern
into a separated set of extruded triangular tiles. It is the mechanical
counterpart to SVG cut/score export.

## Purpose

The export path produces an ASCII STL for 3D-printing rigid tile islands on a
flat pattern. Faces that participate in sharper folds are adaptively subdivided
into more, smaller tiles; flatter areas stay coarse. Each tile is inset toward
its centroid so exposed membrane/gap space remains between tiles.

The same subdivision and inset constants are shared with the 3D Sim printed
render, so the rule is:

```text
what you see as printed tiles is what you export as STL
```

## Files

| File | Role |
| --- | --- |
| `src/model/stl-export.ts` | Pure FOLD/FKLD to ASCII-STL tile export. |
| `src/model/tile-subdiv.ts` | Shared adaptive subdivision and tile-gap constants. |
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

## Adaptive Subdivision

`buildStlExport` computes a fold score per face from:

1. `fkld:edges_dihedralTarget`, if present and nonzero;
2. otherwise, dihedrals measured from a `foldedForm` frame;
3. otherwise, zero for flat/no-goal models.

The largest fold in the model normalizes all face scores. The chosen detail
level caps recursive midpoint subdivision. `DETAIL_OFFSET` means UI level 0
still maps to a useful base subdivision cap.

## Geometry Contract

- Input coordinates are flat `vertices_coords`; z is read if present but the
  normal case is z = 0.
- N-gon faces fan-triangulate.
- Every sub-triangle is inset by `TILE_INSET_FRAC` or the caller-provided gap.
- Every tile becomes a closed triangular prism.
- The export is ASCII STL.
- Returns `null` when the fold has no faces or no coordinates.

## Controls

| Control | Meaning |
| --- | --- |
| Tile height | Extrusion height in model units. Null or <= 0 uses a bbox-relative default. |
| Detail | Maximum adaptive subdivision level. |
| Gap/inset | Shrink-toward-centroid fraction shared with printed sim rendering. |

## Failure Modes

| Failure | Cause | Fix |
| --- | --- | --- |
| STL export disabled | No viewer-shown or loaded fold model. | Load/show a FOLD/FKLD pattern first. |
| Export returns null | Pattern lacks faces or vertices. | Validate the source FKLD/FOLD. |
| Printed output too coarse | Detail cap too low or no fold targets/folded frame. | Increase detail or emit fold targets/foldedForm. |
| Export does not match sim | Sim and export used different detail/gap settings. | Use shared sim detail and export from the same displayed model. |
