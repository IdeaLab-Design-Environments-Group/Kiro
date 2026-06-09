import { afterEach, describe, expect, it } from "vitest";
import { MetadataPanel } from "../../../src/view/metadata-panel.js";
import type { SummarySection } from "../../../src/model/fkld-metadata.js";
import { childByClass, installDom, MockElement } from "./mock-dom.js";

describe("view/metadata-panel", () => {
  afterEach(() => {
    delete (globalThis as any).document;
    delete (globalThis as any).window;
  });

  it("shows the empty message when no sections are rendered", () => {
    installDom();
    const panel = new MetadataPanel();
    panel.render([]);

    const body = childByClass(panel.element as unknown as MockElement, "fkld-meta-body")!;
    expect(body.children).toHaveLength(1);
    expect(body.children[0]?.textContent).toBe("Load a model to inspect its FKLD metadata.");
  });

  it("renders titled sections with either rows or empty messages", () => {
    installDom();
    const panel = new MetadataPanel();
    const sections: SummarySection[] = [
      {
        title: "Header",
        rows: [
          { term: "file_spec", value: "1.1" },
          { term: "frame_title", value: "Example" },
        ],
      },
      {
        title: "Cuts",
        rows: [],
        emptyMessage: "Not present.",
      },
    ];

    panel.render(sections);

    const body = childByClass(panel.element as unknown as MockElement, "fkld-meta-body")!;
    expect(body.children).toHaveLength(2);
    expect(body.children[0]?.children[0]?.textContent).toBe("Header");
    expect(body.children[1]?.children[0]?.textContent).toBe("Cuts");
    expect(body.children[1]?.children[1]?.textContent).toBe("Not present.");
  });
});
