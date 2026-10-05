import { expect } from "chai";
import * as constants from "../src/constants";
import { DEFAULTS } from "../src/constants";
import { ModelRegistry } from "../src/models/modelRegistry";
import { RerankerModelRegistry } from "../src/models/rerankerModelRegistry";
import { RetrievalStrategy } from "../src/utils/types";

describe("shared constants", function () {
  it("states the setting defaults every host falls back to", function () {
    expect(DEFAULTS).to.include({
      CHUNK_SIZE: 1000,
      CHUNK_OVERLAP: 200,
      RETRIEVAL_STRATEGY: RetrievalStrategy.HYBRID,
      MAX_ITERATIONS: 3,
      CONFIDENCE_THRESHOLD: 0.7,
      LOG_LEVEL: "info",
      EMBEDDING_BACKEND: "auto",
      MAX_RESIDENT_MODELS: 2,
    });
  });

  it("names the memory export file and the public GitHub host once", function () {
    expect(constants.EXTENSION).to.include({ MEMORIES_MARKDOWN_FILENAME: "memories.md" });
    expect(constants).to.have.property("GITHUB_HOST", "github.com");
  });

  it("puts the default model first in each curated list, where the registries read it", function () {
    expect(ModelRegistry.CURATED_MODELS[0]).to.equal(DEFAULTS.EMBEDDING_MODEL);
    expect(RerankerModelRegistry.CURATED_MODELS[0]).to.equal(DEFAULTS.RERANKER_MODEL);
  });
});
