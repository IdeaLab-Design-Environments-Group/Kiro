/**
 * **Controller** — the only place that knows about *both* the Model and the
 * Views. It (1) translates view intents (file chosen, kirigamize, load sample)
 * into Model updates, performing file IO/parsing along the way, and (2)
 * subscribes to the Model and pushes the new state into every View. Views and
 * the store never reference each other directly.
 */
import { type AppState, AppStore } from "../model/app-store.js";
import { deriveFacts } from "../model/derive-facts.js";
import { type FoldFile, isFkld } from "../model/fold-file.js";
import { summarizeFkldForDisplay } from "../model/fkld-metadata.js";
import { buildScene, canSimulate } from "../sim/scene.js";
// Transferred AKDE creation pipeline: inputs → KirigamiState → FKLD crease+cut pattern.
import { computeState, defaultInputs } from "@kirigami/model/geometry.js";
import { buildFkldFile } from "@kirigami/model/fkld-export.js";
import type { ConvertPanel } from "../view/convert-panel.js";
import type { MetadataPanel } from "../view/metadata-panel.js";
import type { ViewerFrame } from "../view/viewer-frame.js";
import type { HeaderActions } from "../view/header-actions.js";
import type { SimModal } from "../view/sim-modal.js";

const SAMPLE_URL = "./examples/akde-hex.fkld";
const SAMPLE_NAME = "akde-hex.fkld";

export class AppController {
  constructor(
    private readonly store: AppStore,
    private readonly convert: ConvertPanel,
    private readonly metadata: MetadataPanel,
    private readonly viewer: ViewerFrame,
    private readonly header: HeaderActions,
    private readonly sim: SimModal,
  ) {
    // 3D Sim folds exactly what the VIEWER is showing (fall back to the loaded model). This keeps
    // "what you see is what gets simulated" true even when the viewer and the convert panel differ.
    this.sim.setProvider(() => {
      const shown = this.viewer.current();
      const src = shown ?? (this.store.model?.kind === "fold" ? this.store.model : null);
      if (!src) return null;
      const built = buildScene(src.object);
      return built ? { scene: built.scene, title: `${src.name} (${built.mode})` } : null;
    });

    // View intents → controller handlers.
    this.convert.onFileChosen((file) => this.loadFromFile(file));
    this.header.onCreatePyramid(() => this.createPyramid());
    this.header.onLoadSample(() => void this.loadSample());
    this.header.onKirigamize(() => this.kirigamize());

    // Model changes → re-render every view (fires once immediately with state).
    this.store.subscribe((state) => this.render(state));
  }

  /** Single render path: derive view data from state and push to all views. */
  private render(state: Readonly<AppState>): void {
    const m = state.model;
    this.convert.renderFacts(m ? deriveFacts(m) : []);
    this.convert.setStatus(state.status.msg, state.status.kind);
    this.metadata.render(m && m.kind === "fold" ? summarizeFkldForDisplay(m.object) : []);
    this.header.setKirigamizeEnabled(!!m);
    this.sim.setEnabled(!!m && m.kind === "fold" && canSimulate(m.object));
  }

  // ---- intents ------------------------------------------------------------

  loadFromFile(file: File): void {
    const name = file.name;
    const ext = (name.split(".").pop() ?? "").toLowerCase();
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result);
      if (ext === "fold" || ext === "fkld" || ext === "json") {
        try {
          this.applyFold(JSON.parse(text) as FoldFile, name);
        } catch (err) {
          this.store.update({
            model: null,
            status: { msg: `Parse error in ${name}: ${(err as Error).message}`, kind: "bad" },
          });
        }
      } else if (ext === "obj" || ext === "stl") {
        this.applyMesh(text, name, ext);
      } else {
        this.store.setStatus(`Unsupported file type: .${ext}`, "bad");
      }
    };
    reader.onerror = () => this.store.setStatus(`Could not read ${name}.`, "bad");
    reader.readAsText(file);
  }

  kirigamize(): void {
    const m = this.store.model;
    if (!m) return;
    if (m.kind === "fold") {
      this.viewer.show(m.object, m.name); // passthrough stub
      this.store.setStatus(`Showing "${m.name}" in the viewer (passthrough — conversion stub).`, "ok");
    } else {
      this.store.setStatus(
        `Kirigamizer conversion for ${m.name} is not implemented yet — ` +
          `this is where curvature → molecule/cut placement → unfold will run.`,
        "",
      );
    }
  }

  /**
   * Generate an AKDE uniform-molecule pyramid via the **transferred creation
   * pipeline** (`@kirigami/model`): default inputs → KirigamiState → FKLD
   * crease+cut pattern. The result loads exactly like an imported FKLD — shown
   * in the viewer and ready for the guided 3D Sim (its `frame_title` carries the
   * N/L/H/T the sim recovers). This is the "creation" half of AKDE running
   * inside the Kirigamizer shell, ahead of the general mesh→pattern pipeline.
   */
  createPyramid(): void {
    const fkld = buildFkldFile(computeState(defaultInputs())) as FoldFile | null;
    if (!fkld) {
      this.store.setStatus("Could not create the pyramid pattern.", "bad");
      return;
    }
    const name = "akde-pyramid.fkld";
    this.applyFold(fkld, name);
    this.viewer.show(fkld, name);
    this.store.setStatus(
      `Created AKDE pyramid via the transferred creation pipeline. Open 3D Sim to fold it.`,
      "ok",
    );
  }

  async loadSample(announce = true): Promise<void> {
    try {
      const resp = await fetch(SAMPLE_URL);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const obj = JSON.parse(await resp.text()) as FoldFile;
      this.applyFold(obj, SAMPLE_NAME);
      this.viewer.show(obj, SAMPLE_NAME);
      if (announce) this.store.setStatus("Loaded bundled sample into the viewer.", "ok");
    } catch {
      if (announce)
        this.store.setStatus("Sample fetch failed (serve over http). The viewer shows it by default.", "");
    }
  }

  // ---- model transitions --------------------------------------------------

  private applyFold(obj: FoldFile, name: string): void {
    const kind = isFkld(obj) ? "FKLD" : "FOLD";
    const sim = canSimulate(obj) ? " 3D Sim ready." : "";
    this.store.update({
      model: { kind: "fold", name, object: obj },
      status: { msg: `Loaded ${kind} model "${name}". Ready to Kirigamize.${sim}`, kind: "ok" },
    });
  }

  private applyMesh(text: string, name: string, ext: "obj" | "stl"): void {
    this.store.update({
      model: { kind: "mesh", name, ext, text },
      status: { msg: `Loaded ${ext.toUpperCase()} mesh "${name}". Conversion pipeline is a stub.`, kind: "" },
    });
  }
}
