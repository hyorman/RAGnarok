import { expect } from "chai";
import type { EmbeddingBackend, IConfigProvider, INotifier } from "../src/index";
import { EmbeddingService } from "../src/index";

const config: IConfigProvider = {
  get: <T>(_key: string, defaultValue: T): T => defaultValue,
};

const notifier: INotifier = {
  showInfo: () => {},
  showWarning: () => {},
  showError: () => {},
  withProgress: async <T>(_title: string, task: (report: (message: string) => void) => Promise<T>) => task(() => {}),
};

class LifecycleBackend implements EmbeddingBackend {
  readonly name: string;
  model = "old";
  initializeCalls: string[] = [];
  embedCalls: string[] = [];
  embedGate: Promise<void> | null = null;
  private switchSnapshot: string | null = null;
  onModelChanged: ((model: string) => void) | undefined = undefined;

  constructor(name = "lifecycle") {
    this.name = name;
  }

  async initialize(modelName?: string): Promise<void> {
    const candidate = modelName ?? this.model;
    this.initializeCalls.push(candidate);
    await Promise.resolve();
    if (candidate === "broken") {
      throw new Error("candidate failed validation");
    }
    this.model = candidate;
    this.onModelChanged?.(candidate);
  }

  async embed(_text: string): Promise<number[]> {
    const generation = this.model;
    this.embedCalls.push(generation);
    await (this.embedGate ?? Promise.resolve());
    return generation === "old" ? [1, 0] : [0, 1];
  }

  beginSwitchTransaction(): void {
    this.switchSnapshot = this.model;
  }

  commitSwitchTransaction(): void {
    this.switchSnapshot = null;
  }

  rollbackSwitchTransaction(): void {
    if (this.switchSnapshot) {
      this.model = this.switchSnapshot;
      this.switchSnapshot = null;
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.embed(text)));
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  getDimension(): number {
    return 2;
  }

  getModelId(): string {
    return this.model;
  }

  dispose(): void {}
}

function createService(...backends: LifecycleBackend[]): EmbeddingService {
  const service = new EmbeddingService({ config, notifier });
  for (const backend of backends) {
    service.registerBackend(backend);
  }
  return service;
}

describe("EmbeddingService generation lifecycle", () => {
  it("lets an active query finish before mutating a same-backend model", async () => {
    const backend = new LifecycleBackend();
    const service = createService(backend);
    await service.initialize("old");
    let release!: () => void;
    backend.embedGate = new Promise<void>((resolve) => (release = resolve));

    const oldQuery = service.embed("in flight");
    await waitUntil(() => backend.embedCalls.length === 1);
    const switching = service.initialize("new");
    await Promise.resolve();
    expect(backend.initializeCalls).to.deep.equal(["old"]);

    release();
    expect(await oldQuery).to.deep.equal([1, 0]);
    await switching;
    expect(backend.model).to.equal("new");
    await service.dispose();
  });

  it("rolls back a candidate and queues unrelated readers until validation finishes", async () => {
    const backend = new LifecycleBackend();
    const service = createService(backend);
    const observedEvents: string[] = [];
    const subscription = EmbeddingService.onModelChanged.subscribe((model) => observedEvents.push(model));
    await service.initialize("old");
    observedEvents.length = 0;
    let rejectValidation!: (error: Error) => void;
    const validation = new Promise<void>((_resolve, reject) => (rejectValidation = reject));

    const switching = service.runTransactionalSwitch("lifecycle", "new", () => validation);
    await Promise.resolve();
    await Promise.resolve();
    const queuedQuery = service.embed("must not see candidate");
    await Promise.resolve();
    expect(backend.embedCalls).to.deep.equal([]);

    rejectValidation(new Error("manager rebuild failed"));
    try {
      await switching;
      expect.fail("expected rollback");
    } catch (error) {
      expect((error as Error).message).to.equal("manager rebuild failed");
    }
    expect(await queuedQuery).to.deep.equal([1, 0]);
    expect(service.getCurrentModel()).to.equal("lifecycle:old");
    expect(backend.initializeCalls).to.deep.equal(["old", "new"]);
    expect(observedEvents).to.deep.equal([]);
    subscription.unsubscribe();
    await service.dispose();
  });

  it("single-flights concurrent initialization of the same target", async () => {
    const backend = new LifecycleBackend();
    const service = createService(backend);
    await Promise.all(Array.from({ length: 10 }, () => service.initialize("new")));
    expect(backend.initializeCalls).to.deep.equal(["new"]);
    await service.dispose();
  });

  it("leaves the active model untouched when candidate initialization fails", async () => {
    const backend = new LifecycleBackend();
    const service = createService(backend);
    await service.initialize("old");
    try {
      await service.initialize("broken");
      expect.fail("expected initialization failure");
    } catch (error) {
      expect((error as Error).message).to.include("candidate failed");
    }
    expect(service.getCurrentModel()).to.equal("lifecycle:old");
    expect(await service.embed("still usable")).to.deep.equal([1, 0]);
    await service.dispose();
  });

  it("drains scoped readers before first global initialization mutates their backend", async () => {
    const backend = new LifecycleBackend();
    const service = createService(backend);
    let release!: () => void;
    backend.embedGate = new Promise<void>((resolve) => (release = resolve));

    const scopedQuery = service.embedWithBackend("lifecycle", "already in flight");
    await waitUntil(() => backend.embedCalls.length === 1);
    const initializing = service.initialize();
    await Promise.resolve();
    expect(backend.initializeCalls).to.deep.equal([]);

    release();
    expect(await scopedQuery).to.deep.equal([1, 0]);
    await initializing;
    expect(backend.initializeCalls).to.deep.equal(["old"]);
    await service.dispose();
  });

  it("drains scoped readers before initializing and publishing a replacement backend", async () => {
    const active = new LifecycleBackend("active");
    const replacement = new LifecycleBackend("replacement");
    const service = createService(active, replacement);
    await service.selectBackendTransactional("active", "old");
    let release!: () => void;
    replacement.embedGate = new Promise<void>((resolve) => (release = resolve));

    const scopedQuery = service.embedWithBackend("replacement", "replacement reader");
    await waitUntil(() => replacement.embedCalls.length === 1);
    const switching = service.selectBackendTransactional("replacement", "new");
    await Promise.resolve();
    expect(replacement.initializeCalls).to.deep.equal([]);

    release();
    expect(await scopedQuery).to.deep.equal([1, 0]);
    await switching;
    expect(replacement.initializeCalls).to.deep.equal(["new"]);
    expect(service.getActiveBackendType()).to.equal("replacement");
    await service.dispose();
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20 && !predicate(); attempt += 1) {
    await Promise.resolve();
  }
  expect(predicate()).to.equal(true);
}
