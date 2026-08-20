import { expect } from "chai";
import { Document as LangChainDocument } from "@langchain/core/documents";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { connect } from "@lancedb/lancedb";
import { VectorRetriever, lanceDistanceToSimilarity, unitCosineToLanceDistance } from "../src/index";
import { RealVectorStore } from "./helpers/realVectorStore";

describe("VectorRetriever score contract", function () {
  it("normalizes production squared-L2 fixtures and treats invalid distances as no evidence", async function () {
    const docs = [0, 1, 2, Number.NaN, Number.POSITIVE_INFINITY, -1].map(
      (distance) => new LangChainDocument({ pageContent: String(distance), metadata: {} }),
    );
    const vectorStore = {
      similaritySearchWithScore: async () =>
        docs.map((document, index) => [document, [0, 1, 2, Number.NaN, Number.POSITIVE_INFINITY, -1][index]]),
    } as any;
    const results = await new VectorRetriever(vectorStore).search("query", docs.length);

    expect(results.map((result) => result.score)).to.deep.equal([1, 0.5, 0, 0, 0, 0]);
    expect(results.every((result) => result.scoreKind === "vector_similarity")).to.equal(true);
    expect(results.every((result) => result.componentScores.vector === result.score)).to.equal(true);
  });

  it("uses metadata _distance only when the primary score is invalid", async function () {
    const document = new LangChainDocument({ pageContent: "fallback", metadata: { _distance: 0.4 } });
    const vectorStore = {
      similaritySearchWithScore: async () => [[document, Number.NaN]],
    } as any;
    const [result] = await new VectorRetriever(vectorStore).search("query", 1);

    expect(result.score).to.equal(lanceDistanceToSimilarity(0.4));
  });

  it("keeps the benchmark fixture and production distance conversion in parity", async function () {
    const embeddings = {
      embedQuery: async () => [0, 1],
      embedDocuments: async () => [],
    } as any;
    const store = new RealVectorStore(embeddings, {});
    const document = new LangChainDocument({ pageContent: "orthogonal", metadata: { chunkId: "orthogonal" } });
    await store.addVectors([[1, 0]], [document]);

    const [result] = await new VectorRetriever(store).search("query", 1);
    const expectedDistance = unitCosineToLanceDistance(0);

    expect(expectedDistance).to.equal(2);
    expect(result.score).to.equal(lanceDistanceToSimilarity(expectedDistance));
    expect(result.score).to.equal(0);
  });

  it("matches the squared-L2 distance emitted by a real LanceDB query", async function () {
    const directory = await mkdtemp(join(tmpdir(), "ragnarok-distance-parity-"));
    const db = await connect(directory);
    try {
      const table = await db.createTable("vectors", [
        { vector: [1, 0], text: "orthogonal" },
        { vector: [0, 1], text: "identical" },
      ]);
      const rows = await table.query().nearestTo([0, 1]).limit(2).toArray();
      const orthogonal = rows.find((row) => row.text === "orthogonal");

      expect(orthogonal?._distance).to.equal(2);
      expect(lanceDistanceToSimilarity(orthogonal?._distance as number)).to.equal(0);
    } finally {
      await db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
