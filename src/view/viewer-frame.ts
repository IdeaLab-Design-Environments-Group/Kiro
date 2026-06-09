/**
 * **View** — the central FKLD viewer column. Owns the preview `<iframe>` and
 * encapsulates the cross-frame handshake: it buffers a payload until the
 * embedded viewer posts `kirigamizer:viewer-ready`, then forwards it. Callers
 * just call `show(object, name)`; the readiness/queueing is hidden here.
 */
import type { FoldFile } from "../model/fold-file.js";
import { el } from "./dom.js";

interface LoadPayload {
  type: "kirigamizer:load";
  fkld: FoldFile;
  name: string;
}

export class ViewerFrame {
  readonly element: HTMLElement;
  private readonly iframe: HTMLIFrameElement;
  private ready = false;
  private pending: LoadPayload | null = null;
  /** The object currently displayed — so the 3D Sim folds exactly what the viewer shows. */
  private shown: { object: FoldFile; name: string } | null = null;
  private loadedHandler: (object: FoldFile, name: string) => void = () => {};

  constructor() {
    this.element = el("section", "column viewer-column");
    this.iframe = el("iframe", "viewer-frame") as HTMLIFrameElement;
    this.iframe.src = "./viewer/index.html";
    this.iframe.title = "FKLD viewer";
    this.element.append(this.iframe);

    window.addEventListener("message", (e: MessageEvent) => {
      if (e.data && e.data.type === "kirigamizer:viewer-ready") {
        this.ready = true;
        if (this.pending) {
          this.post(this.pending);
          this.pending = null;
        }
      }
    });
  }

  /** Show a FOLD/FKLD object in the viewer (queued until the viewer is ready). */
  show(object: FoldFile, name: string): void {
    this.shown = { object, name };
    const payload: LoadPayload = { type: "kirigamizer:load", fkld: object, name };
    if (this.ready) this.post(payload);
    else this.pending = payload;
  }

  /** The FOLD/FKLD object currently displayed in the viewer, or null if nothing has loaded. */
  current(): { object: FoldFile; name: string } | null {
    return this.shown;
  }

  private post(payload: LoadPayload): void {
    this.iframe.contentWindow?.postMessage(payload, "*");
  }
}
