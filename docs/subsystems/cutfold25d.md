# Subsystem: 2.5D Cut-and-Fold Signage

The 2.5D subsystem generates orthogonal cut-and-fold relief signs from pixel
height maps. It is implemented in `src/pipeline/cutfold25d.ts` and exposed to
the app through `src/services/pattern-service.ts`.

## Purpose

This path is separate from the general M1-M5 mesh pipeline. It implements the
parallel-cut universality construction from Demaine, Demaine, Devadoss, Myers,
and Parra Rubio, "2.5D Signage from Sheet Material with Orthogonal Cuts and
Folds" (ASME IDETC/CIE 2023).

Input is a pixelated height field, usually `{0,1}` text or art. Output is a
single FOLD/FKLD crease pattern with:

- vertical parallel cuts between image columns;
- a reserved top connector row that keeps the sheet connected;
- per-column 90 degree mountain/valley crease pairs for each height change;
- a `foldedForm` frame and `fkld:vertices_driven` flags for guided simulation.

## Files

| File | Role |
| --- | --- |
| `src/pipeline/cutfold25d.ts` | Pure height-map to `PatternGrid` algorithm, built-in Space Invader, and 3x5 text font. |
| `src/services/pattern-service.ts` | `create25dSign` facade; converts the generated grid to FKLD and stamps metadata. |
| `src/model/pattern-grid.ts` | Paintable lattice that the 2.5D algorithm writes into. |
| `src/view/header-actions.ts` | Owns the `Create 2.5D` intent. |
| `tests/current/cutfold25d.test.ts` | Unit coverage for bitmap parsing, column variation, crease placement, text, and generated FKLD behavior. |

## Data Flow

```text
HeaderActions.onCreate25d
  -> AppController prompts for text
  -> pattern-service.create25dSign(text?)
  -> cutfold25d.build25dPattern(bitmap)
  -> patternDraftToFkld(...)
  -> AppStore model update + ViewerFrame.show(...)
```

Blank text falls back to the bundled Space Invader art. Non-empty text is
rendered with the built-in 3x5 pixel font.

## Geometry Contract

The generated sheet has:

- `cols = X`, the pixel width;
- `rows = eps + R + V`, where `R` is image height and `V` is maximum column
  total variation;
- `CONNECTOR_EPS = 1`, the preserved top connector band;
- cell size defaulting to 12 mm.

Every height transition `delta` emits two creases separated by `abs(delta)` grid
units:

```text
delta > 0: valley, then mountain
delta < 0: mountain, then valley
```

The generated folded-form frame maps each grid vertex to the intended 3D
staircase relief. The frame is required because the symmetric strip of parallel
90 degree creases can remain flat under free folding.

## Limits

- The current `PatternGrid` path rejects generated patterns above 40 x 40 grid
  units.
- Heights parse from `#`, `X`, `x`, `*`, or digits `1..9`; everything else is
  background height 0.
- The construction is orthogonal and pixelated. It is not a substitute for the
  general smooth mesh kirigamizer pipeline.

## Extension Points

- Add glyphs or improve letterforms in `FONT_3X5`.
- Add named bitmap presets beside `SPACE_INVADER`.
- If larger signs are needed, raise the `PatternGrid` limit only after checking
  viewer, SVG, and sim performance.
- Keep generated fold angles at +/-90 degrees. Do not use the default FOLD
  mountain/valley +/-180 convention for this path.
