import { expect } from "chai";
import { Document as LangChainDocument } from "@langchain/core/documents";
import { GraphHybridRetriever, GraphRetriever, KnowledgeGraph } from "../src/index";
import {
  RELEASE_GRAPH_ENTITIES,
  RELEASE_GRAPH_FALLBACK,
  RELEASE_GRAPH_QUERIES,
  type ReleaseGraphQueryFixture,
} from "./helpers/releaseGraphFixture";

interface GraphQualityMetrics {
  entityRecallAt5: number;
  chunkRecallAt5: number;
  fallbackAccuracy: number;
  explanationCoverage: number;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function createBenchmark() {
  const graph = new KnowledgeGraph("release-graph-fixture");
  const documents = RELEASE_GRAPH_ENTITIES.map(
    (fixture) =>
      new LangChainDocument({
        pageContent: fixture.content,
        metadata: { chunkId: fixture.chunkId, source: `${fixture.id}.md` },
      }),
  );
  const fallbackDocument = new LangChainDocument({
    pageContent: RELEASE_GRAPH_FALLBACK.content,
    metadata: { chunkId: RELEASE_GRAPH_FALLBACK.chunkId, source: "billing.md" },
  });
  for (const fixture of RELEASE_GRAPH_ENTITIES) {
    graph.addEntity({
      id: fixture.id,
      name: fixture.name,
      type: "concept",
      description: fixture.content,
      vector: fixture.vector,
      sourceChunkIds: [fixture.chunkId],
      confidence: 1,
      strength: 1,
      lastAccessedAt: 0,
      metadata: {},
    });
  }

  const queryByText = new Map(RELEASE_GRAPH_QUERIES.map((fixture) => [fixture.query, fixture]));
  const documentByChunk = new Map(
    [...documents, fallbackDocument].map((document) => [String(document.metadata.chunkId), document]),
  );
  const vectorRetriever = {
    search: async (query: string) => {
      const fixture = queryByText.get(query);
      const chunkId = fixture?.expectedChunkIds[0] ?? RELEASE_GRAPH_FALLBACK.chunkId;
      return [{ document: documentByChunk.get(chunkId)!, score: 0.9, scoreKind: "vector_similarity" as const }];
    },
  };
  const embeddingService = {
    embed: async (query: string) => queryByText.get(query)?.vector ?? [0, 0, 0, 0],
  };
  const graphRetriever = new GraphRetriever(graph, vectorRetriever as any, embeddingService as any, async () => [
    ...documents,
    fallbackDocument,
  ]);
  return {
    graph: graphRetriever,
    graphHybrid: new GraphHybridRetriever(graphRetriever, vectorRetriever as any),
  };
}

function hasExplanation(
  result: {
    score: number;
    scoreKind?: string;
    componentScores?: { vector?: number; graph?: number };
    matchedEntities?: string[];
    hopDepth?: number;
    effectiveStrategy?: string;
    degradedFrom?: string;
    fallbackReason?: string;
  },
  fixture: ReleaseGraphQueryFixture,
): boolean {
  const componentValues = Object.values(result.componentScores ?? {});
  const common =
    Number.isFinite(result.score) &&
    typeof result.scoreKind === "string" &&
    componentValues.length > 0 &&
    componentValues.every(Number.isFinite) &&
    Array.isArray(result.matchedEntities) &&
    Number.isInteger(result.hopDepth) &&
    typeof result.effectiveStrategy === "string";
  if (!common) {
    return false;
  }
  return fixture.expectsFallback
    ? result.effectiveStrategy === "vector" &&
        typeof result.degradedFrom === "string" &&
        typeof result.fallbackReason === "string"
    : result.effectiveStrategy !== "vector" && result.matchedEntities!.length > 0;
}

async function measureStrategy(
  search: (query: string) => Promise<
    Array<{
      document: LangChainDocument;
      score: number;
      scoreKind?: string;
      componentScores?: { vector?: number; graph?: number };
      matchedEntities?: string[];
      hopDepth?: number;
      effectiveStrategy?: string;
      degradedFrom?: string;
      fallbackReason?: string;
    }>
  >,
): Promise<GraphQualityMetrics> {
  const entityRecall: number[] = [];
  const chunkRecall: number[] = [];
  const fallbackAccuracy: number[] = [];
  const explanationCoverage: number[] = [];

  for (const fixture of RELEASE_GRAPH_QUERIES) {
    const results = (await search(fixture.query)).slice(0, 5);
    const entities = new Set(results.flatMap((result) => result.matchedEntities ?? []));
    if (fixture.expectedEntities.length > 0) {
      entityRecall.push(
        fixture.expectedEntities.filter((entity) => entities.has(entity)).length / fixture.expectedEntities.length,
      );
    }
    const chunks = new Set(results.map((result) => String(result.document.metadata.chunkId)));
    chunkRecall.push(
      fixture.expectedChunkIds.filter((chunkId) => chunks.has(chunkId)).length / fixture.expectedChunkIds.length,
    );
    fallbackAccuracy.push(
      (results[0]?.effectiveStrategy === "vector") === fixture.expectsFallback && results.length > 0 ? 1 : 0,
    );
    explanationCoverage.push(results.length > 0 && results.every((result) => hasExplanation(result, fixture)) ? 1 : 0);
  }

  return {
    entityRecallAt5: mean(entityRecall),
    chunkRecallAt5: mean(chunkRecall),
    fallbackAccuracy: mean(fallbackAccuracy),
    explanationCoverage: mean(explanationCoverage),
  };
}

describe("deterministic release graph benchmark", function () {
  it("emits aggregate graph and graph-hybrid quality contracts", async function () {
    const benchmark = createBenchmark();
    const graph = await measureStrategy((query) => benchmark.graph.search(query, { k: 5 }));
    const graphHybrid = await measureStrategy((query) => benchmark.graphHybrid.search(query, { k: 5 }));

    expect(graph).to.deep.equal({
      entityRecallAt5: 1,
      chunkRecallAt5: 1,
      fallbackAccuracy: 1,
      explanationCoverage: 1,
    });
    expect(graphHybrid).to.deep.equal({
      entityRecallAt5: 1,
      chunkRecallAt5: 1,
      fallbackAccuracy: 1,
      explanationCoverage: 1,
    });
    if (process.env.RAGNAROK_BENCHMARK_MODE === "release") {
      console.log(`RAGNAROK_METRICS graph ${JSON.stringify(graph)}`);
      console.log(`RAGNAROK_METRICS graph_hybrid ${JSON.stringify(graphHybrid)}`);
    }
  });
});
