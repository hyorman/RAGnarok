import { expect } from "chai";
import { MemoryMarkdownExporter } from "../src/memory/memoryMarkdownExporter";
import { MemoryEntry, MemoryEntity, MemoryRelationship, MemoryStats } from "../src/memory/types";

// ── Test helpers ─────────────────────────────────────────────────────

function createTestEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "mem-1",
    content: "Test memory content",
    scope: "workspace",
    vector: [0.1, 0.2, 0.3],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    accessCount: 0,
    lastAccessedAt: Date.now(),
    tags: ["test"],
    entityIds: [],
    metadata: {},
    ...overrides,
  };
}

function createTestEntity(overrides: Partial<MemoryEntity> = {}): MemoryEntity {
  return {
    id: "e1",
    name: "TestEntity",
    type: "concept",
    description: "A test entity",
    vector: [0.1, 0.2, 0.3],
    scope: "workspace",
    confidence: 1.0,
    strength: 0.5,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sourceMemoryIds: ["mem-1"],
    metadata: {},
    ...overrides,
  };
}

function createTestRelationship(overrides: Partial<MemoryRelationship> = {}): MemoryRelationship {
  return {
    id: "r1",
    sourceId: "e1",
    targetId: "e2",
    type: "related_to",
    description: "e1 relates to e2",
    weight: 0.5,
    scope: "workspace",
    metadata: {},
    ...overrides,
  };
}

function createEmptyStats(): MemoryStats {
  return {
    totalMemories: 0,
    totalEntities: 0,
    totalRelationships: 0,
    byScope: { workspace: 0, branch: 0 },
    branches: [],
    entityTypes: {},
    lastUpdated: Date.now(),
  };
}

function createStats(overrides: Partial<MemoryStats> = {}): MemoryStats {
  return { ...createEmptyStats(), ...overrides };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("MemoryMarkdownExporter", function () {
  let exporter: MemoryMarkdownExporter;

  beforeEach(function () {
    exporter = new MemoryMarkdownExporter();
  });

  describe("generate() with workspace entries only", function () {
    it("should produce markdown with summary and workspace entries section", function () {
      const entries = [
        createTestEntry({ id: "m1", content: "First workspace memory", createdAt: 1000 }),
        createTestEntry({ id: "m2", content: "Second workspace memory", createdAt: 2000 }),
      ];
      const stats = createStats({
        totalMemories: 2,
        byScope: { workspace: 2, branch: 0 },
      });

      const md = exporter.generate({
        workspaceEntries: entries,
        workspaceEntities: [],
        workspaceRelationships: [],
        branchEntries: new Map(),
        branchEntities: new Map(),
        branchRelationships: new Map(),
        stats,
      });

      expect(md).to.include("# Project Memories");
      expect(md).to.include("## Summary");
      expect(md).to.include("**Total memories**: 2");
      expect(md).to.include("**Workspace memories**: 2");
      expect(md).to.include("## Workspace Memories");
      expect(md).to.include("### Recent Memories");
      expect(md).to.include("First workspace memory");
      expect(md).to.include("Second workspace memory");
      // No branch section
      expect(md).to.not.include("## Branch:");
    });

    it("should sort entries by date descending (newest first)", function () {
      const entries = [
        createTestEntry({ id: "m-old", content: "Old memory", createdAt: 1000 }),
        createTestEntry({ id: "m-new", content: "New memory", createdAt: 5000 }),
        createTestEntry({ id: "m-mid", content: "Mid memory", createdAt: 3000 }),
      ];
      const stats = createStats({ totalMemories: 3, byScope: { workspace: 3, branch: 0 } });

      const md = exporter.generate({
        workspaceEntries: entries,
        workspaceEntities: [],
        workspaceRelationships: [],
        branchEntries: new Map(),
        branchEntities: new Map(),
        branchRelationships: new Map(),
        stats,
      });

      const newIdx = md.indexOf("New memory");
      const midIdx = md.indexOf("Mid memory");
      const oldIdx = md.indexOf("Old memory");
      expect(newIdx).to.be.lessThan(midIdx);
      expect(midIdx).to.be.lessThan(oldIdx);
    });
  });

  describe("generate() with branch entries", function () {
    it("should include branch section with correct header", function () {
      const branchEntries = new Map<string, MemoryEntry[]>();
      branchEntries.set("feature/auth", [
        createTestEntry({
          id: "b1",
          content: "Branch memory for auth",
          scope: "branch",
          branch: "feature/auth",
          createdAt: 1000,
        }),
      ]);
      const stats = createStats({
        totalMemories: 1,
        byScope: { workspace: 0, branch: 1 },
        branches: ["feature/auth"],
      });

      const md = exporter.generate({
        workspaceEntries: [],
        workspaceEntities: [],
        workspaceRelationships: [],
        branchEntries,
        branchEntities: new Map(),
        branchRelationships: new Map(),
        stats,
      });

      expect(md).to.include("## Branch: feature/auth");
      expect(md).to.include("Branch memory for auth");
    });

    it("should render multiple branches as separate sections", function () {
      const branchEntries = new Map<string, MemoryEntry[]>();
      branchEntries.set("main", [
        createTestEntry({ id: "b1", content: "Main branch mem", scope: "branch", createdAt: 1000 }),
      ]);
      branchEntries.set("develop", [
        createTestEntry({ id: "b2", content: "Develop branch mem", scope: "branch", createdAt: 2000 }),
      ]);
      const stats = createStats({
        totalMemories: 2,
        byScope: { workspace: 0, branch: 2 },
        branches: ["main", "develop"],
      });

      const md = exporter.generate({
        workspaceEntries: [],
        workspaceEntities: [],
        workspaceRelationships: [],
        branchEntries,
        branchEntities: new Map(),
        branchRelationships: new Map(),
        stats,
      });

      expect(md).to.include("## Branch: main");
      expect(md).to.include("## Branch: develop");
      expect(md).to.include("Main branch mem");
      expect(md).to.include("Develop branch mem");
    });
  });

  describe("generate() with entities", function () {
    it("should generate entity table for workspace entities", function () {
      const entities = [
        createTestEntity({
          id: "e1",
          name: "AuthService",
          type: "tool",
          description: "Handles authentication",
          strength: 0.8,
        }),
        createTestEntity({
          id: "e2",
          name: "UserPrefs",
          type: "preference",
          description: "User preferences config",
          strength: 0.6,
        }),
      ];
      const stats = createStats({ totalEntities: 2 });

      const md = exporter.generate({
        workspaceEntries: [],
        workspaceEntities: entities,
        workspaceRelationships: [],
        branchEntries: new Map(),
        branchEntities: new Map(),
        branchRelationships: new Map(),
        stats,
      });

      expect(md).to.include("### Entities");
      expect(md).to.include("| Entity | Type | Description | Strength |");
      expect(md).to.include("| AuthService | tool | Handles authentication | 0.8 |");
      expect(md).to.include("| UserPrefs | preference | User preferences config | 0.6 |");
    });

    it("should sort entities by strength descending", function () {
      const entities = [
        createTestEntity({ id: "e-low", name: "Low", strength: 0.2 }),
        createTestEntity({ id: "e-high", name: "High", strength: 0.9 }),
      ];
      const stats = createStats({ totalEntities: 2 });

      const md = exporter.generate({
        workspaceEntries: [],
        workspaceEntities: entities,
        workspaceRelationships: [],
        branchEntries: new Map(),
        branchEntities: new Map(),
        branchRelationships: new Map(),
        stats,
      });

      const highIdx = md.indexOf("High");
      const lowIdx = md.indexOf("Low");
      expect(highIdx).to.be.lessThan(lowIdx);
    });

    it("should generate entity table for branch entities", function () {
      const branchEntities = new Map<string, MemoryEntity[]>();
      branchEntities.set("feature/x", [
        createTestEntity({
          id: "be1",
          name: "BranchEntity",
          type: "fact",
          description: "Branch specific entity",
          strength: 0.7,
        }),
      ]);
      const branchEntries = new Map<string, MemoryEntry[]>();
      branchEntries.set("feature/x", []);
      const stats = createStats({ totalEntities: 1, branches: ["feature/x"] });

      const md = exporter.generate({
        workspaceEntries: [],
        workspaceEntities: [],
        workspaceRelationships: [],
        branchEntries,
        branchEntities,
        branchRelationships: new Map(),
        stats,
      });

      expect(md).to.include("## Branch: feature/x");
      expect(md).to.include("| BranchEntity | fact | Branch specific entity | 0.7 |");
    });
  });

  describe("generate() with relationships", function () {
    it("should generate relationship list for workspace relationships", function () {
      const entities = [
        createTestEntity({ id: "e1", name: "ServiceA" }),
        createTestEntity({ id: "e2", name: "ServiceB" }),
      ];
      const relationships = [
        createTestRelationship({
          id: "r1",
          sourceId: "e1",
          targetId: "e2",
          type: "depends_on",
          description: "A depends on B",
        }),
      ];
      const stats = createStats({ totalRelationships: 1, totalEntities: 2 });

      const md = exporter.generate({
        workspaceEntries: [],
        workspaceEntities: entities,
        workspaceRelationships: relationships,
        branchEntries: new Map(),
        branchEntities: new Map(),
        branchRelationships: new Map(),
        stats,
      });

      expect(md).to.include("### Key Relationships");
      expect(md).to.include("**ServiceA** → depends_on → **ServiceB**");
      expect(md).to.include("A depends on B");
    });

    it("should fall back to IDs when entities are not found", function () {
      const relationships = [
        createTestRelationship({
          id: "r1",
          sourceId: "unknown-src",
          targetId: "unknown-tgt",
          type: "uses",
          description: "fallback test",
        }),
      ];
      const stats = createStats({ totalRelationships: 1 });

      const md = exporter.generate({
        workspaceEntries: [],
        workspaceEntities: [],
        workspaceRelationships: relationships,
        branchEntries: new Map(),
        branchEntities: new Map(),
        branchRelationships: new Map(),
        stats,
      });

      expect(md).to.include("**unknown-src** → uses → **unknown-tgt**");
    });

    it("should generate relationship list for branch relationships", function () {
      const branchEntities = new Map<string, MemoryEntity[]>();
      branchEntities.set("dev", [
        createTestEntity({ id: "be1", name: "CompA" }),
        createTestEntity({ id: "be2", name: "CompB" }),
      ]);
      const branchRelationships = new Map<string, MemoryRelationship[]>();
      branchRelationships.set("dev", [
        createTestRelationship({
          id: "br1",
          sourceId: "be1",
          targetId: "be2",
          type: "part_of",
          description: "A part of B",
        }),
      ]);
      const branchEntries = new Map<string, MemoryEntry[]>();
      branchEntries.set("dev", []);
      const stats = createStats({ totalRelationships: 1, branches: ["dev"] });

      const md = exporter.generate({
        workspaceEntries: [],
        workspaceEntities: [],
        workspaceRelationships: [],
        branchEntries,
        branchEntities,
        branchRelationships,
        stats,
      });

      expect(md).to.include("## Branch: dev");
      expect(md).to.include("**CompA** → part_of → **CompB**");
    });
  });

  describe("generate() with stats", function () {
    it("should render all stats fields correctly", function () {
      const stats = createStats({
        totalMemories: 15,
        totalEntities: 8,
        totalRelationships: 5,
        byScope: { workspace: 10, branch: 5 },
        branches: ["main", "dev", "feature/x"],
      });

      const md = exporter.generate({
        workspaceEntries: [],
        workspaceEntities: [],
        workspaceRelationships: [],
        branchEntries: new Map(),
        branchEntities: new Map(),
        branchRelationships: new Map(),
        stats,
      });

      expect(md).to.include("**Total memories**: 15");
      expect(md).to.include("**Workspace memories**: 10");
      expect(md).to.include("**Branch memories**: 5 (across 3 branches)");
      expect(md).to.include("**Entities**: 8");
      expect(md).to.include("**Relationships**: 5");
    });
  });

  describe("generate() with empty inputs", function () {
    it("should produce valid markdown with no entries, entities, or relationships", function () {
      const stats = createEmptyStats();

      const md = exporter.generate({
        workspaceEntries: [],
        workspaceEntities: [],
        workspaceRelationships: [],
        branchEntries: new Map(),
        branchEntities: new Map(),
        branchRelationships: new Map(),
        stats,
      });

      expect(md).to.include("# Project Memories");
      expect(md).to.include("## Summary");
      expect(md).to.include("**Total memories**: 0");
      expect(md).to.include("## Workspace Memories");
      // Should not contain entity or relationship sub-sections
      expect(md).to.not.include("### Entities");
      expect(md).to.not.include("### Key Relationships");
      expect(md).to.not.include("### Recent Memories");
    });
  });

  describe("generate() with mixed workspace + branch data", function () {
    it("should include both workspace and branch sections", function () {
      const workspaceEntries = [createTestEntry({ id: "w1", content: "Workspace note", createdAt: 3000 })];
      const workspaceEntities = [createTestEntity({ id: "we1", name: "WsEntity", strength: 0.7 })];
      const workspaceRelationships = [
        createTestRelationship({
          id: "wr1",
          sourceId: "we1",
          targetId: "we1",
          type: "related_to",
          description: "self ref",
        }),
      ];

      const branchEntries = new Map<string, MemoryEntry[]>();
      branchEntries.set("feature/login", [
        createTestEntry({ id: "b1", content: "Login feature note", scope: "branch", createdAt: 4000 }),
      ]);
      const branchEntities = new Map<string, MemoryEntity[]>();
      branchEntities.set("feature/login", [
        createTestEntity({ id: "be1", name: "LoginService", type: "tool", strength: 0.9 }),
      ]);
      const branchRelationships = new Map<string, MemoryRelationship[]>();
      branchRelationships.set("feature/login", [
        createTestRelationship({ id: "br1", sourceId: "be1", targetId: "be1", type: "uses", description: "self" }),
      ]);

      const stats = createStats({
        totalMemories: 2,
        totalEntities: 2,
        totalRelationships: 2,
        byScope: { workspace: 1, branch: 1 },
        branches: ["feature/login"],
      });

      const md = exporter.generate({
        workspaceEntries,
        workspaceEntities,
        workspaceRelationships,
        branchEntries,
        branchEntities,
        branchRelationships,
        stats,
      });

      // Workspace section
      expect(md).to.include("## Workspace Memories");
      expect(md).to.include("Workspace note");
      expect(md).to.include("| WsEntity |");
      expect(md).to.include("**WsEntity** → related_to → **WsEntity**");

      // Branch section
      expect(md).to.include("## Branch: feature/login");
      expect(md).to.include("Login feature note");
      expect(md).to.include("| LoginService |");
      expect(md).to.include("**LoginService** → uses → **LoginService**");
    });
  });

  describe("Output format", function () {
    it("should use proper markdown heading levels", function () {
      const stats = createStats({
        totalMemories: 1,
        byScope: { workspace: 1, branch: 0 },
      });

      const md = exporter.generate({
        workspaceEntries: [createTestEntry({ createdAt: 1000 })],
        workspaceEntities: [createTestEntity()],
        workspaceRelationships: [createTestRelationship()],
        branchEntries: new Map(),
        branchEntities: new Map(),
        branchRelationships: new Map(),
        stats,
      });

      // H1 for title
      expect(md).to.match(/^# Project Memories\n/);
      // H2 for major sections
      expect(md).to.include("\n## Summary\n");
      expect(md).to.include("\n## Workspace Memories\n");
      // H3 for sub-sections
      expect(md).to.include("\n### Entities\n");
      expect(md).to.include("\n### Key Relationships\n");
      expect(md).to.include("\n### Recent Memories\n");
    });

    it("should include auto-generated header comment", function () {
      const md = exporter.generate({
        workspaceEntries: [],
        workspaceEntities: [],
        workspaceRelationships: [],
        branchEntries: new Map(),
        branchEntities: new Map(),
        branchRelationships: new Map(),
        stats: createEmptyStats(),
      });

      expect(md).to.include("Auto-generated by RAGnarōk Memory Module");
      expect(md).to.include("Do not edit manually");
      expect(md).to.include("Last updated:");
    });

    it("should truncate long content in entries", function () {
      const longContent = "A".repeat(200);
      const md = exporter.generate({
        workspaceEntries: [createTestEntry({ content: longContent, createdAt: 1000 })],
        workspaceEntities: [],
        workspaceRelationships: [],
        branchEntries: new Map(),
        branchEntities: new Map(),
        branchRelationships: new Map(),
        stats: createStats({ totalMemories: 1, byScope: { workspace: 1, branch: 0 } }),
      });

      // Content should be truncated to 80 chars (77 + "...")
      expect(md).to.not.include(longContent);
      expect(md).to.include("...");
    });

    it("should truncate long entity descriptions", function () {
      const longDesc = "B".repeat(100);
      const md = exporter.generate({
        workspaceEntries: [],
        workspaceEntities: [createTestEntity({ description: longDesc })],
        workspaceRelationships: [],
        branchEntries: new Map(),
        branchEntities: new Map(),
        branchRelationships: new Map(),
        stats: createStats({ totalEntities: 1 }),
      });

      // Description should be truncated to 60 chars (57 + "...")
      expect(md).to.not.include(longDesc);
      expect(md).to.include("...");
    });

    it("should number entries starting from 1", function () {
      const entries = [
        createTestEntry({ id: "m1", content: "First", createdAt: 3000 }),
        createTestEntry({ id: "m2", content: "Second", createdAt: 2000 }),
        createTestEntry({ id: "m3", content: "Third", createdAt: 1000 }),
      ];
      const stats = createStats({ totalMemories: 3, byScope: { workspace: 3, branch: 0 } });

      const md = exporter.generate({
        workspaceEntries: entries,
        workspaceEntities: [],
        workspaceRelationships: [],
        branchEntries: new Map(),
        branchEntities: new Map(),
        branchRelationships: new Map(),
        stats,
      });

      expect(md).to.include('1. "First"');
      expect(md).to.include('2. "Second"');
      expect(md).to.include('3. "Third"');
    });

    it("should include horizontal rule separators between sections", function () {
      const md = exporter.generate({
        workspaceEntries: [],
        workspaceEntities: [],
        workspaceRelationships: [],
        branchEntries: new Map(),
        branchEntities: new Map(),
        branchRelationships: new Map(),
        stats: createEmptyStats(),
      });

      expect(md).to.include("---");
    });
  });
});
