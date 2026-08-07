import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Transform } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import type { Request, Response } from "express";
import type { AccessRole } from "./httpServer";

export type TransferKind = "document" | "archive";

export interface TransferLimits {
  maxFileBytes: number;
  maxAggregateBytes: number;
  maxSessionsPerPrincipal: number;
  ttlMs: number;
}

export class TransferError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

type Upload = {
  id: string;
  principal: string;
  role: AccessRole;
  kind: TransferKind;
  filename: string;
  contentType: string;
  declaredSize: number;
  declaredSha256: string;
  filePath: string;
  state: "created" | "uploading" | "ready" | "consuming";
  expiresAt: number;
};

type Download = {
  id: string;
  principal: string;
  filename: string;
  contentType: string;
  filePath: string;
  size: number;
  sha256: string;
  state: "ready" | "streaming";
  expiresAt: number;
};

const HARD_MAX_FILE_BYTES = 1024 * 1024 * 1024;
const DOCUMENT_TYPES = new Map([
  [".md", new Set(["text/markdown", "text/plain", "application/octet-stream"])],
  [".markdown", new Set(["text/markdown", "text/plain", "application/octet-stream"])],
  [".txt", new Set(["text/plain", "application/octet-stream"])],
  [".html", new Set(["text/html", "application/octet-stream"])],
  [".htm", new Set(["text/html", "application/octet-stream"])],
  [".pdf", new Set(["application/pdf", "application/octet-stream"])],
]);
const ARCHIVE_TYPES = new Set(["application/vnd.ragnarok.archive", "application/octet-stream", "application/zip"]);

function validateNameAndType(filename: string, contentType: string, kind: TransferKind): string {
  if (
    typeof filename !== "string" ||
    typeof contentType !== "string" ||
    !filename ||
    filename.length > 255 ||
    filename !== path.basename(filename) ||
    /[/\\]/.test(filename) ||
    [...filename].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
    filename === "." ||
    filename === ".."
  ) {
    throw new TransferError("INVALID_FILENAME", "Filename must be a plain basename");
  }
  const extension = path.extname(filename).toLowerCase();
  const normalizedType = contentType.split(";", 1)[0].trim().toLowerCase();
  if (kind === "archive") {
    if (extension !== ".rag" || !ARCHIVE_TYPES.has(normalizedType)) {
      throw new TransferError(
        "UNSUPPORTED_MEDIA",
        "Archive uploads require a .rag file and approved content type",
        415,
      );
    }
  } else if (!DOCUMENT_TYPES.get(extension)?.has(normalizedType)) {
    throw new TransferError("UNSUPPORTED_MEDIA", "Unsupported document extension or content type", 415);
  }
  return normalizedType;
}

export class TransferManager {
  private readonly uploads = new Map<string, Upload>();
  private readonly downloads = new Map<string, Download>();
  private readonly expiryTimer: NodeJS.Timeout;

  constructor(
    private readonly stagingDir: string,
    private readonly limits: TransferLimits,
  ) {
    this.expiryTimer = setInterval(
      () => void this.cleanupExpired(),
      Math.min(60_000, Math.max(1_000, limits.ttlMs / 2)),
    );
    this.expiryTimer.unref();
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.stagingDir, { recursive: true, mode: 0o700 });
    // The process owns this private directory under the locked storage root;
    // remove crash-orphaned staging files before accepting new handles.
    for (const entry of await fs.readdir(this.stagingDir)) {
      await fs.rm(path.join(this.stagingDir, entry), { recursive: true, force: true });
    }
  }

  async createUpload(
    principal: string,
    role: AccessRole,
    input: { kind: TransferKind; filename: string; contentType: string; size: number; sha256: string },
  ): Promise<{ id: string; uploadEndpoint: string; expiresAt: string }> {
    if (!input || (input.kind !== "document" && input.kind !== "archive")) {
      throw new TransferError("INVALID_METADATA", "Transfer metadata is invalid");
    }
    if (role === "reader" || (input.kind === "archive" && role !== "admin")) {
      throw new TransferError(
        "FORBIDDEN",
        input.kind === "archive" ? "Admin capability required" : "Curator capability required",
        403,
      );
    }
    const contentType = validateNameAndType(input.filename, input.contentType, input.kind);
    if (
      !Number.isSafeInteger(input.size) ||
      input.size <= 0 ||
      input.size > this.limits.maxFileBytes ||
      input.size > HARD_MAX_FILE_BYTES
    ) {
      throw new TransferError("SIZE_LIMIT", "Declared file size exceeds the configured limit", 413);
    }
    if (!/^[a-f0-9]{64}$/i.test(input.sha256)) {
      throw new TransferError("INVALID_DIGEST", "sha256 must be a 64-character hexadecimal digest");
    }
    const activeUploads = [...this.uploads.values()].filter((entry) => entry.principal === principal);
    const activeDownloads = [...this.downloads.values()].filter((entry) => entry.principal === principal);
    if (activeUploads.length + activeDownloads.length >= this.limits.maxSessionsPerPrincipal) {
      throw new TransferError("SESSION_LIMIT", "Too many active upload sessions", 429);
    }
    const aggregateBytes =
      activeUploads.reduce((sum, entry) => sum + entry.declaredSize, 0) +
      activeDownloads.reduce((sum, entry) => sum + entry.size, 0);
    if (aggregateBytes + input.size > this.limits.maxAggregateBytes) {
      throw new TransferError("AGGREGATE_LIMIT", "Principal upload aggregate quota exceeded", 413);
    }
    const id = randomUUID();
    const expiresAt = Date.now() + this.limits.ttlMs;
    this.uploads.set(id, {
      id,
      principal,
      role,
      kind: input.kind,
      filename: input.filename,
      contentType,
      declaredSize: input.size,
      declaredSha256: input.sha256.toLowerCase(),
      filePath: path.join(this.stagingDir, `${id}${path.extname(input.filename).toLowerCase()}`),
      state: "created",
      expiresAt,
    });
    return { id, uploadEndpoint: `transfer/uploads/${id}`, expiresAt: new Date(expiresAt).toISOString() };
  }

  async receiveUpload(principal: string, id: string, req: Request): Promise<{ size: number; sha256: string }> {
    const upload = this.ownedUpload(principal, id);
    if (req.headers["content-range"]) {
      throw new TransferError("UPLOAD_NOT_RESUMABLE", "Content-Range resumable uploads are not supported", 409);
    }
    if (upload.state !== "created") {
      throw new TransferError("UPLOAD_NOT_RESUMABLE", "Upload is already in progress or complete", 409);
    }
    const requestType = String(req.headers["content-type"] ?? "")
      .split(";", 1)[0]
      .toLowerCase();
    if (requestType !== upload.contentType) {
      throw new TransferError("CONTENT_TYPE_MISMATCH", "Upload content type differs from the declaration", 415);
    }
    const contentLength = Number(req.headers["content-length"]);
    if (Number.isFinite(contentLength) && contentLength !== upload.declaredSize) {
      throw new TransferError("SIZE_MISMATCH", "Content-Length differs from the declared size");
    }
    upload.state = "uploading";
    const digest = createHash("sha256");
    let bytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > upload.declaredSize || bytes > HARD_MAX_FILE_BYTES) {
          callback(new TransferError("SIZE_LIMIT", "Upload exceeded its declared or hard size limit", 413));
          return;
        }
        digest.update(chunk);
        callback(null, chunk);
      },
    });
    const expiry = setTimeout(
      () => req.destroy(new TransferError("EXPIRED", "Upload handle expired during transfer", 410)),
      Math.max(1, upload.expiresAt - Date.now()),
    );
    expiry.unref();
    try {
      await streamPipeline(req, meter, createWriteStream(upload.filePath, { flags: "wx", mode: 0o600 }));
      const actualSha256 = digest.digest("hex");
      if (bytes !== upload.declaredSize) {
        throw new TransferError("SIZE_MISMATCH", "Received size differs from the declared size");
      }
      if (actualSha256 !== upload.declaredSha256) {
        throw new TransferError("DIGEST_MISMATCH", "Received SHA-256 differs from the declared digest");
      }
      upload.state = "ready";
      return { size: bytes, sha256: actualSha256 };
    } catch (error) {
      this.uploads.delete(id);
      await fs.rm(upload.filePath, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(expiry);
    }
  }

  async consumeUpload<T>(
    principal: string,
    id: string,
    kind: TransferKind,
    operation: (filePath: string, filename: string) => Promise<T>,
  ): Promise<T> {
    const upload = this.ownedUpload(principal, id);
    if (upload.kind !== kind || upload.state !== "ready") {
      throw new TransferError("UPLOAD_NOT_READY", "Upload is not ready for this operation", 409);
    }
    upload.state = "consuming";
    try {
      return await operation(upload.filePath, upload.filename);
    } finally {
      this.uploads.delete(id);
      await fs.rm(upload.filePath, { force: true }).catch(() => undefined);
    }
  }

  async createDownload(
    principal: string,
    input: { filePath: string; filename: string; contentType: string },
  ): Promise<{ id: string; downloadEndpoint: string; size: number; sha256: string; expiresAt: string }> {
    validateNameAndType(input.filename, input.contentType, "archive");
    const sourceStat = await fs.lstat(input.filePath);
    if (!sourceStat.isFile() || sourceStat.size > this.limits.maxFileBytes || sourceStat.size > HARD_MAX_FILE_BYTES) {
      throw new TransferError("SIZE_LIMIT", "Download exceeds the configured file limit", 413);
    }
    const activeUploads = [...this.uploads.values()].filter((entry) => entry.principal === principal);
    const activeDownloads = [...this.downloads.values()].filter((entry) => entry.principal === principal);
    if (activeUploads.length + activeDownloads.length >= this.limits.maxSessionsPerPrincipal) {
      throw new TransferError("SESSION_LIMIT", "Too many active transfer sessions", 429);
    }
    const aggregateBytes =
      activeUploads.reduce((sum, entry) => sum + entry.declaredSize, 0) +
      activeDownloads.reduce((sum, entry) => sum + entry.size, 0);
    if (aggregateBytes + sourceStat.size > this.limits.maxAggregateBytes) {
      throw new TransferError("AGGREGATE_LIMIT", "Principal transfer aggregate quota exceeded", 413);
    }
    const id = randomUUID();
    const stagedPath = path.join(this.stagingDir, `${id}.download${path.extname(input.filename).toLowerCase()}`);
    try {
      // Copy into a private, exclusively-created inode before hashing. Copying
      // (rather than retaining/renaming the caller's inode) also breaks hard
      // links that could mutate bytes after the handle is issued.
      const digest = createHash("sha256");
      let copiedBytes = 0;
      const maximumStagedBytes = Math.min(
        this.limits.maxFileBytes,
        HARD_MAX_FILE_BYTES,
        this.limits.maxAggregateBytes - aggregateBytes,
      );
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          copiedBytes += chunk.length;
          if (copiedBytes > maximumStagedBytes) {
            callback(new TransferError("SIZE_LIMIT", "Download exceeded its configured file/quota limit", 413));
            return;
          }
          digest.update(chunk);
          callback(null, chunk);
        },
      });
      await streamPipeline(
        createReadStream(input.filePath),
        meter,
        createWriteStream(stagedPath, { flags: "wx", mode: 0o600 }),
      );
      const stagedStat = await fs.lstat(stagedPath);
      if (
        !stagedStat.isFile() ||
        stagedStat.size < 1 ||
        stagedStat.size !== copiedBytes ||
        stagedStat.size > this.limits.maxFileBytes ||
        stagedStat.size > HARD_MAX_FILE_BYTES ||
        aggregateBytes + stagedStat.size > this.limits.maxAggregateBytes
      ) {
        throw new TransferError("SIZE_LIMIT", "Staged download exceeds the configured file limit", 413);
      }
      const expiresAt = Date.now() + this.limits.ttlMs;
      const sha256 = digest.digest("hex");
      const currentSource = await fs.lstat(input.filePath).catch(() => null);
      if (currentSource && currentSource.dev === sourceStat.dev && currentSource.ino === sourceStat.ino) {
        await fs.rm(input.filePath, { force: true });
      }
      this.downloads.set(id, {
        id,
        principal,
        filename: input.filename,
        contentType: input.contentType,
        filePath: stagedPath,
        size: stagedStat.size,
        sha256,
        state: "ready",
        expiresAt,
      });
      return {
        id,
        downloadEndpoint: `transfer/downloads/${id}`,
        size: stagedStat.size,
        sha256,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    } catch (error) {
      await fs.rm(stagedPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async serveDownload(principal: string, id: string, res: Response): Promise<void> {
    const download = this.downloads.get(id);
    if (!download) {
      throw new TransferError("NOT_FOUND", "Download handle not found", 404);
    }
    if (download.principal !== principal) {
      throw new TransferError("NOT_FOUND", "Download handle not found", 404);
    }
    if (download.expiresAt <= Date.now()) {
      this.downloads.delete(id);
      await fs.rm(download.filePath, { force: true }).catch(() => undefined);
      throw new TransferError("EXPIRED", "Download handle expired", 410);
    }
    if (download.state !== "ready") {
      throw new TransferError("DOWNLOAD_SINGLE_USE", "Download is already in progress or consumed", 409);
    }
    download.state = "streaming";
    res.status(200);
    res.setHeader("content-type", download.contentType);
    res.setHeader("content-length", String(download.size));
    res.setHeader(
      "content-disposition",
      `attachment; filename="ragnarok-download.rag"; filename*=UTF-8''${encodeURIComponent(download.filename)}`,
    );
    res.setHeader("digest", `sha-256=${Buffer.from(download.sha256, "hex").toString("base64")}`);
    try {
      await streamPipeline(createReadStream(download.filePath), res);
    } finally {
      this.downloads.delete(id);
      await fs.rm(download.filePath, { force: true }).catch(() => undefined);
    }
  }

  private ownedUpload(principal: string, id: string): Upload {
    const upload = this.uploads.get(id);
    if (!upload || upload.principal !== principal) {
      throw new TransferError("NOT_FOUND", "Upload handle not found", 404);
    }
    if (upload.expiresAt <= Date.now()) {
      void this.removeUpload(upload);
      throw new TransferError("EXPIRED", "Upload handle expired", 410);
    }
    return upload;
  }

  private async cleanupExpired(): Promise<void> {
    const now = Date.now();
    await Promise.all(
      [...this.uploads.values()]
        .filter((item) => item.expiresAt <= now && item.state !== "uploading")
        .map((item) => this.removeUpload(item)),
    );
    await Promise.all(
      [...this.downloads.values()]
        .filter((item) => item.expiresAt <= now && item.state !== "streaming")
        .map(async (item) => {
          this.downloads.delete(item.id);
          await fs.rm(item.filePath, { force: true }).catch(() => undefined);
        }),
    );
  }

  private async removeUpload(upload: Upload): Promise<void> {
    this.uploads.delete(upload.id);
    await fs.rm(upload.filePath, { force: true }).catch(() => undefined);
  }

  async dispose(): Promise<void> {
    clearInterval(this.expiryTimer);
    await Promise.all([...this.uploads.values()].map((item) => this.removeUpload(item)));
    await Promise.all(
      [...this.downloads.values()].map(async (item) => {
        this.downloads.delete(item.id);
        await fs.rm(item.filePath, { force: true }).catch(() => undefined);
      }),
    );
  }
}
