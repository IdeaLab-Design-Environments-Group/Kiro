/**
 * **View** — the header action bar: "Create pyramid", "Load sample" and
 * "Kirigamize ▶" buttons, plus a slot for the 3D-Sim trigger. Emits intents
 * (`onCreatePyramid`, `onLoadSample`, `onKirigamize`) and exposes
 * `setKirigamizeEnabled`; it holds no app state.
 */
import { el } from "./dom.js";

/** Which kirigamization method the ▶ button runs. */
export type KirigamizeMethod = "normal" | "bst";

export class HeaderActions {
  readonly element: HTMLElement;
  private readonly createBtn: HTMLButtonElement;
  private readonly sampleBtn: HTMLButtonElement;
  private readonly methodSelect: HTMLSelectElement;
  private readonly kirigamizeBtn: HTMLButtonElement;

  constructor() {
    this.element = el("div", "header-actions");
    this.createBtn = el("button", "sim-trigger") as HTMLButtonElement;
    this.createBtn.type = "button";
    this.createBtn.textContent = "Create pyramid";
    this.sampleBtn = el("button", "sim-trigger") as HTMLButtonElement;
    this.sampleBtn.type = "button";
    this.sampleBtn.textContent = "Load sample";
    // Method selector: "normal" (cut & fold, the M1–M5 pipeline) or "bst" (bistable star tiling).
    this.methodSelect = el("select", "method-select") as HTMLSelectElement;
    for (const [value, label] of [
      ["normal", "Cut & fold"],
      ["bst", "Bistable star tiling"],
    ] as [KirigamizeMethod, string][]) {
      const opt = el("option") as HTMLOptionElement;
      opt.value = value;
      opt.textContent = label;
      this.methodSelect.appendChild(opt);
    }
    this.kirigamizeBtn = el("button", "export-trigger") as HTMLButtonElement;
    this.kirigamizeBtn.type = "button";
    this.kirigamizeBtn.textContent = "Kirigamize ▶";
    this.kirigamizeBtn.disabled = true;
  }

  /** The currently selected kirigamization method. */
  method(): KirigamizeMethod {
    return this.methodSelect.value as KirigamizeMethod;
  }

  /**
   * Append the action buttons. Call *after* any earlier triggers (e.g. the
   * 3D-Sim button) have been mounted into `element`, to preserve their order:
   * [3D Sim] [Create pyramid] [Load sample] [Kirigamize ▶].
   */
  appendActionButtons(): void {
    this.element.append(this.createBtn, this.sampleBtn, this.methodSelect, this.kirigamizeBtn);
  }

  /** Generate an AKDE pyramid from the transferred creation pipeline. */
  onCreatePyramid(handler: () => void): void {
    this.createBtn.addEventListener("click", handler);
  }

  onLoadSample(handler: () => void): void {
    this.sampleBtn.addEventListener("click", handler);
  }

  onKirigamize(handler: (method: KirigamizeMethod) => void): void {
    this.kirigamizeBtn.addEventListener("click", () => handler(this.method()));
  }

  setKirigamizeEnabled(enabled: boolean): void {
    this.kirigamizeBtn.disabled = !enabled;
  }
}
