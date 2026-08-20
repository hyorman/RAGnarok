import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { connect, type Connection } from "@lancedb/lancedb";
import { EXTENSION } from "../constants";
import type { Document, Topic, TopicsIndex } from "./types";
import { acquireStorageLock, STORAGE_LOCK_FILENAME, type StorageLockHandle } from "./storageLock";
import {
  atomicWriteFile,
  atomicWriteJson,
  STORAGE_FORMAT_FILENAME,
  STORAGE_FORMAT_VERSION,
  type StorageFormatMarker,
} from "./storageV2";

export const MIGRATION_STATE_VERSION = 1 as const;
export const MIGRATION_REPORT_FILENAME = "migration-report.json";

export type LegacyLayout = "v0.3-local" | "v0.3-common" | "v2" | "empty" | "unsupported";
export type MigrationStage =
  | "planned"
  | "staged"
  | "validated"
  | "cutoverPrepared"
  | "legacyBackedUp"
  | "v2Published"
  | "committed"
  | "rollbackPrepared"
  | "rollbackV2BackedUp"
  | "rollbackLegacyPublished"
  | "rolledBack";

export type MigrationDiagnosticCode =
  | "MIG_ALREADY_V2"
  | "MIG_EMPTY"
  | "MIG_CORRUPT"
  | "MIG_UNSUPPORTED"
  | "MIG_COLLISION"
  | "MIG_SPACE"
  | "MIG_CHANGED"
  | "MIG_BUSY"
  | "MIG_VALIDATION"
  | "MIG_CUTOVER"
  | "MIG_NOT_FOUND"
  | "MIG_CONFIRMATION";

export class StorageMigrationError extends Error {
  constructor(
    public readonly code: MigrationDiagnosticCode,
    message: string,
  ) {
    super(message);
    this.name = "StorageMigrationError";
  }
}

export interface MigrationInventoryFile {
  relativePath: string;
  size: number;
  mtimeMs: number;
  mode: number;
  sha256: string;
}

export interface MigrationInventory {
  files: MigrationInventoryFile[];
  totalBytes: number;
  digest: string;
}

export interface MigrationRemap {
  kind: "topic" | "document";
  from: string;
  to: string;
  reason: string;
}

export interface MigrationTopicPlan {
  sourceTopicId: string;
  targetTopicId: string;
  name: string;
  legacyDocumentCount: number;
  leafDocumentCount: number;
  chunkCount: number;
  embeddingModel: string;
  vectorDimension?: number;
  graphRebuildRequired: boolean;
  remaps: MigrationRemap[];
}

export interface StorageMigrationPlan {
  migrationId: string;
  sourcePath: string;
  layout: LegacyLayout;
  sourceVersion: "0.3" | "unversioned" | "2" | "empty" | "unsupported";
  inventory: MigrationInventory;
  topics: MigrationTopicPlan[];
  remaps: MigrationRemap[];
  unsupported: string[];
  warnings: string[];
  requiredBytes: number;
  availableBytes: number;
  backupPath: string;
  stagingPath: string;
  statePath: string;
  dryRun: true;
}

export interface MigrationReport extends Omit<StorageMigrationPlan, "dryRun"> {
  formatVersion: typeof STORAGE_FORMAT_VERSION;
  completedAt: number;
  sourceInventoryDigest: string;
  targetInventoryDigest: string;
  validation: {
    topics: number;
    documents: number;
    chunks: number;
    contentDigestsMatched: boolean;
    vectorDimensionsValid: boolean;
    referentialIntegrityValid: boolean;
    nativeQuerySmokePassed: boolean;
  };
}

export interface MigrationState {
  stateVersion: typeof MIGRATION_STATE_VERSION;
  migrationId: string;
  sourcePath: string;
  layout: LegacyLayout;
  stage: MigrationStage;
  sourceInventoryDigest: string;
  sourceInventory?: MigrationInventory;
  backupPath: string;
  stagingPath: string;
  reportPath?: string;
  currentV2BackupPath?: string;
  updatedAt: number;
  lastError?: string;
}

export interface MigrationApplyOptions {
  migrationId?: string;
  acceptedBackupPath?: string;
  nonInteractive?: boolean;
  signal?: AbortSignal;
  /** Test-only deterministic interruption seam. */
  failAfterStage?:
    | "planned"
    | "staged"
    | "validated"
    | "cutoverPrepared"
    | "legacyBackedUp"
    | "v2Published"
    | "committed";
}

export interface MigrationRollbackOptions {
  /** Test-only deterministic interruption seam. */
  failAfterStage?:
    | "rollbackPrepared"
    | "rollbackV2Renamed"
    | "rollbackV2BackedUp"
    | "rollbackLegacyRenamed"
    | "rollbackLegacyPublished";
}

interface ParsedLegacy {
  layout: "v0.3-local" | "v0.3-common";
  databaseDir: string;
  index: TopicsIndex;
  documents: Map<string, Document[]>;
  unknown: string[];
  graphTopicIds: Set<string>;
}

interface ConvertedTopic {
  sourceTopicId: string;
  targetTopicId: string;
  topic: Topic;
  documents: Document[];
  rows: Array<Record<string, unknown>>;
  metadata: Record<string, unknown>;
  sourceContentDigest: string;
  targetContentDigest: string;
  vectorDimension?: number;
  remaps: MigrationRemap[];
}

function hashBytes(value: Buffer | string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableId(prefix: string, value: string): string {
  return `${prefix}-${hashBytes(value)}`;
}

function statePathFor(storageDir: string, migrationId: string): string {
  return path.join(path.dirname(storageDir), `.${path.basename(storageDir)}.migration-${migrationId}.json`);
}

function migrationLockPath(storageDir: string): string {
  return path.join(path.dirname(storageDir), `.${path.basename(storageDir)}.migration.lock`);
}

function backupPathFor(sourcePath: string, inventory: MigrationInventory, migrationId: string): string {
  const timestamp = new Date(Math.max(0, ...inventory.files.map((file) => Math.floor(file.mtimeMs))))
    .toISOString()
    .replace(/[:.]/g, "-");
  return path.join(path.dirname(sourcePath), `backup-v0.3-${timestamp}-${migrationId}`);
}

async function writeChecksummedJson(filePath: string, value: unknown): Promise<void> {
  await atomicWriteJson(filePath, value);
  const contents = await fs.readFile(filePath);
  await atomicWriteFile(`${filePath}.sha256`, `${hashBytes(contents)}  ${path.basename(filePath)}\n`);
}

async function verifyChecksummedJson(filePath: string): Promise<void> {
  const contents = await fs.readFile(filePath);
  const checksum = (await fs.readFile(`${filePath}.sha256`, "utf8")).trim().split(/\s+/)[0];
  if (checksum !== hashBytes(contents)) {
    throw new StorageMigrationError("MIG_VALIDATION", `Checksum mismatch: ${filePath}`);
  }
}

async function syncTree(root: string): Promise<void> {
  async function walk(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(candidate);
      } else if (entry.isFile()) {
        const handle = await fs.open(candidate, "r");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
    }
    try {
      const handle = await fs.open(directory, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // Directory fsync is unavailable on Windows.
    }
  }
  await walk(root);
}

function normalizeSource(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
      url.port = "";
    }
    return url.toString();
  } catch {
    return path.resolve(value).replace(/\\/g, "/");
  }
}

function sourceType(value: string, fileType?: string): "file" | "web" | "github" {
  if (fileType === "github" || /^https:\/\/github\.com\//i.test(value)) {
    return "github";
  }
  return /^https?:\/\//i.test(value) ? "web" : "file";
}

function fileType(value: string, legacy?: string): Document["fileType"] {
  if (legacy && ["pdf", "markdown", "html", "text", "web", "github"].includes(legacy)) {
    return legacy as Document["fileType"];
  }
  if (/^https?:\/\//i.test(value)) {
    return "web";
  }
  switch (path.extname(value).toLowerCase()) {
    case ".pdf":
      return "pdf";
    case ".md":
    case ".markdown":
      return "markdown";
    case ".html":
    case ".htm":
      return "html";
    default:
      return "text";
  }
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await fs.lstat(candidate);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function inventoryDirectory(root: string): Promise<MigrationInventory> {
  const files: MigrationInventoryFile[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (directory === root && entry.name === STORAGE_LOCK_FILENAME) {
        continue;
      }
      const absolute = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolute).replace(/\\/g, "/");
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) {
        throw new StorageMigrationError("MIG_UNSUPPORTED", `Symbolic links are not supported: ${relativePath}`);
      }
      if (stat.isDirectory()) {
        await walk(absolute);
      } else if (stat.isFile()) {
        files.push({
          relativePath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          mode: stat.mode,
          sha256: hashBytes(await fs.readFile(absolute)),
        });
      } else {
        throw new StorageMigrationError("MIG_UNSUPPORTED", `Unsupported filesystem entry: ${relativePath}`);
      }
    }
  }
  if (await exists(root)) {
    await walk(root);
  }
  const digest = hashBytes(files.map((file) => `${file.relativePath}\0${file.size}\0${file.sha256}`).join("\n"));
  return {
    files,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    digest,
  };
}

function parseJsonRecord(contents: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new StorageMigrationError("MIG_CORRUPT", `${label} contains malformed JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StorageMigrationError("MIG_CORRUPT", `${label} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function parseIndex(contents: string, label: string): TopicsIndex {
  const parsed = parseJsonRecord(contents, label);
  if (
    !parsed.topics ||
    typeof parsed.topics !== "object" ||
    Array.isArray(parsed.topics) ||
    typeof parsed.modelName !== "string" ||
    !Number.isFinite(parsed.lastUpdated)
  ) {
    throw new StorageMigrationError("MIG_CORRUPT", `${label} does not match the v0.3 topics schema`);
  }
  for (const [topicId, topic] of Object.entries(parsed.topics as Record<string, unknown>)) {
    if (
      !topic ||
      typeof topic !== "object" ||
      Array.isArray(topic) ||
      (topic as any).id !== topicId ||
      typeof (topic as any).name !== "string" ||
      !Number.isFinite((topic as any).createdAt) ||
      !Number.isFinite((topic as any).updatedAt) ||
      !Number.isInteger((topic as any).documentCount)
    ) {
      throw new StorageMigrationError("MIG_CORRUPT", `${label} contains invalid topic "${topicId}"`);
    }
  }
  return parsed as unknown as TopicsIndex;
}

function parseDocuments(contents: string, topicId: string, label: string): Document[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new StorageMigrationError("MIG_CORRUPT", `${label} contains malformed JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new StorageMigrationError("MIG_CORRUPT", `${label} must contain a JSON array`);
  }
  const ids = new Set<string>();
  for (const document of parsed) {
    if (
      !document ||
      typeof document !== "object" ||
      Array.isArray(document) ||
      typeof (document as any).id !== "string" ||
      (document as any).topicId !== topicId ||
      typeof (document as any).name !== "string" ||
      typeof (document as any).filePath !== "string" ||
      !["pdf", "markdown", "html", "text", "web", "github"].includes(String((document as any).fileType)) ||
      !Number.isFinite((document as any).addedAt) ||
      !Number.isInteger((document as any).chunkCount)
    ) {
      throw new StorageMigrationError("MIG_CORRUPT", `${label} contains invalid document metadata`);
    }
    if (ids.has((document as any).id)) {
      throw new StorageMigrationError(
        "MIG_COLLISION",
        `${label} contains duplicate document ID ${(document as any).id}`,
      );
    }
    ids.add((document as any).id);
  }
  return parsed as Document[];
}

async function parseLegacy(storageDir: string): Promise<ParsedLegacy | null> {
  const marker = path.join(storageDir, STORAGE_FORMAT_FILENAME);
  if (await exists(marker)) {
    const parsed = parseJsonRecord(await fs.readFile(marker, "utf8"), marker);
    if (parsed.formatVersion === STORAGE_FORMAT_VERSION) {
      return null;
    }
    throw new StorageMigrationError(
      "MIG_UNSUPPORTED",
      `Storage declares unsupported format ${String(parsed.formatVersion)}`,
    );
  }
  const localIndex = path.join(storageDir, EXTENSION.DATABASE_DIR, EXTENSION.TOPICS_INDEX_FILENAME);
  const commonIndex = path.join(storageDir, EXTENSION.TOPICS_INDEX_FILENAME);
  const hasLocal = await exists(localIndex);
  const hasCommon = await exists(commonIndex);
  if (hasLocal === hasCommon) {
    return null;
  }
  const layout = hasLocal ? "v0.3-local" : "v0.3-common";
  const databaseDir = hasLocal ? path.join(storageDir, EXTENSION.DATABASE_DIR) : storageDir;
  const indexPath = hasLocal ? localIndex : commonIndex;
  const index = parseIndex(await fs.readFile(indexPath, "utf8"), indexPath);
  const documents = new Map<string, Document[]>();
  for (const topicId of Object.keys(index.topics)) {
    const documentPath = path.join(databaseDir, `topic-${topicId}-documents.json`);
    if (!(await exists(documentPath))) {
      throw new StorageMigrationError("MIG_CORRUPT", `Missing document metadata for topic "${topicId}"`);
    }
    const topicDocuments = parseDocuments(await fs.readFile(documentPath, "utf8"), topicId, documentPath);
    if (topicDocuments.length !== index.topics[topicId].documentCount) {
      throw new StorageMigrationError("MIG_CORRUPT", `Document count mismatch for topic "${topicId}"`);
    }
    documents.set(topicId, topicDocuments);
  }

  const allowedRoot = new Set(
    layout === "v0.3-local"
      ? [EXTENSION.DATABASE_DIR, STORAGE_LOCK_FILENAME]
      : [
          EXTENSION.TOPICS_INDEX_FILENAME,
          "lancedb",
          STORAGE_LOCK_FILENAME,
          ...Object.keys(index.topics).flatMap((id) => [`topic-${id}-documents.json`, `vector-${id}-metadata.json`]),
        ],
  );
  const rootEntries = await fs.readdir(storageDir);
  const unknown = rootEntries.filter((entry) => !allowedRoot.has(entry));
  if (layout === "v0.3-local") {
    const allowedDatabase = new Set([
      EXTENSION.TOPICS_INDEX_FILENAME,
      "lancedb",
      ...Object.keys(index.topics).flatMap((id) => [`topic-${id}-documents.json`, `vector-${id}-metadata.json`]),
    ]);
    unknown.push(
      ...(await fs.readdir(databaseDir))
        .filter((entry) => !allowedDatabase.has(entry))
        .map((entry) => `${EXTENSION.DATABASE_DIR}/${entry}`),
    );
  }
  const graphTopicIds = new Set<string>();
  const lanceDir = path.join(databaseDir, "lancedb");
  if (await exists(lanceDir)) {
    for (const entry of await fs.readdir(lanceDir)) {
      const graphMatch = /^kg-(?:entities|edges|metadata)-(.+)\.lance$/.exec(entry);
      if (graphMatch) {
        graphTopicIds.add(graphMatch[1]);
        continue;
      }
      const topicMatch = /^(.+)\.lance$/.exec(entry);
      if (!topicMatch || !index.topics[topicMatch[1]]) {
        unknown.push(layout === "v0.3-local" ? `${EXTENSION.DATABASE_DIR}/lancedb/${entry}` : `lancedb/${entry}`);
      }
    }
  }
  return { layout, databaseDir, index, documents, unknown, graphTopicIds };
}

async function legacyRows(databaseDir: string, topicId: string): Promise<Array<Record<string, unknown>>> {
  const lanceDir = path.join(databaseDir, "lancedb");
  if (!(await exists(path.join(lanceDir, `${topicId}.lance`)))) {
    return [];
  }
  const db = await connect(lanceDir);
  const table = await db.openTable(topicId);
  const count = await table.countRows();
  if (count > 1_000_000) {
    table.close();
    db.close();
    throw new StorageMigrationError(
      "MIG_UNSUPPORTED",
      `Topic "${topicId}" exceeds the 1,000,000 chunk migration limit`,
    );
  }
  const rows = (await table.query().limit(Math.max(count, 1)).toArray()) as Array<Record<string, unknown>>;
  table.close();
  db.close();
  return rows;
}

function ownerForSource(source: string, documents: Document[]): Document | undefined {
  const normalized = normalizeSource(source);
  return (
    documents.find((document) => normalizeSource(document.filePath) === normalized) ??
    documents.find((document) => {
      if (/^https?:\/\//i.test(document.filePath)) {
        return normalized.startsWith(`${normalizeSource(document.filePath).replace(/\/$/, "")}/`);
      }
      const relative = path.relative(path.resolve(document.filePath), path.resolve(source));
      return (
        relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      );
    })
  );
}

function contentDigest(rows: Array<Record<string, unknown>>): string {
  return hashBytes(
    rows
      .map((row) => `${String(row.text ?? "")}\0${JSON.stringify(Array.from((row.vector as any) ?? []))}`)
      .sort()
      .join("\n"),
  );
}

function convertRows(
  topicId: string,
  targetTopicId: string,
  rows: Array<Record<string, unknown>>,
  legacyDocuments: Document[],
): { documents: Document[]; rows: Array<Record<string, unknown>>; remaps: MigrationRemap[]; vectorDimension?: number } {
  const grouped = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    let source = String(row.source ?? row.filePath ?? "");
    if (!source && legacyDocuments.length === 1) {
      source = legacyDocuments[0].filePath;
    }
    if (!source) {
      throw new StorageMigrationError(
        "MIG_UNSUPPORTED",
        `Topic "${topicId}" has vector rows without source provenance and multiple legacy documents`,
      );
    }
    const canonical = normalizeSource(source);
    const sourceRows = grouped.get(canonical) ?? [];
    sourceRows.push(row);
    grouped.set(canonical, sourceRows);
  }
  const dimensions = new Set(
    rows.map((row) => Array.from((row.vector as any) ?? []).length).filter((dimension) => dimension > 0),
  );
  if (
    dimensions.size > 1 ||
    rows.some((row) => Array.from((row.vector as any) ?? []).some((v) => !Number.isFinite(v)))
  ) {
    throw new StorageMigrationError(
      "MIG_VALIDATION",
      `Topic "${topicId}" contains invalid vector dimensions or values`,
    );
  }

  const documents: Document[] = [];
  const convertedRows: Array<Record<string, unknown>> = [];
  const remaps: MigrationRemap[] = [];
  const usedIds = new Map<string, string>();
  for (const [canonicalSource, sourceRows] of [...grouped].sort(([left], [right]) => left.localeCompare(right))) {
    const first = sourceRows[0];
    const type = sourceType(canonicalSource, String(first.fileType ?? ""));
    const descriptor = JSON.stringify({ type, source: canonicalSource });
    let documentId = stableId("doc", descriptor);
    const conflictingSource = usedIds.get(documentId);
    if (conflictingSource && conflictingSource !== canonicalSource) {
      const original = documentId;
      documentId = stableId("doc", `${descriptor}\0${canonicalSource}`);
      remaps.push({ kind: "document", from: original, to: documentId, reason: "deterministic ID collision" });
    }
    usedIds.set(documentId, canonicalSource);
    const owner = ownerForSource(canonicalSource, legacyDocuments);
    if (!owner) {
      throw new StorageMigrationError(
        "MIG_UNSUPPORTED",
        `Topic "${topicId}" cannot map vector source "${canonicalSource}" to legacy document provenance`,
      );
    }
    const revision = hashBytes(sourceRows.map((row) => String(row.text ?? "")).join("\0"));
    const leafType = fileType(canonicalSource, String(first.fileType ?? owner?.fileType ?? ""));
    const sourceDescriptor =
      type === "github"
        ? ({ type: "github", url: owner?.filePath ?? canonicalSource } as const)
        : type === "web"
          ? ({ type: "url", url: canonicalSource } as const)
          : ({ type: "file", path: canonicalSource } as const);
    if (owner.id !== documentId) {
      remaps.push({
        kind: "document",
        from: owner.id,
        to: documentId,
        reason: "expanded legacy container/source into canonical leaf identity",
      });
    }
    documents.push({
      id: documentId,
      topicId: targetTopicId,
      name: (() => {
        try {
          return path.posix.basename(new URL(canonicalSource).pathname) || owner?.name || canonicalSource;
        } catch {
          return path.basename(canonicalSource) || owner?.name || canonicalSource;
        }
      })(),
      filePath: canonicalSource,
      fileType: leafType,
      source: sourceDescriptor,
      addedAt: owner?.addedAt ?? 0,
      chunkCount: sourceRows.length,
      containerId: owner
        ? stableId("doc", JSON.stringify({ type, source: normalizeSource(owner.filePath) }))
        : documentId,
      canonicalSource,
      sourceRevision: revision,
    });
    sourceRows.forEach((row, index) => {
      const text = String(row.text ?? "");
      const chunkId = stableId("chunk", `${documentId}\0${index}\0${text}`);
      const headingPath =
        typeof row.headingPath === "string"
          ? row.headingPath
          : JSON.stringify(Array.isArray(row.headingPath) ? row.headingPath : []);
      convertedRows.push({
        vector: Array.from((row.vector as any) ?? []),
        text,
        source: canonicalSource,
        sourceType: type,
        sourceDescriptor: descriptor,
        sourceRevision: revision,
        ingestionTransactionId: "",
        documentId,
        document_id: documentId,
        chunkId,
        chunk_id: chunkId,
        fileName: String(row.fileName ?? path.basename(canonicalSource)),
        filePath: String(row.filePath ?? canonicalSource),
        fileType: leafType,
        fileSize: Number(row.fileSize ?? 0),
        loadedAt: Number(row.loadedAt ?? owner?.addedAt ?? 0),
        chunkIndex: index,
        totalChunks: sourceRows.length,
        loc_lines_from: Number(row.loc_lines_from ?? 0),
        loc_lines_to: Number(row.loc_lines_to ?? 0),
        isMarkdown: Boolean(row.isMarkdown ?? leafType === "markdown"),
        preserveStructure: Boolean(row.preserveStructure ?? false),
        startPosition: Number(row.startPosition ?? 0),
        endPosition: Number(row.endPosition ?? 0),
        headingPath,
        headingLevel: Number(row.headingLevel ?? 0),
        sectionTitle: String(row.sectionTitle ?? ""),
      });
    });
  }
  return { documents, rows: convertedRows, remaps, vectorDimension: [...dimensions][0] };
}

async function convertTopic(
  parsed: ParsedLegacy,
  sourceTopicId: string,
  targetTopicId: string,
): Promise<ConvertedTopic> {
  const sourceTopic = parsed.index.topics[sourceTopicId];
  const rows = await legacyRows(parsed.databaseDir, sourceTopicId);
  const legacyDocuments = parsed.documents.get(sourceTopicId) ?? [];
  if (rows.length === 0 && legacyDocuments.some((document) => document.chunkCount > 0)) {
    throw new StorageMigrationError("MIG_CORRUPT", `Topic "${sourceTopicId}" has document chunks but no vector table`);
  }
  const converted = convertRows(sourceTopicId, targetTopicId, rows, legacyDocuments);
  const metadataPath = path.join(parsed.databaseDir, `vector-${sourceTopicId}-metadata.json`);
  let legacyMetadata: Record<string, unknown> = {};
  if (await exists(metadataPath)) {
    legacyMetadata = parseJsonRecord(await fs.readFile(metadataPath, "utf8"), metadataPath);
    if (legacyMetadata.topicId !== sourceTopicId || typeof legacyMetadata.embeddingModel !== "string") {
      throw new StorageMigrationError("MIG_CORRUPT", `${metadataPath} contains invalid vector metadata`);
    }
    if (
      Number(legacyMetadata.documentCount) !== legacyDocuments.length ||
      Number(legacyMetadata.chunkCount) !== rows.length
    ) {
      throw new StorageMigrationError("MIG_CORRUPT", `${metadataPath} count fields do not match persisted data`);
    }
  }
  const embeddingModel = String(legacyMetadata.embeddingModel ?? parsed.index.modelName);
  const topic: Topic = {
    ...sourceTopic,
    id: targetTopicId,
    documentCount: converted.documents.length,
  };
  return {
    sourceTopicId,
    targetTopicId,
    topic,
    documents: converted.documents,
    rows: converted.rows,
    metadata: {
      schemaVersion: STORAGE_FORMAT_VERSION,
      topicId: targetTopicId,
      documentCount: converted.documents.length,
      chunkCount: converted.rows.length,
      embeddingModel,
      embeddingBackend: "",
      createdAt: Number(legacyMetadata.createdAt ?? sourceTopic.createdAt),
      updatedAt: Number(legacyMetadata.updatedAt ?? sourceTopic.updatedAt),
      migrationRequiresFingerprintOnReindex: true,
    },
    sourceContentDigest: contentDigest(rows),
    targetContentDigest: contentDigest(converted.rows),
    vectorDimension: converted.vectorDimension,
    remaps: converted.remaps,
  };
}

async function preparePlan(
  storageDir: string,
): Promise<{ plan: StorageMigrationPlan; parsed?: ParsedLegacy; converted: ConvertedTopic[] }> {
  const sourcePath = path.resolve(storageDir);
  const inventory = await inventoryDirectory(sourcePath);
  const parsed = await parseLegacy(sourcePath);
  if (!parsed) {
    const layout: LegacyLayout = (await exists(path.join(sourcePath, STORAGE_FORMAT_FILENAME)))
      ? "v2"
      : inventory.files.length === 0
        ? "empty"
        : "unsupported";
    const sourceVersion = layout === "v2" ? "2" : layout === "empty" ? "empty" : "unsupported";
    const migrationId = `mig-${inventory.digest.slice(0, 20)}`;
    const parent = path.dirname(sourcePath);
    const base = path.basename(sourcePath);
    return {
      plan: {
        migrationId,
        sourcePath,
        layout,
        sourceVersion,
        inventory,
        topics: [],
        remaps: [],
        unsupported: layout === "unsupported" ? ["Layout is not a recognized v0.3 local or flat common database"] : [],
        warnings: [],
        requiredBytes: inventory.totalBytes * 2 + 16 * 1024 * 1024,
        availableBytes: Number((await fs.statfs(parent)).bavail * (await fs.statfs(parent)).bsize),
        backupPath: backupPathFor(sourcePath, inventory, migrationId),
        stagingPath: path.join(parent, `${base}.migrating-${migrationId}`),
        statePath: statePathFor(sourcePath, migrationId),
        dryRun: true,
      },
      converted: [],
    };
  }
  const unsupported = [...parsed.unknown];
  const converted: ConvertedTopic[] = [];
  const remaps: MigrationRemap[] = [];
  for (const sourceTopicId of Object.keys(parsed.index.topics).sort()) {
    let targetTopicId = sourceTopicId;
    if (parsed.layout === "v0.3-common") {
      targetTopicId = `common-${hashBytes(`ragnarok-common-topic\0${sourceTopicId}`).slice(0, 40)}`;
      remaps.push({
        kind: "topic",
        from: sourceTopicId,
        to: targetTopicId,
        reason: "namespace flat common-database IDs to avoid local/common collisions",
      });
    }
    const topic = await convertTopic(parsed, sourceTopicId, targetTopicId);
    converted.push(topic);
    remaps.push(...topic.remaps);
  }
  const migrationId = `mig-${inventory.digest.slice(0, 20)}`;
  const parent = path.dirname(sourcePath);
  const base = path.basename(sourcePath);
  const stat = await fs.statfs(parent);
  const availableBytes = Number(stat.bavail * stat.bsize);
  const requiredBytes = Math.ceil(inventory.totalBytes * 2.2) + 16 * 1024 * 1024;
  const warnings = [
    "Legacy vectors preserve their declared model but have no provable backend fingerprint; additions require explicit reindex.",
  ];
  if (parsed.graphTopicIds.size > 0) {
    warnings.push(
      "Legacy knowledge graphs are not copied because their embedding identity cannot be proven; rebuild is required.",
    );
  }
  const backupPath = backupPathFor(sourcePath, inventory, migrationId);
  const stagingPath = path.join(parent, `${base}.migrating-${migrationId}`);
  const plan: StorageMigrationPlan = {
    migrationId,
    sourcePath,
    layout: parsed.layout,
    sourceVersion: "0.3",
    inventory,
    topics: converted.map((topic) => ({
      sourceTopicId: topic.sourceTopicId,
      targetTopicId: topic.targetTopicId,
      name: topic.topic.name,
      legacyDocumentCount: parsed.documents.get(topic.sourceTopicId)?.length ?? 0,
      leafDocumentCount: topic.documents.length,
      chunkCount: topic.rows.length,
      embeddingModel: String(topic.metadata.embeddingModel),
      vectorDimension: topic.vectorDimension,
      graphRebuildRequired: parsed.graphTopicIds.has(topic.sourceTopicId),
      remaps: topic.remaps,
    })),
    remaps,
    unsupported,
    warnings,
    requiredBytes,
    availableBytes,
    backupPath,
    stagingPath,
    statePath: statePathFor(sourcePath, migrationId),
    dryRun: true,
  };
  return { plan, parsed, converted };
}

/** Read-only detection and complete dry-run plan. */
export async function planStorageMigration(storageDir: string): Promise<StorageMigrationPlan> {
  return (await preparePlan(storageDir)).plan;
}

export async function getStorageMigrationStatus(
  storageDir: string,
  migrationId?: string,
): Promise<{ plan: StorageMigrationPlan; state?: MigrationState }> {
  const plan = await planStorageMigration(storageDir);
  let state: MigrationState | undefined;
  const sourcePath = path.resolve(storageDir);
  if (migrationId) {
    try {
      state = JSON.parse(await fs.readFile(statePathFor(sourcePath, migrationId), "utf8")) as MigrationState;
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  } else {
    const prefix = `.${path.basename(sourcePath)}.migration-`;
    const candidates = (await fs.readdir(path.dirname(sourcePath)))
      .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".json"))
      .sort();
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(
          await fs.readFile(path.join(path.dirname(sourcePath), candidate), "utf8"),
        ) as MigrationState;
        if (parsed.sourcePath === sourcePath && (!state || parsed.updatedAt > state.updatedAt)) {
          state = parsed;
        }
      } catch {
        throw new StorageMigrationError("MIG_CORRUPT", `Migration state is corrupt: ${candidate}`);
      }
    }
  }
  return { plan, state };
}

async function writeState(state: MigrationState): Promise<void> {
  state.updatedAt = Date.now();
  await atomicWriteJson(statePathFor(state.sourcePath, state.migrationId), state);
}

function isLocalProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code !== "ESRCH";
  }
}

interface MigrationLockHandle {
  handle: fs.FileHandle;
  ownerId: string;
}

async function acquireMigrationLock(storageDir: string): Promise<MigrationLockHandle> {
  const lockPath = migrationLockPath(storageDir);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      const ownerId = crypto.randomUUID();
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, hostname: os.hostname(), ownerId, createdAt: Date.now() }),
      );
      await handle.sync();
      return { handle, ownerId };
    } catch (error: any) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      let observed: { pid?: number; hostname?: string };
      let raw: string;
      try {
        raw = await fs.readFile(lockPath, "utf8");
        observed = JSON.parse(raw) as { pid?: number; hostname?: string };
      } catch {
        throw new StorageMigrationError("MIG_BUSY", `Migration lock is unreadable; inspect manually (${lockPath})`);
      }
      const sameHost = observed.hostname === undefined || observed.hostname === os.hostname();
      if (typeof observed.pid !== "number" || !sameHost || isLocalProcessAlive(observed.pid)) {
        throw new StorageMigrationError("MIG_BUSY", `Another migration is active (${lockPath})`);
      }
      const quarantinePath = `${lockPath}.stale-${crypto.randomUUID()}`;
      try {
        await fs.rename(lockPath, quarantinePath);
        if ((await fs.readFile(quarantinePath, "utf8")) !== raw) {
          await fs.rename(quarantinePath, lockPath).catch(() => undefined);
          continue;
        }
        await fs.unlink(quarantinePath);
      } catch (reclaimError: any) {
        if (reclaimError?.code === "ENOENT") {
          continue;
        }
        throw reclaimError;
      }
    }
  }
  throw new StorageMigrationError("MIG_BUSY", `Migration lock is contended (${lockPath})`);
}

async function releaseMigrationLock(storageDir: string, lock: MigrationLockHandle): Promise<void> {
  await lock.handle.close().catch(() => undefined);
  const lockPath = migrationLockPath(storageDir);
  try {
    const observed = JSON.parse(await fs.readFile(lockPath, "utf8")) as { ownerId?: string };
    if (observed.ownerId === lock.ownerId) {
      await fs.unlink(lockPath);
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

async function closeConnection(connection: Connection | undefined): Promise<void> {
  connection?.close();
}

async function writeStaging(
  plan: StorageMigrationPlan,
  parsed: ParsedLegacy,
  converted: ConvertedTopic[],
): Promise<MigrationReport> {
  if (await exists(plan.stagingPath)) {
    throw new StorageMigrationError("MIG_COLLISION", `Staging path already exists: ${plan.stagingPath}`);
  }
  await fs.mkdir(path.join(plan.stagingPath, EXTENSION.DATABASE_DIR, "lancedb"), { recursive: true });
  const targetDatabaseDir = path.join(plan.stagingPath, EXTENSION.DATABASE_DIR);
  const targetIndex: TopicsIndex = {
    topics: Object.fromEntries(converted.map((topic) => [topic.targetTopicId, topic.topic])),
    modelName: parsed.index.modelName,
    lastUpdated: parsed.index.lastUpdated,
  };
  await atomicWriteJson(path.join(targetDatabaseDir, EXTENSION.TOPICS_INDEX_FILENAME), targetIndex);
  let db: Connection | undefined;
  try {
    db = await connect(path.join(targetDatabaseDir, "lancedb"));
    for (const topic of converted) {
      await atomicWriteJson(
        path.join(targetDatabaseDir, `topic-${topic.targetTopicId}-documents.json`),
        topic.documents,
      );
      await atomicWriteJson(
        path.join(targetDatabaseDir, `vector-${topic.targetTopicId}-metadata.json`),
        topic.metadata,
      );
      if (topic.rows.length > 0) {
        await db.createTable(topic.targetTopicId, topic.rows);
      }
    }
  } finally {
    await closeConnection(db);
  }
  const marker: StorageFormatMarker & { migratedFrom: string; migrationId: string } = {
    formatVersion: STORAGE_FORMAT_VERSION,
    initializedAt: Date.now(),
    migratedFrom: "0.3",
    migrationId: plan.migrationId,
  };
  await atomicWriteJson(path.join(plan.stagingPath, STORAGE_FORMAT_FILENAME), marker);
  const targetInventory = await inventoryDirectory(plan.stagingPath);
  const { dryRun: _dryRun, ...committedPlan } = plan;
  const report: MigrationReport = {
    ...committedPlan,
    formatVersion: STORAGE_FORMAT_VERSION,
    completedAt: Date.now(),
    sourceInventoryDigest: plan.inventory.digest,
    targetInventoryDigest: targetInventory.digest,
    validation: {
      topics: converted.length,
      documents: converted.reduce((sum, topic) => sum + topic.documents.length, 0),
      chunks: converted.reduce((sum, topic) => sum + topic.rows.length, 0),
      contentDigestsMatched: converted.every((topic) => topic.sourceContentDigest === topic.targetContentDigest),
      vectorDimensionsValid: converted.every(
        (topic) => topic.vectorDimension === undefined || topic.vectorDimension > 0,
      ),
      referentialIntegrityValid: true,
      nativeQuerySmokePassed: false,
    },
  };
  await writeChecksummedJson(path.join(plan.stagingPath, MIGRATION_REPORT_FILENAME), report);
  return report;
}

async function validateStaging(
  plan: StorageMigrationPlan,
  converted: ConvertedTopic[],
  report: MigrationReport,
): Promise<MigrationReport> {
  const index = parseIndex(
    await fs.readFile(path.join(plan.stagingPath, EXTENSION.DATABASE_DIR, EXTENSION.TOPICS_INDEX_FILENAME), "utf8"),
    "staged topics.json",
  );
  let db: Connection | undefined;
  try {
    db = await connect(path.join(plan.stagingPath, EXTENSION.DATABASE_DIR, "lancedb"));
    const tableNames = new Set(await db.tableNames());
    for (const topic of converted) {
      const documents = parseDocuments(
        await fs.readFile(
          path.join(plan.stagingPath, EXTENSION.DATABASE_DIR, `topic-${topic.targetTopicId}-documents.json`),
          "utf8",
        ),
        topic.targetTopicId,
        `staged documents for ${topic.targetTopicId}`,
      );
      if (
        documents.length !== topic.documents.length ||
        index.topics[topic.targetTopicId]?.documentCount !== documents.length
      ) {
        throw new StorageMigrationError("MIG_VALIDATION", `Document count mismatch for ${topic.targetTopicId}`);
      }
      const documentIds = new Set(documents.map((document) => document.id));
      if (topic.rows.length === 0) {
        continue;
      }
      if (!tableNames.has(topic.targetTopicId)) {
        throw new StorageMigrationError("MIG_VALIDATION", `Missing staged vector table ${topic.targetTopicId}`);
      }
      const table = await db.openTable(topic.targetTopicId);
      const rows = (await table
        .query()
        .limit(topic.rows.length + 1)
        .toArray()) as Array<Record<string, unknown>>;
      table.close();
      if (
        rows.length !== topic.rows.length ||
        contentDigest(rows) !== topic.targetContentDigest ||
        rows.some((row) => !documentIds.has(String(row.documentId ?? row.document_id ?? "")))
      ) {
        throw new StorageMigrationError(
          "MIG_VALIDATION",
          `Vector/content/referential validation failed for ${topic.targetTopicId}`,
        );
      }
    }
  } finally {
    await closeConnection(db);
  }
  report.validation.nativeQuerySmokePassed = true;
  report.validation.referentialIntegrityValid = true;
  if (!report.validation.contentDigestsMatched || !report.validation.vectorDimensionsValid) {
    throw new StorageMigrationError("MIG_VALIDATION", "Staged content or vector validation failed");
  }
  await writeChecksummedJson(path.join(plan.stagingPath, MIGRATION_REPORT_FILENAME), report);
  await verifyChecksummedJson(path.join(plan.stagingPath, MIGRATION_REPORT_FILENAME));
  await syncTree(plan.stagingPath);
  return report;
}

async function makeReadOnly(root: string): Promise<void> {
  async function walk(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(candidate);
        await fs.chmod(candidate, 0o500).catch(() => undefined);
      } else {
        await fs.chmod(candidate, 0o400).catch(() => undefined);
      }
    }
  }
  await walk(root);
  await fs.chmod(root, 0o500).catch(() => undefined);
}

async function makeWritable(root: string): Promise<void> {
  async function walk(directory: string): Promise<void> {
    await fs.chmod(directory, 0o700).catch(() => undefined);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(candidate);
      } else {
        await fs.chmod(candidate, 0o600).catch(() => undefined);
      }
    }
  }
  await walk(root);
}

async function isEmptyMigrationPlaceholder(sourcePath: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(sourcePath);
    return entries.every((entry) => entry === STORAGE_LOCK_FILENAME);
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return true;
    }
    throw error;
  }
}

async function finalizeBackup(
  backupPath: string,
  migrationId: string,
  sourcePath: string,
  expectedDigest: string,
  expectedInventory?: MigrationInventory,
): Promise<void> {
  await makeWritable(backupPath);
  await fs.unlink(path.join(backupPath, STORAGE_LOCK_FILENAME)).catch(() => undefined);
  const inventory = await inventoryDirectory(backupPath);
  if (inventory.digest !== expectedDigest) {
    throw new StorageMigrationError("MIG_VALIDATION", "Immutable legacy backup does not match source inventory");
  }
  if (
    expectedInventory &&
    JSON.stringify(inventory.files.map(({ relativePath, size, sha256 }) => ({ relativePath, size, sha256 }))) !==
      JSON.stringify(expectedInventory.files.map(({ relativePath, size, sha256 }) => ({ relativePath, size, sha256 })))
  ) {
    throw new StorageMigrationError("MIG_VALIDATION", "Immutable legacy backup file inventory does not match source");
  }
  await atomicWriteJson(`${backupPath}.inventory.json`, {
    migrationId,
    sourcePath,
    createdAt: Date.now(),
    inventory,
  });
  await fs.chmod(`${backupPath}.inventory.json`, 0o400).catch(() => undefined);
  await makeReadOnly(backupPath);
}

/**
 * Reconcile rollback state when a process died after an atomic namespace
 * rename but before its following state-file write. The filesystem rename is
 * authoritative only when the complementary source/staging paths prove which
 * boundary completed; ambiguous layouts fail closed.
 */
async function reconcileRollbackFilesystemState(state: MigrationState, restoreStage: string): Promise<void> {
  if (state.stage === "committed") {
    // A crash while preparing the legacy restore copy is pre-cutover: the
    // still-published v2 source is authoritative and the unpublished copy can
    // be rebuilt safely.
    if (await exists(restoreStage)) {
      await fs.rm(restoreStage, { recursive: true, force: true });
    }
    return;
  }

  if (state.stage === "rollbackPrepared") {
    if (!state.currentV2BackupPath) {
      throw new StorageMigrationError("MIG_CUTOVER", "Rollback intent is missing the v2 backup path");
    }
    let sourceExists = await exists(state.sourcePath);
    const v2BackupExists = await exists(state.currentV2BackupPath);
    const restoreExists = await exists(restoreStage);
    if (sourceExists && v2BackupExists && restoreExists && (await isEmptyMigrationPlaceholder(state.sourcePath))) {
      // Recover from an interrupted/older resume attempt that recreated only
      // the lock placeholder after the v2 namespace had already moved.
      await fs.rm(state.sourcePath, { recursive: true, force: true });
      sourceExists = false;
    }
    if (!sourceExists && v2BackupExists && restoreExists) {
      state.stage = "rollbackV2BackedUp";
      await writeState(state);
      return;
    }
    if (sourceExists && !v2BackupExists && restoreExists) {
      return;
    }
    throw new StorageMigrationError(
      "MIG_CUTOVER",
      "Rollback filesystem state does not match the prepared v2-backup boundary",
    );
  }

  if (state.stage === "rollbackV2BackedUp") {
    let sourceExists = await exists(state.sourcePath);
    const restoreExists = await exists(restoreStage);
    if (sourceExists && restoreExists && (await isEmptyMigrationPlaceholder(state.sourcePath))) {
      await fs.rm(state.sourcePath, { recursive: true, force: true });
      sourceExists = false;
    }
    if (!sourceExists && restoreExists) {
      return;
    }
    if (sourceExists && !restoreExists) {
      const restoredInventory = await inventoryDirectory(state.sourcePath);
      if (restoredInventory.digest !== state.sourceInventoryDigest) {
        throw new StorageMigrationError(
          "MIG_VALIDATION",
          "Published rollback source does not match the immutable legacy inventory",
        );
      }
      state.stage = "rollbackLegacyPublished";
      await writeState(state);
      return;
    }
    throw new StorageMigrationError(
      "MIG_CUTOVER",
      "Rollback filesystem state does not match the legacy-publication boundary",
    );
  }
}

async function applyPreparedCutover(
  plan: StorageMigrationPlan,
  state: MigrationState,
  storageLock: StorageLockHandle,
  failAfterStage?: MigrationApplyOptions["failAfterStage"],
): Promise<void> {
  if ((await inventoryDirectory(plan.sourcePath)).digest !== plan.inventory.digest) {
    throw new StorageMigrationError("MIG_CHANGED", "Legacy storage changed after planning; rerun dry-run");
  }
  const sourceLockPath = path.join(plan.sourcePath, STORAGE_LOCK_FILENAME);
  const stagedLockPath = path.join(plan.stagingPath, STORAGE_LOCK_FILENAME);
  await fs.copyFile(sourceLockPath, stagedLockPath);
  state.stage = "cutoverPrepared";
  await writeState(state);
  if (failAfterStage === "cutoverPrepared") {
    throw new Error("Injected failure after cutoverPrepared");
  }
  try {
    await fs.rename(plan.sourcePath, plan.backupPath);
    state.stage = "legacyBackedUp";
    await writeState(state);
    if (failAfterStage === "legacyBackedUp") {
      throw new Error("Injected failure after legacyBackedUp");
    }
    try {
      await fs.rename(plan.stagingPath, plan.sourcePath);
    } catch (error) {
      await fs.rename(plan.backupPath, plan.sourcePath).catch(() => undefined);
      throw new StorageMigrationError(
        "MIG_CUTOVER",
        `Atomic migration cutover failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    state.stage = "v2Published";
    state.reportPath = path.join(plan.sourcePath, MIGRATION_REPORT_FILENAME);
    await writeState(state);
    if (failAfterStage === "v2Published") {
      throw new Error("Injected failure after v2Published");
    }
    await finalizeBackup(plan.backupPath, plan.migrationId, plan.sourcePath, plan.inventory.digest, plan.inventory);
    state.stage = "committed";
    await writeState(state);
  } finally {
    await storageLock?.release().catch(() => undefined);
    await fs.unlink(path.join(plan.sourcePath, STORAGE_LOCK_FILENAME)).catch(() => undefined);
  }
}

/** Apply a planned migration. The source is never edited in place. */
export async function applyStorageMigration(
  storageDir: string,
  options: MigrationApplyOptions = {},
): Promise<MigrationReport> {
  const sourcePath = path.resolve(storageDir);
  const migrationLock = await acquireMigrationLock(sourcePath);
  let storageLock: StorageLockHandle | undefined;
  try {
    options.signal?.throwIfAborted();
    const prepared = await preparePlan(sourcePath);
    const { plan, parsed, converted } = prepared;
    if (plan.layout === "v2") {
      throw new StorageMigrationError("MIG_ALREADY_V2", "Storage already uses format v2");
    }
    if (plan.layout === "empty") {
      throw new StorageMigrationError("MIG_EMPTY", "Storage is empty; normal initialization is sufficient");
    }
    if (!parsed || plan.layout === "unsupported" || plan.unsupported.length > 0) {
      throw new StorageMigrationError(
        "MIG_UNSUPPORTED",
        `Migration cannot proceed: ${plan.unsupported.join("; ") || "unsupported layout"}`,
      );
    }
    if (options.migrationId && options.migrationId !== plan.migrationId) {
      throw new StorageMigrationError("MIG_CHANGED", "Requested migration ID does not match current source inventory");
    }
    if (plan.availableBytes < plan.requiredBytes) {
      throw new StorageMigrationError(
        "MIG_SPACE",
        `Insufficient disk space: need ${plan.requiredBytes} bytes, have ${plan.availableBytes}`,
      );
    }
    if (
      options.nonInteractive &&
      (!options.acceptedBackupPath || path.resolve(options.acceptedBackupPath) !== path.resolve(plan.backupPath))
    ) {
      throw new StorageMigrationError(
        "MIG_CONFIRMATION",
        `Non-interactive migration requires --accept-backup-path ${plan.backupPath}`,
      );
    }
    if (await exists(plan.backupPath)) {
      throw new StorageMigrationError("MIG_COLLISION", `Backup path already exists: ${plan.backupPath}`);
    }
    storageLock = await acquireStorageLock(sourcePath);
    const state: MigrationState = {
      stateVersion: MIGRATION_STATE_VERSION,
      migrationId: plan.migrationId,
      sourcePath,
      layout: plan.layout,
      stage: "planned",
      sourceInventoryDigest: plan.inventory.digest,
      sourceInventory: plan.inventory,
      backupPath: plan.backupPath,
      stagingPath: plan.stagingPath,
      updatedAt: Date.now(),
    };
    await writeState(state);
    options.signal?.throwIfAborted();
    if (options.failAfterStage === "planned") {
      throw new Error("Injected failure after planned");
    }
    const report = await writeStaging(plan, parsed, converted);
    state.stage = "staged";
    await writeState(state);
    options.signal?.throwIfAborted();
    if (options.failAfterStage === "staged") {
      throw new Error("Injected failure after staged");
    }
    await validateStaging(plan, converted, report);
    state.stage = "validated";
    await writeState(state);
    options.signal?.throwIfAborted();
    if (options.failAfterStage === "validated") {
      throw new Error("Injected failure after validated");
    }
    await applyPreparedCutover(plan, state, storageLock, options.failAfterStage);
    storageLock = undefined;
    if (options.failAfterStage === "committed") {
      throw new Error("Injected failure after committed");
    }
    return JSON.parse(await fs.readFile(path.join(sourcePath, MIGRATION_REPORT_FILENAME), "utf8")) as MigrationReport;
  } catch (error) {
    await storageLock?.release().catch(() => undefined);
    throw error;
  } finally {
    await releaseMigrationLock(sourcePath, migrationLock);
  }
}

/** Resume is idempotent: staged data is rebuilt, or a completed cutover is recognized. */
export async function resumeStorageMigration(storageDir: string, migrationId: string): Promise<MigrationReport> {
  const sourcePath = path.resolve(storageDir);
  const statePath = statePathFor(sourcePath, migrationId);
  let state: MigrationState;
  try {
    state = JSON.parse(await fs.readFile(statePath, "utf8")) as MigrationState;
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      throw new StorageMigrationError("MIG_NOT_FOUND", `Migration state not found: ${migrationId}`);
    }
    throw error;
  }
  if (state.stage === "committed") {
    return JSON.parse(await fs.readFile(path.join(sourcePath, MIGRATION_REPORT_FILENAME), "utf8")) as MigrationReport;
  }
  if (await exists(path.join(sourcePath, STORAGE_FORMAT_FILENAME))) {
    const marker = parseJsonRecord(
      await fs.readFile(path.join(sourcePath, STORAGE_FORMAT_FILENAME), "utf8"),
      STORAGE_FORMAT_FILENAME,
    );
    if (marker.formatVersion === STORAGE_FORMAT_VERSION && marker.migrationId === migrationId) {
      const migrationLock = await acquireMigrationLock(sourcePath);
      try {
        if (await exists(state.backupPath)) {
          await finalizeBackup(
            state.backupPath,
            migrationId,
            sourcePath,
            state.sourceInventoryDigest,
            state.sourceInventory,
          );
        }
        await verifyChecksummedJson(path.join(sourcePath, MIGRATION_REPORT_FILENAME));
        state.stage = "committed";
        state.reportPath = path.join(sourcePath, MIGRATION_REPORT_FILENAME);
        await writeState(state);
        return JSON.parse(await fs.readFile(state.reportPath, "utf8")) as MigrationReport;
      } finally {
        await releaseMigrationLock(sourcePath, migrationLock);
      }
    }
  }
  if (
    (await isEmptyMigrationPlaceholder(sourcePath)) &&
    (await exists(state.backupPath)) &&
    (await exists(state.stagingPath))
  ) {
    const migrationLock = await acquireMigrationLock(sourcePath);
    try {
      await finalizeBackup(
        state.backupPath,
        migrationId,
        sourcePath,
        state.sourceInventoryDigest,
        state.sourceInventory,
      );
      await fs.rm(sourcePath, { recursive: true, force: true });
      await fs.rename(state.stagingPath, sourcePath);
      await fs.unlink(path.join(sourcePath, STORAGE_LOCK_FILENAME)).catch(() => undefined);
      state.stage = "committed";
      state.reportPath = path.join(sourcePath, MIGRATION_REPORT_FILENAME);
      await writeState(state);
      return JSON.parse(await fs.readFile(state.reportPath, "utf8")) as MigrationReport;
    } finally {
      await releaseMigrationLock(sourcePath, migrationLock);
    }
  }
  if (await exists(state.stagingPath)) {
    await fs.rm(state.stagingPath, { recursive: true, force: true });
  }
  return applyStorageMigration(sourcePath, {
    migrationId,
    acceptedBackupPath: state.backupPath,
    nonInteractive: true,
  });
}

/** Restore the immutable legacy backup while preserving current v2 as a new backup. */
export async function rollbackStorageMigration(
  storageDir: string,
  migrationId: string,
  options: MigrationRollbackOptions = {},
): Promise<MigrationState> {
  const sourcePath = path.resolve(storageDir);
  const statePath = statePathFor(sourcePath, migrationId);
  let state: MigrationState;
  try {
    state = JSON.parse(await fs.readFile(statePath, "utf8")) as MigrationState;
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      throw new StorageMigrationError("MIG_NOT_FOUND", `Migration state not found: ${migrationId}`);
    }
    throw error;
  }
  if (!["committed", "rollbackPrepared", "rollbackV2BackedUp", "rollbackLegacyPublished"].includes(state.stage)) {
    throw new StorageMigrationError("MIG_UNSUPPORTED", `Migration ${migrationId} is not committed`);
  }
  const migrationLock = await acquireMigrationLock(sourcePath);
  let storageLock: StorageLockHandle | undefined;
  const restoreStage = `${sourcePath}.rollback-${migrationId}`;
  try {
    await reconcileRollbackFilesystemState(state, restoreStage);
    if (state.stage === "rollbackLegacyPublished") {
      state.stage = "rolledBack";
      await writeState(state);
      await fs.unlink(path.join(sourcePath, STORAGE_LOCK_FILENAME)).catch(() => undefined);
      return state;
    }

    if (state.stage === "rollbackV2BackedUp") {
      if (!(await exists(restoreStage)) || !state.currentV2BackupPath) {
        throw new StorageMigrationError("MIG_CUTOVER", "Rollback intent is incomplete; inspect migration state");
      }
      await fs.rename(restoreStage, sourcePath);
      state.stage = "rollbackLegacyPublished";
      await writeState(state);
      if (options.failAfterStage === "rollbackLegacyPublished") {
        throw new Error("Injected failure after rollbackLegacyPublished");
      }
    } else {
      storageLock = await acquireStorageLock(sourcePath);
      if (state.stage === "committed") {
        if (await exists(restoreStage)) {
          throw new StorageMigrationError("MIG_COLLISION", `Rollback staging path exists: ${restoreStage}`);
        }
        await fs.cp(state.backupPath, restoreStage, { recursive: true, preserveTimestamps: true });
        await makeWritable(restoreStage);
        state.currentV2BackupPath = path.join(
          path.dirname(sourcePath),
          `backup-v2-${new Date().toISOString().replace(/[:.]/g, "-")}-${migrationId}`,
        );
        await fs.copyFile(path.join(sourcePath, STORAGE_LOCK_FILENAME), path.join(restoreStage, STORAGE_LOCK_FILENAME));
        state.stage = "rollbackPrepared";
        await writeState(state);
        if (options.failAfterStage === "rollbackPrepared") {
          throw new Error("Injected failure after rollbackPrepared");
        }
      }
      await fs.rename(sourcePath, state.currentV2BackupPath!);
      if (options.failAfterStage === "rollbackV2Renamed") {
        throw new Error("Injected failure after rollback v2 namespace rename");
      }
      state.stage = "rollbackV2BackedUp";
      await writeState(state);
      if (options.failAfterStage === "rollbackV2BackedUp") {
        throw new Error("Injected failure after rollbackV2BackedUp");
      }
      await fs.rename(restoreStage, sourcePath);
      if (options.failAfterStage === "rollbackLegacyRenamed") {
        throw new Error("Injected failure after rollback legacy namespace rename");
      }
      state.stage = "rollbackLegacyPublished";
      await writeState(state);
      if (options.failAfterStage === "rollbackLegacyPublished") {
        throw new Error("Injected failure after rollbackLegacyPublished");
      }
    }
    await fs.unlink(path.join(state.currentV2BackupPath!, STORAGE_LOCK_FILENAME)).catch(() => undefined);
    state.stage = "rolledBack";
    await writeState(state);
    await storageLock?.release().catch(() => undefined);
    await fs.unlink(path.join(sourcePath, STORAGE_LOCK_FILENAME)).catch(() => undefined);
    storageLock = undefined;
    return state;
  } finally {
    await storageLock?.release().catch(() => undefined);
    await releaseMigrationLock(sourcePath, migrationLock);
  }
}
