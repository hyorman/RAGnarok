import { expect } from "chai";
import { MemoryDecayEngine } from "../src/memory/memoryDecayEngine";
import { MemoryGraph } from "../src/memory/memoryGraph";
import {
  MemoryEntry,
  MemoryEntity,
  MIN_CONFIDENCE_THRESHOLD,
} from "../src/memory/types";

// ── Helpers ──────────────────────────────────────────────────────────

const DAY_MS = 1000 * 60 * 60 * 24;

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: overrides.id ?? `entry-${Math.random().toString(36).slice(2, 8)}`,
    content: overrides.content ?? "test memory",
    scope: overrides.scope ?? "workspace",
    branch: overrides.branch,
    vector: overrides.vector ?? [1, 0, 0],
    createdAt: overrides.createdAt ?? Date.now(),
    updatedAt: overrides.updatedAt ?? Date.now(),
    accessCount: overrides.accessCount ?? 0,
    lastAccessedAt: overrides.lastAccessedAt ?? Date.now(),
    tags: overrides.tags ?? [],
    entityIds: overrides.entityIds ?? [],
    metadata: overrides.metadata ?? {},
    confidence: overrides.confidence ?? 1.0,
    expiresAt: overrides.expiresAt,
  };
}

function makeFactEntity(id: string, sourceMemoryIds: string[]): MemoryEntity {
  return {
    id,
    name: "some fact",
    type: "fact",
    description: "a fact",
    vector: [1, 0, 0],
    scope: "workspace",
    confidence: 1.0,
    strength: 1.0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sourceMemoryIds,
    metadata: {},
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("MemoryDecayEngine", function () {
  let engine: MemoryDecayEngine;
  let graph: MemoryGraph;

  beforeEach(function () {
    engine = new MemoryDecayEngine();
    graph = new MemoryGraph();
  });

  // ── runDecayCycle ──────────────────────────────────────────────────

  describe("runDecayCycle", function () {
    it("should not decay entries accessed just now", function () {
      // Use a future timestamp to avoid sub-millisecond timing causing tiny decay
      const entries = [makeEntry({ lastAccessedAt: Date.now() + 1000, confidence: 1.0 })];
      const status = engine.runDecayCycle(entries, graph);

      expect(engine.effectiveConfidence(entries[0], graph)).to.be.closeTo(1.0, 0.001);
      expect(status.decayedCount).to.equal(0);
      expect(status.expiredCount).to.equal(0);
    });

    it("should report reduced effective confidence for entries not accessed for days", function () {
      const entries = [
        makeEntry({
          lastAccessedAt: Date.now() - 30 * DAY_MS,
          confidence: 1.0,
          accessCount: 0,
        }),
      ];
      const status = engine.runDecayCycle(entries, graph);

      // e^(-0.05 * 30) * (1 + 0.1 * ln(1)) = e^(-1.5) * 1 ≈ 0.223
      const effective = engine.effectiveConfidence(entries[0], graph);
      expect(effective).to.be.lessThan(0.3);
      expect(effective).to.be.greaterThan(0.1);
      expect(status.decayedCount).to.equal(1);
      // Stored base confidence is never mutated
      expect(entries[0].confidence).to.equal(1.0);
    });

    it("should be idempotent: repeated cycles never compound decay", function () {
      const entries = [
        makeEntry({
          lastAccessedAt: Date.now() - 10 * DAY_MS,
          confidence: 1.0,
          accessCount: 0,
        }),
      ];

      // Previously each cycle wrote the decayed value back into confidence
      // and the next cycle re-applied the full elapsed-time penalty on top:
      // 0.607 → 0.368 → 0.223 within seconds. Effective confidence must be
      // stable across back-to-back cycles.
      const first = engine.effectiveConfidence(entries[0], graph);
      engine.runDecayCycle(entries, graph);
      engine.runDecayCycle(entries, graph);
      engine.runDecayCycle(entries, graph);
      const after = engine.effectiveConfidence(entries[0], graph);

      expect(entries[0].confidence).to.equal(1.0);
      expect(after).to.be.closeTo(first, 0.001);
      // e^(-0.05 * 10) ≈ 0.607 — nowhere near the compounded 0.223
      expect(after).to.be.greaterThan(0.55);
    });

    it("should mark entries below threshold as expired", function () {
      const entries = [
        makeEntry({
          lastAccessedAt: Date.now() - 100 * DAY_MS,
          confidence: 1.0,
          accessCount: 0,
        }),
      ];
      const status = engine.runDecayCycle(entries, graph);

      expect(engine.effectiveConfidence(entries[0], graph)).to.be.lessThan(MIN_CONFIDENCE_THRESHOLD);
      expect(status.expiredCount).to.equal(1);
    });

    it("should give access-count boost to frequently accessed entries", function () {
      const low = makeEntry({
        lastAccessedAt: Date.now() - 20 * DAY_MS,
        confidence: 1.0,
        accessCount: 0,
      });
      const high = makeEntry({
        lastAccessedAt: Date.now() - 20 * DAY_MS,
        confidence: 1.0,
        accessCount: 50,
      });

      expect(engine.effectiveConfidence(high, graph)).to.be.greaterThan(
        engine.effectiveConfidence(low, graph),
      );
    });

    it("should never decay fact entries", function () {
      const factEntityId = "fact-entity-1";
      const entry = makeEntry({
        lastAccessedAt: Date.now() - 100 * DAY_MS,
        confidence: 1.0,
        entityIds: [factEntityId],
      });
      graph.addEntity(makeFactEntity(factEntityId, [entry.id]));

      const entries = [entry];
      const status = engine.runDecayCycle(entries, graph);

      expect(engine.effectiveConfidence(entries[0], graph)).to.equal(1.0);
      expect(status.decayedCount).to.equal(0);
      expect(status.expiredCount).to.equal(0);
    });

    it("should count TTL-expired entries", function () {
      const entries = [
        makeEntry({
          expiresAt: Date.now() - 1000,
          confidence: 1.0,
          lastAccessedAt: Date.now(),
        }),
      ];
      const status = engine.runDecayCycle(entries, graph);

      expect(status.expiredCount).to.equal(1);
    });

    it("should count near-threshold entries", function () {
      // An entry whose effective confidence lands between threshold and 2x threshold
      // e^(-0.05 * days) ≈ 0.15 → -0.05*days = ln(0.15) → days ≈ 37.9
      const entries = [
        makeEntry({
          lastAccessedAt: Date.now() - 36 * DAY_MS,
          confidence: 1.0,
          accessCount: 0,
        }),
      ];
      const status = engine.runDecayCycle(entries, graph);

      const effective = engine.effectiveConfidence(entries[0], graph);
      expect(effective).to.be.greaterThan(MIN_CONFIDENCE_THRESHOLD);
      expect(effective).to.be.lessThan(MIN_CONFIDENCE_THRESHOLD * 2);
      expect(status.nearThresholdCount).to.equal(1);
    });

    it("should clamp effective confidence between 0 and 1", function () {
      // Even with very high accessCount, confidence should not exceed 1
      const entry = makeEntry({
        lastAccessedAt: Date.now(),
        confidence: 1.0,
        accessCount: 10000,
      });

      expect(engine.effectiveConfidence(entry, graph)).to.be.at.most(1.0);
    });
  });

  // ── expireStale ────────────────────────────────────────────────────

  describe("expireStale", function () {
    it("should remove entries with confidence below threshold", function () {
      const entries = [
        makeEntry({ id: "low", confidence: 0.05 }),
        makeEntry({ id: "high", confidence: 0.8 }),
      ];
      const removed = engine.expireStale(entries, graph);

      expect(removed).to.have.length(1);
      expect(removed[0].id).to.equal("low");
      expect(entries).to.have.length(1);
      expect(entries[0].id).to.equal("high");
    });

    it("should remove TTL-expired entries", function () {
      const entries = [
        makeEntry({ id: "expired", expiresAt: Date.now() - 1000, confidence: 1.0 }),
        makeEntry({ id: "alive", confidence: 1.0 }),
      ];
      const removed = engine.expireStale(entries, graph);

      expect(removed).to.have.length(1);
      expect(removed[0].id).to.equal("expired");
      expect(entries).to.have.length(1);
    });

    it("should not remove fact entries with low confidence", function () {
      const factEntityId = "fact-entity-2";
      const entry = makeEntry({ id: "fact-entry", confidence: 0.01, entityIds: [factEntityId] });
      graph.addEntity(makeFactEntity(factEntityId, [entry.id]));

      const entries = [entry];
      const removed = engine.expireStale(entries, graph);

      expect(removed).to.have.length(0);
      expect(entries).to.have.length(1);
    });

    it("should remove orphaned graph entities when entry is expired", function () {
      const entityId = "orphan-entity";
      graph.addEntity({
        id: entityId,
        name: "orphan",
        type: "concept",
        description: "will be orphaned",
        vector: [1, 0, 0],
        scope: "workspace",
        confidence: 1.0,
        strength: 1.0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sourceMemoryIds: ["entry-to-remove"],
        metadata: {},
      });

      const entries = [
        makeEntry({ id: "entry-to-remove", confidence: 0.01, entityIds: [entityId] }),
      ];
      engine.expireStale(entries, graph);

      expect(graph.getEntity(entityId)).to.be.null;
    });

    it("should keep graph entities referenced by surviving entries", function () {
      const entityId = "shared-entity";
      graph.addEntity({
        id: entityId,
        name: "shared",
        type: "concept",
        description: "shared between entries",
        vector: [1, 0, 0],
        scope: "workspace",
        confidence: 1.0,
        strength: 1.0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sourceMemoryIds: ["dying", "alive"],
        metadata: {},
      });

      const entries = [
        makeEntry({ id: "dying", confidence: 0.01, entityIds: [entityId] }),
        makeEntry({ id: "alive", confidence: 0.9, entityIds: [entityId] }),
      ];
      engine.expireStale(entries, graph);

      expect(graph.getEntity(entityId)).to.not.be.null;
      expect(entries).to.have.length(1);
      expect(entries[0].id).to.equal("alive");
    });

    it("should handle entries without confidence field (default 1.0)", function () {
      const entry = makeEntry({ id: "no-conf" });
      delete (entry as unknown as Record<string, unknown>).confidence;

      const entries = [entry];
      const removed = engine.expireStale(entries, graph);

      expect(removed).to.have.length(0);
      expect(entries).to.have.length(1);
    });
  });

  // ── getDecayStatus ─────────────────────────────────────────────────

  describe("getDecayStatus", function () {
    it("should not modify entries", function () {
      const entries = [
        makeEntry({ lastAccessedAt: Date.now() - 30 * DAY_MS, confidence: 1.0 }),
      ];
      const originalConfidence = entries[0].confidence;
      engine.getDecayStatus(entries, graph);

      expect(entries[0].confidence).to.equal(originalConfidence);
    });

    it("should return accurate counts", function () {
      const entries = [
        makeEntry({ lastAccessedAt: Date.now(), confidence: 1.0 }),
        makeEntry({ lastAccessedAt: Date.now() - 100 * DAY_MS, confidence: 1.0 }),
        makeEntry({ expiresAt: Date.now() - 1000, confidence: 1.0, lastAccessedAt: Date.now() }),
      ];
      const status = engine.getDecayStatus(entries, graph);

      expect(status.totalEntries).to.equal(3);
      // At least the 100-day-old entry should be expired
      expect(status.expiredCount).to.be.greaterThanOrEqual(1);
    });

    it("should match runDecayCycle counts", function () {
      const entriesForStatus = [
        makeEntry({ lastAccessedAt: Date.now() - 20 * DAY_MS, confidence: 1.0 }),
        makeEntry({ lastAccessedAt: Date.now() - 50 * DAY_MS, confidence: 1.0 }),
      ];
      const entriesForCycle = entriesForStatus.map((e) => ({ ...e }));

      const status = engine.getDecayStatus(entriesForStatus, graph);
      const cycleResult = engine.runDecayCycle(entriesForCycle, graph);

      expect(status.decayedCount).to.equal(cycleResult.decayedCount);
      expect(status.expiredCount).to.equal(cycleResult.expiredCount);
      expect(status.nearThresholdCount).to.equal(cycleResult.nearThresholdCount);
    });
  });

  // ── Custom options ─────────────────────────────────────────────────

  describe("custom options", function () {
    it("should use custom lambda for faster decay", function () {
      const fastEngine = new MemoryDecayEngine({ lambda: 0.5 });
      const entry = makeEntry({ lastAccessedAt: Date.now() - 10 * DAY_MS, confidence: 1.0 });

      // e^(-0.5 * 10) = e^(-5) ≈ 0.0067
      expect(fastEngine.effectiveConfidence(entry, graph)).to.be.lessThan(0.05);
    });

    it("should use custom minConfidence threshold", function () {
      const strictEngine = new MemoryDecayEngine({ minConfidence: 0.5 });
      const entries = [makeEntry({ confidence: 0.4 })];
      const removed = strictEngine.expireStale(entries, graph);

      expect(removed).to.have.length(1);
    });

    it("should use default constants when no options provided", function () {
      const defaultEngine = new MemoryDecayEngine();
      // Verify it uses DECAY_LAMBDA and MIN_CONFIDENCE_THRESHOLD
      const entries = [makeEntry({ confidence: 0.09 })]; // Below default threshold 0.1
      const removed = defaultEngine.expireStale(entries, graph);

      expect(removed).to.have.length(1);
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────

  describe("edge cases", function () {
    it("should handle empty entries array", function () {
      const status = engine.runDecayCycle([], graph);
      expect(status.totalEntries).to.equal(0);
      expect(status.decayedCount).to.equal(0);

      const removed = engine.expireStale([], graph);
      expect(removed).to.have.length(0);
    });

    it("should handle entries with no entityIds", function () {
      const entries = [makeEntry({ confidence: 0.01, entityIds: [] })];
      const removed = engine.expireStale(entries, graph);

      expect(removed).to.have.length(1);
      expect(entries).to.have.length(0);
    });

    it("should handle entries referencing non-existent graph entities", function () {
      const entries = [
        makeEntry({ confidence: 0.01, entityIds: ["nonexistent-entity"] }),
      ];
      // Should not throw
      const removed = engine.expireStale(entries, graph);
      expect(removed).to.have.length(1);
    });
  });
});
