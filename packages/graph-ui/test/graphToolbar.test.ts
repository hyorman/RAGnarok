import { expect } from "chai";
import { clearVisualization, renderDocument, showEmpty } from "../src/renderer";
import { installGraphToolbar } from "../src/toolbar";
import { graphDocument, installGraphAppDom, type GraphAppDomHarness } from "./helpers/graphAppDom";

describe("graph toolbar", function () {
  let installed: GraphAppDomHarness;
  let uninstallToolbar: (() => void) | undefined;

  beforeEach(function () {
    installed = installGraphAppDom();
  });

  afterEach(function () {
    uninstallToolbar?.();
    uninstallToolbar = undefined;
    clearVisualization();
    installed.restore();
  });

  function button(): HTMLButtonElement {
    return installed.dom.window.document.querySelector<HTMLButtonElement>("#graph-refresh")!;
  }

  function loadingHidden(): boolean {
    return installed.dom.window.document.querySelector<HTMLElement>("#loading")!.hidden;
  }

  it("keeps the view-only label and asks nothing of a host that cannot re-send", function () {
    uninstallToolbar = installGraphToolbar();
    renderDocument(graphDocument());
    const root = installed.dom.window.document.querySelector<SVGGElement>(".zoom-root")!;
    const fitted = root.getAttribute("transform");
    root.setAttribute("transform", "translate(400,400) scale(3)");

    button().click();

    expect(button().textContent).to.equal("Reset view");
    expect(root.getAttribute("transform")).to.equal(fitted);
    expect(loadingHidden()).to.equal(true);
  });

  it("relabels, refits, and requests a refresh when the host can re-send", function () {
    const refreshes: number[] = [];
    uninstallToolbar = installGraphToolbar({ requestRefresh: () => refreshes.push(1) });
    renderDocument(graphDocument());
    const root = installed.dom.window.document.querySelector<SVGGElement>(".zoom-root")!;
    const fitted = root.getAttribute("transform");
    root.setAttribute("transform", "translate(400,400) scale(3)");

    button().click();

    expect(button().textContent).to.equal("Refresh");
    expect(button().title).to.equal("Reload the graph and reset the view");
    expect(root.getAttribute("transform")).to.equal(fitted);
    expect(refreshes).to.have.lengthOf(1);
    expect(loadingHidden()).to.equal(false);
  });

  // The regression this feature exists for: the button used to be wired inside
  // renderDocument, so on the empty graph a user most wants to reload it was
  // inert.
  it("requests a refresh while the graph is empty", function () {
    const refreshes: number[] = [];
    uninstallToolbar = installGraphToolbar({ requestRefresh: () => refreshes.push(1) });
    showEmpty();

    expect(() => button().click()).not.to.throw();

    expect(refreshes).to.have.lengthOf(1);
    expect(loadingHidden()).to.equal(false);
  });

  it("survives re-renders and stops on uninstall", function () {
    const refreshes: number[] = [];
    const uninstall = installGraphToolbar({ requestRefresh: () => refreshes.push(1) });
    renderDocument(graphDocument());
    clearVisualization();
    renderDocument(graphDocument());

    button().click();
    expect(refreshes).to.have.lengthOf(1);

    uninstall();
    button().click();
    expect(refreshes).to.have.lengthOf(1);
  });
});
