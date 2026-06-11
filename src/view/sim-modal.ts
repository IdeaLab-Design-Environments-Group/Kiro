import type { FoldScene } from "../sim/index.js";
import type { SimCanvas } from "./sim-canvas.js";

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
  private provider: SimSceneProvider | null = null;
  private canvas: SimCanvas | null = null;

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
          <div class="sim-canvas-mount"></div>
        </div>
        <footer class="sim-modal-footer">
          <span class="sim-status"></span>
          <label class="sim-fold-control">
            Fold <span class="sim-fold-value">100%</span>
            <input type="range" class="sim-fold-slider" min="0" max="100" step="1" value="100" />
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

    this.foldSlider.addEventListener("input", () => this.applyFold());
    this.overlay.querySelector(".sim-modal-close")!.addEventListener("click", () => this.close());
    this.overlay.querySelector(".sim-reset-btn")!.addEventListener("click", () => this.loadWorld());
    this.overlay.addEventListener("click", (e) => {
      if (e.target === this.overlay) this.close();
    });
    document.addEventListener("keydown", (e) => {
      if (!this.overlay.hidden && e.key === "Escape") this.close();
    });
  }

  mountTrigger(container: HTMLElement): void {
    container.appendChild(this.trigger);
  }

  setProvider(provider: SimSceneProvider): void {
    this.provider = provider;
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
        `${net.edges.filter((e) => e.faces.length >= 2).length} creases. Drag to orbit.`;
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
