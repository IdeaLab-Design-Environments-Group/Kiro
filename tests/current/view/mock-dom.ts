type Listener = (event: any) => void;

class MockClassList {
  private readonly names = new Set<string>();

  constructor(initial = "") {
    for (const name of initial.split(/\s+/).filter(Boolean)) this.names.add(name);
  }

  add(...names: string[]): void {
    for (const name of names) this.names.add(name);
  }

  remove(...names: string[]): void {
    for (const name of names) this.names.delete(name);
  }

  contains(name: string): boolean {
    return this.names.has(name);
  }

  toString(): string {
    return Array.from(this.names).join(" ");
  }
}

export class MockElement {
  readonly children: MockElement[] = [];
  readonly listeners = new Map<string, Listener[]>();
  classList = new MockClassList();
  className = "";
  textContent = "";
  hidden = false;
  disabled = false;
  type = "";
  accept = "";
  title = "";
  src = "";
  files?: File[];
  innerHTMLValue = "";
  contentWindow?: { postMessage: (payload: unknown, target: string) => void };

  constructor(readonly tagName: string) {}

  append(...nodes: any[]): void {
    for (const node of nodes) {
      if (node instanceof MockElement) {
        this.children.push(node);
      }
    }
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  dispatch(type: string, event: any = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  click(): void {
    this.dispatch("click", { target: this });
  }

  set innerHTML(value: string) {
    this.innerHTMLValue = value;
    this.children.length = 0;
  }

  get innerHTML(): string {
    return this.innerHTMLValue;
  }
}

export class MockDocument {
  readonly body = new MockElement("body");
  readonly created: MockElement[] = [];

  createElement(tag: string): MockElement {
    const element = new MockElement(tag);
    this.created.push(element);
    return element;
  }

  querySelector(): MockElement | null {
    return null;
  }
}

export class MockWindow {
  private readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  dispatch(type: string, event: any): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

export function installDom(): { document: MockDocument; window: MockWindow } {
  const document = new MockDocument();
  const window = new MockWindow();
  (globalThis as any).document = document;
  (globalThis as any).window = window;
  return { document, window };
}

export function childByClass(root: MockElement, className: string): MockElement | undefined {
  if (root.className.split(/\s+/).includes(className)) return root;
  for (const child of root.children) {
    const found = childByClass(child, className);
    if (found) return found;
  }
  return undefined;
}

export function childrenByTag(root: MockElement, tag: string): MockElement[] {
  const out: MockElement[] = [];
  if (root.tagName === tag) out.push(root);
  for (const child of root.children) out.push(...childrenByTag(child, tag));
  return out;
}
