import { strict as assert } from "assert";
import { EmbeddingServiceRegistry, isCapExempt } from "../src/embeddings/embeddingServiceRegistry";

/** Minimal stand-in — the registry only ever initializes and disposes. */
class FakeService {
  /** Model this service was pointed at, by whichever initialization path ran. */
  public initializedWith: string | undefined;
  /** Backend it was initialized THROUGH, or undefined if the config decided. */
  public initializedForBackend: string | undefined;
  /** True only when the config-resolving path ran. */
  public plainInitializeCalled = false;
  public disposed = false;
  async initialize(modelName?: string): Promise<void> {
    this.plainInitializeCalled = true;
    this.initializedWith = modelName;
  }
  async initializeForBackend(backendType: string, modelName?: string): Promise<void> {
    this.initializedForBackend = backendType;
    this.initializedWith = modelName;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

describe("EmbeddingServiceRegistry", () => {
  const makeRegistry = (max: number) => {
    const created: FakeService[] = [];
    const registry = new EmbeddingServiceRegistry({
      createService: () => {
        const service = new FakeService();
        created.push(service);
        return service as never;
      },
      maxResidentLocal: max,
    });
    return { registry, created };
  };

  it("classifies backends by whether they hold weights", () => {
    assert.equal(isCapExempt("remote"), true);
    assert.equal(isCapExempt("vscodeLM"), true);
    assert.equal(isCapExempt("huggingface"), false);
    assert.equal(isCapExempt(""), false);
    assert.equal(isCapExempt("some-future-backend"), false, "unknown kinds count against the cap");
  });

  it("initializes each service to exactly one model", async () => {
    const { registry, created } = makeRegistry(2);
    await registry.get({ model: "model-a", backend: "huggingface", endpointHash: "local" });
    assert.equal(created.length, 1);
    assert.equal(created[0].initializedWith, "model-a");
  });

  it("initializes through the backend the resolution names", async () => {
    const { registry, created } = makeRegistry(2);
    await registry.get({ model: "v-model", backend: "vscodeLM", endpointHash: "local" });
    assert.equal(created[0].initializedForBackend, "vscodeLM");
    assert.equal(created[0].initializedWith, "v-model");
    // The decisive half: plain initialize() resolves the backend from config, so
    // the entry would be keyed by a backend it was never initialized with — a
    // cap-exempt key holding a resident local model, and a vscodeLM topic that
    // fails to load whenever the configured backend is something else.
    assert.equal(
      created[0].plainInitializeCalled,
      false,
      "must not fall back to the config-resolved backend when the key names one",
    );
  });

  it("lets the config decide only when the resolution names no backend", async () => {
    const { registry, created } = makeRegistry(2);
    await registry.get({ model: "m", backend: "", endpointHash: "local" });
    await registry.get({ model: "m", backend: "auto", endpointHash: "local" });
    for (const service of created) {
      // "auto" and "" are configuration requests, not backends: initializing
      // through them would throw as unregistered.
      assert.equal(service.plainInitializeCalled, true);
      assert.equal(service.initializedForBackend, undefined);
      assert.equal(service.initializedWith, "m");
    }
    assert.equal(created.length, 2, "an unnamed backend and \"auto\" are distinct keys");
  });

  it("returns the same instance for the same resolution", async () => {
    const { registry, created } = makeRegistry(2);
    const first = await registry.get({ model: "m", backend: "huggingface", endpointHash: "local" });
    const second = await registry.get({ model: "m", backend: "huggingface", endpointHash: "local" });
    assert.equal(first, second);
    assert.equal(created.length, 1, "must not create a second service for the same key");
  });

  it("returns different instances for different models", async () => {
    const { registry } = makeRegistry(2);
    const a = await registry.get({ model: "a", backend: "huggingface", endpointHash: "local" });
    const b = await registry.get({ model: "b", backend: "huggingface", endpointHash: "local" });
    assert.notEqual(a, b);
  });

  it("distinguishes the same model on different endpoints", async () => {
    const { registry } = makeRegistry(2);
    const a = await registry.get({ model: "m", backend: "remote", endpointHash: "aaa" });
    const b = await registry.get({ model: "m", backend: "remote", endpointHash: "bbb" });
    assert.notEqual(a, b, "endpointHash is part of the identity");
  });

  it("evicts the least-recently-used local service and disposes it", async () => {
    const { registry, created } = makeRegistry(2);
    await registry.get({ model: "a", backend: "huggingface", endpointHash: "local" });
    await registry.get({ model: "b", backend: "huggingface", endpointHash: "local" });
    await registry.get({ model: "a", backend: "huggingface", endpointHash: "local" }); // touch a
    await registry.get({ model: "c", backend: "huggingface", endpointHash: "local" }); // evicts b
    assert.equal(created[0].disposed, false, "a was most recently used");
    assert.equal(created[1].disposed, true, "b was least recently used");
    assert.equal(created[2].disposed, false);
  });

  it("never counts or evicts remote services", async () => {
    const { registry, created } = makeRegistry(2);
    await registry.get({ model: "a", backend: "huggingface", endpointHash: "local" });
    await registry.get({ model: "b", backend: "huggingface", endpointHash: "local" });
    for (const model of ["r1", "r2", "r3", "r4"]) {
      await registry.get({ model, backend: "remote", endpointHash: "aaa" });
    }
    assert.deepEqual(
      created.map((s) => s.disposed),
      created.map(() => false),
      "remote entries must not evict local ones, nor be evicted themselves",
    );
    assert.deepEqual(registry.size(), { local: 2, exempt: 4 });
  });

  it("never counts or evicts vscodeLM services", async () => {
    const { registry, created } = makeRegistry(2);
    await registry.get({ model: "a", backend: "huggingface", endpointHash: "local" });
    await registry.get({ model: "b", backend: "huggingface", endpointHash: "local" });
    for (const model of ["v1", "v2", "v3", "v4"]) {
      await registry.get({ model, backend: "vscodeLM", endpointHash: "local" });
    }
    assert.deepEqual(
      created.map((s) => s.disposed),
      created.map(() => false),
      "vscodeLM holds no weights, so it must not evict a real model to make room for nothing",
    );
    assert.deepEqual(registry.size(), { local: 2, exempt: 4 });
  });

  it("counts an unknown backend against the cap", async () => {
    const { registry, created } = makeRegistry(1);
    await registry.get({ model: "a", backend: "some-future-backend", endpointHash: "local" });
    await registry.get({ model: "b", backend: "some-future-backend", endpointHash: "local" });
    assert.equal(created[0].disposed, true, "an unknown backend must be treated as weight-bearing");
    assert.equal(created[1].disposed, false);
    assert.deepEqual(registry.size(), { local: 1, exempt: 0 });
  });

  it("creates one service when two concurrent gets race for the same key", async () => {
    const { registry, created } = makeRegistry(2);
    const resolution = { model: "m", backend: "huggingface", endpointHash: "local" };
    const [first, second] = await Promise.all([registry.get(resolution), registry.get(resolution)]);
    assert.equal(first, second, "concurrent callers must share one service");
    assert.equal(created.length, 1, "a concurrent race must not create a second service");
    assert.deepEqual(registry.size(), { local: 1, exempt: 0 });
  });

  it("works at a cap of 1 without disposing a service it is about to return", async () => {
    const { registry, created } = makeRegistry(1);
    const a = await registry.get({ model: "a", backend: "huggingface", endpointHash: "local" });
    const b = await registry.get({ model: "b", backend: "huggingface", endpointHash: "local" });
    assert.notEqual(a, b);
    assert.equal(created[0].disposed, true);
    assert.equal(created[1].disposed, false, "the freshly created service must not be evicted");
  });

  it("disposes everything on disposeAll", async () => {
    const { registry, created } = makeRegistry(2);
    await registry.get({ model: "a", backend: "huggingface", endpointHash: "local" });
    await registry.get({ model: "r", backend: "remote", endpointHash: "aaa" });
    await registry.disposeAll();
    assert.deepEqual(
      created.map((s) => s.disposed),
      [true, true],
    );
    assert.deepEqual(registry.size(), { local: 0, exempt: 0 });
  });
});
