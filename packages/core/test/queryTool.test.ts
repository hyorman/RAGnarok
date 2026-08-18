import { expect } from "chai";
import { executeQueryTool } from "../src/tools/index";
import { TopicEmptyError } from "../src/agents/ragQueryService";

function fakeService(behaviour: { result?: unknown; throws?: Error }) {
  const calls: Array<{ params: unknown; workspaceContext?: string }> = [];
  return {
    calls,
    executeQuery: async (params: unknown, workspaceContext?: string) => {
      calls.push({ params, workspaceContext });
      if (behaviour.throws) {
        throw behaviour.throws;
      }
      return behaviour.result;
    },
  };
}

describe("query tool", function () {
  it("passes validated params and workspace context through", async function () {
    const result = { results: [], query: "q", topicName: "T", topicMatched: "exact" };
    const service = fakeService({ result });
    const payload = await executeQueryTool(
      { topic: " T ", query: " q ", topK: 5, retrievalStrategy: "hybrid" },
      { ragQueryService: service as never, workspaceContext: "ctx" },
    );
    expect(payload).to.deep.equal(result);
    expect(service.calls[0].params).to.deep.equal({
      topic: "T",
      query: "q",
      topK: 5,
      retrievalStrategy: "hybrid",
    });
    expect(service.calls[0].workspaceContext).to.equal("ctx");
  });

  it("omits workspace context when the host supplies none", async function () {
    const service = fakeService({ result: { results: [], query: "q", topicName: "T", topicMatched: "exact" } });
    await executeQueryTool({ topic: "T", query: "q" }, { ragQueryService: service as never });
    expect(service.calls[0].workspaceContext).to.equal(undefined);
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

  it("rejects an unknown retrievalStrategy", async function () {
    const service = fakeService({ result: {} });
    try {
      await executeQueryTool(
        { topic: "T", query: "q", retrievalStrategy: "magic" },
        { ragQueryService: service as never },
      );
      expect.fail("should have thrown");
    } catch (error) {
      expect((error as Error).message).to.match(/'retrievalStrategy'/);
    }
  });

  it("rethrows errors that are not TopicEmptyError", async function () {
    const service = fakeService({ throws: new Error("boom") });
    try {
      await executeQueryTool({ topic: "T", query: "q" }, { ragQueryService: service as never });
      expect.fail("should have thrown");
    } catch (error) {
      expect((error as Error).message).to.equal("boom");
    }
  });

  it("rejects a blank topic", async function () {
    const service = fakeService({ result: {} });
    try {
      await executeQueryTool({ topic: "   ", query: "q" }, { ragQueryService: service as never });
      expect.fail("should have thrown");
    } catch (error) {
      expect((error as Error).message).to.match(/'topic'/);
    }
  });

  it("rejects an over-long query", async function () {
    const service = fakeService({ result: {} });
    try {
      await executeQueryTool({ topic: "T", query: "x".repeat(20_001) }, { ragQueryService: service as never });
      expect.fail("should have thrown");
    } catch (error) {
      expect((error as Error).message).to.match(/20000/);
    }
  });

  it("rejects a non-integer topK", async function () {
    const service = fakeService({ result: {} });
    try {
      await executeQueryTool({ topic: "T", query: "q", topK: 2.5 }, { ragQueryService: service as never });
      expect.fail("should have thrown");
    } catch (error) {
      expect((error as Error).message).to.match(/'topK'/);
    }
  });
});
