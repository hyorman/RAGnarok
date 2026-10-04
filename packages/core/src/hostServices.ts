import type { EmbeddingBackend } from "./embeddings/embeddingBackend";
import { EmbeddingService } from "./embeddings/embeddingService";
import { EmbeddingServiceRegistry } from "./embeddings/embeddingServiceRegistry";
import type { IConfigProvider, INotifier } from "./interfaces";
import { MemoryOperationCoordinator, MemoryService, MemoryStore } from "./memory";
import { GraphVisualizationService } from "./visualization/graphVisualizationService";

export interface EmbeddingServicesOptions {
  config: IConfigProvider;
  notifier: INotifier;
  /**
   * Backends in fallback order: the last one registered is the fallback.
   * Called once per service, because each service needs its own instances:
   * sharing one HuggingFaceBackend across services would let one service
   * re-point the model under another.
   */
  createBackends(): EmbeddingBackend[];
  /** Resident weight-bearing services the registry keeps loaded. */
  maxResidentLocal: number;
  /** Test seam; defaults to `new EmbeddingService(options)`. */
  createService?: (options: { config: IConfigProvider; notifier: INotifier }) => EmbeddingService;
}

/** The host's default embedding service plus the one registry that caps resident models. */
export function createEmbeddingServices(options: EmbeddingServicesOptions): {
  embeddingService: EmbeddingService;
  embeddingRegistry: EmbeddingServiceRegistry;
  buildEmbeddingService: () => EmbeddingService;
} {
  const create = options.createService ?? ((serviceOptions) => new EmbeddingService(serviceOptions));
  const buildEmbeddingService = (): EmbeddingService => {
    const service = create({ config: options.config, notifier: options.notifier });
    for (const backend of options.createBackends()) {
      service.registerBackend(backend);
    }
    return service;
  };
  return {
    embeddingService: buildEmbeddingService(),
    // One registry per host: a registry per consumer would give each its own
    // resident models and defeat the cap.
    embeddingRegistry: new EmbeddingServiceRegistry({
      createService: buildEmbeddingService,
      maxResidentLocal: options.maxResidentLocal,
    }),
    buildEmbeddingService,
  };
}

export interface MemoryServices {
  coordinator: MemoryOperationCoordinator;
  memoryService: MemoryService;
  graphService: GraphVisualizationService;
}

export interface MemoryServiceFactory {
  createMemoryCoordinator(): MemoryOperationCoordinator;
  createMemoryService(store: MemoryStore, coordinator: MemoryOperationCoordinator): MemoryService;
  createGraphVisualizationService(
    store: MemoryStore,
    coordinator: MemoryOperationCoordinator,
  ): GraphVisualizationService;
}

export const defaultMemoryServiceFactory: MemoryServiceFactory = {
  createMemoryCoordinator: () => new MemoryOperationCoordinator(),
  createMemoryService: (store, coordinator) => new MemoryService(store, coordinator),
  createGraphVisualizationService: (store, coordinator) => new GraphVisualizationService(store, coordinator),
};

/** One coordinator shared by the memory service and the graph projection over the same store. */
export function createMemoryServices(
  store: MemoryStore,
  factory: MemoryServiceFactory = defaultMemoryServiceFactory,
): MemoryServices {
  const coordinator = factory.createMemoryCoordinator();
  return {
    coordinator,
    memoryService: factory.createMemoryService(store, coordinator),
    graphService: factory.createGraphVisualizationService(store, coordinator),
  };
}
