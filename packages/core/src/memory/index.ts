// Standalone Memory Module — Barrel Exports

export { MemoryStore } from "./memoryStore";
export type { MemoryStoreOptions } from "./memoryStore";
export { MemoryOperationCoordinator } from "./memoryOperationCoordinator";
export { MemoryService } from "./memoryService";
export { MemoryServiceError } from "./memoryServiceError";
export type { MemoryServiceErrorCode } from "./memoryServiceError";
export { reduceMemoryOperationResult } from "./memoryResultReducer";
export type { MemoryResultMeasurement } from "./memoryResultReducer";
export type {
  MemoryBranchContext,
  MemoryHostContext,
  MemoryOperationInput,
  MemoryResponseMeta,
  StoreMemoryResult,
  RecallMemoryResult,
  ForgetMemoryResult,
  MemoryStatsResult,
  ListMemoryResult,
  DecayMemoryResult,
  HistoryMemoryResult,
  PromoteMemoryResult,
  LinksMemoryResult,
  CommunitiesMemoryResult,
  MemoryOperationResult,
  MemoryResetResult,
} from "./memoryServiceTypes";
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
  MemoryCommunity,
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
