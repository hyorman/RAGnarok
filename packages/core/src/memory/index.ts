// Standalone Memory Module — Barrel Exports

export { MemoryStore } from "./memoryStore";
export type { MemoryStoreOptions } from "./memoryStore";
export { MemoryVectorStore } from "./memoryVectorStore";
export { MemoryGraph } from "./memoryGraph";
export { MemoryEntityExtractor } from "./memoryEntityExtractor";
export type { ExtractedMemoryEntity, ExtractedMemoryRelationship, ExtractionResult } from "./memoryEntityExtractor";
export { MemoryMarkdownExporter } from "./memoryMarkdownExporter";
export { MemoryDecayEngine } from "./memoryDecayEngine";
export { MemoryScopeLinker } from "./memoryScopeLinker";
export { GitBranchDetector } from "./gitBranchDetector";
export type {
  MemoryScope,
  MemoryEntry,
  MemoryEntity,
  MemoryEntityType,
  MemoryRelationship,
  MemoryRelationshipType,
  StoreOptions,
  RecallOptions,
  RecallResult,
  ForgetOptions,
  MemoryStats,
  MemoryGraphData,
  MemoryGraphSnapshot,
  DecayStatus,
  ScopeLink,
} from "./types";
export {
  DUPLICATE_SIMILARITY_THRESHOLD,
  DEFAULT_TOP_K,
  MEMORY_TABLE_PREFIX,
  DECAY_LAMBDA,
  MIN_CONFIDENCE_THRESHOLD,
  DECAY_INTERVAL_MS,
} from "./types";
