import { expect } from "chai";
import { JSDOM } from "jsdom";
import { createMcpGraphAppBridge } from "../src/bridges/mcpBridge";
import { startGraphApp, type GraphAppBridge } from "../src/app";
import { parseGraphVisualizationResult } from "../src/schema";
import type { GraphVisualizationDocument, GraphVisualizationGroup, GraphVisualizationNode } from "../src/documentTypes";

function graphDocument(): GraphVisualizationDocument {
  return {
    schema: "ragnarok.graph.visualization.v1",
    source: { kind: "memory", scope: "workspace" },
    nodes: [
      {
        id: "node-1",
        label: "Node 1",
        type: "concept",
        x: 10,
        y: 20,
        radius: 8,
        groupId: null,
        attributes: { confidence: 0.9, nested: { active: true } },
      },
    ],
    edges: [],
    groups: [],
    viewport: { minX: 2, minY: 12, maxX: 18, maxY: 28 },
    metadata: {
      originalNodeCount: 1,
      retainedNodeCount: 1,
      originalEdgeCount: 0,
      retainedEdgeCount: 0,
      truncated: false,
      truncationReasons: [],
      empty: false,
    },
  };
}

function emptyGraphDocument(): GraphVisualizationDocument {
  return {
    ...graphDocument(),
    nodes: [],
    viewport: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    metadata: {
      originalNodeCount: 0,
      retainedNodeCount: 0,
      originalEdgeCount: 0,
      retainedEdgeCount: 0,
      truncated: false,
      truncationReasons: [],
      empty: true,
    },
  };
}

function cloneDocument(): GraphVisualizationDocument {
  return structuredClone(graphDocument());
}

function installDom(): { dom: JSDOM; restore(): void } {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <main id="app" data-ragnarok-graph-app>
        <div id="loading">Loading graph...</div>
        <div id="status" role="status"></div>
        <div id="error" role="alert" hidden></div>
        <button id="graph-refresh" type="button">Reset view</button>
        <button id="toggle-labels" type="button">Labels</button>
        <span id="truncation-banner">stale banner</span>
        <svg id="graph"><circle id="stale-node"></circle></svg>
        <aside id="panel"><header id="panel-title">stale panel</header><dl id="panel-attrs"></dl></aside>
      </main>
    </body></html>`,
    { pretendToBeVisual: true, url: "https://app.example.test" },
  );
  const globals = [
    "window",
    "document",
    "navigator",
    "Element",
    "SVGElement",
    "ResizeObserver",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ] as const;
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const name of globals) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  }
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
    navigator: { configurable: true, value: dom.window.navigator },
    Element: { configurable: true, value: dom.window.Element },
    SVGElement: { configurable: true, value: dom.window.SVGElement },
    requestAnimationFrame: { configurable: true, value: dom.window.requestAnimationFrame.bind(dom.window) },
    cancelAnimationFrame: { configurable: true, value: dom.window.cancelAnimationFrame.bind(dom.window) },
    ResizeObserver: {
      configurable: true,
      value: class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    },
  });
  return {
    dom,
    restore() {
      dom.window.close();
      for (const name of globals) {
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

describe("graph app lifecycle", function () {
  it("registers the result handler before connect and processes a synchronous initial result", async function () {
    const installed = installDom();
    const order: string[] = [];
    let handler: ((document: GraphVisualizationDocument) => void) | undefined;
    const bridge: GraphAppBridge = {
      setDocumentHandler(next) {
        order.push("setDocumentHandler");
        handler = next;
      },
      async connect() {
        order.push("connect");
        expect(handler).not.to.equal(undefined);
        handler!(emptyGraphDocument());
      },
    };

    try {
      await startGraphApp(bridge);
      expect(order).to.deep.equal(["setDocumentHandler", "connect"]);
      expect(installed.dom.window.document.querySelector("#graph")?.textContent).to.include(
        "No graph entities in this scope/branch yet.",
      );
      expect(installed.dom.window.document.querySelector("#loading")?.hasAttribute("hidden")).to.equal(true);
    } finally {
      installed.restore();
    }
  });

  it("clears stale graph, panel, banner, and transient state before showing parse failures", async function () {
    const installed = installDom();
    let errorHandler: ((error: unknown) => void) | undefined;
    const bridge: GraphAppBridge = {
      setDocumentHandler(_next, nextError) {
        errorHandler = nextError;
      },
      async connect() {},
    };

    try {
      await startGraphApp(bridge);
      errorHandler!(new TypeError("Graph tool result text is not valid JSON."));

      const document = installed.dom.window.document;
      expect(document.querySelector("#graph")?.children).to.have.length(0);
      expect((document.querySelector("#panel") as HTMLElement).hidden).to.equal(true);
      expect(document.querySelector("#truncation-banner")?.textContent).to.equal("");
      expect(document.querySelector("#status")?.textContent).to.equal("");
      expect(document.querySelector("#error")?.textContent).to.match(/valid JSON/i);
      expect((document.querySelector("#error") as HTMLElement).hidden).to.equal(false);
    } finally {
      installed.restore();
    }
  });

  it("resets label visibility and its control for each new result", async function () {
    const installed = installDom();
    let handler: ((document: GraphVisualizationDocument) => void) | undefined;
    const bridge: GraphAppBridge = {
      setDocumentHandler(next) {
        handler = next;
      },
      async connect() {},
    };

    try {
      await startGraphApp(bridge);
      handler!(graphDocument());

      const document = installed.dom.window.document;
      expect(document.querySelector("#error")?.textContent).to.equal("");
      const toggle = document.querySelector("#toggle-labels") as HTMLButtonElement;
      toggle.click();
      expect(document.querySelector(".node-label")?.textContent).to.equal("");

      const next = cloneDocument();
      next.nodes[0].label = "Node 2";
      handler!(next);

      expect(document.querySelector(".node-label")?.textContent).to.equal("Node 2");
      toggle.click();
      expect(document.querySelector(".node-label")?.textContent).to.equal("");
    } finally {
      installed.restore();
    }
  });

  it("shows a stable visible error when the host connection rejects", async function () {
    const installed = installDom();
    const bridge: GraphAppBridge = {
      setDocumentHandler() {},
      async connect() {
        throw new Error("host unavailable");
      },
    };

    try {
      await startGraphApp(bridge, "Unable to connect to the MCP host.");
      const error = installed.dom.window.document.querySelector("#error") as HTMLElement;
      expect(error.textContent).to.equal("Unable to connect to the MCP host.");
      expect(error.hidden).to.equal(false);
    } finally {
      installed.restore();
    }
  });

  it("emits a real ui/initialize request with the graph app identity", async function () {
    const installed = installDom();
    const sent: Array<Record<string, unknown>> = [];
    const originalDebug = console.debug;
    const originalLog = console.log;
    console.debug = () => undefined;
    console.log = () => undefined;
    installed.dom.window.postMessage = ((message: Record<string, unknown>) => {
      sent.push(message);
      if (message.method !== "ui/initialize") {
        return;
      }
      const params = message.params as { protocolVersion: string };
      queueMicrotask(() => {
        installed.dom.window.dispatchEvent(
          new installed.dom.window.MessageEvent("message", {
            data: {
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: params.protocolVersion,
                hostInfo: { name: "Test Host", version: "1.0.0" },
                hostCapabilities: {},
                hostContext: {},
              },
            },
            source: installed.dom.window as unknown as MessageEventSource,
          }),
        );
      });
    }) as typeof installed.dom.window.postMessage;

    try {
      const bridge = createMcpGraphAppBridge();
      await bridge.connect();
      const initialize = sent.find((message) => message.method === "ui/initialize");
      expect(initialize, "the installed Apps SDK must emit ui/initialize").not.to.equal(undefined);
      expect((initialize!.params as { appInfo: unknown }).appInfo).to.deep.equal({
        name: "RAGnarok Graph",
        version: "0.6.0",
      });
    } finally {
      console.debug = originalDebug;
      console.log = originalLog;
      installed.restore();
    }
  });

  it("uses valid structuredContent as the authoritative representation", function () {
    const document = graphDocument();
    expect(parseGraphVisualizationResult({ structuredContent: document })).to.equal(document);
  });

  it("falls back to a JSON text content block", function () {
    const document = graphDocument();
    expect(
      parseGraphVisualizationResult({ content: [{ type: "text", text: JSON.stringify(document) }] }),
    ).to.deep.equal(document);
  });

  it("accepts canonically equal text and structured representations", function () {
    const document = graphDocument();
    const reordered = {
      metadata: document.metadata,
      viewport: document.viewport,
      groups: document.groups,
      edges: document.edges,
      nodes: document.nodes,
      source: document.source,
      schema: document.schema,
    };
    expect(
      parseGraphVisualizationResult({
        structuredContent: document,
        content: [{ type: "text", text: JSON.stringify(reordered) }],
      }),
    ).to.equal(document);
  });

  it("rejects semantic disagreement between text and structured representations", function () {
    const structuredContent = graphDocument();
    const textDocument = cloneDocument();
    textDocument.source = { kind: "memory", scope: "branch", branch: "other-branch" };
    expect(() =>
      parseGraphVisualizationResult({
        structuredContent,
        content: [{ type: "text", text: JSON.stringify(textDocument) }],
      }),
    ).to.throw(/representations do not match/i);
  });

  it("rejects tool errors, missing content, and malformed JSON", function () {
    expect(() => parseGraphVisualizationResult({ isError: true, structuredContent: graphDocument() })).to.throw(
      /tool returned an error/i,
    );
    expect(() => parseGraphVisualizationResult({})).to.throw(/did not include/i);
    expect(() => parseGraphVisualizationResult({ content: [{ type: "text", text: "{" }] })).to.throw(/valid JSON/i);
  });

  it("rejects wrong schema and source discriminants", function () {
    const wrongSchema = { ...graphDocument(), schema: "ragnarok.graph.layout.v1" };
    const wrongSource = { ...graphDocument(), source: { kind: "memory", scope: "topic" } };
    const inexactSource = {
      ...graphDocument(),
      source: { kind: "memory", scope: "workspace", branch: "must-not-exist" },
    };
    const removedKnowledgeSource = {
      ...graphDocument(),
      source: { kind: "knowledge", topicId: "topic-1", topicName: "Test Topic" },
    };
    for (const candidate of [wrongSchema, wrongSource, inexactSource, removedKnowledgeSource]) {
      expect(() => parseGraphVisualizationResult({ structuredContent: candidate })).to.throw(
        /invalid graph visualization document/i,
      );
    }
  });

  it("rejects duplicate node, edge, and group IDs", function () {
    const duplicateNodes = cloneDocument();
    duplicateNodes.nodes.push({ ...duplicateNodes.nodes[0] });

    const duplicateEdges = cloneDocument();
    duplicateEdges.edges = [
      {
        id: "edge-1",
        source: "node-1",
        target: "node-1",
        label: "self",
        weight: 1,
        attributes: {},
      },
      {
        id: "edge-1",
        source: "node-1",
        target: "node-1",
        label: "duplicate",
        weight: 1,
        attributes: {},
      },
    ];
    duplicateEdges.metadata.originalEdgeCount = 2;
    duplicateEdges.metadata.retainedEdgeCount = 2;

    const duplicateGroups = cloneDocument();
    duplicateGroups.nodes[0].groupId = 1;
    const group: GraphVisualizationGroup = { id: 1, label: "Group", color: "#123abc", retainedNodeCount: 1 };
    duplicateGroups.groups = [group, { ...group }];

    for (const candidate of [duplicateNodes, duplicateEdges, duplicateGroups]) {
      expect(() => parseGraphVisualizationResult({ structuredContent: candidate })).to.throw(/duplicate/i);
    }
  });

  it("rejects dangling edge endpoints and group references", function () {
    const danglingEdge = cloneDocument();
    danglingEdge.edges = [
      {
        id: "edge-1",
        source: "node-1",
        target: "missing-node",
        label: "missing",
        weight: 1,
        attributes: {},
      },
    ];
    danglingEdge.metadata.originalEdgeCount = 1;
    danglingEdge.metadata.retainedEdgeCount = 1;

    const danglingGroup = cloneDocument();
    danglingGroup.nodes[0].groupId = 99;

    const unreferencedGroup = cloneDocument();
    unreferencedGroup.groups = [{ id: 2, label: "Unused", color: "#abcdef", retainedNodeCount: 1 }];

    for (const candidate of [danglingEdge, danglingGroup, unreferencedGroup]) {
      expect(() => parseGraphVisualizationResult({ structuredContent: candidate })).to.throw(/dangling/i);
    }
  });

  it("rejects invalid colors and non-finite or structurally invalid numbers", function () {
    const invalidColor = cloneDocument();
    invalidColor.nodes[0].groupId = 0;
    invalidColor.groups = [{ id: 0, label: "Bad color", color: "javascript:alert(1)", retainedNodeCount: 1 }];

    const invalidCoordinate = cloneDocument();
    invalidCoordinate.nodes[0].x = Number.POSITIVE_INFINITY;

    const invalidRadius = cloneDocument();
    invalidRadius.nodes[0].radius = Number.NaN;

    const invalidWeight = cloneDocument();
    invalidWeight.edges = [
      {
        id: "edge-1",
        source: "node-1",
        target: "node-1",
        label: "bad weight",
        weight: Number.NEGATIVE_INFINITY,
        attributes: {},
      },
    ];
    invalidWeight.metadata.originalEdgeCount = 1;
    invalidWeight.metadata.retainedEdgeCount = 1;

    const invalidAttribute = cloneDocument();
    invalidAttribute.nodes[0].attributes.invalid = Number.NaN;

    const invalidCount = cloneDocument();
    invalidCount.metadata.retainedNodeCount = 1.5;

    for (const candidate of [
      invalidColor,
      invalidCoordinate,
      invalidRadius,
      invalidWeight,
      invalidAttribute,
      invalidCount,
    ]) {
      expect(() => parseGraphVisualizationResult({ structuredContent: candidate })).to.throw(
        /invalid graph visualization document/i,
      );
    }
  });

  it("rejects non-plain structured objects before canonical comparison", function () {
    class CustomAttributes {}

    for (const attributes of [new Date(0), new Map(), new Set(), new CustomAttributes()]) {
      const structuredContent = cloneDocument();
      structuredContent.nodes[0].attributes = attributes as unknown as GraphVisualizationNode["attributes"];
      const textDocument = cloneDocument();
      textDocument.nodes[0].attributes = {};

      expect(
        () =>
          parseGraphVisualizationResult({
            structuredContent,
            content: [{ type: "text", text: JSON.stringify(textDocument) }],
          }),
        Object.prototype.toString.call(attributes),
      ).to.throw(/plain object/i);
    }
  });

  it("accepts null-prototype JSON objects", function () {
    const document = cloneDocument();
    const attributes = Object.create(null) as GraphVisualizationNode["attributes"];
    attributes.owner = "platform";
    document.nodes[0].attributes = attributes;

    expect(parseGraphVisualizationResult({ structuredContent: document })).to.equal(document);
  });

  it("rejects cyclic, sparse, and unsupported structured JSON values", function () {
    const cyclic = cloneDocument();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    cyclic.nodes[0].attributes = cycle as GraphVisualizationNode["attributes"];

    const sparse = cloneDocument();
    sparse.nodes[0].attributes.values = new Array(1) as GraphVisualizationNode["attributes"][string];

    const unsupported = cloneDocument();
    unsupported.nodes[0].attributes.value = undefined as unknown as GraphVisualizationNode["attributes"][string];

    expect(() => parseGraphVisualizationResult({ structuredContent: cyclic })).to.throw(/cycles/i);
    expect(() => parseGraphVisualizationResult({ structuredContent: sparse })).to.throw(/sparse/i);
    expect(() => parseGraphVisualizationResult({ structuredContent: unsupported })).to.throw(/JSON values/i);
  });

  it("rejects metadata whose truncated flag contradicts its reasons", function () {
    const reasonsWithoutTruncation = cloneDocument();
    reasonsWithoutTruncation.metadata.truncationReasons = ["maxNodes"];

    const truncationWithoutReasons = cloneDocument();
    truncationWithoutReasons.metadata.truncated = true;

    for (const candidate of [reasonsWithoutTruncation, truncationWithoutReasons]) {
      expect(() => parseGraphVisualizationResult({ structuredContent: candidate })).to.throw(
        /truncated.*truncationReasons/i,
      );
    }
  });

  it("rejects valid truncation reasons outside canonical order", function () {
    const reorderedReasons = [
      ["maxEdges", "maxNodes"],
      ["responseBytes", "maxEdges"],
      ["responseBytes", "maxNodes", "maxEdges"],
    ] as const;

    for (const reasons of reorderedReasons) {
      const document = cloneDocument();
      document.metadata.originalNodeCount = 2;
      document.metadata.originalEdgeCount = 1;
      document.metadata.truncated = true;
      document.metadata.truncationReasons = [...reasons];

      expect(() => parseGraphVisualizationResult({ structuredContent: document }), reasons.join(",")).to.throw(
        /canonical order/i,
      );
    }
  });

  it("accepts consistent truncated metadata", function () {
    const document = cloneDocument();
    document.metadata.originalNodeCount = 2;
    document.metadata.truncated = true;
    document.metadata.truncationReasons = ["maxNodes"];

    expect(parseGraphVisualizationResult({ structuredContent: document })).to.equal(document);
  });

  it("rejects documents above the 2,000-node and 10,000-edge parser bounds", function () {
    const oversizedNodes = cloneDocument();
    const node: GraphVisualizationNode = oversizedNodes.nodes[0];
    oversizedNodes.nodes = Array.from({ length: 2_001 }, (_, index) => ({
      ...node,
      id: `node-${index}`,
    }));
    oversizedNodes.metadata.originalNodeCount = 2_001;
    oversizedNodes.metadata.retainedNodeCount = 2_001;

    const oversizedEdges = cloneDocument();
    oversizedEdges.edges = Array.from({ length: 10_001 }, (_, index) => ({
      id: `edge-${index}`,
      source: "node-1",
      target: "node-1",
      label: "self",
      weight: 1,
      attributes: {},
    }));
    oversizedEdges.metadata.originalEdgeCount = 10_001;
    oversizedEdges.metadata.retainedEdgeCount = 10_001;

    expect(() => parseGraphVisualizationResult({ structuredContent: oversizedNodes })).to.throw(/2,000 nodes/i);
    expect(() => parseGraphVisualizationResult({ structuredContent: oversizedEdges })).to.throw(/10,000 edges/i);
  });
});
