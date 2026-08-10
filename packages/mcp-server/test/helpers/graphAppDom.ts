import { JSDOM } from "jsdom";
import type { GraphVisualizationDocument } from "../../src/ui/graphApp/documentTypes";

interface TestResizeObserver {
  disconnected: boolean;
  trigger(): void;
}

export interface GraphAppDomHarness {
  dom: JSDOM;
  resizeObservers: TestResizeObserver[];
  pointerCaptures: Array<{ element: Element; pointerId: number }>;
  pointerReleases: Array<{ element: Element; pointerId: number }>;
  losePointerCapture(element: Element, pointerId: number): void;
  setSize(width: number, height: number): void;
  restore(): void;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const globalNames = [
  "window",
  "document",
  "navigator",
  "Element",
  "HTMLElement",
  "SVGElement",
  "SVGSVGElement",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "ResizeObserver",
] as const;

export function graphDocument(truncated = false): GraphVisualizationDocument {
  return {
    schema: "ragnarok.graph.visualization.v1",
    source: { kind: "memory", scope: "workspace" },
    nodes: [
      {
        id: "source",
        label: "Source node with a deliberately wide label",
        type: "concept",
        x: -100,
        y: -40,
        radius: 10,
        groupId: 0,
        attributes: { confidence: 0.9, nested: { active: true } },
      },
      {
        id: "target",
        label: "Target node with another deliberately wide label",
        type: "module",
        x: 100,
        y: 40,
        radius: 10,
        groupId: 0,
        attributes: { description: "Target details" },
      },
    ],
    edges: [
      {
        id: "edge-1",
        source: "source",
        target: "target",
        label: "depends on",
        weight: 1.5,
        attributes: { provenance: "unit test" },
      },
    ],
    groups: [{ id: 0, label: "Primary", color: "#7c3aed", retainedNodeCount: 2 }],
    viewport: { minX: -110, minY: -50, maxX: 110, maxY: 50 },
    metadata: {
      originalNodeCount: truncated ? 5 : 2,
      retainedNodeCount: 2,
      originalEdgeCount: truncated ? 4 : 1,
      retainedEdgeCount: 1,
      truncated,
      truncationReasons: truncated ? ["maxNodes"] : [],
      empty: false,
    },
  };
}

export function installGraphAppDom(): GraphAppDomHarness {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <main id="app" data-ragnarok-graph-app>
        <header id="toolbar">
          <button id="reset-view" type="button">Reset view</button>
          <button id="toggle-labels" type="button" aria-pressed="true">Labels</button>
          <span id="truncation-banner"></span>
        </header>
        <div id="loading">Loading graph...</div>
        <div id="status" role="status" aria-live="polite"></div>
        <div id="error" role="alert" hidden></div>
        <svg id="graph" role="img" aria-labelledby="graph-title graph-description">
          <title id="graph-title">RAGnarok graph visualization</title>
          <desc id="graph-description">Interactive graph of connected entities.</desc>
        </svg>
        <aside id="panel" role="dialog" aria-labelledby="panel-title" hidden>
          <button id="panel-close" type="button" aria-label="Close details">Close</button>
          <h2 id="panel-title"></h2>
          <dl id="panel-attrs"></dl>
        </aside>
      </main>
    </body></html>`,
    { pretendToBeVisual: true, url: "https://app.example.test" },
  );
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const name of globalNames) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  }

  const resizeObservers: TestResizeObserver[] = [];
  class ResizeObserverPolyfill {
    disconnected = false;
    private readonly callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      resizeObservers.push(this);
    }

    observe(): void {}

    unobserve(): void {}

    disconnect(): void {
      this.disconnected = true;
    }

    trigger(): void {
      if (!this.disconnected) {
        this.callback([], this as unknown as ResizeObserver);
      }
    }
  }

  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
    navigator: { configurable: true, value: dom.window.navigator },
    Element: { configurable: true, value: dom.window.Element },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    SVGElement: { configurable: true, value: dom.window.SVGElement },
    SVGSVGElement: { configurable: true, value: dom.window.SVGSVGElement },
    requestAnimationFrame: { configurable: true, value: dom.window.requestAnimationFrame.bind(dom.window) },
    cancelAnimationFrame: { configurable: true, value: dom.window.cancelAnimationFrame.bind(dom.window) },
    ResizeObserver: { configurable: true, value: ResizeObserverPolyfill },
  });

  const pointerCaptures: Array<{ element: Element; pointerId: number }> = [];
  const pointerReleases: Array<{ element: Element; pointerId: number }> = [];
  const capturedPointers = new WeakMap<Element, Set<number>>();
  const elementPrototype = dom.window.Element.prototype;
  if (!("setPointerCapture" in elementPrototype)) {
    Object.defineProperties(elementPrototype, {
      setPointerCapture: {
        configurable: true,
        value(this: Element, pointerId: number) {
          const pointers = capturedPointers.get(this) ?? new Set<number>();
          pointers.add(pointerId);
          capturedPointers.set(this, pointers);
          pointerCaptures.push({ element: this, pointerId });
        },
      },
      hasPointerCapture: {
        configurable: true,
        value(this: Element, pointerId: number) {
          return capturedPointers.get(this)?.has(pointerId) ?? false;
        },
      },
      releasePointerCapture: {
        configurable: true,
        value(this: Element, pointerId: number) {
          capturedPointers.get(this)?.delete(pointerId);
          pointerReleases.push({ element: this, pointerId });
        },
      },
    });
  }

  const svgPrototype = dom.window.SVGElement.prototype;
  if (!("getBBox" in svgPrototype)) {
    Object.defineProperty(svgPrototype, "getBBox", {
      configurable: true,
      value(this: SVGElement): DOMRect {
        const boxes: Box[] = [];
        if (this.matches(".zoom-root")) {
          const bounds = this.querySelector<SVGRectElement>(".viewport-bounds");
          if (bounds) {
            boxes.push({
              x: numberAttribute(bounds, "x"),
              y: numberAttribute(bounds, "y"),
              width: numberAttribute(bounds, "width"),
              height: numberAttribute(bounds, "height"),
            });
          }
          for (const label of this.querySelectorAll<SVGTextElement>(".node-label, .edge-label")) {
            if (label.style.display === "none") {
              continue;
            }
            const width = (label.textContent?.length ?? 0) * 7;
            let x = numberAttribute(label, "x") - width / 2;
            let y = numberAttribute(label, "y") - 12;
            const transform = label.parentElement?.getAttribute("transform") ?? "";
            const match = /translate\(([-+\d.eE]+)[ ,]([-+\d.eE]+)\)/.exec(transform);
            if (match) {
              x += Number(match[1]);
              y += Number(match[2]);
            }
            boxes.push({ x, y, width, height: 14 });
          }
        }
        const box = unionBoxes(boxes);
        return {
          ...box,
          top: box.y,
          left: box.x,
          right: box.x + box.width,
          bottom: box.y + box.height,
          toJSON: () => box,
        } as DOMRect;
      },
    });
  }

  const svg = dom.window.document.querySelector<SVGSVGElement>("#graph")!;
  const setSize = (width: number, height: number): void => {
    Object.defineProperties(svg, {
      clientWidth: { configurable: true, value: width },
      clientHeight: { configurable: true, value: height },
    });
  };
  setSize(800, 600);

  return {
    dom,
    resizeObservers,
    pointerCaptures,
    pointerReleases,
    losePointerCapture(element, pointerId) {
      capturedPointers.get(element)?.delete(pointerId);
      dispatchPointer(this, element, "lostpointercapture", { pointerId, clientX: 0, clientY: 0, buttons: 0 });
    },
    setSize,
    restore() {
      dom.window.close();
      for (const name of globalNames) {
        const descriptor = previous.get(name);
        if (descriptor) {
          Object.defineProperty(globalThis, name, descriptor);
        } else {
          Reflect.deleteProperty(globalThis, name);
        }
      }
    },
  };
}

export function dispatchPointer(
  harness: GraphAppDomHarness,
  target: EventTarget,
  type: string,
  init: { pointerId?: number; clientX: number; clientY: number; button?: number; buttons?: number },
): MouseEvent {
  const event = new harness.dom.window.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    view: harness.dom.window as unknown as Window,
    clientX: init.clientX,
    clientY: init.clientY,
    button: init.button ?? 0,
    buttons: init.buttons ?? (type === "pointerup" ? 0 : 1),
  });
  Object.defineProperties(event, {
    pointerId: { value: init.pointerId ?? 1 },
    isPrimary: { value: true },
  });
  target.dispatchEvent(event);
  return event;
}

function numberAttribute(element: Element, name: string): number {
  return Number(element.getAttribute(name) ?? 0);
}

function unionBoxes(boxes: Box[]): Box {
  if (boxes.length === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => box.x + box.width));
  const maxY = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
