import { expect } from "chai";
import { DEFAULTS } from "../src/constants";

describe("reranker candidate defaults", function () {
  const DEFAULT_TOP_K = 10;

  it("keeps the ceiling above the multiplier's reach at the default topK", function () {
    // Over-fetch is min(topK * multiplier, maxCandidates). If the ceiling is
    // the smaller of the two at the default topK, the documented multiplier
    // silently stops applying — which is exactly the regression this guards.
    const wanted = DEFAULT_TOP_K * DEFAULTS.RERANKER_CANDIDATE_MULTIPLIER;

    expect(DEFAULTS.RERANKER_MAX_CANDIDATES).to.be.at.least(wanted);
  });

  it("states the values the config reference advertises", function () {
    expect(DEFAULTS.RERANKER_CANDIDATE_MULTIPLIER).to.equal(4);
    expect(DEFAULTS.RERANKER_MAX_CANDIDATES).to.equal(40);
  });
});
