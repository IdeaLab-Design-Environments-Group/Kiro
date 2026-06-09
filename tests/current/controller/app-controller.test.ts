import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppController } from "../../../src/controller/app-controller.js";
import { AppStore } from "../../../src/model/app-store.js";
import { canSimulate } from "../../../src/sim/scene.js";
import type { FoldFile, LoadedModel } from "../../../src/model/fold-file.js";

class ConvertPanelMock {
  factsCalls: [string, string][][] = [];
  statusCalls: Array<{ msg: string; kind: string }> = [];
  chosenHandler: ((file: File) => void) | null = null;

  onFileChosen(handler: (file: File) => void): void {
    this.chosenHandler = handler;
  }

  renderFacts(rows: [string, string][]): void {
    this.factsCalls.push(rows);
  }

  setStatus(msg: string, kind = ""): void {
    this.statusCalls.push({ msg, kind });
  }
}

class MetadataPanelMock {
  renderCalls: unknown[] = [];

  render(sections: unknown): void {
    this.renderCalls.push(sections);
  }
}

class ViewerFrameMock {
  showCalls: Array<{ object: FoldFile; name: string }> = [];
  private shown: { object: FoldFile; name: string } | null = null;

  show(object: FoldFile, name: string): void {
    this.showCalls.push({ object, name });
    this.shown = { object, name };
  }

  current(): { object: FoldFile; name: string } | null {
    return this.shown;
  }
}

class HeaderActionsMock {
  createPyramidHandler: (() => void) | null = null;
  loadSampleHandler: (() => void) | null = null;
  kirigamizeHandler: (() => void) | null = null;
  enabledCalls: boolean[] = [];

  onCreatePyramid(handler: () => void): void {
    this.createPyramidHandler = handler;
  }

  onLoadSample(handler: () => void): void {
    this.loadSampleHandler = handler;
  }

  onKirigamize(handler: () => void): void {
    this.kirigamizeHandler = handler;
  }

  setKirigamizeEnabled(enabled: boolean): void {
    this.enabledCalls.push(enabled);
  }
}

type SimProvider = () => { scene: unknown; title: string } | null;

class SimModalMock {
  provider: SimProvider | null = null;
  enabledCalls: boolean[] = [];

  setProvider(provider: SimProvider): void {
    this.provider = provider;
  }

  setEnabled(enabled: boolean): void {
    this.enabledCalls.push(enabled);
  }
}

function makeFold(overrides: Partial<FoldFile> = {}): FoldFile {
  return {
    vertices_coords: [
      [0, 0],
      [1, 0],
      [0, 1],
    ],
    faces_vertices: [[0, 1, 2]],
    edges_vertices: [
      [0, 1],
      [1, 2],
      [2, 0],
    ],
    ...overrides,
  };
}

function setup() {
  const store = new AppStore();
  const convert = new ConvertPanelMock();
  const metadata = new MetadataPanelMock();
  const viewer = new ViewerFrameMock();
  const header = new HeaderActionsMock();
  const sim = new SimModalMock();
  const controller = new AppController(
    store,
    convert as never,
    metadata as never,
    viewer as never,
    header as never,
    sim as never,
  );
  return { controller, store, convert, metadata, viewer, header, sim };
}

describe("controller/app-controller", () => {
  const originalFetch = globalThis.fetch;
  const originalFileReader = globalThis.FileReader;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.FileReader = originalFileReader;
  });

  it("renders initial empty state and wires a sim provider", () => {
    const { convert, metadata, header, sim } = setup();

    expect(convert.factsCalls[0]).toEqual([]);
    expect(convert.statusCalls[0]).toEqual({ msg: "No model loaded.", kind: "" });
    expect(metadata.renderCalls[0]).toEqual([]);
    expect(header.enabledCalls[0]).toBe(false);
    expect(sim.enabledCalls[0]).toBe(false);
    expect(sim.provider?.()).toBeNull();
  });

  it("kirigamizes a loaded fold by passing it through to the viewer", () => {
    const { controller, store, viewer, convert } = setup();
    const fold = makeFold({ "fkld:meta_architecture": {} });
    store.update({ model: { kind: "fold", name: "sample.fkld", object: fold } });

    controller.kirigamize();

    expect(viewer.showCalls).toEqual([{ object: fold, name: "sample.fkld" }]);
    expect(convert.statusCalls.at(-1)).toEqual({
      msg: 'Showing "sample.fkld" in the viewer (passthrough — conversion stub).',
      kind: "ok",
    });
  });

  it("reports the mesh conversion stub for non-fold models", () => {
    const { controller, store, convert } = setup();
    store.update({
      model: { kind: "mesh", name: "shape.obj", ext: "obj", text: "v 0 0 0" },
    });

    controller.kirigamize();

    expect(convert.statusCalls.at(-1)?.msg).toContain("conversion for shape.obj is not implemented yet");
  });

  it("loads the bundled sample on fetch success and announces it", async () => {
    const { controller, viewer, convert } = setup();
    const fold = makeFold({ frame_title: "sample" });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify(fold),
    } as Response);

    await controller.loadSample(true);

    expect(viewer.showCalls).toEqual([{ object: fold, name: "akde-hex.fkld" }]);
    expect(convert.statusCalls.at(-1)).toEqual({
      msg: "Loaded bundled sample into the viewer.",
      kind: "ok",
    });
  });

  it("creates the default AKDE pyramid and sends it to the viewer", () => {
    const { header, viewer, convert, sim } = setup();

    header.createPyramidHandler?.();

    expect(viewer.showCalls).toHaveLength(1);
    expect(viewer.showCalls[0]?.name).toBe("akde-pyramid.fkld");
    expect(viewer.showCalls[0]?.object.vertices_coords?.length).toBeGreaterThan(0);
    expect(canSimulate(viewer.showCalls[0]!.object)).toBe(true);
    expect(convert.statusCalls.at(-1)).toEqual({
      msg: "Created AKDE pyramid via the transferred creation pipeline. Open 3D Sim to fold it.",
      kind: "ok",
    });
    expect(sim.enabledCalls.at(-1)).toBe(true);
  });

  it("reports sample-fetch failure without throwing", async () => {
    const { controller, convert } = setup();
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("offline"));

    await controller.loadSample(true);

    expect(convert.statusCalls.at(-1)).toEqual({
      msg: "Sample fetch failed (serve over http). The viewer shows it by default.",
      kind: "",
    });
  });

  it("parses loaded FOLD files through FileReader", () => {
    const { convert, sim, header } = setup();
    const fold = makeFold();

    class FileReaderMock {
      result = JSON.stringify(fold);
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      readAsText(): void {
        this.onload?.();
      }
    }

    globalThis.FileReader = FileReaderMock as unknown as typeof FileReader;
    convert.chosenHandler?.({ name: "ok.fold" } as File);

    expect(header.enabledCalls.at(-1)).toBe(true);
    expect(sim.enabledCalls.at(-1)).toBe(true);
  });

  it("handles parse errors and unsupported file types", () => {
    const { convert } = setup();

    class BadReader {
      result = "{broken";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      readAsText(): void {
        this.onload?.();
      }
    }
    globalThis.FileReader = BadReader as unknown as typeof FileReader;
    convert.chosenHandler?.({ name: "broken.fold" } as File);
    expect(convert.statusCalls.at(-1)?.msg).toContain("Parse error in broken.fold");

    class PlainReader {
      result = "hello";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      readAsText(): void {
        this.onload?.();
      }
    }
    globalThis.FileReader = PlainReader as unknown as typeof FileReader;
    convert.chosenHandler?.({ name: "note.txt" } as File);
    expect(convert.statusCalls.at(-1)).toEqual({
      msg: "Unsupported file type: .txt",
      kind: "bad",
    });
  });

  it("builds the sim provider only for current fold models", () => {
    const { store, sim } = setup();
    expect(sim.provider?.()).toBeNull();

    const mesh: LoadedModel = { kind: "mesh", name: "shape.obj", ext: "obj", text: "v 0 0 0" };
    store.update({ model: mesh });
    expect(sim.provider?.()).toBeNull();

    const fold = makeFold();
    store.update({ model: { kind: "fold", name: "shape.fold", object: fold } });
    const built = sim.provider?.();
    expect(built?.title).toContain("shape.fold");
  });
});
