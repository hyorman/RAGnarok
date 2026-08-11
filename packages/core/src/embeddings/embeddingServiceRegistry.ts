import type { EmbeddingService } from "./embeddingService";
import { Logger } from "../logger";

/** Identity of one embedding space. `endpointHash` is "local" for local backends. */
export interface EmbeddingResolution {
  model: string;
  backend: string;
  endpointHash: string;
}

/** Backend kinds are exactly "huggingface" and "remote". */
export function isRemoteBackend(backend: string): boolean {
  return backend === "remote";
}

const keyOf = (r: EmbeddingResolution): string => `${r.backend}::${r.endpointHash}::${r.model}`;

export interface EmbeddingServiceRegistryOptions {
  /** Creates an uninitialised EmbeddingService. */
  createService: () => EmbeddingService;
  /** Maximum resident LOCAL services. Remote services are exempt. */
  maxResidentLocal: number;
}

/**
 * Owns one EmbeddingService per embedding space.
 *
 * Each service is initialised to exactly one model and never mutated afterwards.
 * That immutability is the point: a single shared service being re-pointed by
 * whichever topic loaded last is the bug this registry exists to remove.
 *
 * Local services hold ONNX weights and are LRU-bounded. Remote services are
 * stateless HTTP clients, so they neither occupy a slot nor get evicted.
 */
export class EmbeddingServiceRegistry {
  private readonly logger = new Logger("EmbeddingServiceRegistry");
  private readonly createService: () => EmbeddingService;
  private readonly maxResidentLocal: number;
  /** Map iteration order is insertion order, which we maintain as LRU order. */
  private readonly local = new Map<string, EmbeddingService>();
  private readonly remote = new Map<string, EmbeddingService>();

  constructor(options: EmbeddingServiceRegistryOptions) {
    this.createService = options.createService;
    this.maxResidentLocal = Math.max(1, options.maxResidentLocal);
  }

  public async get(resolution: EmbeddingResolution): Promise<EmbeddingService> {
    const key = keyOf(resolution);
    const pool = isRemoteBackend(resolution.backend) ? this.remote : this.local;

    const existing = pool.get(key);
    if (existing) {
      if (pool === this.local) {
        // Re-insert to move to the most-recently-used end.
        pool.delete(key);
        pool.set(key, existing);
      }
      return existing;
    }

    const service = this.createService();
    await service.initialize(resolution.model);

    if (pool === this.local) {
      // Evict BEFORE inserting, so the service we are about to return can
      // never be the one evicted — which is what a cap of 1 would otherwise do.
      while (this.local.size >= this.maxResidentLocal) {
        const oldestKey = this.local.keys().next().value;
        if (oldestKey === undefined) {
          break;
        }
        const evicted = this.local.get(oldestKey);
        this.local.delete(oldestKey);
        if (evicted) {
          this.logger.info("Evicting embedding service", { key: oldestKey });
          await evicted.dispose();
        }
      }
    }

    pool.set(key, service);
    return service;
  }

  public size(): { local: number; remote: number } {
    return { local: this.local.size, remote: this.remote.size };
  }

  public async disposeAll(): Promise<void> {
    for (const pool of [this.local, this.remote]) {
      for (const service of pool.values()) {
        await service.dispose();
      }
      pool.clear();
    }
  }
}
