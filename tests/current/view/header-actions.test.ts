import { afterEach, describe, expect, it, vi } from "vitest";
import { HeaderActions } from "../../../src/view/header-actions.js";
import { installDom } from "./mock-dom.js";

describe("view/header-actions", () => {
  afterEach(() => {
    delete (globalThis as any).document;
    delete (globalThis as any).window;
  });

  it("appends the buttons in order with the method selector before Kirigamize ▶", () => {
    installDom();
    const header = new HeaderActions();
    header.appendActionButtons();

    const children = Array.from(header.element.children) as any[];
    // [Create pyramid] [Load sample] [<select method>] [Kirigamize ▶]
    expect(children.map((c) => c.tagName)).toEqual(["button", "button", "select", "button"]);
    expect(children[0].textContent).toBe("Create pyramid");
    expect(children[1].textContent).toBe("Load sample");
    expect(children[3].textContent).toBe("Kirigamize ▶");
    // the method selector offers the two methods
    const select = children[2];
    expect(select.classList.contains("method-select")).toBe(true);
    expect(select.children.map((o: any) => o.value)).toEqual(["normal", "bst"]);
  });

  it("fires registered handlers (Kirigamize ▶ passes the method) and toggles disabled state", () => {
    installDom();
    const header = new HeaderActions();
    header.appendActionButtons();
    const onCreate = vi.fn();
    const onSample = vi.fn();
    const onKirigamize = vi.fn();
    header.onCreatePyramid(onCreate);
    header.onLoadSample(onSample);
    header.onKirigamize(onKirigamize);

    const children = Array.from(header.element.children) as HTMLButtonElement[];
    children[0]?.click(); // Create pyramid
    children[1]?.click(); // Load sample
    header.setKirigamizeEnabled(true);
    children[3]?.click(); // Kirigamize ▶ (children[2] is the method select)

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onSample).toHaveBeenCalledTimes(1);
    expect(onKirigamize).toHaveBeenCalledTimes(1);
    expect(onKirigamize.mock.calls[0]?.length).toBe(1); // handler receives the method arg
    expect(children[3]?.disabled).toBe(false);
  });
});
