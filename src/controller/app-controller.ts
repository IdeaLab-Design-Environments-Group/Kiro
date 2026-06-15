/**
 * **Controller** — the only place that knows about *both* the Model and the
 * Views. It (1) translates view intents (file chosen, kirigamize, create
 * pyramid, load sample) into service calls + Model updates, and (2)
 * subscribes to the Model and pushes the new state into every View. Views and
 * the store never reference each other directly; the use-case logic itself
 * lives in `src/services/` so new features land there, not here.
 */
import { type AppState, AppStore } from "../model/app-store.js";
import { deriveFacts } from "../model/derive-facts.js";
import { type FoldFile, type LoadedModel } from "../model/fold-file.js";
import { summarizeFkldForDisplay } from "../model/fkld-metadata.js";
import { canSimulate } from "../sim/index.js";
import { statusFromError } from "../core/errors.js";
import { loadedStatus, readModelFile, fetchSample } from "../services/model-loader.js";
import { kirigamizeMesh, createAkdePyramid } from "../services/pattern-service.js";
import { resolveSimScene } from "../services/sim-scene-service.js";
import { resolveSvgExport } from "../services/svg-export-service.js";
import { resolveStlExport } from "../services/stl-export-service.js";
import type { ConvertPanel } from "../view/convert-panel.js";
import type { MetadataPanel } from "../view/metadata-panel.js";
import type { ViewerFrame } from "../view/viewer-frame.js";
import type { HeaderActions } from "../view/header-actions.js";
import type { SimModal } from "../view/sim-modal.js";
import type { ExportModal } from "../view/export-modal.js";

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
    private readonly exporter: ExportModal,
  ) {
    // 3D Sim folds exactly what the VIEWER is showing (fall back to the loaded model). This keeps
    // "what you see is what gets simulated" true even when the viewer and the convert panel differ.
    this.sim.setProvider(() => {
      const { model, viewerShown, simMaterial } = this.store.getState();
      return resolveSimScene(model, viewerShown, simMaterial);
    });
    // The sim modal's Vinyl/3D-printed tabs feed the chosen material back into state; the provider
    // above then rebuilds the scene for that material on the next loadWorld().
    this.sim.onMaterialChange((material) => this.store.update({ simMaterial: material }));

    // SVG export targets the same source — "what you see is what you cut" (black=cut, blue=score).
    this.exporter.setProvider(() => {
      const { model, viewerShown } = this.store.getState();
      return resolveSvgExport(model, viewerShown);
    });
    // STL export of the separated, extruded 3D-printed tiles — height + fold-adaptive detail from menu.
    this.exporter.setStlProvider((heightUnits, maxSubdiv) => {
      const { model, viewerShown } = this.store.getState();
      return resolveStlExport(model, viewerShown, heightUnits, maxSubdiv);
    });

    // The viewer can load models on its own (file picker, example dropdown, drag-drop); record
    // what it shows in the store so sim enablement/provider derive from one source of truth.
    this.viewer.onLoaded((object, name) => this.store.update({ viewerShown: { object, name } }));

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
    // Sim enablement follows what would actually be simulated: the viewer's
    // model first, else the loaded fold model. (Previously the viewer-driven
    // enablement was silently overridden by the next render — now it derives
    // consistently from state.)
    const simObject = state.viewerShown?.object ?? (m?.kind === "fold" ? m.object : null);
    this.sim.setEnabled(!!simObject && canSimulate(simObject));
    // Export is available for any displayed FKLD/FOLD pattern (even non-simulable ones).
    this.exporter.setEnabled(!!simObject);
  }

  // ---- intents (each: a service call + a store update) ---------------------

  loadFromFile(file: File): void {
    readModelFile(
      file,
      (model) => this.apply(model),
      (err) => {
        // Parse failures invalidate the current model; IO failures (unsupported
        // type, unreadable file) leave it untouched — same behavior as before.
        if (err.domain === "parse") this.store.update({ model: null, status: { msg: err.message, kind: "bad" } });
        else this.store.setStatus(err.message, "bad");
      },
    );
  }

  /**
   * The general pipeline (M1–M5): condition → curvature → plan cuts →
   * seamed unfold → pack/classify → emit FKLD → fold in the sim and verify
   * d_H against the source mesh. FOLD/FKLD models pass through to the viewer.
   */
  kirigamize(): void {
    const m = this.store.model;
    if (!m) return;
    if (m.kind === "fold") {
      this.viewer.show(m.object, m.name); // already a pattern — just show it
      this.store.setStatus(`Showing "${m.name}" in the viewer (already a FOLD/FKLD pattern).`, "ok");
      return;
    }
    this.store.setStatus(`Kirigamizing ${m.name}… (plan cuts → unfold → emit → verify)`, "");
    try {
      const outcome = kirigamizeMesh(m.text, m.ext, m.name);
      this.showPattern(outcome.fkld, outcome.name);
      this.store.setStatus(outcome.summary, outcome.ok ? "ok" : "bad");
    } catch (err) {
      // PipelineError passes through with its "<stage>: <message>" text;
      // anything else is wrapped with the kirigamize prefix.
      const { msg, kind } = statusFromError(err, "pipeline", "kirigamize failed");
      this.store.setStatus(msg, kind);
    }
  }

  /** Generate an AKDE pyramid via the transferred creation pipeline (see pattern-service). */
  createPyramid(): void {
    try {
      const outcome = createAkdePyramid();
      this.showPattern(outcome.fkld, outcome.name);
      this.store.setStatus(outcome.summary, "ok");
    } catch (err) {
      const { msg, kind } = statusFromError(err, "create");
      this.store.setStatus(msg, kind);
    }
  }

  async loadSample(announce = true): Promise<void> {
    try {
      const model = await fetchSample(SAMPLE_URL, SAMPLE_NAME);
      this.apply(model);
      if (model.kind === "fold") this.viewer.show(model.object, model.name);
      if (announce) this.store.setStatus("Loaded bundled sample into the viewer.", "ok");
    } catch {
      if (announce)
        this.store.setStatus("Sample fetch failed (serve over http). The viewer shows it by default.", "");
    }
  }

  // ---- model transitions --------------------------------------------------

  /** Commit a loaded model to the store with its standard status line. */
  private apply(model: LoadedModel): void {
    this.store.update({ model, status: loadedStatus(model) });
  }

  /** Commit a generated pattern and show it in the viewer. */
  private showPattern(fkld: FoldFile, name: string): void {
    this.apply({ kind: "fold", name, object: fkld });
    this.viewer.show(fkld, name);
  }
}
