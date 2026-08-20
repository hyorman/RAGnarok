import { expect } from "chai";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { zoomTransform } from "d3-zoom";
import { clearVisualization, renderDocument, resetActiveView, showEmpty, showError } from "../src/renderer";
import { createViewport } from "../src/viewport";
import { dispatchPointer, graphDocument, installGraphAppDom, type GraphAppDomHarness } from "./helpers/graphAppDom";

describe("graph app renderer", function () {
  let installed: GraphAppDomHarness;

  beforeEach(function () {
    installed = installGraphAppDom();
  });

  afterEach(function () {
    clearVisualization();
    installed.restore();
  });

  it("generates exactly one self-contained responsive app shell", function () {
    const graphAppHtml = generatedMcpHtml();
    expect(graphAppHtml.match(/data-ragnarok-graph-app/g)).to.have.length(1);
    expect(graphAppHtml).to.include("width: min(320px, calc(100vw - 24px));");
    expect(graphAppHtml).to.include("env(safe-area-inset-");
    expect(graphAppHtml).to.include("#graph {");
    expect(graphAppHtml).to.include("min-height: 0;");
    expect(graphAppHtml).to.match(/#panel-close\s*{[^}]*min-height:\s*44px;/s);
    expect(graphAppHtml).to.match(
      /@media \(max-width: 560px\)[\s\S]*?#panel\s*{[^}]*right:\s*calc\(12px \+ env\(safe-area-inset-right\)\);/,
    );
    expect(graphAppHtml).to.match(/#panel\s*{[^}]*max-height:\s*calc\(100% - 24px - env\(safe-area-inset-bottom\)\);/);
    expect(graphAppHtml).not.to.match(/<script\s+[^>]*src\s*=/);
  });

  it("checks generated bundle drift without writing the bundle", function () {
    const packageRoot = process.cwd().endsWith(path.join("packages", "graph-ui"))
      ? process.cwd()
      : path.join(process.cwd(), "packages", "graph-ui");
    const script = path.join(packageRoot, "build.mjs");
    const outputs = [
      path.join(packageRoot, "..", "mcp-server", "src", "ui", "graphAppBundle.ts"),
      path.join(packageRoot, "..", "..", "media", "memoryGraph.js"),
      path.join(packageRoot, "..", "..", "media", "memoryGraph.css"),
    ];
    const before = outputs.map((output) => statSync(output, { bigint: true }).mtimeNs);

    execFileSync(process.execPath, [script, "--check"], { cwd: packageRoot, stdio: "pipe" });

    expect(outputs.map((output) => statSync(output, { bigint: true }).mtimeNs)).to.deep.equal(before);
  });

  it("generates a host-specific VS bundle and the unchanged shared stylesheet", function () {
    const root = repositoryRoot();
    const script = readFileSync(path.join(root, "media", "memoryGraph.js"), "utf8");
    const css = readFileSync(path.join(root, "media", "memoryGraph.css"), "utf8");

    expect(script).to.include("graphDocument");
    expect(script).to.include("ready");
    expect(script).not.to.include("ontoolresult");
    expect(script).not.to.include("ui/initialize");
    expect(css).to.equal(readFileSync(path.join(root, "packages", "graph-ui", "src", "styles.css"), "utf8"));
  });

  it("renders resolved edge endpoints and midpoint labels through the real zoom path", function () {
    const graph = graphDocument();

    expect(() => renderDocument(graph)).not.to.throw();

    const line = installed.dom.window.document.querySelector<SVGLineElement>("line.edge")!;
    const edgeLabel = installed.dom.window.document.querySelector<SVGTextElement>(".edge-label")!;
    const source = graph.nodes[0];
    const target = graph.nodes[1];
    expect(line.getAttribute("x1")).to.equal(String(source.x));
    expect(line.getAttribute("y1")).to.equal(String(source.y));
    expect(line.getAttribute("x2")).to.equal(String(target.x));
    expect(line.getAttribute("y2")).to.equal(String(target.y));
    expect(edgeLabel.getAttribute("x")).to.equal(String((source.x + target.x) / 2));
    expect(edgeLabel.getAttribute("y")).to.equal(String((source.y + target.y) / 2));

    const transform = installed.dom.window.document.querySelector(".zoom-root")?.getAttribute("transform") ?? "";
    expect(transform).to.match(/^translate\([-+\d.eE]+,[-+\d.eE]+\) scale\([-+\d.eE]+\)$/);
    expect(transform).not.to.include("NaN");
    expect(transform).not.to.include("Infinity");
    expect(transform).not.to.equal("translate(0,0) scale(1)");
  });

  for (const reason of ["maxEdges", "responseBytes"] as const) {
    it(`reports retained edge counts for edge-only ${reason} truncation`, function () {
      const graph = graphDocument();
      graph.metadata.originalEdgeCount = 4;
      graph.metadata.truncated = true;
      graph.metadata.truncationReasons = [reason];

      renderDocument(graph);

      expect(installed.dom.window.document.querySelector("#truncation-banner")?.textContent).to.equal(
        "Showing 2 of 2 nodes and 1 of 4 edges",
      );
    });
  }

  it("refits on reset, label visibility changes, and resize", function () {
    renderDocument(graphDocument());
    const document = installed.dom.window.document;
    const svg = document.querySelector<SVGSVGElement>("#graph")!;
    const root = document.querySelector<SVGGElement>(".zoom-root")!;
    const initialFit = root.getAttribute("transform");

    zoomToScale(installed, svg, 1);
    expect(root.getAttribute("transform")).not.to.equal(initialFit);
    resetActiveView();
    expect(root.getAttribute("transform")).to.equal(initialFit);

    const labels = document.querySelector<HTMLButtonElement>("#toggle-labels")!;
    labels.click();
    const withoutLabels = root.getAttribute("transform");
    expect(labels.getAttribute("aria-pressed")).to.equal("false");
    expect(document.querySelector<SVGTextElement>(".node-label")?.textContent).to.equal("");
    expect(withoutLabels).not.to.equal(initialFit);

    installed.setSize(500, 300);
    installed.resizeObservers[0].trigger();
    const resizedFit = root.getAttribute("transform");
    expect(resizedFit).not.to.equal(withoutLabels);
    zoomToScale(installed, svg, 1);
    resetActiveView();
    expect(root.getAttribute("transform")).to.equal(resizedFit);
  });

  it("unions authoritative and independently measured bounds for degenerate and extreme geometry", function () {
    const document = installed.dom.window.document;
    const svg = document.querySelector<SVGSVGElement>("#graph")!;
    const cases = [
      {
        name: "zero-size single node",
        authoritative: { minX: -20, minY: -30, maxX: -20, maxY: -30 },
        measured: { x: 10, y: 5, width: 0, height: 0 },
      },
      {
        name: "one-dimensional graph",
        authoritative: { minX: -100, minY: 50, maxX: 100, maxY: 50 },
        measured: { x: -2, y: 40, width: 4, height: 20 },
      },
      {
        name: "tiny negative graph",
        authoritative: { minX: -2e-12, minY: -3e-12, maxX: -1e-12, maxY: -3e-12 },
        measured: { x: -4e-12, y: -5e-12, width: 1e-12, height: 1e-12 },
      },
      {
        name: "extreme finite graph",
        authoritative: {
          minX: -Number.MAX_VALUE,
          minY: -Number.MAX_VALUE,
          maxX: Number.MAX_VALUE,
          maxY: -Number.MAX_VALUE,
        },
        measured: { x: -1, y: -1, width: 2, height: 2 },
      },
    ];

    for (const testCase of cases) {
      svg.replaceChildren();
      const root = document.createElementNS("http://www.w3.org/2000/svg", "g");
      const bounds = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      bounds.setAttribute("class", "viewport-bounds");
      bounds.setAttribute("x", String(testCase.authoritative.minX));
      bounds.setAttribute("y", String(testCase.authoritative.minY));
      bounds.setAttribute("width", String(testCase.authoritative.maxX - testCase.authoritative.minX));
      bounds.setAttribute("height", String(testCase.authoritative.maxY - testCase.authoritative.minY));
      if (testCase.name !== "one-dimensional graph") {
        bounds.setAttribute("data-min-x", String(testCase.authoritative.minX));
        bounds.setAttribute("data-min-y", String(testCase.authoritative.minY));
        bounds.setAttribute("data-max-x", String(testCase.authoritative.maxX));
        bounds.setAttribute("data-max-y", String(testCase.authoritative.maxY));
      }
      root.append(bounds);
      Object.defineProperty(root, "getBBox", {
        configurable: true,
        value: () => domRect(testCase.measured),
      });
      svg.append(root);
      const viewport = createViewport(svg, root);

      viewport.fit();

      const actual = zoomTransform(svg);
      const expected = expectedFit(testCase.authoritative, testCase.measured, 800, 600);
      expect(Number.isFinite(actual.k), `${testCase.name} scale`).to.equal(true);
      expect(Number.isFinite(actual.x), `${testCase.name} x`).to.equal(true);
      expect(Number.isFinite(actual.y), `${testCase.name} y`).to.equal(true);
      expect(actual.k, `${testCase.name} scale`).to.be.closeTo(expected.k, 1e-12);
      expect(actual.x, `${testCase.name} x`).to.be.closeTo(expected.x, Math.max(1e-9, Math.abs(expected.x) * 1e-12));
      expect(actual.y, `${testCase.name} y`).to.be.closeTo(expected.y, Math.max(1e-9, Math.abs(expected.y) * 1e-12));
      viewport.destroy();
    }
  });

  it("suppresses exactly the delayed compatibility click after scaled pointer drag", async function () {
    const graph = graphDocument();
    renderDocument(graph);
    const document = installed.dom.window.document;
    const svg = document.querySelector<SVGSVGElement>("#graph")!;
    const node = document.querySelector<SVGGElement>('[data-node-id="source"]')!;
    const line = document.querySelector<SVGLineElement>("line.edge")!;
    const edgeLabel = document.querySelector<SVGTextElement>(".edge-label")!;
    zoomToScale(installed, svg, 2);
    expect(zoomTransform(svg).k).to.be.closeTo(2, 1e-9);

    let bubbledPointerDown = 0;
    svg.addEventListener("pointerdown", () => {
      bubbledPointerDown += 1;
    });
    const down = dispatchPointer(installed, node, "pointerdown", { pointerId: 7, clientX: 20, clientY: 30 });
    expect(down.defaultPrevented).to.equal(true);
    expect(bubbledPointerDown).to.equal(0);
    expect(installed.pointerCaptures).to.deep.equal([{ element: node, pointerId: 7 }]);

    dispatchPointer(installed, document.body, "pointermove", {
      pointerId: 7,
      clientX: 40,
      clientY: 40,
    });
    expect(node.getAttribute("transform")).to.equal("translate(-90,-35)");
    expect(line.getAttribute("x1")).to.equal("-90");
    expect(line.getAttribute("y1")).to.equal("-35");
    expect(line.getAttribute("x2")).to.equal("100");
    expect(line.getAttribute("y2")).to.equal("40");
    expect(edgeLabel.getAttribute("x")).to.equal("5");
    expect(edgeLabel.getAttribute("y")).to.equal("2.5");

    dispatchPointer(installed, document.body, "pointerup", { pointerId: 7, clientX: 40, clientY: 40 });
    expect(installed.pointerReleases).to.deep.equal([{ element: node, pointerId: 7 }]);
    await Promise.resolve();
    node.dispatchEvent(new installed.dom.window.MouseEvent("click", { bubbles: true }));
    expect(document.querySelector<HTMLElement>("#panel")!.hidden).to.equal(true);
    node.dispatchEvent(new installed.dom.window.MouseEvent("click", { bubbles: true }));
    expect(document.querySelector<HTMLElement>("#panel")!.hidden).to.equal(false);
    document.querySelector<HTMLButtonElement>("#panel-close")!.click();

    dispatchPointer(installed, node, "pointerdown", { pointerId: 8, clientX: 40, clientY: 40 });
    dispatchPointer(installed, document.body, "pointermove", { pointerId: 8, clientX: 42, clientY: 42 });
    dispatchPointer(installed, document.body, "pointerup", { pointerId: 8, clientX: 42, clientY: 42 });
    await new Promise<void>((resolve) => installed.dom.window.setTimeout(resolve, 0));
    node.dispatchEvent(new installed.dom.window.MouseEvent("click", { bubbles: true }));
    expect(document.querySelector<HTMLElement>("#panel")!.hidden).to.equal(false);
    document.querySelector<HTMLButtonElement>("#panel-close")!.click();

    const settledTransform = node.getAttribute("transform");
    dispatchPointer(installed, document.body, "pointermove", {
      pointerId: 7,
      clientX: 80,
      clientY: 80,
    });
    expect(node.getAttribute("transform")).to.equal(settledTransform);
  });

  it("keeps the viewport stable for node-originated touch drag while background touch still pans", function () {
    Object.defineProperty(installed.dom.window.navigator, "maxTouchPoints", { configurable: true, value: 1 });
    renderDocument(graphDocument());
    const document = installed.dom.window.document;
    const svg = document.querySelector<SVGSVGElement>("#graph")!;
    const root = document.querySelector<SVGGElement>(".zoom-root")!;
    const node = document.querySelector<SVGGElement>('[data-node-id="source"]')!;
    const initialViewportTransform = root.getAttribute("transform");

    dispatchPointer(installed, node, "pointerdown", { pointerId: 12, clientX: 20, clientY: 30 });
    dispatchTouch(installed, node, "touchstart", 12, 20, 30);
    dispatchPointer(installed, document.body, "pointermove", { pointerId: 12, clientX: 40, clientY: 40 });
    dispatchTouch(installed, node, "touchmove", 12, 40, 40);

    expect(node.getAttribute("transform")).not.to.equal("translate(-100,-40)");
    expect(root.getAttribute("transform")).to.equal(initialViewportTransform);

    dispatchTouch(installed, node, "touchend", 12, 40, 40, false);
    dispatchPointer(installed, document.body, "pointerup", { pointerId: 12, clientX: 40, clientY: 40 });
    dispatchTouch(installed, svg, "touchstart", 13, 100, 100);
    dispatchTouch(installed, svg, "touchmove", 13, 130, 115);
    expect(root.getAttribute("transform")).not.to.equal(initialViewportTransform);
    dispatchTouch(installed, svg, "touchend", 13, 130, 115, false);
  });

  it("updates only incident geometry when dragging a sparse node in a 10,000-edge graph", function () {
    this.timeout(30000);
    const graph = graphDocument();
    graph.nodes.push(
      { ...graph.nodes[0], id: "other-source", label: "Other source", x: -50, y: 100 },
      { ...graph.nodes[1], id: "other-target", label: "Other target", x: 50, y: 100 },
    );
    graph.edges.push(
      ...Array.from({ length: 9_999 }, (_, index) => ({
        ...graph.edges[0],
        id: `unrelated-${index}`,
        source: "other-source",
        target: "other-target",
      })),
    );
    graph.groups[0].retainedNodeCount = 4;
    graph.metadata.originalNodeCount = 4;
    graph.metadata.retainedNodeCount = 4;
    graph.metadata.originalEdgeCount = 10_000;
    graph.metadata.retainedEdgeCount = 10_000;
    renderDocument(graph);

    const document = installed.dom.window.document;
    const node = document.querySelector<SVGGElement>('[data-node-id="source"]')!;
    const lines = Array.from(document.querySelectorAll<SVGLineElement>("line.edge"));
    let disconnectedGeometryReads = 0;
    for (const line of lines.slice(1)) {
      const edge = (line as SVGLineElement & { __data__: { source: string; target: string } }).__data__;
      const source = edge.source;
      const target = edge.target;
      Object.defineProperties(edge, {
        source: {
          configurable: true,
          get() {
            disconnectedGeometryReads += 1;
            return source;
          },
        },
        target: {
          configurable: true,
          get() {
            disconnectedGeometryReads += 1;
            return target;
          },
        },
      });
    }

    dispatchPointer(installed, node, "pointerdown", { pointerId: 14, clientX: 10, clientY: 10 });
    dispatchPointer(installed, document.body, "pointermove", { pointerId: 14, clientX: 20, clientY: 20 });
    dispatchPointer(installed, document.body, "pointerup", { pointerId: 14, clientX: 20, clientY: 20 });

    expect(lines[0].getAttribute("x1")).not.to.equal("-100");
    expect(disconnectedGeometryReads).to.equal(0);
  });

  it("ends dragging when pointer capture is lost", function () {
    renderDocument(graphDocument());
    const document = installed.dom.window.document;
    const node = document.querySelector<SVGGElement>('[data-node-id="source"]')!;
    dispatchPointer(installed, node, "pointerdown", { pointerId: 11, clientX: 10, clientY: 10 });
    dispatchPointer(installed, node, "pointermove", { pointerId: 11, clientX: 20, clientY: 20 });
    const movedTransform = node.getAttribute("transform");

    installed.losePointerCapture(node, 11);
    dispatchPointer(installed, document.body, "pointermove", { pointerId: 11, clientX: 40, clientY: 40 });

    expect(node.getAttribute("transform")).to.equal(movedTransform);
  });

  it("cancels an active D3 mouse pan before replacing the render", function () {
    renderDocument(graphDocument());
    const document = installed.dom.window.document;
    const svg = document.querySelector<SVGSVGElement>("#graph")!;
    const oldRoot = document.querySelector<SVGGElement>(".zoom-root")!;
    const initialTransform = oldRoot.getAttribute("transform");
    svg.dispatchEvent(mouseEvent(installed, "mousedown", 100, 100, 1));
    installed.dom.window.dispatchEvent(mouseEvent(installed, "mousemove", 120, 110, 1));
    expect(oldRoot.getAttribute("transform")).not.to.equal(initialTransform);

    renderDocument(graphDocument());
    const oldTransformAtReplacement = oldRoot.getAttribute("transform");
    const newRoot = document.querySelector<SVGGElement>(".zoom-root")!;
    const newTransformAtReplacement = newRoot.getAttribute("transform");
    installed.dom.window.dispatchEvent(mouseEvent(installed, "mousemove", 180, 170, 1));

    expect(oldRoot.isConnected).to.equal(false);
    expect(oldRoot.getAttribute("transform")).to.equal(oldTransformAtReplacement);
    expect(newRoot.getAttribute("transform")).to.equal(newTransformAtReplacement);
  });

  it("clears stale panel, status, observers, and active pointer state across results", function () {
    renderDocument(graphDocument(true));
    const document = installed.dom.window.document;
    const oldNode = document.querySelector<SVGGElement>('[data-node-id="source"]')!;
    oldNode.dispatchEvent(new installed.dom.window.MouseEvent("click", { bubbles: true }));
    expect(document.querySelector<HTMLElement>("#panel")!.hidden).to.equal(false);
    expect(document.querySelector("#truncation-banner")?.textContent).to.include("2 of 5");
    dispatchPointer(installed, oldNode, "pointerdown", { pointerId: 9, clientX: 0, clientY: 0 });

    showEmpty();
    expect(document.querySelector<HTMLElement>("#panel")!.hidden).to.equal(true);
    expect(document.querySelector("#truncation-banner")?.textContent).to.equal("");
    expect(document.querySelector("#status")?.textContent).not.to.include("2 nodes");
    expect(document.querySelector("#graph")?.textContent).to.include("No graph entities in this scope/branch yet.");
    expect(installed.resizeObservers[0].disconnected).to.equal(true);
    expect(installed.pointerReleases).to.deep.include({ element: oldNode, pointerId: 9 });

    renderDocument(graphDocument(true));
    const currentNode = document.querySelector<SVGGElement>('[data-node-id="source"]')!;
    currentNode.dispatchEvent(new installed.dom.window.MouseEvent("click", { bubbles: true }));
    showError("Unsafe <script>must stay text</script>");
    const error = document.querySelector<HTMLElement>("#error")!;
    expect(error.textContent).to.equal("Unsafe <script>must stay text</script>");
    expect(error.querySelector("script")).to.equal(null);
    expect(error.hidden).to.equal(false);
    expect(document.querySelector("#graph .node")).to.equal(null);
    expect(document.querySelector<HTMLElement>("#panel")!.hidden).to.equal(true);
    expect(document.querySelector("#truncation-banner")?.textContent).to.equal("");
    expect(document.querySelector("#status")?.textContent).to.equal("");
    expect(installed.resizeObservers[1].disconnected).to.equal(true);
  });
});

function generatedMcpHtml(): string {
  const root = repositoryRoot();
  const source = readFileSync(path.join(root, "packages", "mcp-server", "src", "ui", "graphAppBundle.ts"), "utf8");
  const match = /export const GRAPH_APP_HTML = (.*);\n$/.exec(source);
  expect(match, "generated MCP graph export").not.to.equal(null);
  return JSON.parse(match![1]) as string;
}

function repositoryRoot(): string {
  return process.cwd().endsWith(path.join("packages", "graph-ui"))
    ? path.join(process.cwd(), "..", "..")
    : process.cwd();
}

function zoomToScale(installed: GraphAppDomHarness, svg: SVGSVGElement, scale: number): void {
  const current = zoomTransform(svg).k;
  const deltaY = -Math.log2(scale / current) / 0.002;
  svg.dispatchEvent(
    new installed.dom.window.WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      view: installed.dom.window as unknown as Window,
      clientX: svg.clientWidth / 2,
      clientY: svg.clientHeight / 2,
      deltaY,
    }),
  );
}

function domRect(box: { x: number; y: number; width: number; height: number }): DOMRect {
  return {
    ...box,
    top: box.y,
    left: box.x,
    right: box.x + box.width,
    bottom: box.y + box.height,
    toJSON: () => box,
  } as DOMRect;
}

function mouseEvent(
  installed: GraphAppDomHarness,
  type: "mousedown" | "mousemove" | "mouseup",
  clientX: number,
  clientY: number,
  buttons: number,
): MouseEvent {
  return new installed.dom.window.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    view: installed.dom.window as unknown as Window,
    clientX,
    clientY,
    button: 0,
    buttons,
  });
}

function dispatchTouch(
  installed: GraphAppDomHarness,
  target: EventTarget,
  type: "touchstart" | "touchmove" | "touchend",
  identifier: number,
  clientX: number,
  clientY: number,
  active = true,
): Event {
  const touch = { identifier, clientX, clientY };
  const event = new installed.dom.window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: { value: active ? [touch] : [] },
    changedTouches: { value: [touch] },
  });
  target.dispatchEvent(event);
  return event;
}

function expectedFit(
  authoritative: { minX: number; minY: number; maxX: number; maxY: number },
  measured: { x: number; y: number; width: number; height: number },
  viewportWidth: number,
  viewportHeight: number,
): { k: number; x: number; y: number } {
  const minX = Math.min(authoritative.minX, measured.x);
  const minY = Math.min(authoritative.minY, measured.y);
  const maxX = Math.max(authoritative.maxX, measured.x + measured.width);
  const maxY = Math.max(authoritative.maxY, measured.y + measured.height);
  const graphWidth = Math.max(maxX - minX, 1);
  const graphHeight = Math.max(maxY - minY, 1);
  const k = Math.max(0.2, Math.min(4, (viewportWidth - 96) / graphWidth, (viewportHeight - 96) / graphHeight));
  const centerX = minX / 2 + maxX / 2;
  const centerY = minY / 2 + maxY / 2;
  return { k, x: viewportWidth / 2 - centerX * k, y: viewportHeight / 2 - centerY * k };
}
