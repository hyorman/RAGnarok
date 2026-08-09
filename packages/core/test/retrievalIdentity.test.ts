import { expect } from "chai";
import { getChunkId } from "../src/index";

describe("retrievalIdentity", function () {
  describe("getChunkId", function () {
    it("should normalize a string chunkId", function () {
      expect(getChunkId({ chunkId: "chunk-1" })).to.equal("chunk-1");
    });

    it("should normalize a numeric chunkId to its string form", function () {
      expect(getChunkId({ chunkId: 42 })).to.equal("42");
    });

    it("should return null when chunkId is missing", function () {
      expect(getChunkId({})).to.be.null;
      expect(getChunkId(undefined)).to.be.null;
      expect(getChunkId(null)).to.be.null;
    });

    it("should return null for a non-string/number chunkId", function () {
      expect(getChunkId({ chunkId: { nested: true } })).to.be.null;
    });
  });
});
