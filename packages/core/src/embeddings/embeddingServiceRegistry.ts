import type { EmbeddingService } from "./embeddingService";
import { Logger } from "../logger";

/** Identity of one embedding space. `endpointHash` is "local" for local backends. */
export interface EmbeddingResolution {
  model: string;
  backend: string;
  endpointHash: string;
}

/**
 * Backend kinds that hold no resident weights and therefore never occupy a
 * cap slot. Unknown kinds deliberately COUNT against the cap: an unknown
 * weight-bearing backend treated as exempt grows unbounded to OOM, whereas
 * an unknown stateless one merely wastes a slot. Fail toward the cheaper mistake.
 */
const CAP_EXEMPT_BACKENDS = new Set(["remote", "vscodeLM"]);

export function isCapExempt(backend: string): boolean {
  return CAP_EXEMPT_BACKENDS.has(backend);
}

/**
 * Whether a backend talks to a configurable HTTP endpoint, and therefore has a
 * meaningful endpointHash. Distinct from isCapExempt: "vscodeLM" is cap-exempt
 * (it holds no weights) but has NO endpoint, so it must key as "local" here.
 * Using isCapExempt for this would make every vscodeLM store load perform a
 * live embed probe against an endpoint that does not exist.
 */
export function hasRemoteEndpoint(backend: string): boolean {
  return backend === "remote";
}

const keyOf = (r: EmbeddingResolution): string => `${r.backend}::${r.endpointHash}::${r.model}`;

export interface EmbeddingServiceRegistryOptions {
  /** Creates an uninitialised EmbeddingService. */
  createService: () => EmbeddingService;
  /** Maximum resident weight-bearing services. Cap-exempt backends do not count. */
  maxResidentLocal: number;
}

/**
 * Owns one EmbeddingService per embedding space.
 *
 * Each service is initialised to exactly one model and never mutated afterwards.
 * That immutability is the point: a single shared service being re-pointed by
 * whichever topic loaded last is the bug this registry exists to remove.
 *
 * Weight-bearing services (ONNX models) are LRU-bounded. Cap-exempt backends —
 * remote HTTP clients and vscodeLM — hold no weights, so they neither occupy a
 * slot nor get evicted; letting one take a slot would evict a real model to
 * make room for nothing.
 *
 * Entries are pooled as PROMISES, claimed synchronously on a miss, so two
 * concurrent get() calls for the same key share one service rather than each
 * building their own and leaking the loser.
 */
export class EmbeddingServiceRegistry {
  private readonly logger = new Logger("EmbeddingServiceRegistry");
  private readonly createService: () => EmbeddingService;
  private readonly maxResidentLocal: number;
  /** Map iteration order is insertion order, which we maintain as LRU order. */
  private readonly local = new Map<string, Promise<EmbeddingService>>();
  private readonly exempt = new Map<string, Promise<EmbeddingService>>();

  constructor(options: EmbeddingServiceRegistryOptions) {
    this.createService = options.createService;
    this.maxResidentLocal = Math.max(1, options.maxResidentLocal);
  }

  public async get(resolution: EmbeddingResolution): Promise<EmbeddingService> {
    const key = keyOf(resolution);
    const pool = isCapExempt(resolution.backend) ? this.exempt : this.local;

    const existing = pool.get(key);
    if (existing) {
      if (pool === this.local) {
        // Re-insert to move to the most-recently-used end.
        pool.delete(key);
        pool.set(key, existing);
      }
      return existing;
    }

    // Claim the key SYNCHRONOUSLY — before the first await — so a concurrent
    // caller for the same key finds this promise instead of starting a second
    // service that would overwrite ours and leak undisposed.
    const creation = (async () => {
      const service = this.createService();
      await service.initialize(resolution.model);
      return service;
    })();
    pool.set(key, creation);

    try {
      await creation;
    } catch (error) {
      // A failed initialise must not poison the key.
      if (pool.get(key) === creation) {
        pool.delete(key);
      }
      throw error;
    }

    if (pool === this.local) {
      await this.evictDownTo(this.maxResidentLocal, key);
    }

    return creation;
  }

  /**
   * Trims the local pool to `max` entries, oldest first.
   *
   * The synchronous claim above forces insert-before-evict, so the invariant
   * "never dispose the service we are about to return" is held here instead of
   * by ordering: `size > max` (post-insert) is the old pre-insert `size >= max`,
   * and `protectedKey` is skipped outright.
   */
  private async evictDownTo(max: number, protectedKey: string): Promise<void> {
    while (this.local.size > max) {
      let oldestKey: string | undefined;
      for (const candidate of this.local.keys()) {
        if (candidate !== protectedKey) {
          oldestKey = candidate;
          break;
        }
      }
      if (oldestKey === undefined) {
        break;
      }
      const evicted = this.local.get(oldestKey);
      this.local.delete(oldestKey);
      if (evicted) {
        this.logger.info("Evicting embedding service", { key: oldestKey });
        await (await evicted).dispose();
      }
    }
  }

  public size(): { local: number; exempt: number } {
    return { local: this.local.size, exempt: this.exempt.size };
  }

  public async disposeAll(): Promise<void> {
    for (const pool of [this.local, this.exempt]) {
      for (const pending of pool.values()) {
        const service = await pending;
        await service.dispose();
      }
      pool.clear();
    }
  }
}
