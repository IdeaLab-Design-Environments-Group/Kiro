/**
 * **View** — the header action bar: "Load sample" and "Kirigamize ▶" buttons,
 * plus a slot for the 3D-Sim trigger. Emits intents (`onLoadSample`,
 * `onKirigamize`) and exposes `setKirigamizeEnabled`; it holds no app state.
 */
import { el } from "./dom.js";

export class HeaderActions {
  readonly element: HTMLElement;
  private readonly sampleBtn: HTMLButtonElement;
  private readonly kirigamizeBtn: HTMLButtonElement;

  constructor() {
    this.element = el("div", "header-actions");
    this.sampleBtn = el("button", "sim-trigger") as HTMLButtonElement;
    this.sampleBtn.type = "button";
    this.sampleBtn.textContent = "Load sample";
    this.kirigamizeBtn = el("button", "export-trigger") as HTMLButtonElement;
    this.kirigamizeBtn.type = "button";
    this.kirigamizeBtn.textContent = "Kirigamize ▶";
    this.kirigamizeBtn.disabled = true;
  }

  /**
   * Append the action buttons. Call *after* any earlier triggers (e.g. the
   * 3D-Sim button) have been mounted into `element`, to preserve their order:
   * [3D Sim] [Load sample] [Kirigamize ▶].
   */
  appendActionButtons(): void {
    this.element.append(this.sampleBtn, this.kirigamizeBtn);
  }

  onLoadSample(handler: () => void): void {
    this.sampleBtn.addEventListener("click", handler);
  }

  onKirigamize(handler: () => void): void {
    this.kirigamizeBtn.addEventListener("click", handler);
  }

  setKirigamizeEnabled(enabled: boolean): void {
    this.kirigamizeBtn.disabled = !enabled;
  }
}
