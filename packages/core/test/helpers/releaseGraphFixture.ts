/**
 * Small deterministic graph-quality corpus for the release gate.
 *
 * Each graph query has one unambiguous entity/chunk target. The final query
 * deliberately has no graph target and exercises the declared vector fallback.
 */
export interface ReleaseGraphEntityFixture {
  id: string;
  name: string;
  chunkId: string;
  content: string;
  vector: number[];
}

export interface ReleaseGraphQueryFixture {
  query: string;
  vector: number[];
  expectedEntities: string[];
  expectedChunkIds: string[];
  expectsFallback: boolean;
}

export const RELEASE_GRAPH_ENTITIES: ReleaseGraphEntityFixture[] = [
  {
    id: "entity-typescript",
    name: "TypeScript",
    chunkId: "chunk-typescript",
    content: "TypeScript adds static typing and interfaces to JavaScript applications.",
    vector: [1, 0, 0, 0],
  },
  {
    id: "entity-kubernetes",
    name: "Kubernetes",
    chunkId: "chunk-kubernetes",
    content: "Kubernetes schedules containers and manages services across a cluster.",
    vector: [0, 1, 0, 0],
  },
  {
    id: "entity-oauth",
    name: "OAuth",
    chunkId: "chunk-oauth",
    content: "OAuth provides delegated authorization using scoped access tokens.",
    vector: [0, 0, 1, 0],
  },
  {
    id: "entity-lancedb",
    name: "LanceDB",
    chunkId: "chunk-lancedb",
    content: "LanceDB persists embedding vectors for semantic nearest-neighbor search.",
    vector: [0, 0, 0, 1],
  },
];

export const RELEASE_GRAPH_FALLBACK = {
  chunkId: "chunk-invoice",
  content: "Invoice disputes are routed to the billing escalation queue.",
};

export const RELEASE_GRAPH_QUERIES: ReleaseGraphQueryFixture[] = [
  {
    query: "TypeScript interfaces",
    vector: [1, 0, 0, 0],
    expectedEntities: ["TypeScript"],
    expectedChunkIds: ["chunk-typescript"],
    expectsFallback: false,
  },
  {
    query: "Kubernetes services",
    vector: [0, 1, 0, 0],
    expectedEntities: ["Kubernetes"],
    expectedChunkIds: ["chunk-kubernetes"],
    expectsFallback: false,
  },
  {
    query: "OAuth access tokens",
    vector: [0, 0, 1, 0],
    expectedEntities: ["OAuth"],
    expectedChunkIds: ["chunk-oauth"],
    expectsFallback: false,
  },
  {
    query: "LanceDB vector search",
    vector: [0, 0, 0, 1],
    expectedEntities: ["LanceDB"],
    expectedChunkIds: ["chunk-lancedb"],
    expectsFallback: false,
  },
  {
    query: "invoice escalation",
    vector: [0, 0, 0, 0],
    expectedEntities: [],
    expectedChunkIds: ["chunk-invoice"],
    expectsFallback: true,
  },
];
