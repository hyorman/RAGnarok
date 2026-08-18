import { expect } from "chai";
import { normalizeMemoryInput } from "../src/tools/index";
import { MemoryServiceError } from "../src/memory";

describe("memory tool normalizer", function () {
  it("trims strings and drops undefined keys", function () {
    const result = normalizeMemoryInput({ action: "store", content: "  a fact  ", branch: undefined });
    expect(result).to.deep.equal({ action: "store", content: "a fact" });
  });

  it("rejects a non-string content", function () {
    expect(() => normalizeMemoryInput({ action: "store", content: 42 })).to.throw(MemoryServiceError);
  });

  it("rejects blank content", function () {
    expect(() => normalizeMemoryInput({ action: "store", content: "   " })).to.throw(/must not be empty/);
  });

  it("rejects over-long content", function () {
    expect(() => normalizeMemoryInput({ action: "store", content: "x".repeat(50_001) })).to.throw(/50000 characters/);
  });

  it("discards irrelevant fields for stats", function () {
    expect(normalizeMemoryInput({ action: "stats", topK: 5, branch: "main" })).to.deep.equal({ action: "stats" });
  });

  it("coerces a missing history id to empty so the service reports it", function () {
    expect(normalizeMemoryInput({ action: "history" })).to.deep.equal({ action: "history", id: "" });
  });

  it("coerces a missing promote branch to empty so the service reports it", function () {
    expect(normalizeMemoryInput({ action: "promote", ids: ["a"] })).to.deep.equal({
      action: "promote",
      branch: "",
      ids: ["a"],
    });
  });

  it("keeps recall flags", function () {
    expect(normalizeMemoryInput({ action: "recall", query: " why ", topK: 3, reinforce: true })).to.deep.equal({
      action: "recall",
      query: "why",
      topK: 3,
      reinforce: true,
    });
  });

  it("rejects a non-array tags value", function () {
    expect(() => normalizeMemoryInput({ action: "store", content: "a", tags: "x" })).to.throw(/must be an array/);
  });

  it("keeps forget fields and drops the rest", function () {
    expect(
      normalizeMemoryInput({
        action: "forget",
        id: " mem-1 ",
        olderThan: 30,
        expired: true,
        scope: "branch",
        branch: " main ",
        topK: 5,
        content: "a fact",
      }),
    ).to.deep.equal({
      action: "forget",
      id: "mem-1",
      olderThan: 30,
      expired: true,
      scope: "branch",
      branch: "main",
    });
  });

  it("keeps list fields and drops the rest", function () {
    expect(
      normalizeMemoryInput({
        action: "list",
        limit: 25,
        includeAuto: true,
        scope: "workspace",
        branch: " main ",
        topK: 5,
        id: "mem-1",
      }),
    ).to.deep.equal({
      action: "list",
      limit: 25,
      includeAuto: true,
      scope: "workspace",
      branch: "main",
    });
  });

  it("keeps decay fields and drops the rest", function () {
    expect(normalizeMemoryInput({ action: "decay", scope: "branch", branch: " main ", limit: 25 })).to.deep.equal({
      action: "decay",
      scope: "branch",
      branch: "main",
    });
  });

  it("keeps links fields and drops the rest", function () {
    expect(normalizeMemoryInput({ action: "links", scope: "branch", branch: " main ", topK: 5 })).to.deep.equal({
      action: "links",
      scope: "branch",
      branch: "main",
    });
  });

  it("keeps communities fields and drops the rest", function () {
    expect(
      normalizeMemoryInput({ action: "communities", scope: "workspace", branch: " main ", includeAuto: true }),
    ).to.deep.equal({
      action: "communities",
      scope: "workspace",
      branch: "main",
    });
  });

  it("keeps a promote id alongside ids", function () {
    expect(normalizeMemoryInput({ action: "promote", branch: " main ", id: " a,b,c " })).to.deep.equal({
      action: "promote",
      branch: "main",
      id: "a,b,c",
    });
  });

  it("accepts a query at the length bound", function () {
    const query = "x".repeat(10_000);
    expect(normalizeMemoryInput({ action: "recall", query })).to.deep.equal({ action: "recall", query });
  });

  it("rejects a query over the length bound", function () {
    expect(() => normalizeMemoryInput({ action: "recall", query: "x".repeat(10_001) })).to.throw(/10000 characters/);
  });

  it("accepts an id at the length bound", function () {
    const id = "x".repeat(1_000);
    expect(normalizeMemoryInput({ action: "forget", id })).to.deep.equal({ action: "forget", id });
  });

  it("rejects an id over the length bound", function () {
    expect(() => normalizeMemoryInput({ action: "forget", id: "x".repeat(1_001) })).to.throw(/1000 characters/);
  });

  it("accepts an ids entry at the length bound", function () {
    const id = "x".repeat(1_000);
    expect(normalizeMemoryInput({ action: "promote", branch: "main", ids: [id] })).to.deep.equal({
      action: "promote",
      branch: "main",
      ids: [id],
    });
  });

  it("rejects an ids entry over the length bound", function () {
    expect(() => normalizeMemoryInput({ action: "promote", branch: "main", ids: ["x".repeat(1_001)] })).to.throw(
      /1000 characters/,
    );
  });

  it("rejects a blank array entry", function () {
    expect(() => normalizeMemoryInput({ action: "store", content: "a", tags: ["  "] })).to.throw(/must not be empty/);
  });

  it("rejects a non-string array entry", function () {
    expect(() => normalizeMemoryInput({ action: "store", content: "a", tags: [42] })).to.throw(/must be a string/);
  });

  it("rejects an undefined array entry", function () {
    expect(() => normalizeMemoryInput({ action: "store", content: "a", tags: [undefined] })).to.throw(
      /entries must be strings/,
    );
  });

  // The MCP host gates action through a zod enum, but VS Code does not enforce a
  // tool's declared inputSchema before invoking it, so an unrecognized action can
  // reach this function as raw JSON. Falling through would return undefined and
  // TypeError deep inside the host instead of producing a correctable payload.
  it("rejects an unrecognized action with a structured invalid-input error", function () {
    expect(() => normalizeMemoryInput({ action: "reset" } as never)).to.throw(MemoryServiceError);
    expect(() => normalizeMemoryInput({ action: "reset" } as never)).to.throw(/unsupported action 'reset'/);
  });

  it("reports the invalid-input code for an unrecognized action", function () {
    try {
      normalizeMemoryInput({ action: "" } as never);
      expect.fail("expected an unsupported-action rejection");
    } catch (error) {
      expect((error as MemoryServiceError).code).to.equal("MEMORY_INVALID_INPUT");
    }
  });
});
