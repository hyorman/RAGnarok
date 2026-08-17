import { expect } from "chai";
import { EmbeddingBackend, EmbeddingService, IConfigProvider, INotifier } from "../src/index";

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

class MockEmbeddingBackend implements EmbeddingBackend {
  readonly name = "mock";

  async embed(): Promise<number[]> {
    return [1, 2, 3];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, 2, 3]);
  }

  async initialize(): Promise<void> {}

  async isAvailable(): Promise<boolean> {
    return false;
  }

  async isAvailableForModel(modelName?: string): Promise<boolean> {
    return modelName === "mock:model-a";
  }

  getDimension(): number | null {
    return 3;
  }

  dispose(): void {}
}

describe("EmbeddingService availability routing", () => {
  it("should honor model-specific backend availability probes", async () => {
    const embeddingService = new EmbeddingService({ config: mockConfig, notifier: mockNotifier });
    embeddingService.registerBackend(new MockEmbeddingBackend());

    expect(await embeddingService.isBackendAvailable("mock", "mock:model-a")).to.equal(true);
    expect(await embeddingService.isBackendAvailable("mock", "mock:model-b")).to.equal(false);
  });
});

class RemoteCatalogBackend implements EmbeddingBackend {
  readonly name = "remote";
  listModelCalls = 0;
  failListing = false;

  async embed(): Promise<number[]> {
    return [1, 2, 3];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, 2, 3]);
  }

  async initialize(): Promise<void> {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  getDimension(): number | null {
    return 3;
  }

  async listModels(): Promise<Array<{ id: string; name: string }>> {
    this.listModelCalls += 1;
    if (this.failListing) {
      throw new Error("remote catalogue unavailable");
    }
    return [{ id: "remote-model-a", name: "remote-model-a" }];
  }

  dispose(): void {}
}

function configForcingBackend(backend: string): IConfigProvider {
  return {
    get: <T>(key: string, defaultValue: T): T => (key === "embeddingBackend" ? (backend as T) : defaultValue),
  };
}

describe("EmbeddingService.listAvailableModels before initialization", () => {
  it("returns the remote catalogue when the configured backend is remote and nothing is active yet", async () => {
    const backend = new RemoteCatalogBackend();
    const embeddingService = new EmbeddingService({ config: configForcingBackend("remote"), notifier: mockNotifier });
    embeddingService.registerBackend(backend);

    const models = await embeddingService.listAvailableModels();

    expect(backend.listModelCalls).to.equal(1);
    expect(models).to.deep.equal([{ name: "remote-model-a", source: "remote", downloaded: true }]);
  });

  it("keeps the local registry when the configured backend is huggingface", async () => {
    const backend = new RemoteCatalogBackend();
    const embeddingService = new EmbeddingService({
      config: configForcingBackend("huggingface"),
      notifier: mockNotifier,
    });
    embeddingService.registerBackend(backend);

    const models = await embeddingService.listAvailableModels();

    expect(backend.listModelCalls).to.equal(0);
    expect(models.length).to.be.greaterThan(0);
    expect(models.every((model) => model.source !== "remote")).to.equal(true);
  });

  it("falls back to the local registry when the remote catalogue cannot be fetched", async () => {
    const backend = new RemoteCatalogBackend();
    backend.failListing = true;
    const embeddingService = new EmbeddingService({ config: configForcingBackend("remote"), notifier: mockNotifier });
    embeddingService.registerBackend(backend);

    const models = await embeddingService.listAvailableModels();

    expect(backend.listModelCalls).to.equal(1);
    expect(models.length).to.be.greaterThan(0);
    expect(models.every((model) => model.source !== "remote")).to.equal(true);
  });
});
