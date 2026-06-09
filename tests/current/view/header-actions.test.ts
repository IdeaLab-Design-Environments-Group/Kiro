import { afterEach, describe, expect, it, vi } from "vitest";
import { HeaderActions } from "../../../src/view/header-actions.js";
import { installDom } from "./mock-dom.js";

describe("view/header-actions", () => {
  afterEach(() => {
    delete (globalThis as any).document;
    delete (globalThis as any).window;
  });

  it("appends buttons in the documented order", () => {
    installDom();
    const header = new HeaderActions();
    header.appendActionButtons();

    const children = Array.from(header.element.children);
    expect(children.map((child) => child.textContent)).toEqual([
      "Create pyramid",
      "Load sample",
      "Kirigamize ▶",
    ]);
  });

  it("fires registered handlers and toggles kirigamize disabled state", () => {
    installDom();
    const header = new HeaderActions();
    header.appendActionButtons();
    const onCreate = vi.fn();
    const onSample = vi.fn();
    const onKirigamize = vi.fn();
    header.onCreatePyramid(onCreate);
    header.onLoadSample(onSample);
    header.onKirigamize(onKirigamize);

    const buttons = Array.from(header.element.children) as HTMLButtonElement[];
    buttons[0]?.click();
    buttons[1]?.click();
    header.setKirigamizeEnabled(true);
    buttons[2]?.click();

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onSample).toHaveBeenCalledTimes(1);
    expect(onKirigamize).toHaveBeenCalledTimes(1);
    expect(buttons[2]?.disabled).toBe(false);
  });
});
