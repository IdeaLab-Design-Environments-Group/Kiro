import type { SvgExportPayload } from "../model/fkld-svg-export.js";

/** Returns the export payload for the current pattern when the modal opens, or null if none. */
export type ExportProvider = () => SvgExportPayload | null;

/**
 * "Export SVG" trigger + modal for vinyl/Cricut cutting. Opening pulls a fresh {@link SvgExportPayload}
 * from the provider, shows cut / score / both previews, and offers two downloads: the registered
 * cut+score **ZIP** (assign black=Cut, blue=Score in Design Space) and a single colour-coded SVG.
 * Mirrors `SimModal`'s trigger/provider/enabled lifecycle.
 */
export class ExportModal {
  private readonly overlay: HTMLElement;
  private readonly trigger: HTMLButtonElement;
  private readonly statusEl: HTMLElement;
  private readonly previews: { cut: HTMLElement; score: HTMLElement; both: HTMLElement };
  private readonly zipBtn: HTMLButtonElement;
  private readonly combinedBtn: HTMLButtonElement;
  private provider: ExportProvider | null = null;
  private payload: SvgExportPayload | null = null;

  constructor() {
    this.trigger = document.createElement("button");
    this.trigger.type = "button";
    this.trigger.className = "sim-trigger";
    this.trigger.textContent = "Export SVG";
    this.trigger.disabled = true;
    this.trigger.addEventListener("click", () => this.open());

    this.overlay = document.createElement("div");
    this.overlay.className = "sim-overlay";
    this.overlay.hidden = true;
    this.overlay.innerHTML = `
      <div class="sim-modal" role="dialog" aria-modal="true" aria-label="Export SVG for cutting">
        <header class="sim-modal-header">
          <span class="sim-modal-title">Export SVG (cut + score)</span>
          <button type="button" class="sim-modal-close" aria-label="Close">×</button>
        </header>
        <div class="sim-modal-body">
          <div class="export-previews">
            <figure><figcaption>Cut</figcaption><div class="export-preview" data-k="cut"></div></figure>
            <figure><figcaption>Score</figcaption><div class="export-preview" data-k="score"></div></figure>
            <figure><figcaption>Both</figcaption><div class="export-preview" data-k="both"></div></figure>
          </div>
        </div>
        <footer class="sim-modal-footer">
          <span class="sim-status"></span>
          <button type="button" class="export-zip-btn">Cut + score (zip)</button>
          <button type="button" class="export-combined-btn">Single SVG</button>
        </footer>
      </div>
    `;
    document.body.appendChild(this.overlay);
    this.statusEl = this.overlay.querySelector(".sim-status")!;
    this.previews = {
      cut: this.overlay.querySelector('[data-k="cut"]')!,
      score: this.overlay.querySelector('[data-k="score"]')!,
      both: this.overlay.querySelector('[data-k="both"]')!,
    };
    this.zipBtn = this.overlay.querySelector(".export-zip-btn")!;
    this.combinedBtn = this.overlay.querySelector(".export-combined-btn")!;

    this.zipBtn.addEventListener("click", () => this.downloadZip());
    this.combinedBtn.addEventListener("click", () => this.downloadCombined());
    this.overlay.querySelector(".sim-modal-close")!.addEventListener("click", () => this.close());
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

  setProvider(provider: ExportProvider): void {
    this.provider = provider;
  }

  /** Enable/disable the Export button (only when there's a cuttable pattern on screen). */
  setEnabled(enabled: boolean): void {
    this.trigger.disabled = !enabled;
  }

  open(): void {
    this.payload = this.provider?.() ?? null;
    this.overlay.hidden = false;
    if (!this.payload) {
      this.previews.cut.innerHTML = this.previews.score.innerHTML = this.previews.both.innerHTML = "";
      this.statusEl.textContent = "No pattern to export — load or kirigamize a model first.";
      this.zipBtn.disabled = this.combinedBtn.disabled = true;
      return;
    }
    this.previews.cut.innerHTML = this.payload.previews.cut;
    this.previews.score.innerHTML = this.payload.previews.score;
    this.previews.both.innerHTML = this.payload.previews.both;
    this.zipBtn.disabled = this.combinedBtn.disabled = false;
    this.statusEl.textContent =
      "Black = Cut, blue = Score. Import the zip's two SVGs (registered, in mm) and set the layer ops.";
  }

  close(): void {
    this.overlay.hidden = true;
  }

  private downloadZip(): void {
    if (!this.payload) return;
    download(this.payload.archive.filename, new Blob([this.payload.archive.bytes], { type: "application/zip" }));
  }

  private downloadCombined(): void {
    if (!this.payload) return;
    download(this.payload.combined.filename, new Blob([this.payload.combined.svg], { type: "image/svg+xml" }));
  }
}

function download(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
