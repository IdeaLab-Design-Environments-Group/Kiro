/**
 * **View** — the "Electronics" trigger + modal: a 2D flat-pattern interface for
 * laying out LEDs and auto-routing their copper-tape traces.
 *
 * The user clicks a gap to drop an LED bridging two tiles (or a tile to place the battery).
 * There are only two nets — PWR and GND. The modal is a *dumb* view: it renders the flat pattern +
 * the {@link RoutedCircuit} it is handed (copper drawn as filled tape rectangles), and emits the
 * authored {@link Circuit} via `onEdit`. Route planning happens in the service/controller (the view
 * never calls the router) — the controller plans and pushes the result back via
 * {@link ElectronicsModal.setPreview}, keeping the single-render path.
 *
 * All geometry is the flat pattern's 2D mm coords (the SVG export frame), so the
 * on-screen routes match the exported copper layer exactly.
 */
import {
  type Circuit,
  type FlatFace,
  type GapEdge,
  type RoutedCircuit,
  TAPE_W,
  type TilePoly,
  type Vec2,
  flatFaces,
  flatPoints,
  gapForLed,
  gapGraph,
  ledOf,
  nearestGap,
  pointInFace,
  tapeQuads,
  tilePolys,
} from "../model/electronics.js";
import type { FoldFile } from "../model/fold-file.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const MARGIN = 8; // mm — must match the SVG export so preview ↔ export register

type Tool = "led" | "battery";

export class ElectronicsModal {
  private readonly overlay: HTMLElement;
  private readonly trigger: HTMLButtonElement;
  private readonly svg: SVGSVGElement;
  private readonly statusEl: HTMLElement;
  private readonly toolButtons = new Map<Tool, HTMLButtonElement>();

  private tool: Tool = "led";
  private fold: FoldFile | null = null;
  private faces: FlatFace[] = [];
  private tiles: TilePoly[] = [];
  private gaps: GapEdge[] = [];
  private points: Vec2[] = [];
  private bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private circuit: Circuit = { leds: [], battery: null };
  private routed: RoutedCircuit | null = null;

  private editHandler: (circuit: Circuit) => void = () => {};

  constructor() {
    this.trigger = document.createElement("button");
    this.trigger.type = "button";
    this.trigger.className = "sim-trigger";
    this.trigger.textContent = "Electronics";
    this.trigger.disabled = true;
    this.trigger.addEventListener("click", () => this.open());

    this.overlay = document.createElement("div");
    this.overlay.className = "sim-overlay";
    this.overlay.hidden = true;
    this.overlay.innerHTML = `
      <div class="sim-modal el-modal" role="dialog" aria-modal="true" aria-label="LED electronics editor">
        <header class="sim-modal-header">
          <span class="sim-modal-title">Electronics — flat printed pattern; click a gap to bridge it with an LED</span>
          <button type="button" class="sim-modal-close" aria-label="Close">×</button>
        </header>
        <div class="sim-modal-body el-body">
          <div class="el-toolbar">
            <span class="el-group">
              <span class="el-label">Place</span>
              <button type="button" class="el-tool" data-tool="led" title="LED (click a gap between two tiles)">LED</button>
              <button type="button" class="el-tool" data-tool="battery" title="Battery (click a tile)">Battery</button>
            </span>
            <span class="el-group">
              <button type="button" class="el-clear">Clear</button>
            </span>
          </div>
          <div class="el-canvas-wrap">
            <svg class="el-svg" xmlns="${SVG_NS}" aria-label="Electronics flat-pattern canvas"></svg>
          </div>
          <p class="el-legend">
            <span class="el-key el-key-led">● LED (legs on two tiles)</span>
            <span class="el-key el-key-batt">▮ battery</span>
            <span class="el-key el-key-pwr">▬ PWR tape</span>
            <span class="el-key el-key-gnd">▬ GND tape</span>
            &nbsp;· gray = printed tiles, light = cloth backing; tape crosses freely (insulated back)
          </p>
        </div>
        <footer class="sim-modal-footer">
          <span class="sim-status el-status"></span>
          <span class="el-hint">Export the copper layer from <strong>Export SVG</strong>.</span>
        </footer>
      </div>
    `;
    document.body.appendChild(this.overlay);

    this.svg = this.overlay.querySelector(".el-svg")!;
    this.statusEl = this.overlay.querySelector(".el-status")!;

    for (const btn of this.overlay.querySelectorAll<HTMLButtonElement>(".el-tool")) {
      const tool = btn.dataset.tool as Tool;
      btn.addEventListener("click", () => this.selectTool(tool));
      this.toolButtons.set(tool, btn);
    }
    this.overlay.querySelector(".el-clear")!.addEventListener("click", () => this.clear());
    this.overlay.querySelector(".sim-modal-close")!.addEventListener("click", () => this.close());
    this.overlay.addEventListener("click", (e) => {
      if (e.target === this.overlay) this.close();
    });
    this.svg.addEventListener("click", (e) => this.onCanvasClick(e));
    document.addEventListener("keydown", (e) => {
      if (this.overlay.hidden) return;
      if (e.key === "Escape") this.close();
    });
  }

  // ---- public lifecycle (mirrors SimModal / ExportModal) -------------------

  mountTrigger(container: HTMLElement): void {
    container.appendChild(this.trigger);
  }

  setEnabled(enabled: boolean): void {
    this.trigger.disabled = !enabled;
  }

  /** Register the handler invoked whenever the authored circuit changes. */
  onEdit(handler: (circuit: Circuit) => void): void {
    this.editHandler = handler;
  }

  /** Provide the current flat pattern to lay electronics on (clears the circuit if it changed). */
  setPattern(fold: FoldFile | null): void {
    if (fold === this.fold) return;
    this.fold = fold;
    this.faces = fold ? flatFaces(fold) : [];
    this.tiles = fold ? tilePolys(fold, this.faces) : [];
    this.gaps = fold ? gapGraph(fold, this.faces).gaps : [];
    this.points = fold ? flatPoints(fold) : [];
    this.circuit = { leds: [], battery: null };
    this.routed = null;
    this.computeBounds();
    if (!this.overlay.hidden) this.render();
  }

  /** Receive the planned routes from the controller and redraw. */
  setPreview(routed: RoutedCircuit | null): void {
    this.routed = routed;
    if (!this.overlay.hidden) this.render();
  }

  open(): void {
    this.selectTool(this.tool);
    this.render();
    this.overlay.hidden = false;
    this.emit(); // ask the controller for a fresh plan now that we're visible
  }

  close(): void {
    this.overlay.hidden = true;
  }

  // ---- editing -------------------------------------------------------------

  private selectTool(tool: Tool): void {
    this.tool = tool;
    for (const [t, btn] of this.toolButtons) btn.classList.toggle("is-active", t === tool);
  }

  private clear(): void {
    this.circuit = { leds: [], battery: null };
    this.routed = null;
    this.emit();
  }

  private onCanvasClick(e: MouseEvent): void {
    const flat = this.clientToFlat(e);
    if (!flat) return;
    if (this.tool === "battery") {
      // Toggle the single battery on/off the clicked face (it tapes onto a gray tile).
      const face = pointInFace(this.faces, flat);
      if (face < 0) return;
      this.circuit = {
        ...this.circuit,
        battery: this.circuit.battery?.face === face ? null : { face },
      };
    } else {
      // LEDs straddle a gap: snap the click to the nearest hinge between two tiles.
      const hit = nearestGap(this.gaps, flat);
      if (!hit || hit.dist > this.pickRadius()) return;
      const led = ledOf(hit.gap.faceA, hit.gap.faceB);
      const has = this.circuit.leds.some((l) => l.a === led.a && l.b === led.b);
      this.circuit = {
        ...this.circuit,
        leds: has
          ? this.circuit.leds.filter((l) => !(l.a === led.a && l.b === led.b))
          : [...this.circuit.leds, led],
      };
    }
    this.emit();
  }

  /** How close (flat mm) a click must land to a hinge to drop an LED there. */
  private pickRadius(): number {
    const diag = Math.hypot(this.bounds.maxX - this.bounds.minX, this.bounds.maxY - this.bounds.minY);
    return Math.max(2, diag * 0.06);
  }

  /** Notify the controller; it stores the circuit and pushes a fresh preview back. */
  private emit(): void {
    this.editHandler(cloneCircuit(this.circuit));
  }

  // ---- geometry ------------------------------------------------------------

  private computeBounds(): void {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of this.points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    if (!Number.isFinite(minX)) {
      minX = minY = 0;
      maxX = maxY = 1;
    }
    this.bounds = { minX, minY, maxX, maxY };
  }

  /** Flat mm → SVG user space (shift to a positive margin, flip Y like the export). */
  private tp(p: Vec2): Vec2 {
    return { x: p.x - this.bounds.minX + MARGIN, y: this.bounds.maxY - p.y + MARGIN };
  }

  /** Pointer client coords → flat mm (inverse of {@link tp}). */
  private clientToFlat(e: MouseEvent): Vec2 | null {
    const ctm = this.svg.getScreenCTM();
    if (!ctm) return null;
    const pt = this.svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const loc = pt.matrixTransform(ctm.inverse());
    return { x: loc.x + this.bounds.minX - MARGIN, y: this.bounds.maxY + MARGIN - loc.y };
  }

  // ---- rendering -----------------------------------------------------------

  private render(): void {
    const { minX, minY, maxX, maxY } = this.bounds;
    const w = maxX - minX + 2 * MARGIN;
    const h = maxY - minY + 2 * MARGIN;
    this.svg.setAttribute("viewBox", `0 0 ${fmt(w)} ${fmt(h)}`);

    const parts: string[] = [];
    // Cloth backing (the full flat faces) under everything — the fabric the tiles sit on.
    for (const f of this.faces) {
      if (f.poly.length < 3) continue;
      const d = "M " + f.poly.map((p, k) => (k === 0 ? "" : "L ") + ptStr(this.tp(p))).join(" ") + " Z";
      parts.push(`<path d="${d}" class="el-cloth" />`);
    }
    // Gray rigid tiles (the 3D-printed inset polygons, flat at 0% fold) — what gets cut. The empty
    // diamonds between them are the gaps an LED bridges.
    for (const t of this.tiles) {
      if (t.ring.length < 3) continue;
      const d = "M " + t.ring.map((p, k) => (k === 0 ? "" : "L ") + ptStr(this.tp(p))).join(" ") + " Z";
      parts.push(`<path d="${d}" class="el-tile" />`);
    }
    // Copper-tape routes: each run thickened into filled rectangles (tapeQuads). PWR/GND tape may
    // cross/overlap freely (insulated underside). Drawn under the markers.
    for (const tr of this.routed?.traces ?? []) {
      const quads = tapeQuads(tr.points, TAPE_W);
      if (quads.length === 0) continue;
      const d = quads
        .map((q) => "M " + q.map((p, k) => (k === 0 ? "" : "L ") + ptStr(this.tp(p))).join(" ") + " Z")
        .join(" ");
      parts.push(`<path d="${d}" class="el-tape el-tape-${tr.net}" />`);
    }
    // LEDs straddling a gap: a body at the hinge midpoint with a leg landing on each gray tile.
    // The router reports unreachable LEDs by their index in circuit.leds.
    const unreachable = new Set(this.routed?.unreachable ?? []);
    this.circuit.leds.forEach((led, i) => {
      const gap = gapForLed(this.gaps, led);
      if (!gap) return;
      const a = this.tp(gap.legA);
      const b = this.tp(gap.legB);
      const c = this.tp(gap.point);
      const orphan = unreachable.has(i);
      const cls = orphan ? "el-led el-led-orphan" : "el-led";
      const legCls = orphan ? "el-led-leg el-led-leg-orphan" : "el-led-leg";
      const r = this.markerR();
      // Two legs reaching onto the two tiles, then the body across the gap.
      parts.push(`<line x1="${fmt(a.x)}" y1="${fmt(a.y)}" x2="${fmt(c.x)}" y2="${fmt(c.y)}" class="${legCls}" />`);
      parts.push(`<line x1="${fmt(b.x)}" y1="${fmt(b.y)}" x2="${fmt(c.x)}" y2="${fmt(c.y)}" class="${legCls}" />`);
      parts.push(`<circle cx="${fmt(a.x)}" cy="${fmt(a.y)}" r="${fmt(r * 0.45)}" class="el-led-pad" />`);
      parts.push(`<circle cx="${fmt(b.x)}" cy="${fmt(b.y)}" r="${fmt(r * 0.45)}" class="el-led-pad" />`);
      parts.push(`<circle cx="${fmt(c.x)}" cy="${fmt(c.y)}" r="${fmt(r)}" class="${cls}" />`);
    });
    // Battery marker (square) on its tile.
    if (this.circuit.battery) {
      const f = this.faces[this.circuit.battery.face];
      if (f) {
        const c = this.tp(f.centroid);
        const r = this.markerR() * 1.2;
        parts.push(
          `<rect x="${fmt(c.x - r)}" y="${fmt(c.y - r)}" width="${fmt(2 * r)}" height="${fmt(2 * r)}" class="el-batt" />`,
        );
      }
    }
    this.svg.innerHTML = parts.join("");
    this.renderStatus();
  }

  /** Marker radius scaled to the pattern so it reads at any model size. */
  private markerR(): number {
    const diag = Math.hypot(this.bounds.maxX - this.bounds.minX, this.bounds.maxY - this.bounds.minY);
    return Math.max(0.5, diag * 0.012);
  }

  private renderStatus(): void {
    const n = this.circuit.leds.length;
    const batt = this.circuit.battery ? "battery set" : "no battery";
    const orphans = this.routed?.unreachable?.length ?? 0;
    let msg = `${n} LED${n === 1 ? "" : "s"} · ${batt} · PWR/GND`;
    if (this.gaps.length === 0 && n === 0) msg += " — no gaps to bridge in this pattern";
    else if (!this.circuit.battery && n > 0) msg += " — place a battery to route";
    else if (orphans > 0) msg += ` — ${orphans} LED${orphans === 1 ? "" : "s"} unreachable (no gap path)`;
    this.statusEl.textContent = msg;
  }
}

function cloneCircuit(c: Circuit): Circuit {
  return {
    leds: c.leds.map((l) => ({ a: l.a, b: l.b })),
    battery: c.battery ? { face: c.battery.face } : null,
  };
}

const fmt = (n: number): string => (Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : "0");
const ptStr = (p: Vec2): string => `${fmt(p.x)} ${fmt(p.y)}`;
