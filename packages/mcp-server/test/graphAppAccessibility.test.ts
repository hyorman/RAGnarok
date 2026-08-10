import { expect } from "chai";
import { clearVisualization, renderDocument, showEmpty, showError } from "../src/ui/graphApp/renderer";
import { graphDocument, installGraphAppDom, type GraphAppDomHarness } from "./helpers/graphAppDom";

describe("graph app accessibility", function () {
  let installed: GraphAppDomHarness;

  beforeEach(function () {
    installed = installGraphAppDom();
  });

  afterEach(function () {
    clearVisualization();
    installed.restore();
  });

  it("maintains one roving tab stop and moves graph focus over nodes then edges", function () {
    renderDocument(graphDocument());
    const document = installed.dom.window.document;
    const items = Array.from(document.querySelectorAll<SVGElement>('[data-graph-item="true"]'));
    expect(items).to.have.length(3);
    expect(items.filter((item) => item.getAttribute("tabindex") === "0")).to.have.length(1);
    expect(items.filter((item) => item.getAttribute("tabindex") === "-1")).to.have.length(2);

    const source = document.querySelector<SVGElement>('[data-node-id="source"]')!;
    const target = document.querySelector<SVGElement>('[data-node-id="target"]')!;
    const edge = document.querySelector<SVGElement>('[data-edge-id="edge-1"]')!;
    expect(source.getAttribute("tabindex")).to.equal("0");
    source.focus();
    keydown(installed, source, "ArrowRight");
    expect(document.activeElement).to.equal(target);
    expect(target.getAttribute("tabindex")).to.equal("0");
    expect(source.getAttribute("tabindex")).to.equal("-1");
    keydown(installed, target, "ArrowDown");
    expect(document.activeElement).to.equal(edge);
    keydown(installed, edge, "ArrowLeft");
    expect(document.activeElement).to.equal(target);
    expect(items.filter((item) => item.getAttribute("tabindex") === "0")).to.have.length(1);
  });

  it("opens details with Enter and Space, then restores invoking focus on close or Escape", function () {
    renderDocument(graphDocument());
    const document = installed.dom.window.document;
    const source = document.querySelector<SVGElement>('[data-node-id="source"]')!;
    const edge = document.querySelector<SVGElement>('[data-edge-id="edge-1"]')!;
    const panel = document.querySelector<HTMLElement>("#panel")!;
    const close = document.querySelector<HTMLButtonElement>("#panel-close")!;

    source.focus();
    keydown(installed, source, "Enter");
    expect(panel.hidden).to.equal(false);
    expect(document.activeElement).to.equal(close);
    expect(source.classList.contains("selected")).to.equal(true);
    close.click();
    expect(panel.hidden).to.equal(true);
    expect(document.activeElement).to.equal(source);
    expect(source.classList.contains("selected")).to.equal(false);

    edge.focus();
    keydown(installed, edge, " ");
    expect(panel.hidden).to.equal(false);
    expect(document.activeElement).to.equal(close);
    expect(edge.classList.contains("selected")).to.equal(true);
    keydown(installed, close, "Escape");
    expect(panel.hidden).to.equal(true);
    expect(document.activeElement).to.equal(edge);
    expect(edge.classList.contains("selected")).to.equal(false);
  });

  it("moves the roving tab stop to a clicked item before restoring focus", function () {
    renderDocument(graphDocument());
    const document = installed.dom.window.document;
    const edge = document.querySelector<SVGElement>('[data-edge-id="edge-1"]')!;
    edge.dispatchEvent(new installed.dom.window.MouseEvent("click", { bubbles: true }));

    const items = Array.from(document.querySelectorAll<SVGElement>('[data-graph-item="true"]'));
    expect(
      items
        .filter((item) => item.getAttribute("tabindex") === "0")
        .map((item) => item.getAttribute("data-edge-id") ?? item.getAttribute("data-node-id")),
    ).to.deep.equal(["edge-1"]);
    expect(document.activeElement?.id).to.equal("panel-close");

    document.querySelector<HTMLButtonElement>("#panel-close")!.click();
    expect(document.activeElement?.getAttribute("data-edge-id")).to.equal("edge-1");
    expect(document.activeElement?.getAttribute("tabindex")).to.equal("0");
    expect(items.filter((item) => item.getAttribute("tabindex") === "0")).to.have.length(1);
  });

  it("renders attribute keys and values only as text", function () {
    const graph = graphDocument();
    graph.nodes[0].label = "<img src=x onerror=alert(1)>";
    graph.nodes[0].attributes = {
      "<b>owner</b>": "<script>window.compromised = true</script>",
      nested: { markup: "<img src=x>" },
    };
    renderDocument(graph);
    const document = installed.dom.window.document;
    const source = document.querySelector<SVGElement>('[data-node-id="source"]')!;
    source.dispatchEvent(new installed.dom.window.MouseEvent("click", { bubbles: true }));

    const panel = document.querySelector<HTMLElement>("#panel")!;
    expect(document.querySelector("#panel-title")?.textContent).to.equal("<img src=x onerror=alert(1)>");
    expect(panel.querySelector("img")).to.equal(null);
    expect(panel.querySelector("script")).to.equal(null);
    expect(panel.querySelector("b")).to.equal(null);
    const owner = Array.from(panel.querySelectorAll("dt")).find(
      (term) => term.textContent === "Attribute: <b>owner</b>",
    );
    expect(owner).not.to.equal(undefined);
    expect(owner?.nextElementSibling?.textContent).to.equal("<script>window.compromised = true</script>");
    expect(panel.textContent).to.include('{"markup":"<img src=x>"}');
  });

  it("preserves intrinsic details when attributes use colliding keys", function () {
    const graph = graphDocument();
    graph.nodes[0].attributes = { Type: "spoofed node type" };
    graph.edges[0].attributes = {
      Source: "spoofed source",
      Target: "spoofed target",
      Weight: "spoofed weight",
    };
    renderDocument(graph);
    const document = installed.dom.window.document;

    document
      .querySelector<SVGElement>('[data-node-id="source"]')!
      .dispatchEvent(new installed.dom.window.MouseEvent("click", { bubbles: true }));
    expect(detailValue(document, "Type")).to.equal("concept");
    expect(detailValue(document, "Attribute: Type")).to.equal("spoofed node type");
    document.querySelector<HTMLButtonElement>("#panel-close")!.click();

    document
      .querySelector<SVGElement>('[data-edge-id="edge-1"]')!
      .dispatchEvent(new installed.dom.window.MouseEvent("click", { bubbles: true }));
    expect(detailValue(document, "Source")).to.equal("Source node with a deliberately wide label");
    expect(detailValue(document, "Target")).to.equal("Target node with another deliberately wide label");
    expect(detailValue(document, "Weight")).to.equal("1.5");
    expect(detailValue(document, "Attribute: Source")).to.equal("spoofed source");
    expect(detailValue(document, "Attribute: Target")).to.equal("spoofed target");
    expect(detailValue(document, "Attribute: Weight")).to.equal("spoofed weight");
  });

  it("exposes pressed, live-status, alert, SVG, and item names", function () {
    renderDocument(graphDocument());
    const document = installed.dom.window.document;
    const toggle = document.querySelector<HTMLButtonElement>("#toggle-labels")!;
    const status = document.querySelector<HTMLElement>("#status")!;
    const svg = document.querySelector<SVGSVGElement>("#graph")!;

    expect(toggle.getAttribute("aria-pressed")).to.equal("true");
    toggle.click();
    expect(toggle.getAttribute("aria-pressed")).to.equal("false");
    toggle.click();
    expect(toggle.getAttribute("aria-pressed")).to.equal("true");
    expect(status.getAttribute("role")).to.equal("status");
    expect(status.getAttribute("aria-live")).to.equal("polite");
    expect(status.textContent).to.match(/2 nodes.*1 edge/i);
    expect(svg.getAttribute("role")).to.equal("img");
    expect(svg.getAttribute("aria-labelledby")).to.equal("graph-title graph-description");
    expect(svg.querySelector("title")?.textContent).to.equal("RAGnarok graph visualization");
    expect(svg.querySelectorAll("[aria-labelledby]")).to.have.length.greaterThan(0);

    showError("Unable to render graph.");
    const error = document.querySelector<HTMLElement>("#error")!;
    expect(error.getAttribute("role")).to.equal("alert");
    expect(error.textContent).to.equal("Unable to render graph.");
    expect(error.hidden).to.equal(false);
  });

  it("resets roving focus and panel state when a new result replaces the graph", function () {
    renderDocument(graphDocument());
    const document = installed.dom.window.document;
    const target = document.querySelector<SVGElement>('[data-node-id="target"]')!;
    target.focus();
    keydown(installed, target, "Enter");
    expect(document.querySelector<HTMLElement>("#panel")!.hidden).to.equal(false);

    renderDocument(graphDocument());
    const currentItems = Array.from(document.querySelectorAll<SVGElement>('[data-graph-item="true"]'));
    expect(currentItems.filter((item) => item.getAttribute("tabindex") === "0")).to.have.length(1);
    expect(document.querySelector('[data-node-id="source"]')?.getAttribute("tabindex")).to.equal("0");
    expect(document.querySelector<HTMLElement>("#panel")!.hidden).to.equal(true);
    expect(document.querySelector("#panel-title")?.textContent).to.equal("");
    expect(document.querySelector("#panel-attrs")?.children).to.have.length(0);
  });

  it("moves focus out of hidden details when results are replaced", function () {
    const document = installed.dom.window.document;
    const replacements = [
      () => renderDocument(graphDocument()),
      () => showEmpty(),
      () => showError("Unable to render graph."),
    ];

    for (const replace of replacements) {
      renderDocument(graphDocument());
      const source = document.querySelector<SVGElement>('[data-node-id="source"]')!;
      source.dispatchEvent(new installed.dom.window.MouseEvent("click", { bubbles: true }));
      const close = document.querySelector<HTMLButtonElement>("#panel-close")!;
      expect(document.activeElement).to.equal(close);

      replace();

      expect(document.activeElement?.id).to.equal("graph");
      expect(document.activeElement?.id).not.to.equal(close.id);
      expect(document.activeElement?.closest("[hidden]")).to.equal(null);
    }
  });

  it("keeps valid SVG names after empty and error transitions clear graph children", function () {
    const document = installed.dom.window.document;

    showEmpty();
    expectValidSvgName(document);

    showError("Unable to render graph.");
    expectValidSvgName(document);
  });
});

function keydown(installed: GraphAppDomHarness, target: EventTarget, key: string): void {
  target.dispatchEvent(
    new installed.dom.window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key,
    }),
  );
}

function expectValidSvgName(document: Document): void {
  const svg = document.querySelector<SVGSVGElement>("#graph")!;
  const references = svg.getAttribute("aria-labelledby")?.split(/\s+/) ?? [];
  if (references.length === 0) {
    expect(svg.getAttribute("role")).to.equal("img");
    expect(svg.getAttribute("aria-label")).to.be.a("string").and.not.equal("");
    return;
  }
  for (const reference of references) {
    const label = document.getElementById(reference);
    expect(label, reference).not.to.equal(null);
    expect(svg.contains(label)).to.equal(true);
    expect(label?.textContent).not.to.equal("");
  }
}

function detailValue(document: Document, key: string): string | null | undefined {
  const term = Array.from(document.querySelectorAll("#panel-attrs dt")).find(
    (candidate) => candidate.textContent === key,
  );
  return term?.nextElementSibling?.textContent;
}
