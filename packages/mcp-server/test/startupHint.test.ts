/**
 * Unit tests for what index.ts prints after a fatal startup error.
 */

import { expect } from "chai";
import { StorageFormatVersionError, UnsupportedStorageError } from "@ragnarok/core";
import { reportStartupFailure, startupFailureHint } from "../src/startupHint";

/** Every line reportStartupFailure writes, each as the list of values handed to the writer. */
function reportedLines(error: unknown): unknown[][] {
  const lines: unknown[][] = [];
  reportStartupFailure(error, (...parts) => lines.push(parts));
  return lines;
}

describe("startupFailureHint", function () {
  it("gives an unsupported storage the two ways out, without repeating what was found", function () {
    const hint = startupFailureHint(new UnsupportedStorageError("/data", ["database", "memories.md"]));

    expect(hint).to.be.a("string");
    expect(hint).to.include("RAGNAROK_RESET_STORAGE").and.to.include("RAGNAROK_STORAGE_DIR");
    expect(hint, "the refusal's own message lists the entries").to.not.include("database");
  });

  it("still gives the way out when the refusal carries no entries", function () {
    const hint = startupFailureHint(new UnsupportedStorageError("/data"));

    expect(hint).to.be.a("string");
    expect(hint).to.include("RAGNAROK_RESET_STORAGE");
  });

  it("points a newer-format store at another directory, never at a reset that would back it up", function () {
    const hint = startupFailureHint(new StorageFormatVersionError(3, 2));

    expect(hint).to.be.a("string");
    expect(hint).to.include("RAGNAROK_STORAGE_DIR");
    expect(hint).to.not.include("RAGNAROK_RESET_STORAGE");
  });

  it("gives no hint for a failure that is not a storage refusal", function () {
    expect(startupFailureHint(new Error("boom"))).to.equal(undefined);
    expect(startupFailureHint("UnsupportedStorageError")).to.equal(undefined);
    expect(startupFailureHint(undefined)).to.equal(undefined);
    // Routed by type: a plain Error that only carries the refusal's name and fields is not a refusal.
    const impostor = Object.assign(new Error("pre-0.4 data"), {
      name: "UnsupportedStorageError",
      storageDir: "/data",
      entries: ["database"],
    });
    expect(startupFailureHint(impostor)).to.equal(undefined);
  });
});

describe("reportStartupFailure", function () {
  it("prints a refusal's entries once, with how many were left out, then the way out, and no stack trace", function () {
    const lines = reportedLines(new UnsupportedStorageError("/data", ["a", "b", "c", "d", "e"], 2));

    expect(lines).to.have.length(2);
    expect(lines.every((parts) => parts.length === 1 && typeof parts[0] === "string")).to.equal(true);
    const text = lines.map((parts) => String(parts[0])).join("\n");
    expect(text.split("a, b, c, d, e").length - 1, "the entries are printed once").to.equal(1);
    expect(text).to.include("and 2 more");
    expect(text).to.include("RAGNAROK_RESET_STORAGE");
    expect(text).to.not.include("    at ");
  });

  it("prints any other failure whole, stack included, with no hint", function () {
    const failure = new Error("boom");
    expect(reportedLines(failure)).to.deep.equal([["Fatal error starting MCP server:", failure]]);
  });
});
