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

/** Render flavour for the 3D body marker drawn on top of a footprint's copper pads. */
export type ComponentMarker = "led-dome" | "resistor" | "switch-slide" | "coin-cell";

/**
 * A proper 2-terminal SMD footprint, modelled 1:1 on the **fab.pretty** KiCad library (the Fab
 * Inventory parts — `~/Desktop/kicad-master/footprints/fab.pretty`). Every length is a fraction of
 * the model's bbox diagonal so parts read at any pattern scale; the comment on each entry gives the
 * source footprint and its real millimetre dimensions. The two copper pads sit on the local x axis
 * at ±`padPitch`/2 — exactly the pad centres of the source footprint — with the body bridging them.
 */
export interface ComponentSpec {
  label: string;
  /** Source footprint file in fab.pretty this is modelled on. */
  footprint: string;
  /** Component body length along the pad-to-pad (local x) axis — bbox-diagonal fraction. */
  bodyLen: number;
  /** Component body width (local y) — bbox-diagonal fraction. */
  bodyWid: number;
  /** Each copper pad's length (local x) — bbox-diagonal fraction. */
  padLen: number;
  /** Each copper pad's width (local y) — bbox-diagonal fraction. */
  padWid: number;
  /** Pad centre-to-centre pitch along x — bbox-diagonal fraction (pads at ±pitch/2). */
  padPitch: number;
  /** Number of pads (always 2 here: a 2-terminal SMD). */
  pads: 2;
  /** Render flavour for the body marker. */
  marker: ComponentMarker;
  /** Body colour (three.js hex) for the sim overlay. */
  color: number;
}

// All sizes below = (real fab.pretty millimetres) × K_MM, the diagonal-fraction-per-mm scale that
// keeps a 1206 chip near its previous on-screen size. Proportions within a footprint (pad size,
// gap, pitch) are kept exactly as the source so the parts read as the real SMD packages.
const K_MM = 0.011; // chips / switch
const K_COIN = 0.0045; // coin-cell holder is physically huge — scale it down on its own

export const COMPONENT_SPECS: Record<ComponentKind, ComponentSpec> = {
  // LED_1206.kicad_mod — pads 1.4×1.7 mm @ pitch 3.4 mm; body 3.2×1.6 mm.
  led: {
    label: "LED", footprint: "LED_1206", marker: "led-dome", color: 0xff3b30, pads: 2,
    bodyLen: 3.2 * K_MM, bodyWid: 1.6 * K_MM,
    padLen: 1.4 * K_MM, padWid: 1.7 * K_MM, padPitch: 3.4 * K_MM,
  },
  // R_1206.kicad_mod — pads 1.2×1.6 mm @ pitch 3.0 mm; body 3.2×1.6 mm.
  resistor: {
    label: "Resistor", footprint: "R_1206", marker: "resistor", color: 0x222426, pads: 2,
    bodyLen: 3.2 * K_MM, bodyWid: 1.6 * K_MM,
    padLen: 1.2 * K_MM, padWid: 1.6 * K_MM, padPitch: 3.0 * K_MM,
  },
  // Switch_Slide_Top_CnK_JS102011JCQN_8.5x3.5mm — body 8.5×3.5 mm; throw pads Ø1.0 @ ±2.5 mm.
  switch: {
    label: "Switch", footprint: "Switch_Slide_Top_CnK_JS102011JCQN_8.5x3.5mm", marker: "switch-slide",
    color: 0x2b2f36, pads: 2,
    bodyLen: 8.5 * K_MM, bodyWid: 3.5 * K_MM,
    padLen: 1.2 * K_MM, padWid: 1.2 * K_MM, padPitch: 5.0 * K_MM,
  },
  // Battery-Holder_Coin-Cell_CR2032_Linx_BAT-HLD-001 — CR2032 Ø20 mm; + clip ↔ − centre contact.
  battery: {
    label: "Battery", footprint: "Battery-Holder_Coin-Cell_CR2032_Linx_BAT-HLD-001", marker: "coin-cell",
    color: 0xbfc4cc, pads: 2,
    bodyLen: 20 * K_COIN, bodyWid: 20 * K_COIN,
    padLen: 2.5 * K_COIN, padWid: 6 * K_COIN, padPitch: 13 * K_COIN,
  },
};

export const COMPONENT_KINDS: ComponentKind[] = ["led", "switch", "resistor", "battery"];
