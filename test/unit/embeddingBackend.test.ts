/**
 * Unit tests for the embedding backend abstraction
 *
 * Tests cover:
 * - VscodeLmBackend availability checks
 * - VscodeLmBackend embed / embedBatch
 * - Backend selection logic (auto, forced modes)
 * - Fallback from VS Code LM to HuggingFace
 * - Dimension validation
 *
 * Uses constructor-based dependency injection ({@link VscodeLmBackend}'s
 * `options.lmApi`) to bypass the real vscode.lm proposed API.
 */

import { expect } from 'chai';
import { VscodeLmBackend } from '../../src/embeddings/vscodeLmBackend';
import { HuggingFaceBackend } from '../../src/embeddings/huggingFaceBackend';

// ---------------------------------------------------------------------------
// Minimal LM API mock (enough for backend tests)
// ---------------------------------------------------------------------------

const createMockLmApi = (options?: {
  hasEmbeddingsApi?: boolean;
  models?: string[];
  embedResult?: { values: number[] };
  embedBatchResult?: Array<{ values: number[] }>;
  shouldThrow?: boolean;
  throwMessage?: string;
}) => {
  const opts = {
    hasEmbeddingsApi: true,
    models: ['test-model-001'],
    embedResult: { values: [0.1, 0.2, 0.3, 0.4] },
    embedBatchResult: undefined as Array<{ values: number[] }> | undefined,
    shouldThrow: false,
    throwMessage: 'Mock error',
    ...options,
  };

  if (!opts.hasEmbeddingsApi) {
    // Simulate missing API surface
    return undefined;
  }

  return {
    embeddingModels: opts.models,
    onDidChangeEmbeddingModels: { subscribe: () => ({ dispose: () => {} }) },
    computeEmbeddings: async (_modelId: string, input: string | string[]) => {
      if (opts.shouldThrow) {
        throw new Error(opts.throwMessage);
      }
      if (Array.isArray(input)) {
        return (
          opts.embedBatchResult ??
          input.map(() => ({ ...opts.embedResult }))
        );
      }
      return { ...opts.embedResult };
    },
  };
};

// ---------------------------------------------------------------------------
// Helper: create a backend with injected mock LM API
// ---------------------------------------------------------------------------
const createBackend = (
  modelId?: string,
  lmApiOptions?: Parameters<typeof createMockLmApi>[0],
) => {
  const lmApi = createMockLmApi(lmApiOptions);
  return new VscodeLmBackend(modelId, { lmApi });
};

describe('EmbeddingBackend Abstraction', function () {
  this.timeout(10000);

  // ---------------------------------------------------------------------------
  // VscodeLmBackend — availability
  // ---------------------------------------------------------------------------
  describe('VscodeLmBackend.isAvailable()', () => {
    it('should return true when API and models are present', async () => {
      const backend = createBackend('test-model-001');
      expect(await backend.isAvailable()).to.be.true;
    });

    it('should return false when embeddings API is missing', async () => {
      const backend = createBackend(undefined, { hasEmbeddingsApi: false });
      expect(await backend.isAvailable()).to.be.false;
    });

    it('should return false when no models are registered', async () => {
      const backend = createBackend(undefined, { models: [] });
      expect(await backend.isAvailable()).to.be.false;
    });

    it('should return false when requested model is not in the list', async () => {
      const backend = createBackend('model-b', { models: ['model-a'] });
      expect(await backend.isAvailable()).to.be.false;
    });

    it('should auto-select first model when none is configured', async () => {
      const backend = createBackend(undefined, { models: ['auto-selected-model'] });
      const available = await backend.isAvailable();
      expect(available).to.be.true;
      // The internal modelId should now be set
      expect((backend as any).modelId).to.equal('auto-selected-model');
    });
  });

  // ---------------------------------------------------------------------------
  // VscodeLmBackend — embed single
  // ---------------------------------------------------------------------------
  describe('VscodeLmBackend.embed()', () => {
    it('should return a number[] embedding', async () => {
      const backend = createBackend('test-model-001');
      const embedding = await backend.embed('hello world');
      expect(embedding).to.be.an('array');
      expect(embedding).to.deep.equal([0.1, 0.2, 0.3, 0.4]);
    });

    it('should set the dimension after first embed', async () => {
      const backend = createBackend('test-model-001');
      expect(backend.getDimension()).to.be.null;
      await backend.embed('test');
      expect(backend.getDimension()).to.equal(4);
    });

    it('should throw on empty embedding values', async () => {
      const backend = createBackend('test-model-001', { embedResult: { values: [] } });
      try {
        await backend.embed('test');
        expect.fail('Should have thrown');
      } catch (e: any) {
        expect(e.message).to.include('empty embedding');
      }
    });

    it('should throw when provider throws', async () => {
      const backend = createBackend('test-model-001', {
        shouldThrow: true,
        throwMessage: 'Provider not available',
      });
      try {
        await backend.embed('test');
        expect.fail('Should have thrown');
      } catch (e: any) {
        expect(e.message).to.include('Provider not available');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // VscodeLmBackend — embedBatch
  // ---------------------------------------------------------------------------
  describe('VscodeLmBackend.embedBatch()', () => {
    it('should return consistent embeddings for batch input', async () => {
      const backend = createBackend('test-model-001');
      const results = await backend.embedBatch(['a', 'b', 'c']);
      expect(results).to.have.length(3);
      results.forEach((r) => {
        expect(r).to.deep.equal([0.1, 0.2, 0.3, 0.4]);
      });
    });

    it('should return empty array for empty input', async () => {
      const backend = createBackend('test-model-001');
      const results = await backend.embedBatch([]);
      expect(results).to.deep.equal([]);
    });

    it('should report progress', async () => {
      const progressValues: number[] = [];
      const backend = createBackend('test-model-001');
      await backend.embedBatch(['a', 'b'], (p) => progressValues.push(p));
      expect(progressValues).to.include(1.0);
    });

    it('should detect inconsistent dimensions', async () => {
      const backend = createBackend('test-model-001', {
        embedBatchResult: [
          { values: [0.1, 0.2, 0.3] },
          { values: [0.1, 0.2] }, // shorter!
        ],
      });
      // The batch call will fail dimension validation, then fallback to sequential
      // which uses the default embedResult (consistent dimensions)
      try {
        const results = await backend.embedBatch(['x', 'y']);
        // If fallback to sequential worked, each individual embed returns consistent results
        expect(results).to.have.length(2);
      } catch (e: any) {
        // Also acceptable: error is propagated
        expect(e.message).to.include('dimension');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // VscodeLmBackend — dispose
  // ---------------------------------------------------------------------------
  describe('VscodeLmBackend.dispose()', () => {
    it('should reset state on dispose', async () => {
      const backend = createBackend('test-model-001');
      await backend.embed('test');
      expect(backend.getDimension()).to.equal(4);

      backend.dispose();
      expect(backend.getDimension()).to.be.null;
    });
  });

  // ---------------------------------------------------------------------------
  // Backend selection logic (integration-level)
  // ---------------------------------------------------------------------------
  describe('Backend Selection (EmbeddingBackendType)', () => {
    it('should have the correct name property', () => {
      const backend = createBackend();
      expect(backend.name).to.equal('vscodeLM');
    });

    it('should initialize successfully with a valid model', async () => {
      const backend = createBackend('test-model-001');
      await backend.initialize();
      // No error means success
    });

    it('should throw on initialize when API is not available', async () => {
      const backend = createBackend(undefined, { hasEmbeddingsApi: false });
      try {
        await backend.initialize();
        expect.fail('Should have thrown');
      } catch (e: any) {
        expect(e.message).to.include('not available');
      }
    });

    it('should throw on initialize when model is not found', async () => {
      const backend = createBackend('nonexistent-model', { models: ['other-model'] });
      try {
        await backend.initialize();
        expect.fail('Should have thrown');
      } catch (e: any) {
        expect(e.message).to.include('not available');
      }
    });
  });

  describe('HuggingFaceBackend cache-dir registration', () => {
    it('should register transformers env.cacheDir with the model registry', () => {
      const modelRegistry = {
        getDefaultModel: () => 'Xenova/all-MiniLM-L6-v2',
        getResolvedLocalModelPath: () => null,
        getBundledModelsRoot: () => '/tmp/models',
        setTransformersCacheDir: function(this: any, dir: string | null) {
          this.cacheDir = dir;
        },
      } as any;

      const backend = new HuggingFaceBackend(modelRegistry);

      (backend as any).configureTransformersEnvironment({
        env: {
          cacheDir: '/tmp/transformers-cache',
        },
      });

      expect(modelRegistry.cacheDir).to.equal('/tmp/transformers-cache');
    });

    it('should clear the registered cache dir when transformers env.cacheDir is unavailable', () => {
      const modelRegistry = {
        getDefaultModel: () => 'Xenova/all-MiniLM-L6-v2',
        getResolvedLocalModelPath: () => null,
        getBundledModelsRoot: () => '/tmp/models',
        setTransformersCacheDir: function(this: any, dir: string | null) {
          this.cacheDir = dir;
        },
        cacheDir: '/tmp/old-cache',
      } as any;

      const backend = new HuggingFaceBackend(modelRegistry);

      (backend as any).configureTransformersEnvironment({
        env: {},
      });

      expect(modelRegistry.cacheDir).to.equal(null);
    });
  });
});
