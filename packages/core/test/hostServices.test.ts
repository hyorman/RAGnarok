import { expect } from "chai";
import {
  createEmbeddingServices,
  createMemoryServices,
  type EmbeddingBackend,
  type EmbeddingService,
  type IConfigProvider,
  type INotifier,
} from "../src/index";

const config: IConfigProvider = { get: <T>(_key: string, fallback: T) => fallback };
const notifier: INotifier = {
  showInfo: () => undefined,
  showWarning: () => undefined,
  showError: () => undefined,
  withProgress: async <T>(_title: string, task: (report: (message: string) => void) => Promise<T>) =>
    task(() => undefined),
};

describe("host service builders", function () {
  it("registers fresh backends, in fallback order, on every service it builds", function () {
    const registered: EmbeddingBackend[][] = [];
    let made = 0;
    const { embeddingService, buildEmbeddingService } = createEmbeddingServices({
      config,
      notifier,
      maxResidentLocal: 2,
      createBackends: () => [
        { name: `first-${made}` } as unknown as EmbeddingBackend,
        { name: `last-${made++}` } as unknown as EmbeddingBackend,
      ],
      createService: () => {
        const backends: EmbeddingBackend[] = [];
        registered.push(backends);
        return {
          registerBackend: (backend: EmbeddingBackend) => backends.push(backend),
        } as unknown as EmbeddingService;
      },
    });
    const second = buildEmbeddingService();

    expect(embeddingService).to.not.equal(second);
    expect(registered.map((list) => list.map((b) => (b as unknown as { name: string }).name))).to.deep.equal([
      ["first-0", "last-0"],
      ["first-1", "last-1"],
    ]);
  });

  it("hands the registry the same service builder and the resident cap", async function () {
    interface BuiltService {
      backends: EmbeddingBackend[];
      disposed: boolean;
    }
    const built: BuiltService[] = [];
    const { embeddingRegistry } = createEmbeddingServices({
      config,
      notifier,
      maxResidentLocal: 2,
      createBackends: () => [{ name: "only" } as unknown as EmbeddingBackend],
      createService: () => {
        const record: BuiltService = { backends: [], disposed: false };
        built.push(record);
        return {
          registerBackend: (backend: EmbeddingBackend) => record.backends.push(backend),
          initialize: async () => undefined,
          initializeForBackend: async () => undefined,
          dispose: async () => {
            record.disposed = true;
          },
        } as unknown as EmbeddingService;
      },
    });
    const hostServiceCount = built.length; // the host's default service, built eagerly

    for (const model of ["a", "b", "c"]) {
      await embeddingRegistry.get({ model, backend: "huggingface", endpointHash: "local" });
    }

    const registryServices = built.slice(hostServiceCount);
    expect(registryServices.map((service) => service.backends.length)).to.deep.equal([1, 1, 1]);
    expect(registryServices.map((service) => service.disposed)).to.deep.equal([true, false, false]);
    expect(embeddingRegistry.size().local).to.equal(2);
  });

  it("wires one coordinator into both memory services", function () {
    const coordinator = { tag: "coordinator" };
    const seen: unknown[] = [];
    const services = createMemoryServices({} as never, {
      createMemoryCoordinator: () => coordinator as never,
      createMemoryService: (_store, c) => (seen.push(c), { tag: "memory" }) as never,
      createGraphVisualizationService: (_store, c) => (seen.push(c), { tag: "graph" }) as never,
    });

    expect(services.coordinator).to.equal(coordinator);
    expect(seen).to.deep.equal([coordinator, coordinator]);
  });
});
