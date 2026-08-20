import { expect } from "chai";
import sinon from "sinon";
import type { GraphVisualizationDocument } from "../src/documentTypes";
import { connectVsCodeBridge } from "../src/bridges/vscodeBridge";
import { graphDocument } from "./helpers/graphAppDom";

describe("VS Code graph bridge", function () {
  it("installs the message listener before announcing readiness", async function () {
    const events: string[] = [];
    const api = { postMessage: sinon.spy(() => events.push("ready")), setState: sinon.spy() };
    const host = fakeWindow((listener) => {
      events.push("listener");
      listener({ data: { type: "graphDocument", document: graphDocument() } } as MessageEvent);
    });
    const renderDocument = sinon.spy((_document: GraphVisualizationDocument) => undefined);

    await connectVsCodeBridge(api, host, renderDocument);

    expect(events.slice(0, 2)).to.deep.equal(["listener", "ready"]);
    expect(api.setState.calledOnceWithExactly(graphDocument())).to.equal(true);
    expect(renderDocument.calledOnce).to.equal(true);
  });

  it("restores persisted state before readiness and ignores invalid messages", async function () {
    const restored = graphDocument();
    const api = {
      getState: sinon.stub().returns(restored),
      setState: sinon.spy(),
      postMessage: sinon.spy(),
    };
    let listener: ((event: MessageEvent) => void) | undefined;
    const host = fakeWindow((next) => {
      listener = next;
    });
    const renderDocument = sinon.spy((_document: GraphVisualizationDocument) => undefined);

    await connectVsCodeBridge(api, host, renderDocument);
    listener!({ data: { type: "graphDocument", document: { schema: "wrong" } } } as MessageEvent);
    listener!({ data: { type: "other", document: graphDocument() } } as MessageEvent);

    expect(renderDocument.calledOnceWithExactly(restored)).to.equal(true);
    expect(api.setState.called).to.equal(false);
    expect(api.postMessage.calledOnceWithExactly({ type: "ready" })).to.equal(true);
  });
});

function fakeWindow(onListener: (listener: (event: MessageEvent) => void) => void): Pick<Window, "addEventListener"> {
  return {
    addEventListener(_type: "message", listener: EventListenerOrEventListenerObject) {
      onListener(listener as (event: MessageEvent) => void);
    },
  } as Pick<Window, "addEventListener">;
}
