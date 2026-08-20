import { expect } from "chai";
import {
  DEFAULT_BENCHMARK_SAMPLE_SIZE,
  formatSampleSelection,
  parseBenchmarkSampleSize,
  sampleDeterministically,
} from "./helpers/benchmarkSampling";

describe("benchmarkSampling helpers", () => {
  describe("parseBenchmarkSampleSize", () => {
    it("should use the default sample size when env is unset", () => {
      expect(parseBenchmarkSampleSize(undefined)).to.equal(DEFAULT_BENCHMARK_SAMPLE_SIZE);
    });

    it("should use the default sample size when env is invalid", () => {
      expect(parseBenchmarkSampleSize("not-a-number")).to.equal(DEFAULT_BENCHMARK_SAMPLE_SIZE);
    });

    it("should treat zero as full dataset mode", () => {
      expect(parseBenchmarkSampleSize("0")).to.equal(null);
    });

    it("should floor positive sample sizes", () => {
      expect(parseBenchmarkSampleSize("12.9")).to.equal(12);
    });
  });

  describe("sampleDeterministically", () => {
    it("should return all items in full dataset mode", () => {
      expect(sampleDeterministically([1, 2, 3], null)).to.deep.equal([1, 2, 3]);
    });

    it("should return all items when sample size exceeds input length", () => {
      expect(sampleDeterministically([1, 2, 3], 10)).to.deep.equal([1, 2, 3]);
    });

    it("should sample items evenly with stable ordering", () => {
      expect(sampleDeterministically([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 4)).to.deep.equal([0, 2, 4, 6]);
    });
  });

  describe("formatSampleSelection", () => {
    it("should describe full split mode", () => {
      expect(formatSampleSelection(100, 100, "BEIR_SAMPLE_SIZE", null)).to.equal(
        "using full test split (100/100 queries, BEIR_SAMPLE_SIZE=0)",
      );
    });

    it("should describe deterministic sampling mode", () => {
      expect(formatSampleSelection(100, 50, "BEIR_SAMPLE_SIZE", 50)).to.equal(
        "using deterministic query sample (50/100, BEIR_SAMPLE_SIZE=50)",
      );
    });
  });
});
