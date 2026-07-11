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
