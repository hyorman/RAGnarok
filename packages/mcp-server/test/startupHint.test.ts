/**
 * Unit tests for the hint index.ts prints after a fatal startup error.
 */

import { expect } from "chai";
import { StorageFormatVersionError, UnsupportedStorageError } from "@ragnarok/core";
import { startupFailureHint } from "../src/startupHint";

describe("startupFailureHint", function () {
  it("names the entries that made the storage unsupported, and the two ways out", function () {
    const hint = startupFailureHint(new UnsupportedStorageError("/data", ["database", "memories.md"]));

    expect(hint).to.be.a("string");
    expect(hint).to.include("database").and.to.include("memories.md");
    expect(hint).to.include("RAGNAROK_RESET_STORAGE").and.to.include("RAGNAROK_STORAGE_DIR");
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
  });
});
