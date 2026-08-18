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
});
