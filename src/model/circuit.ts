/**
 * Circuit data model — simple SMD parts placed on a kirigami's tiles plus the traces wiring them.
 *
 * A component is pinned to a face by barycentric coords, so it rides the fold exactly like the tiles
 * (`circuit-geometry.ts` resolves it into flat or folded geometry). Sizes are fractions of the model
 * bbox so parts stay sensible at any pattern scale. This module is pure data + specs — no geometry,
 * no DOM — and is consumed by the sim overlay (`sim-canvas.ts`) and the separate STL export
 * (`circuit-export.ts`).
 */

export type ComponentKind = "led" | "switch" | "resistor" | "battery";

/** A part placed on the mesh: pinned to a face, oriented in the tile plane, riding the fold. */
export interface PlacedComponent {
  id: string;
  kind: ComponentKind;
  /** Index into `net.faces` the part sits on. */
  face: number;
  /** Barycentric position within that face (follows the fold). */
  bary: [number, number, number];
  /** In-plane orientation (radians) of the part's long (pad-to-pad) axis. */
  rot: number;
}

/** A pad terminal of a placed component (`pad` 0 = +, 1 = −). */
export interface PadRef {
  comp: string;
  pad: number;
}

/** A routed connection between two pads (a net segment). */
export interface Trace {
  id: string;
  from: PadRef;
  to: PadRef;
}

export interface Circuit {
  components: PlacedComponent[];
  traces: Trace[];
}

export const EMPTY_CIRCUIT: Circuit = { components: [], traces: [] };

/** Footprint + look of each part. Lengths/widths are fractions of the model's bbox diagonal. */
export interface ComponentSpec {
  label: string;
  /** Body length along the pad-to-pad (local x) axis, as a fraction of the bbox diagonal. */
  len: number;
  /** Body width (local y), bbox-diagonal fraction. */
  wid: number;
  /** Number of pads (always 2 here: a 2-terminal SMD). */
  pads: 2;
  /** Body colour (three.js hex) for the sim overlay. */
  color: number;
}

export const COMPONENT_SPECS: Record<ComponentKind, ComponentSpec> = {
  led: { label: "LED", len: 0.04, wid: 0.022, pads: 2, color: 0xff3b30 },
  switch: { label: "Switch", len: 0.05, wid: 0.034, pads: 2, color: 0x2b2f36 },
  resistor: { label: "Resistor", len: 0.034, wid: 0.016, pads: 2, color: 0xc9a36a },
  battery: { label: "Battery", len: 0.07, wid: 0.06, pads: 2, color: 0xbfc4cc },
};

export const COMPONENT_KINDS: ComponentKind[] = ["led", "switch", "resistor", "battery"];
