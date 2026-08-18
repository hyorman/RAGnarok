import { expect } from "chai";
import { executeQueryTool, type QueryToolInput } from "../src/tools/index";
import { TopicEmptyError } from "../src/agents/ragQueryService";

function fakeService(behaviour: { result?: unknown; throws?: Error }) {
  const calls: Array<{ params: unknown; workspaceContext?: string; signal?: AbortSignal }> = [];
  return {
    calls,
    executeQuery: async (params: unknown, workspaceContext?: string, signal?: AbortSignal) => {
      calls.push({ params, workspaceContext, signal });
      if (behaviour.throws) {
        throw behaviour.throws;
      }
      return behaviour.result;
    },
  };
}

/**
 * Every rejection must happen before the service is touched, so each case also
 * pins that no query was dispatched.
 */
async function expectRejection(input: QueryToolInput, pattern: RegExp): Promise<void> {
  const service = fakeService({ result: {} });
  let thrown: unknown;
  try {
    await executeQueryTool(input, { ragQueryService: service as never });
  } catch (error) {
    thrown = error;
  }
  expect(thrown, "should have thrown").to.be.instanceOf(Error);
  expect((thrown as Error).message).to.match(pattern);
  expect(service.calls).to.be.empty;
}

describe("query tool", function () {
  it("passes validated params, workspace context, and abort signal through", async function () {
    const result = { results: [], query: "q", topicName: "T", topicMatched: "exact" };
    const service = fakeService({ result });
    const signal = new AbortController().signal;
    const payload = await executeQueryTool(
      { topic: " T ", query: " q ", topK: 5, retrievalStrategy: "hybrid" },
      { ragQueryService: service as never, workspaceContext: "ctx" },
      signal,
    );
    expect(payload).to.deep.equal(result);
    expect(service.calls[0].params).to.deep.equal({
      topic: "T",
      query: "q",
      topK: 5,
      retrievalStrategy: "hybrid",
    });
    expect(service.calls[0].workspaceContext).to.equal("ctx");
    expect(service.calls[0].signal).to.equal(signal);
  });

  it("omits workspace context when the host supplies none", async function () {
    const service = fakeService({ result: { results: [], query: "q", topicName: "T", topicMatched: "exact" } });
    await executeQueryTool({ topic: "T", query: "q" }, { ragQueryService: service as never });
    expect(service.calls[0].workspaceContext).to.equal(undefined);
    // Optional params are omitted, not sent as undefined, so the service's own
    // `params.topK ?? config` fallbacks still fire.
    expect(service.calls[0].params).to.deep.equal({ topic: "T", query: "q" });
  });

  it("accepts every supported retrievalStrategy", async function () {
    for (const retrievalStrategy of ["vector", "hybrid", "bm25"]) {
      const service = fakeService({ result: {} });
      await executeQueryTool({ topic: "T", query: "q", retrievalStrategy }, { ragQueryService: service as never });
      expect(service.calls[0].params).to.deep.equal({ topic: "T", query: "q", retrievalStrategy });
    }
  });

  it("returns an honest empty payload with no fabricated agenticMetadata", async function () {
    const service = fakeService({ throws: new TopicEmptyError("Docs") });
    const payload = await executeQueryTool({ topic: "Docs", query: "q" }, { ragQueryService: service as never });
    expect(payload).to.deep.equal({
      query: "q",
      topicName: "Docs",
      topicMatched: "fallback",
      results: [],
      empty: true,
      message: new TopicEmptyError("Docs").message,
    });
    expect(payload).to.not.have.property("agenticMetadata");
  });

  it("reports the resolved topic name from the error, not the requested one", async function () {
    const service = fakeService({ throws: new TopicEmptyError("Docs") });
    const payload = await executeQueryTool(
      { topic: "docs-requested", query: "q" },
      { ragQueryService: service as never },
    );
    expect((payload as { topicName: string }).topicName).to.equal("Docs");
  });

  it("rethrows errors that are not TopicEmptyError", async function () {
    const boom = new Error("boom");
    const service = fakeService({ throws: boom });
    let thrown: unknown;
    try {
      await executeQueryTool({ topic: "T", query: "q" }, { ragQueryService: service as never });
    } catch (error) {
      thrown = error;
    }
    // Identity, not just the message: a re-wrap would lose the error type that
    // hosts rely on to classify failures.
    expect(thrown).to.equal(boom);
  });

  it("rejects a non-string topic", async function () {
    await expectRejection({ topic: 42 as unknown as string, query: "q" }, /'topic' must be a string/);
  });

  it("rejects a blank topic", async function () {
    await expectRejection({ topic: "   ", query: "q" }, /'topic'/);
  });

  it("rejects an over-long topic", async function () {
    await expectRejection({ topic: "t".repeat(201), query: "q" }, /'topic' must not exceed 200 characters/);
  });

  it("rejects an over-long query", async function () {
    await expectRejection({ topic: "T", query: "x".repeat(20_001) }, /20000/);
  });

  it("rejects a non-integer topK", async function () {
    await expectRejection({ topic: "T", query: "q", topK: 2.5 }, /'topK'/);
  });

  it("rejects a topK below the minimum", async function () {
    await expectRejection({ topic: "T", query: "q", topK: 0 }, /'topK'/);
  });

  it("rejects a topK above the maximum", async function () {
    await expectRejection({ topic: "T", query: "q", topK: 21 }, /'topK'/);
  });

  it("rejects an unknown retrievalStrategy", async function () {
    await expectRejection({ topic: "T", query: "q", retrievalStrategy: "magic" }, /'retrievalStrategy'/);
  });
});
