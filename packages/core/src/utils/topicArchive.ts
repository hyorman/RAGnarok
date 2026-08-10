import * as fs from "fs/promises";
import * as path from "path";
import { createHash } from "crypto";
import AdmZip from "adm-zip";
import type { Document, ExportedTopicData, Topic } from "./types";

export const TOPIC_ARCHIVE_FORMAT_VERSION = "2.0";

export const TOPIC_ARCHIVE_LIMITS = {
  maxEntries: 20_000,
  maxManifestBytes: 8 * 1024 * 1024,
  maxEntryBytes: 1024 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxCompressionRatio: 1000,
} as const;

export interface TopicArchiveManifestFile {
  path: string;
  size: number;
  sha256: string;
}

export interface TopicArchiveManifest {
  formatVersion: typeof TOPIC_ARCHIVE_FORMAT_VERSION;
  files: TopicArchiveManifestFile[];
}

export interface StagedTopicArchive {
  contentDir: string;
  exportData: ExportedTopicData;
  manifest: TopicArchiveManifest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseJson(buffer: Buffer, label: string): unknown {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new Error(`Invalid archive: ${label} contains malformed JSON`);
  }
}

/**
 * ZIP entry names are an untrusted namespace. Keep validation independent of
 * the host OS so an archive accepted on one platform cannot become unsafe on
 * another.
 */
export function validateTopicArchivePath(entryPath: string, directory = false): string {
  if (
    entryPath.length === 0 ||
    entryPath.length > 1024 ||
    entryPath.includes("\0") ||
    entryPath.includes("\\") ||
    entryPath.startsWith("/") ||
    /^[a-zA-Z]:/.test(entryPath)
  ) {
    throw new Error(`Invalid archive path: ${entryPath}`);
  }

  const comparablePath = directory && entryPath.endsWith("/") ? entryPath.slice(0, -1) : entryPath;
  const segments = comparablePath.split("/");
  if (
    comparablePath.length === 0 ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(`Invalid archive path: ${entryPath}`);
  }
  if (path.posix.normalize(comparablePath) !== comparablePath) {
    throw new Error(`Invalid archive path: ${entryPath}`);
  }
  return comparablePath;
}

function validateEntryType(entry: AdmZip.IZipEntry): void {
  if (entry.header.encrypted) {
    throw new Error(`Archive entry is encrypted: ${entry.entryName}`);
  }
  if (entry.header.method !== 0 && entry.header.method !== 8) {
    throw new Error(`Invalid archive: unsupported compression method (${entry.entryName})`);
  }

  // For archives made on Unix, the high mode bits describe the file type.
  // Reject links, devices, sockets, and other special files. DOS archives
  // commonly leave these bits unset, in which case the central-directory
  // directory flag remains the available type signal.
  const madeByUnix = entry.header.made >>> 8 === 3;
  const unixType = (entry.attr >>> 16) & 0xf000;
  if (madeByUnix && unixType !== 0) {
    const expectedType = entry.isDirectory ? 0x4000 : 0x8000;
    if (unixType !== expectedType) {
      throw new Error(`Invalid archive: unsafe entry type (${entry.entryName})`);
    }
  }
}

function validateManifest(value: unknown): TopicArchiveManifest {
  if (!isRecord(value) || value.formatVersion !== TOPIC_ARCHIVE_FORMAT_VERSION || !Array.isArray(value.files)) {
    throw new Error("Invalid archive manifest");
  }
  if (value.files.length === 0 || value.files.length > TOPIC_ARCHIVE_LIMITS.maxEntries - 1) {
    throw new Error("Invalid archive manifest: unreasonable file count");
  }

  const seen = new Set<string>();
  const seenFolded = new Set<string>();
  let declaredTotal = 0;
  const files: TopicArchiveManifestFile[] = [];
  for (const candidate of value.files) {
    if (
      !isRecord(candidate) ||
      typeof candidate.path !== "string" ||
      !isNonNegativeInteger(candidate.size) ||
      typeof candidate.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(candidate.sha256)
    ) {
      throw new Error("Invalid archive manifest: malformed file entry");
    }
    const safePath = validateTopicArchivePath(candidate.path);
    const folded = safePath.normalize("NFC").toLowerCase();
    if (safePath === "manifest.json" || seen.has(safePath)) {
      throw new Error(`Invalid archive manifest: duplicate or reserved path (${safePath})`);
    }
    if (seenFolded.has(folded)) {
      throw new Error(`Invalid archive manifest: case-fold path collision (${safePath})`);
    }
    if (candidate.size > TOPIC_ARCHIVE_LIMITS.maxEntryBytes) {
      throw new Error(`Invalid archive manifest: entry too large (${safePath})`);
    }
    declaredTotal += candidate.size;
    if (!Number.isSafeInteger(declaredTotal) || declaredTotal > TOPIC_ARCHIVE_LIMITS.maxTotalBytes) {
      throw new Error("Invalid archive manifest: total size exceeds limit");
    }
    seen.add(safePath);
    seenFolded.add(folded);
    files.push({
      path: safePath,
      size: candidate.size,
      sha256: candidate.sha256,
    });
  }

  return {
    formatVersion: TOPIC_ARCHIVE_FORMAT_VERSION,
    files,
  };
}

function validateTopic(value: unknown): value is Omit<Topic, "source"> {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value.id) &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    value.name.length <= 1000 &&
    (value.description === undefined ||
      (typeof value.description === "string" && value.description.length <= 100_000)) &&
    isFiniteNumber(value.createdAt) &&
    isFiniteNumber(value.updatedAt) &&
    isNonNegativeInteger(value.documentCount) &&
    (value.source === undefined || value.source === "local")
  );
}

function validateDocument(value: unknown, topicId: string): value is Document {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > 1000 ||
    value.topicId !== topicId ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    value.name.length > 10_000 ||
    typeof value.filePath !== "string" ||
    value.filePath.length > 100_000 ||
    !["pdf", "markdown", "html", "text", "web", "github"].includes(String(value.fileType)) ||
    !isFiniteNumber(value.addedAt) ||
    !isNonNegativeInteger(value.chunkCount) ||
    (value.containerId !== undefined &&
      (typeof value.containerId !== "string" || value.containerId.length === 0 || value.containerId.length > 1000)) ||
    (value.canonicalSource !== undefined &&
      (typeof value.canonicalSource !== "string" || value.canonicalSource.length > 100_000)) ||
    (value.sourceRevision !== undefined &&
      (typeof value.sourceRevision !== "string" || value.sourceRevision.length > 10_000))
  ) {
    return false;
  }

  if (value.source === undefined) {
    return true;
  }
  if (!isRecord(value.source) || typeof value.source.type !== "string") {
    return false;
  }
  if (value.source.type === "file") {
    return typeof value.source.path === "string" && value.source.path.length <= 100_000;
  }
  if (value.source.type === "url") {
    return typeof value.source.url === "string" && value.source.url.length <= 100_000;
  }
  return (
    value.source.type === "github" &&
    typeof value.source.url === "string" &&
    value.source.url.length <= 100_000 &&
    (value.source.branch === undefined ||
      (typeof value.source.branch === "string" && value.source.branch.length <= 10_000))
  );
}

export function validateExportedTopicData(value: unknown): ExportedTopicData {
  if (
    !isRecord(value) ||
    value.version !== TOPIC_ARCHIVE_FORMAT_VERSION ||
    !validateTopic(value.topic) ||
    !Array.isArray(value.documents) ||
    typeof value.embeddingModel !== "string" ||
    value.embeddingModel.length === 0 ||
    value.embeddingModel.length > 10_000 ||
    !isFiniteNumber(value.exportedAt)
  ) {
    throw new Error("Invalid archive: topic.json does not match the v2 topic schema");
  }

  const documentIds = new Set<string>();
  for (const document of value.documents) {
    if (!validateDocument(document, value.topic.id)) {
      throw new Error("Invalid archive: topic.json contains invalid document metadata");
    }
    if (documentIds.has(document.id)) {
      throw new Error(`Invalid archive: duplicate document id (${document.id})`);
    }
    documentIds.add(document.id);
  }
  if (value.topic.documentCount !== value.documents.length) {
    throw new Error("Invalid archive: topic document count does not match document metadata");
  }
  return value as unknown as ExportedTopicData;
}

function validateAllowedPayloadPath(entryPath: string, topicId: string): void {
  if (entryPath === "topic.json" || entryPath === `vector-${topicId}-metadata.json`) {
    return;
  }
  const allowedTables = new Set([`${topicId}.lance`]);
  const match = /^lancedb\/([^/]+)\/(.+)$/.exec(entryPath);
  if (!match || !allowedTables.has(match[1])) {
    throw new Error(`Invalid archive: unsupported payload path (${entryPath})`);
  }
}

function validateVectorMetadata(value: unknown, topicId: string): void {
  if (
    !isRecord(value) ||
    value.topicId !== topicId ||
    !isNonNegativeInteger(value.documentCount) ||
    !isNonNegativeInteger(value.chunkCount) ||
    typeof value.embeddingModel !== "string" ||
    value.embeddingModel.length === 0 ||
    !isFiniteNumber(value.createdAt) ||
    !isFiniteNumber(value.updatedAt) ||
    (value.schemaVersion !== undefined && value.schemaVersion !== 2)
  ) {
    throw new Error("Invalid archive: vector metadata does not match the v2 schema");
  }
}

/**
 * Validate the complete ZIP namespace and stage every declared payload exactly
 * once. No caller-owned/live path is touched by this function.
 */
export async function validateAndStageTopicArchive(
  archivePath: string,
  stagingRoot: string,
): Promise<StagedTopicArchive> {
  const archiveStat = await fs.stat(archivePath);
  if (!archiveStat.isFile()) {
    throw new Error("Invalid archive: path is not a file");
  }
  if (archiveStat.size > TOPIC_ARCHIVE_LIMITS.maxTotalBytes) {
    throw new Error("Invalid archive: compressed archive exceeds size limit");
  }

  const zip = new AdmZip(archivePath);
  const entries = zip.getEntries();
  if (entries.length === 0 || entries.length > TOPIC_ARCHIVE_LIMITS.maxEntries) {
    throw new Error("Invalid archive: unreasonable entry count");
  }

  const entriesByName = new Map<string, AdmZip.IZipEntry>();
  const foldedNames = new Map<string, string>();
  let headerTotal = 0;
  for (const entry of entries) {
    const safePath = validateTopicArchivePath(entry.entryName, entry.isDirectory);
    validateEntryType(entry);
    const collisionKey = safePath.normalize("NFC").toLowerCase();
    if (entriesByName.has(entry.entryName)) {
      throw new Error(`Invalid archive: duplicate entry (${entry.entryName})`);
    }
    const previousCollision = foldedNames.get(collisionKey);
    if (previousCollision !== undefined) {
      throw new Error(`Invalid archive: case-fold path collision (${previousCollision}, ${entry.entryName})`);
    }
    entriesByName.set(entry.entryName, entry);
    foldedNames.set(collisionKey, entry.entryName);

    if (!entry.isDirectory) {
      const size = Number(entry.header.size);
      const compressedSize = Number(entry.header.compressedSize);
      if (!isNonNegativeInteger(size) || size > TOPIC_ARCHIVE_LIMITS.maxEntryBytes) {
        throw new Error(`Invalid archive: entry too large (${entry.entryName})`);
      }
      headerTotal += size;
      if (!Number.isSafeInteger(headerTotal) || headerTotal > TOPIC_ARCHIVE_LIMITS.maxTotalBytes) {
        throw new Error("Invalid archive: decompressed size exceeds limit");
      }
      if (size > 0 && (compressedSize <= 0 || size / compressedSize > TOPIC_ARCHIVE_LIMITS.maxCompressionRatio)) {
        throw new Error(`Invalid archive: excessive compression ratio (${entry.entryName})`);
      }
    }
  }

  const manifestEntry = entriesByName.get("manifest.json");
  if (!manifestEntry || manifestEntry.isDirectory) {
    throw new Error("Invalid archive: manifest.json not found");
  }
  if (Number(manifestEntry.header.size) > TOPIC_ARCHIVE_LIMITS.maxManifestBytes) {
    throw new Error("Invalid archive: manifest exceeds size limit");
  }
  const manifest = validateManifest(parseJson(manifestEntry.getData(), "manifest.json"));

  const archiveFiles = new Set(
    entries
      .filter((entry) => !entry.isDirectory && entry.entryName !== "manifest.json")
      .map((entry) => entry.entryName),
  );
  const declaredFiles = new Set(manifest.files.map((file) => file.path));
  for (const filePath of declaredFiles) {
    if (!archiveFiles.has(filePath)) {
      throw new Error(`Invalid archive: manifest entry missing (${filePath})`);
    }
  }
  for (const filePath of archiveFiles) {
    if (!declaredFiles.has(filePath)) {
      throw new Error(`Invalid archive: unlisted entry (${filePath})`);
    }
  }

  const topicManifest = manifest.files.find((file) => file.path === "topic.json");
  if (!topicManifest) {
    throw new Error("Invalid archive: topic.json must be listed in manifest");
  }

  const contentDir = path.join(stagingRoot, "content");
  await fs.mkdir(contentDir, { recursive: true });
  let exportData: ExportedTopicData | undefined;
  for (const expected of manifest.files) {
    const entry = entriesByName.get(expected.path)!;
    // AdmZip exposes decompressed payloads as buffers. Materialize each entry
    // once, validate it, persist it to staging, and immediately release it.
    const bytes = entry.getData();
    if (bytes.byteLength !== expected.size || createHash("sha256").update(bytes).digest("hex") !== expected.sha256) {
      throw new Error(`Invalid archive: checksum mismatch (${expected.path})`);
    }
    if (expected.path === "topic.json") {
      exportData = validateExportedTopicData(parseJson(bytes, "topic.json"));
    }
    const targetPath = path.join(contentDir, ...expected.path.split("/"));
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, bytes, { flag: "wx", mode: 0o600 });
  }

  if (!exportData) {
    throw new Error("Invalid archive: topic.json not found");
  }
  for (const file of manifest.files) {
    validateAllowedPayloadPath(file.path, exportData.topic.id);
  }

  const metadataName = `vector-${exportData.topic.id}-metadata.json`;
  if (declaredFiles.has(metadataName)) {
    const metadataBytes = await fs.readFile(path.join(contentDir, metadataName));
    validateVectorMetadata(parseJson(metadataBytes, metadataName), exportData.topic.id);
  }

  return { contentDir, exportData, manifest };
}
