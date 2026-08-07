import { VectorStore } from "@langchain/core/vectorstores";
import { Document as LangChainDocument } from "@langchain/core/documents";
import { IConfigProvider, INotifier, TransformersEmbeddings, unitCosineToLanceDistance } from "../../src/index";

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
 * cosine similarity. Returns LanceDB squared-L2 distance to be compatible with
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
   * Returns [doc, squared_L2_distance] pairs sorted by ascending distance.
   * VectorRetriever converts this to similarity via 1 - d/2.
   * For unit-normalized vectors: d = 2 - 2*cosine, so the score is cosine.
   */
  async similaritySearchVectorWithScore(query: number[], k: number): Promise<[LangChainDocument, number][]> {
    const scores = this.vectors.map((vec) => {
      const dotProduct = vec.reduce((sum, val, i) => sum + val * query[i], 0);
      const magA = Math.sqrt(vec.reduce((sum, val) => sum + val * val, 0));
      const magB = Math.sqrt(query.reduce((sum, val) => sum + val * val, 0));
      const cosine = magA > 0 && magB > 0 ? dotProduct / (magA * magB) : 0;
      // Use the same unit-vector score contract as production retrieval.
      return unitCosineToLanceDistance(cosine);
    });

    const results = this.docs.map((doc, i) => [doc, scores[i]] as [LangChainDocument, number]);
    // Sort by squared-L2 distance ascending (smaller = more similar)
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
