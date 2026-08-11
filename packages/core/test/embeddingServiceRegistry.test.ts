import { strict as assert } from "assert";
import { EmbeddingServiceRegistry, isRemoteBackend } from "../src/embeddings/embeddingServiceRegistry";

/** Minimal stand-in — the registry only ever calls initialize() and dispose(). */
class FakeService {
  public initializedWith: string | undefined;
  public disposed = false;
  async initialize(modelName?: string): Promise<void> {
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

  it("classifies backends", () => {
    assert.equal(isRemoteBackend("remote"), true);
    assert.equal(isRemoteBackend("huggingface"), false);
    assert.equal(isRemoteBackend(""), false);
  });

  it("initializes each service to exactly one model", async () => {
    const { registry, created } = makeRegistry(2);
    await registry.get({ model: "model-a", backend: "huggingface", endpointHash: "local" });
    assert.equal(created.length, 1);
    assert.equal(created[0].initializedWith, "model-a");
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
    assert.deepEqual(registry.size(), { local: 2, remote: 4 });
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
    assert.deepEqual(registry.size(), { local: 0, remote: 0 });
  });
});
