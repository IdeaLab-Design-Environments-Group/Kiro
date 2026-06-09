/**
 * **View** — the "FKLD metadata" column. Renders the ordered sections produced
 * by the `fkld-metadata` presenter; the screen and the file always agree
 * because every value is read straight from the FKLD/FOLD object.
 */
import type { SummarySection } from "../fkld-metadata.js";
import { el, heading } from "./dom.js";

export class MetadataPanel {
  readonly element: HTMLElement;
  private readonly body: HTMLElement;
  private readonly empty: HTMLElement;

  constructor() {
    this.element = el("section", "column meta-column");
    const panel = el("div", "panel fkld-metadata-panel");
    panel.append(heading("h2", "FKLD metadata"));
    const hint = el("p", "fkld-meta-hint");
    hint.innerHTML =
      "Read straight from the loaded <em>FKLD/FOLD</em> object — the screen and the file always agree.";
    panel.append(hint);

    this.body = el("div", "fkld-meta-body");
    this.empty = el("p", "fkld-meta-empty");
    this.empty.textContent = "Load a model to inspect its FKLD metadata.";
    this.body.append(this.empty);
    panel.append(this.body);

    this.element.append(panel);
  }

  render(sections: SummarySection[]): void {
    this.body.innerHTML = "";
    if (sections.length === 0) {
      this.body.append(this.empty);
      return;
    }
    for (const section of sections) {
      const wrap = el("div", "fkld-meta-section");
      wrap.append(heading("h3", section.title));
      if (section.rows.length === 0) {
        const empty = el("p", "fkld-meta-empty");
        empty.textContent = section.emptyMessage ?? "—";
        wrap.append(empty);
      } else {
        const dl = el("dl", "fkld-meta-list");
        for (const { term, value } of section.rows) {
          const dt = document.createElement("dt");
          dt.textContent = term;
          const dd = document.createElement("dd");
          dd.textContent = value;
          dl.append(dt, dd);
        }
        wrap.append(dl);
      }
      this.body.append(wrap);
    }
  }
}
