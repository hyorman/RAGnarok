import { VectorStore } from "@langchain/core/vectorstores";
import { Document as LangChainDocument } from "@langchain/core/documents";
import { IConfigProvider, INotifier, TransformersEmbeddings } from "../../src/index";

export const mockConfig: IConfigProvider = {
  get: <T>(_key: string, defaultValue: T): T => defaultValue,
};

export const mockNotifier: INotifier = {
  showInfo: () => {},
  showWarning: () => {},
  showError: () => {},
  withProgress: async <T>(_title: string, task: (report: (message: string) => void) => Promise<T>): Promise<T> =>
    task(() => {}),
};

/**
 * In-memory vector store that stores real embedding vectors and computes
 * cosine similarity. Returns L2 distance (not cosine) to be compatible with
 * VectorRetriever.normalizeDistance() which expects L2 in [0, 2].
 */
export class RealVectorStore extends VectorStore {
  private docs: LangChainDocument[] = [];
  private vectors: number[][] = [];

  _vectorstoreType(): string {
    return "real-embedding-memory";
  }

  async addDocuments(documents: LangChainDocument[]): Promise<void> {
    const texts = documents.map((d) => d.pageContent);
    const embeddings = await this.embeddings.embedDocuments(texts);
    this.docs.push(...documents);
    this.vectors.push(...embeddings);
  }

  async addVectors(vectors: number[][], documents: LangChainDocument[]): Promise<void> {
    this.vectors.push(...vectors);
    this.docs.push(...documents);
  }

  /**
   * Returns [doc, L2_distance] pairs sorted by ascending L2 distance.
   * VectorRetriever.normalizeDistance() converts L2 → similarity via 1 - d/2.
   * For unit-normalized vectors: L2 = sqrt(2 - 2*cosine), so (1 - L2/2) ≈ cosine.
   */
  async similaritySearchVectorWithScore(query: number[], k: number): Promise<[LangChainDocument, number][]> {
    const scores = this.vectors.map((vec) => {
      const dotProduct = vec.reduce((sum, val, i) => sum + val * query[i], 0);
      const magA = Math.sqrt(vec.reduce((sum, val) => sum + val * val, 0));
      const magB = Math.sqrt(query.reduce((sum, val) => sum + val * val, 0));
      const cosine = magA > 0 && magB > 0 ? dotProduct / (magA * magB) : 0;
      // Convert cosine similarity to L2 distance for VectorRetriever compatibility
      return Math.sqrt(Math.max(0, 2 - 2 * cosine));
    });

    const results = this.docs.map((doc, i) => [doc, scores[i]] as [LangChainDocument, number]);
    // Sort by L2 distance ascending (smaller = more similar)
    results.sort((a, b) => a[1] - b[1]);
    return results.slice(0, k);
  }

  async similaritySearch(query: string, k: number): Promise<LangChainDocument[]> {
    const queryVec = await this.embeddings.embedQuery(query);
    const results = await this.similaritySearchVectorWithScore(queryVec, k);
    return results.map(([doc]) => doc);
  }

  static async fromDocuments(docs: LangChainDocument[], embeddings: TransformersEmbeddings): Promise<RealVectorStore> {
    const store = new RealVectorStore(embeddings, {});
    await store.addDocuments(docs);
    return store;
  }
}
