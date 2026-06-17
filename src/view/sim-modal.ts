import type { FoldScene, SimMaterial } from "../sim/index.js";
import { DEFAULT_MAX_SUBDIV, TILE_INSET_FRAC } from "../model/tile-subdiv.js";
import { type Circuit, COMPONENT_KINDS, COMPONENT_SPECS, EMPTY_CIRCUIT } from "../model/circuit.js";
import { buildCircuitStl, type CircuitStl } from "../model/circuit-export.js";
import type { CircuitTool, SimCanvas } from "./sim-canvas.js";

/** Returns a ready fold scene when the sim opens, or null when no model is loaded. */
export type SimSceneProvider = () => { scene: FoldScene; title: string } | null;

/**
 * "3D Sim" trigger + modal hosting the Three.js fold simulation. Opening
 * builds the scene from the current model and starts the CPU solver; the
 * fold slider scrubs `foldPercent` 0→1; "Reset fold" rebuilds from the
 * current model. The canvas (and Three.js) load lazily on first open.
 */
export class SimModal {
  private readonly overlay: HTMLElement;
  private readonly trigger: HTMLButtonElement;
  private readonly mount: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly foldSlider: HTMLInputElement;
  private readonly foldValue: HTMLElement;
  private readonly detailControl: HTMLElement;
  private readonly detailSlider: HTMLInputElement;
  private readonly detailValue: HTMLElement;
  private readonly gapControl: HTMLElement;
  private readonly gapSlider: HTMLInputElement;
  private readonly gapValue: HTMLElement;
  private readonly tabs: HTMLButtonElement[];
  private readonly circuitTab: HTMLButtonElement;
  private readonly palette: HTMLElement;
  private readonly partButtons: HTMLButtonElement[];
  private provider: SimSceneProvider | null = null;
  private canvas: SimCanvas | null = null;
  private material: SimMaterial = "vinyl";
  private detail = DEFAULT_MAX_SUBDIV;
  private gap = TILE_INSET_FRAC;
  private circuitOn = false;
  private tool: CircuitTool = "select";
  private materialListener: ((m: SimMaterial) => void) | null = null;
  private detailListener: ((d: number) => void) | null = null;
  private gapListener: ((g: number) => void) | null = null;
  private saveCircuitListener: (() => void) | null = null;

  constructor() {
    this.trigger = document.createElement("button");
    this.trigger.type = "button";
    this.trigger.className = "sim-trigger";
    this.trigger.textContent = "3D Sim";
    this.trigger.disabled = true;
    this.trigger.addEventListener("click", () => {
      this.open().catch((err) => {
        this.statusEl.textContent = "Failed to load the 3D viewer.";
        console.error(err);
      });
    });

    this.overlay = document.createElement("div");
    this.overlay.className = "sim-overlay";
    this.overlay.hidden = true;
    this.overlay.innerHTML = `
      <div class="sim-modal" role="dialog" aria-modal="true" aria-label="3D fold simulation">
        <header class="sim-modal-header">
          <span class="sim-modal-title">3D fold simulation</span>
          <button type="button" class="sim-modal-close" aria-label="Close">×</button>
        </header>
        <div class="sim-modal-body">
          <div class="sim-tabs" role="tablist">
            <button type="button" class="sim-tab is-active" data-material="vinyl" role="tab" aria-selected="true">Vinyl / paper</button>
            <button type="button" class="sim-tab" data-material="printed" role="tab" aria-selected="false">3D-printed</button>
            <button type="button" class="sim-tab sim-circuit-tab" role="tab" aria-selected="false">Circuit</button>
          </div>
          <div class="sim-palette" hidden>
            <span class="sim-palette-label">Tool</span>
            <button type="button" class="sim-part" data-tool="select">Select</button>
            <button type="button" class="sim-part" data-tool="route">Route</button>
            <span class="sim-palette-label">Place</span>
            ${COMPONENT_KINDS.map(
              (k) => `<button type="button" class="sim-part" data-tool="${k}">${COMPONENT_SPECS[k].label}</button>`,
            ).join("")}
            <button type="button" class="sim-part-clear">Clear</button>
            <span class="sim-palette-hint">Place: pick a part — it rides the cursor, click to drop (R rotates, Esc stops). Select then M moves, R rotates, Del deletes. Route: click pad → pad. Wheel zooms to cursor; snaps to grid.</span>
          </div>
          <div class="sim-canvas-mount"></div>
        </div>
        <footer class="sim-modal-footer">
          <span class="sim-status"></span>
          <label class="sim-fold-control sim-detail-control" title="More tile subdivision on harder-folding faces. Level 0 = 1 subdivision; 4 = 5. Matches the STL export.">
            Detail <span class="sim-detail-value">0</span>
            <input type="range" class="sim-detail-slider" min="0" max="4" step="1" value="0" />
          </label>
          <label class="sim-fold-control sim-gap-control" title="Width of the bare-hinge gaps between the printed tiles (tile shrink toward its centroid). Matches the STL export.">
            Gap <span class="sim-gap-value">16%</span>
            <input type="range" class="sim-gap-slider" min="2" max="45" step="1" value="16" />
          </label>
          <label class="sim-fold-control">
            Fold <span class="sim-fold-value">0%</span>
            <input type="range" class="sim-fold-slider" min="0" max="100" step="1" value="0" />
          </label>
          <button type="button" class="sim-reset-btn">Reset fold</button>
        </footer>
      </div>
    `;
    document.body.appendChild(this.overlay);
    this.mount = this.overlay.querySelector(".sim-canvas-mount")!;
    this.statusEl = this.overlay.querySelector(".sim-status")!;
    this.foldSlider = this.overlay.querySelector(".sim-fold-slider")!;
    this.foldValue = this.overlay.querySelector(".sim-fold-value")!;
    this.detailControl = this.overlay.querySelector(".sim-detail-control")!;
    this.detailSlider = this.overlay.querySelector(".sim-detail-slider")!;
    this.detailValue = this.overlay.querySelector(".sim-detail-value")!;
    this.gapControl = this.overlay.querySelector(".sim-gap-control")!;
    this.gapSlider = this.overlay.querySelector(".sim-gap-slider")!;
    this.gapValue = this.overlay.querySelector(".sim-gap-value")!;
    this.tabs = Array.from(this.overlay.querySelectorAll<HTMLButtonElement>(".sim-tab[data-material]"));
    this.circuitTab = this.overlay.querySelector(".sim-circuit-tab")!;
    this.palette = this.overlay.querySelector(".sim-palette")!;
    this.partButtons = Array.from(this.overlay.querySelectorAll<HTMLButtonElement>(".sim-part"));
    for (const tab of this.tabs) {
      tab.addEventListener("click", () => this.selectMaterial(tab.dataset.material as SimMaterial));
    }
    this.circuitTab.addEventListener("click", () => this.enterCircuit());
    for (const btn of this.partButtons) {
      btn.addEventListener("click", () => this.selectTool(btn.dataset.tool as CircuitTool));
    }
    this.overlay.querySelector(".sim-part-clear")!.addEventListener("click", () => this.canvas?.clearCircuit());

    this.foldSlider.addEventListener("input", () => this.applyFold());
    this.detailSlider.addEventListener("input", () => this.applyDetail());
    this.gapSlider.addEventListener("input", () => this.applyGap());
    this.syncDetailVisibility();
    this.overlay.querySelector(".sim-modal-close")!.addEventListener("click", () => this.close());
    this.overlay.querySelector(".sim-reset-btn")!.addEventListener("click", () => this.loadWorld());
    this.overlay.addEventListener("click", (e) => {
      if (e.target === this.overlay) this.close();
    });
    document.addEventListener("keydown", (e) => {
      if (this.overlay.hidden) return;
      if ((e.metaKey || e.ctrlKey) && (e.key === "t" || e.key === "T")) {
        e.preventDefault(); // save the routed circuit onto the design (overrides the browser new-tab)
        this.saveCircuitListener?.();
        return;
      }
      if (this.circuitOn && this.handleCircuitKey(e)) return; // KiCad-style hotkeys inside the editor
      if (e.key === "Escape") this.close();
    });
  }

  /** KiCad-style editor hotkeys; returns true when the key was consumed. */
  private handleCircuitKey(e: KeyboardEvent): boolean {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    switch (e.key) {
      case "Escape": this.canvas?.escapeTool(); return true; // cancel place/move/route, deselect (don't close)
      case "Delete": case "Backspace": this.canvas?.deleteSelected(); return true;
      case "m": case "M": this.canvas?.moveSelected(); return true; // pick the selected part up onto the cursor
      case "r": case "R": this.canvas?.rotateSelected(); return true;
      case "x": case "X": this.selectTool("route"); return true;
      case "s": case "S": this.selectTool("select"); return true;
      default: return false;
    }
  }

  mountTrigger(container: HTMLElement): void {
    container.appendChild(this.trigger);
  }

  setProvider(provider: SimSceneProvider): void {
    this.provider = provider;
  }

  /** Notified when the user switches the Vinyl / 3D-printed tab (controller stores it). */
  onMaterialChange(cb: (m: SimMaterial) => void): void {
    this.materialListener = cb;
  }

  /** Notified when the user changes the adaptive-detail slider (controller stores it; export shares it). */
  onDetailChange(cb: (d: number) => void): void {
    this.detailListener = cb;
  }

  /** Notified when the user changes the gap slider (controller stores it; the STL export shares it). */
  onGapChange(cb: (g: number) => void): void {
    this.gapListener = cb;
  }

  /** Switch the sim material tab: leave circuit mode, update state, then rebuild (fold % preserved). */
  private selectMaterial(m: SimMaterial): void {
    if (this.circuitOn) this.exitCircuit();
    this.setMaterialTabsActive(m);
    if (m === this.material) return;
    this.material = m;
    this.syncDetailVisibility(); // detail only affects the 3D-printed tiles
    this.materialListener?.(m); // update the store before rebuilding so the provider sees the new material
    if (this.canvas) this.loadWorld();
  }

  private setMaterialTabsActive(m: SimMaterial | null): void {
    for (const tab of this.tabs) {
      const on = tab.dataset.material === m;
      tab.classList.toggle("is-active", on);
      tab.setAttribute("aria-selected", String(on));
    }
  }

  /** Enter circuit mode: force 3D-printed tiles (the circuit rides them), show the parts palette. */
  private enterCircuit(): void {
    if (this.material !== "printed") {
      this.material = "printed";
      this.syncDetailVisibility();
      this.materialListener?.("printed");
      if (this.canvas) this.loadWorld();
    }
    this.circuitOn = true;
    this.setMaterialTabsActive(null);
    this.circuitTab.classList.add("is-active");
    this.circuitTab.setAttribute("aria-selected", "true");
    this.palette.hidden = false;
    this.canvas?.setCircuitMode(true);
    this.selectTool("select"); // KiCad default: the selection/move cursor
  }

  private exitCircuit(): void {
    this.circuitOn = false;
    this.tool = "select";
    this.circuitTab.classList.remove("is-active");
    this.circuitTab.setAttribute("aria-selected", "false");
    this.palette.hidden = true;
    for (const b of this.partButtons) b.classList.remove("is-active");
    this.canvas?.setCircuitMode(false);
  }

  /** Pick the active editor tool (select / route / a part) and reflect it in the palette. */
  private selectTool(tool: CircuitTool): void {
    this.tool = tool;
    for (const b of this.partButtons) b.classList.toggle("is-active", b.dataset.tool === tool);
    this.canvas?.setCircuitTool(tool);
  }

  /** Notified on ⌘/Ctrl+T — the controller saves the current circuit onto the design. */
  onSaveCircuit(cb: () => void): void {
    this.saveCircuitListener = cb;
  }

  /** The circuit currently authored on the tiles (empty when no scene). */
  getCircuit(): Circuit {
    return this.canvas?.getCircuit() ?? EMPTY_CIRCUIT;
  }

  /** Build the separate circuit STL from the current placement (or null if empty / no scene). */
  getCircuitStl(baseName: string): CircuitStl | null {
    const c = this.canvas?.getCircuit();
    const net = this.canvas?.getNet();
    if (!c || !net) return null;
    return buildCircuitStl(c, net, baseName);
  }

  /** Detail and gap only matter for 3D-printed tiles — hide both in vinyl/paper mode. */
  private syncDetailVisibility(): void {
    const hidden = this.material !== "printed";
    this.detailControl.hidden = hidden;
    this.gapControl.hidden = hidden;
  }

  private applyDetail(): void {
    this.detail = Number(this.detailSlider.value);
    this.detailValue.textContent = String(this.detail);
    this.canvas?.setTileDetail(this.detail);
    this.detailListener?.(this.detail);
  }

  private applyGap(): void {
    this.gap = Number(this.gapSlider.value) / 100; // slider shows a %, stored as the corner→centroid shrink fraction
    this.gapValue.textContent = `${this.gapSlider.value}%`;
    this.canvas?.setTileGap(this.gap);
    this.gapListener?.(this.gap);
  }

  /** Enable/disable the 3D Sim button (e.g. only when a foldable model is loaded). */
  setEnabled(enabled: boolean): void {
    this.trigger.disabled = !enabled;
  }

  async open(): Promise<void> {
    this.overlay.hidden = false;
    if (!this.canvas) {
      this.statusEl.textContent = "Loading 3D viewer…";
      const { SimCanvas } = await import("./sim-canvas.js");
      if (this.overlay.hidden) return;
      this.canvas = new SimCanvas(this.mount);
    }
    this.loadWorld();
  }

  close(): void {
    this.overlay.hidden = true;
    this.canvas?.stop();
  }

  private loadWorld(): void {
    const built = this.provider?.() ?? null;
    if (!built) {
      this.statusEl.textContent = "No foldable model — load a FOLD/FKLD crease pattern, then reopen.";
      this.canvas?.stop();
      return;
    }
    if (!this.canvas) return;
    try {
      this.canvas.setScene(built.scene);
      this.canvas.setTileDetail(this.detail); // honor the current adaptive-detail setting
      this.canvas.setTileGap(this.gap); // …and the current gap width
      this.syncDetailVisibility();
      this.applyFold();
      this.canvas.warmToTarget();
      this.canvas.start();
      const { net } = built.scene;
      const shell = net.meta.N > 0 && net.faces.length === 7 * net.meta.N;
      const triLabel = shell
        ? `${net.faces.length} tris (${net.meta.N}-tri shell at full fold)`
        : `${net.faces.length} tris`;
      this.statusEl.textContent =
        `Folding ${built.title} — ${net.vertices.length} verts, ${triLabel}, ` +
        `${built.scene.model.creases.count} creases. Drag to orbit.`;
    } catch (err) {
      this.statusEl.textContent = `Cannot simulate this model: ${(err as Error).message}`;
      this.canvas.stop();
    }
  }

  private applyFold(): void {
    const pct = Number(this.foldSlider.value);
    this.foldValue.textContent = `${pct}%`;
    this.canvas?.setFoldPercent(pct / 100);
  }
}
