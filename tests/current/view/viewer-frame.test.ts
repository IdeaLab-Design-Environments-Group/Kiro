import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewerFrame } from "../../../src/view/viewer-frame.js";
import { installDom, MockElement } from "./mock-dom.js";

describe("view/viewer-frame", () => {
  afterEach(() => {
    delete (globalThis as any).document;
    delete (globalThis as any).window;
  });

  it("queues show() until the viewer reports ready, then posts the payload", () => {
    const { window } = installDom();
    const frame = new ViewerFrame();
    const iframe = (frame.element as unknown as MockElement).children[0] as MockElement;
    const postMessage = vi.fn();
    iframe.contentWindow = { postMessage };

    frame.show({ vertices_coords: [[0, 0]] }, "sample.fkld");
    expect(postMessage).not.toHaveBeenCalled();

    window.dispatch("message", { data: { type: "kirigamizer:viewer-ready" } });
    expect(postMessage).toHaveBeenCalledWith(
      { type: "kirigamizer:load", fkld: { vertices_coords: [[0, 0]] }, name: "sample.fkld" },
      "*",
    );
  });

  it("tracks current viewer state and forwards viewer-loaded callbacks", () => {
    const { window } = installDom();
    const frame = new ViewerFrame();
    const loaded = vi.fn();
    frame.onLoaded(loaded);

    window.dispatch("message", {
      data: { type: "kirigamizer:viewer-loaded", fkld: { vertices_coords: [[1, 2]] }, name: "from-viewer.fkld" },
    });

    expect(loaded).toHaveBeenCalledWith({ vertices_coords: [[1, 2]] }, "from-viewer.fkld");
    expect(frame.current()).toEqual({
      object: { vertices_coords: [[1, 2]] },
      name: "from-viewer.fkld",
    });
  });
});
