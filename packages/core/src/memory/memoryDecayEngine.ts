/**
 * MemoryDecayEngine — Confidence decay and TTL expiry for memory entries.
 *
 * Decay formula (computed on read, never persisted):
 *   effectiveConfidence = baseConfidence × e^(-λ × daysSinceLastAccess) × (1 + 0.1 × log(1 + accessCount))
 *
 * The stored `entry.confidence` is an immutable BASE value. Effective
 * confidence is always derived from the base plus the true elapsed time since
 * last access. Writing the decayed value back would compound decay across
 * cycles (each cycle would re-apply the full elapsed-time penalty to an
 * already-decayed baseline), collapsing confidence after a few calls
 * regardless of real elapsed time — so decay evaluation is strictly pure.
 *
 * Recall reinforcement resets lastAccessedAt, which naturally restores
 * effective confidence.
 *
 * Fact entities never decay (entity type = "fact").
 * TTL expiry applies to all entries regardless of type.
 */

import { Logger } from "../logger";
import { MemoryEntry, DecayStatus, DECAY_LAMBDA, MIN_CONFIDENCE_THRESHOLD } from "./types";
import { MemoryGraph } from "./memoryGraph";

export class MemoryDecayEngine {
  private logger = new Logger("MemoryDecayEngine");
  private lambda: number;
  private minConfidence: number;

  constructor(options?: { lambda?: number; minConfidence?: number }) {
    this.lambda = options?.lambda ?? DECAY_LAMBDA;
    this.minConfidence = options?.minConfidence ?? MIN_CONFIDENCE_THRESHOLD;
  }

  /**
   * Compute the effective (decayed) confidence of an entry right now.
   * Pure — never mutates the entry. Facts are immune and return the base.
   */
  effectiveConfidence(entry: MemoryEntry, graph: MemoryGraph, now: number = Date.now()): number {
    const baseConfidence = entry.confidence ?? 1.0;
    if (this.isFactEntry(entry, graph)) {
      return baseConfidence;
    }
    const daysSinceLastAccess = (now - entry.lastAccessedAt) / (1000 * 60 * 60 * 24);
    const accessBoost = 1 + 0.1 * Math.log(1 + entry.accessCount);
    const decayed = baseConfidence * Math.exp(-this.lambda * daysSinceLastAccess) * accessBoost;
    return Math.max(0, Math.min(1, decayed));
  }

  /**
   * Run one decay cycle across provided entries: a pure evaluation of
   * effective confidence against the expiry thresholds. Nothing is mutated or
   * persisted — repeated cycles are idempotent for the same wall-clock time.
   * Facts never decay (entity type = "fact").
   */
  runDecayCycle(entries: MemoryEntry[], graph: MemoryGraph): DecayStatus {
    return this.getDecayStatus(entries, graph);
  }

  /**
   * Remove expired entries (TTL expiresAt < now OR effective confidence <
   * minConfidence). Also removes associated orphaned entities from the graph.
   * Modifies entries array in-place. Returns removed entries.
   */
  expireStale(entries: MemoryEntry[], graph: MemoryGraph): MemoryEntry[] {
    const now = Date.now();
    const removed: MemoryEntry[] = [];

    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      const isFact = this.isFactEntry(entry, graph);
      const confidence = this.effectiveConfidence(entry, graph, now);
      const isConfidenceExpired = !isFact && confidence < this.minConfidence;
      const isTTLExpired = !!entry.expiresAt && entry.expiresAt < now;

      if (isConfidenceExpired || isTTLExpired) {
        entries.splice(i, 1);
        removed.push(entry);

        // Clean up orphaned graph entities
        for (const entityId of entry.entityIds) {
          const stillReferenced = entries.some((e) => e.entityIds.includes(entityId));
          if (!stillReferenced) {
            graph.removeEntity(entityId);
          }
        }
      }
    }

    if (removed.length > 0) {
      this.logger.debug(`Expired ${removed.length} stale entries`);
    }

    return removed;
  }

  /**
   * Get decay status for entries without modifying anything.
   * Reports effective confidence relative to the stored base.
   */
  getDecayStatus(entries: MemoryEntry[], graph: MemoryGraph): DecayStatus {
    let decayedCount = 0;
    let expiredCount = 0;
    let nearThresholdCount = 0;
    const now = Date.now();

    for (const entry of entries) {
      const isFact = this.isFactEntry(entry, graph);
      const baseConfidence = entry.confidence ?? 1.0;
      const projectedConfidence = this.effectiveConfidence(entry, graph, now);

      if (!isFact && projectedConfidence < baseConfidence) {
        decayedCount++;
      }

      const isTTLExpired = !!entry.expiresAt && entry.expiresAt < now;
      const isConfidenceExpired = !isFact && projectedConfidence < this.minConfidence;

      if (isTTLExpired || isConfidenceExpired) {
        expiredCount++;
      } else if (!isFact && projectedConfidence < this.minConfidence * 2) {
        nearThresholdCount++;
      }
    }

    return {
      totalEntries: entries.length,
      decayedCount,
      expiredCount,
      nearThresholdCount,
    };
  }

  /** Check if entry has associated entities of type "fact" */
  private isFactEntry(entry: MemoryEntry, graph: MemoryGraph): boolean {
    return entry.entityIds.some((id) => {
      const entity = graph.getEntity(id);
      return entity?.type === "fact";
    });
  }
}
