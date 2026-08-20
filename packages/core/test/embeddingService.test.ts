/**
 * Tests for EmbeddingService
 * This test downloads the embedding model and verifies embedding generation
 */

import { expect } from "chai";
import { EmbeddingService, IConfigProvider, INotifier, HuggingFaceBackend, ModelRegistry } from "../src/index";

// Mock vscode module
const mockVscode = {
  workspace: {
    getConfiguration: () => ({
      get: (key: string, defaultValue: any) => {
        if (key === "embeddingModel") {
          return "Xenova/all-MiniLM-L6-v2";
        }
        return defaultValue;
      },
    }),
  },
  window: {
    withProgress: async (options: any, task: any) => {
      // Mock progress callback
      const progress = {
        report: (value: any) => {
          console.log(`Progress: ${value.message || ""}`);
        },
      };
      return await task(progress);
    },
  },
};

// Inject mock before importing
(global as any).vscode = mockVscode;

const mockConfig: IConfigProvider = {
  get: <T>(_key: string, defaultValue: T): T => defaultValue,
};

const mockNotifier: INotifier = {
  showInfo: () => {},
  showWarning: () => {},
  showError: () => {},
  withProgress: async <T>(_title: string, task: (report: (message: string) => void) => Promise<T>): Promise<T> =>
    task(() => {}),
};

describe("EmbeddingService", function () {
  // Increase timeout for model download (first time only)
  this.timeout(120000); // 2 minutes

  let embeddingService: EmbeddingService;

  before(async function () {
    console.log("Initializing EmbeddingService...");
    embeddingService = new EmbeddingService({ config: mockConfig, notifier: mockNotifier });

    // Register HuggingFace backend (no longer created internally)
    const modelRegistry = ModelRegistry.getInstance();
    const hfBackend = new HuggingFaceBackend(modelRegistry, mockNotifier);
    embeddingService.registerBackend(hfBackend);
  });

  describe("Model Download and Initialization", function () {
    it("should download and initialize the embedding model", async function () {
      console.log("Starting model initialization...");
      await embeddingService.initialize("Xenova/all-MiniLM-L6-v2");

      const currentModel = embeddingService.getCurrentModel();
      expect(currentModel).to.equal("huggingface:Xenova/all-MiniLM-L6-v2");
      console.log("Model initialized successfully:", currentModel);
    });

    it("should not re-download if model is already initialized", async function () {
      const startTime = Date.now();
      await embeddingService.initialize("Xenova/all-MiniLM-L6-v2");
      const endTime = Date.now();

      // Should be very fast if already initialized (< 1 second)
      const duration = endTime - startTime;
      expect(duration).to.be.lessThan(1000);
      console.log(`Re-initialization took ${duration}ms (should be fast)`);
    });
  });

  describe("Single Embedding Generation", function () {
    it("should generate embeddings for simple text", async function () {
      const text = "This is a test sentence.";
      const embedding = await embeddingService.embed(text);

      expect(embedding).to.be.an("array");
      expect(embedding.length).to.be.greaterThan(0);
      expect(embedding.length).to.equal(384); // all-MiniLM-L6-v2 produces 384-dim vectors
      expect(embedding[0]).to.be.a("number");

      console.log(`Generated embedding with ${embedding.length} dimensions`);
      console.log(
        `First 5 values: [${embedding
          .slice(0, 5)
          .map((v) => v.toFixed(4))
          .join(", ")}]`,
      );
    });

    it("should generate different embeddings for different texts", async function () {
      const text1 = "Machine learning is fascinating.";
      const text2 = "The weather is nice today.";

      const embedding1 = await embeddingService.embed(text1);
      const embedding2 = await embeddingService.embed(text2);

      expect(embedding1).to.not.deep.equal(embedding2);

      // Calculate similarity (should be low for unrelated texts)
      const similarity = embeddingService.cosineSimilarity(embedding1, embedding2);
      expect(similarity).to.be.lessThan(0.5);

      console.log(`Similarity between unrelated texts: ${similarity.toFixed(4)}`);
    });

    it("should generate similar embeddings for semantically similar texts", async function () {
      const text1 = "The cat is sitting on the mat.";
      const text2 = "A feline is resting on the rug.";

      const embedding1 = await embeddingService.embed(text1);
      const embedding2 = await embeddingService.embed(text2);

      const similarity = embeddingService.cosineSimilarity(embedding1, embedding2);
      expect(similarity).to.be.greaterThan(0.4); // Should be somewhat similar

      console.log(`Similarity between similar texts: ${similarity.toFixed(4)}`);
    });
  });

  describe("Batch Embedding Generation", function () {
    it("should generate embeddings for multiple texts", async function () {
      const texts = [
        "Natural language processing is a branch of AI.",
        "Machine learning models learn from data.",
        "Deep learning uses neural networks.",
        "Embeddings capture semantic meaning.",
      ];

      const embeddings = await embeddingService.embedBatch(texts);

      expect(embeddings).to.be.an("array");
      expect(embeddings.length).to.equal(texts.length);

      embeddings.forEach((embedding, idx) => {
        expect(embedding).to.be.an("array");
        expect(embedding.length).to.equal(384);
        console.log(`Text ${idx + 1}: "${texts[idx].substring(0, 30)}..." -> ${embedding.length}D vector`);
      });
    });

    it("should handle empty array", async function () {
      const embeddings = await embeddingService.embedBatch([]);
      expect(embeddings).to.be.an("array");
      expect(embeddings.length).to.equal(0);
    });
  });

  describe("Cosine Similarity", function () {
    it("should calculate correct cosine similarity", function () {
      const vec1 = [1, 0, 0];
      const vec2 = [0, 1, 0];
      const vec3 = [1, 0, 0];

      // Orthogonal vectors should have similarity close to 0
      const similarity1 = embeddingService.cosineSimilarity(vec1, vec2);
      expect(similarity1).to.be.closeTo(0, 0.0001);

      // Identical vectors should have similarity of 1
      const similarity2 = embeddingService.cosineSimilarity(vec1, vec3);
      expect(similarity2).to.be.closeTo(1, 0.0001);

      console.log(`Orthogonal vectors similarity: ${similarity1.toFixed(4)}`);
      console.log(`Identical vectors similarity: ${similarity2.toFixed(4)}`);
    });

    it("should throw error for mismatched dimensions", function () {
      const vec1 = [1, 2, 3];
      const vec2 = [1, 2];

      expect(() => {
        embeddingService.cosineSimilarity(vec1, vec2);
      }).to.throw("Embeddings must have the same dimension");
    });
  });

  describe("Large Text Handling", function () {
    it("should handle longer texts", async function () {
      const longText = `
        Natural Language Processing (NLP) is a fascinating field that combines linguistics,
        computer science, and artificial intelligence. It enables computers to understand,
        interpret, and generate human language in a way that is both meaningful and useful.
        Modern NLP systems use deep learning techniques, particularly transformer-based models,
        to achieve state-of-the-art results on various tasks including translation,
        summarization, question answering, and sentiment analysis.
      `;

      const embedding = await embeddingService.embed(longText);

      expect(embedding).to.be.an("array");
      expect(embedding.length).to.equal(384);

      console.log(`Generated embedding for text with ${longText.length} characters`);
    });
  });
});
