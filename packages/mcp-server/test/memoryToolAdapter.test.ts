import { expect } from "chai";
import sinon from "sinon";
import { MemoryServiceError, TOOL_LIMITS } from "@ragnarok/core";
import { buildMemoryInputSchema } from "../src/tools";
import { invokeMemoryTool } from "../src/memoryToolAdapter";

function makeServerContext(signal = new AbortController().signal): any {
  return { mcpReq: { signal } };
}

function parseResponse(result: any): any {
  return JSON.parse(result.content[0].text);
}

function callMemoryTool(input: Record<string, unknown>, execute: sinon.SinonStub) {
  return invokeMemoryTool(
    input as any,
    makeServerContext(),
    { execute } as any,
    { getCurrentBranch: sinon.stub().resolves(null) } as any,
    { workingDir: "/project" } as any,
  );
}

describe("rag_memory schema bounds", () => {
  const schema = buildMemoryInputSchema();

  it("caps query, id, and ids items to the service limits", () => {
    expect(schema.safeParse({ action: "recall", query: "x".repeat(TOOL_LIMITS.memoryQuery + 1) }).success).to.equal(
      false,
    );
    expect(schema.safeParse({ action: "history", id: "x".repeat(TOOL_LIMITS.memoryId + 1) }).success).to.equal(false);
    expect(
      schema.safeParse({ action: "promote", branch: "b", ids: ["x".repeat(TOOL_LIMITS.memoryId + 1)] }).success,
    ).to.equal(false);
    expect(schema.safeParse({ action: "recall", query: "ok" }).success).to.equal(true);
  });

  it("accepts each bounded field at exactly its limit", () => {
    expect(schema.safeParse({ action: "recall", query: "x".repeat(TOOL_LIMITS.memoryQuery) }).success).to.equal(true);
    expect(schema.safeParse({ action: "history", id: "x".repeat(TOOL_LIMITS.memoryId) }).success).to.equal(true);
    expect(
      schema.safeParse({ action: "promote", branch: "b", ids: ["x".repeat(TOOL_LIMITS.memoryId)] }).success,
    ).to.equal(true);
    expect(schema.safeParse({ action: "store", content: "x".repeat(TOOL_LIMITS.memoryContent) }).success).to.equal(
      true,
    );
    expect(schema.safeParse({ action: "store", content: "x".repeat(TOOL_LIMITS.memoryContent + 1) }).success).to.equal(
      false,
    );
  });

  it("keeps the collection bounds the service enforces", () => {
    const id = "memory";
    expect(schema.safeParse({ action: "promote", branch: "b", ids: Array(TOOL_LIMITS.ids).fill(id) }).success).to.equal(
      true,
    );
    expect(
      schema.safeParse({ action: "promote", branch: "b", ids: Array(TOOL_LIMITS.ids + 1).fill(id) }).success,
    ).to.equal(false);
    expect(
      schema.safeParse({ action: "store", content: "c", tags: Array(TOOL_LIMITS.tags).fill("t") }).success,
    ).to.equal(true);
    expect(
      schema.safeParse({ action: "store", content: "c", tags: Array(TOOL_LIMITS.tags + 1).fill("t") }).success,
    ).to.equal(false);
    expect(
      schema.safeParse({ action: "store", content: "c", branch: "b".repeat(TOOL_LIMITS.branch) }).success,
    ).to.equal(true);
    expect(
      schema.safeParse({ action: "store", content: "c", branch: "b".repeat(TOOL_LIMITS.branch + 1) }).success,
    ).to.equal(false);
  });

  it("rejects an action outside the catalogue, so the shared normalizer never sees one", () => {
    // core's normalizeMemoryInput has no default arm; the enum is what closes it
    // on the MCP path, since the SDK validates inputSchema before the handler runs.
    expect(schema.safeParse({ action: "bogus" }).success).to.equal(false);
    expect(schema.safeParse({}).success).to.equal(false);
    for (const action of [
      "store",
      "recall",
      "forget",
      "stats",
      "list",
      "decay",
      "history",
      "promote",
      "links",
      "communities",
    ]) {
      expect(schema.safeParse({ action, content: "c", query: "q", id: "i", branch: "b" }).success, action).to.equal(
        true,
      );
    }
  });
});

describe("rag_memory error payload", () => {
  afterEach(() => sinon.restore());

  it("rejects an over-long query through the shared normalizer before the service runs", async () => {
    const execute = sinon.stub().resolves({ action: "recall" });

    const result = await callMemoryTool({ action: "recall", query: "x".repeat(TOOL_LIMITS.memoryQuery + 1) }, execute);

    expect(execute.called, "the normalizer must reject before MemoryService.execute").to.equal(false);
    expect(result.isError).to.equal(true);
    const body = parseResponse(result);
    expect(body.error.code).to.equal("MEMORY_INVALID_INPUT");
    expect(body.error.message).to.contain("query");
  });

  it("surfaces a MemoryServiceError code in the canonical payload", async () => {
    const execute = sinon.stub().rejects(new MemoryServiceError("MEMORY_BRANCH_UNAVAILABLE", "no branch"));

    const result = await callMemoryTool({ action: "list" }, execute);

    expect(result.isError).to.equal(true);
    expect(parseResponse(result)).to.deep.equal({
      error: { code: "MEMORY_BRANCH_UNAVAILABLE", message: "no branch" },
    });
  });

  it("labels a non-MemoryServiceError failure MEMORY_OPERATION_FAILED and keeps its message", async () => {
    const execute = sinon.stub().rejects(new Error("memory failed"));

    const result = await callMemoryTool({ action: "list" }, execute);

    expect(result.isError).to.equal(true);
    expect(parseResponse(result)).to.deep.equal({
      error: { code: "MEMORY_OPERATION_FAILED", message: "memory failed" },
    });
  });

  it("stringifies a non-Error rejection into the canonical payload", async () => {
    // a non-Error rejection is the case under test
    const execute = sinon.stub().callsFake(() => Promise.reject("plain-rejection"));

    const result = await callMemoryTool({ action: "stats" }, execute);

    expect(result.isError).to.equal(true);
    expect(parseResponse(result)).to.deep.equal({
      error: { code: "MEMORY_OPERATION_FAILED", message: "plain-rejection" },
    });
  });
});
