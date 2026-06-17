/**
 * **View** — the header action bar: "Create pyramid", "Create 2.5D", "Load
 * sample" and "Kirigamize ▶" buttons, plus a slot for the 3D-Sim trigger. Emits
 * intents (`onCreatePyramid`, `onCreate25d`, `onLoadSample`, `onKirigamize`) and
 * exposes `setKirigamizeEnabled`; it holds no app state.
 */
import { el } from "./dom.js";

export class HeaderActions {
  readonly element: HTMLElement;
  private readonly createBtn: HTMLButtonElement;
  private readonly create25dBtn: HTMLButtonElement;
  private readonly sampleBtn: HTMLButtonElement;
  private readonly kirigamizeBtn: HTMLButtonElement;

  constructor() {
    this.element = el("div", "header-actions");
    this.createBtn = el("button", "sim-trigger") as HTMLButtonElement;
    this.createBtn.type = "button";
    this.createBtn.textContent = "Create pyramid";
    // 2.5D cut-and-fold signage (Demaine et al. 2023) — a flat sheet → relief.
    this.create25dBtn = el("button", "sim-trigger") as HTMLButtonElement;
    this.create25dBtn.type = "button";
    this.create25dBtn.textContent = "Create 2.5D";
    this.create25dBtn.title = "2.5D cut-and-fold sign — type text, or blank for a Space Invader";
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
   * [3D Sim] [Create pyramid] [Create 2.5D] [Load sample] [Kirigamize ▶].
   */
  appendActionButtons(): void {
    this.element.append(this.createBtn, this.create25dBtn, this.sampleBtn, this.kirigamizeBtn);
  }

  /** Generate an AKDE pyramid from the transferred creation pipeline. */
  onCreatePyramid(handler: () => void): void {
    this.createBtn.addEventListener("click", handler);
  }

  /** Generate a 2.5D cut-and-fold sign (the controller prompts for text). */
  onCreate25d(handler: () => void): void {
    this.create25dBtn.addEventListener("click", handler);
  }

  onLoadSample(handler: () => void): void {
    this.sampleBtn.addEventListener("click", handler);
  }

  onKirigamize(handler: () => void): void {
    this.kirigamizeBtn.addEventListener("click", () => handler());
  }

  setKirigamizeEnabled(enabled: boolean): void {
    this.kirigamizeBtn.disabled = !enabled;
  }
}
