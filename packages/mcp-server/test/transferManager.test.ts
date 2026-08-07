import { expect } from "chai";
import { createHash } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { TransferError, TransferManager } from "../src/transferManager";

function uploadRequest(bytes: Buffer, contentType: string, chunked = false): any {
  return Object.assign(Readable.from([bytes]), {
    headers: {
      "content-type": contentType,
      ...(chunked ? {} : { "content-length": String(bytes.length) }),
    },
  });
}

describe("TransferManager", function () {
  let root: string;
  let manager: TransferManager;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ragnarok-transfer-"));
    manager = new TransferManager(root, {
      maxFileBytes: 16 * 1024 * 1024,
      maxAggregateBytes: 20 * 1024 * 1024,
      maxSessionsPerPrincipal: 2,
      ttlMs: 5_000,
    });
    await manager.initialize();
  });

  afterEach(async () => {
    await manager.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function create(
    bytes: Buffer,
    filename = "notes.md",
    principal = "curator:a",
    kind: "document" | "archive" = "document",
  ) {
    const extension = path.extname(filename);
    const documentType =
      extension === ".pdf" ? "application/pdf" : extension === ".txt" ? "text/plain" : "text/markdown";
    return manager.createUpload(principal, kind === "archive" ? "admin" : "curator", {
      kind,
      filename,
      contentType: kind === "archive" ? "application/vnd.ragnarok.archive" : documentType,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }

  it("streams a chunked upload, verifies it, and consumes it exactly once without exposing a path", async () => {
    const bytes = Buffer.from("# streamed markdown");
    const handle = await create(bytes);
    expect(handle).to.have.keys(["id", "uploadEndpoint", "expiresAt"]);
    expect(JSON.stringify(handle)).to.not.include(root);
    await manager.receiveUpload("curator:a", handle.id, uploadRequest(bytes, "text/markdown", true));
    const consumed = await manager.consumeUpload("curator:a", handle.id, "document", async (filePath) => {
      expect(path.extname(filePath)).to.equal(".md");
      return fs.readFile(filePath);
    });
    expect(consumed).to.deep.equal(bytes);
    await expectRejected(
      () => manager.consumeUpload("curator:a", handle.id, "document", async () => undefined),
      "NOT_FOUND",
    );
  });

  it("rejects ownership crossing, digest mismatch, oversize, and name/type abuse", async () => {
    const bytes = Buffer.from("safe");
    const handle = await create(bytes);
    await expectRejected(
      () => manager.receiveUpload("curator:b", handle.id, uploadRequest(bytes, "text/markdown")),
      "NOT_FOUND",
    );
    await expectRejected(
      () =>
        manager.createUpload("curator:a", "curator", {
          kind: "document",
          filename: "../secret.md",
          contentType: "text/markdown",
          size: 4,
          sha256: "0".repeat(64),
        }),
      "INVALID_FILENAME",
    );
    await expectRejected(
      () =>
        manager.createUpload("curator:a", "curator", {
          kind: "document",
          filename: "script.exe",
          contentType: "application/octet-stream",
          size: 4,
          sha256: "0".repeat(64),
        }),
      "UNSUPPORTED_MEDIA",
    );
    const mismatch = await manager.createUpload("curator:b", "curator", {
      kind: "document",
      filename: "bad.txt",
      contentType: "text/plain",
      size: bytes.length,
      sha256: "0".repeat(64),
    });
    await expectRejected(
      () => manager.receiveUpload("curator:b", mismatch.id, uploadRequest(bytes, "text/plain")),
      "DIGEST_MISMATCH",
    );
    await expectRejected(
      () =>
        manager.createUpload("curator:c", "curator", {
          kind: "document",
          filename: "huge.pdf",
          contentType: "application/pdf",
          size: 17 * 1024 * 1024,
          sha256: "0".repeat(64),
        }),
      "SIZE_LIMIT",
    );
  });

  it("rejects concurrent/resumed PUT and removes partial data after disconnect", async () => {
    const bytes = Buffer.from("abcdef");
    const handle = await create(bytes, "doc.md");
    const stream = Object.assign(new PassThrough(), {
      headers: { "content-type": "text/markdown", "content-length": String(bytes.length) },
    });
    const first = manager.receiveUpload("curator:a", handle.id, stream as any);
    await expectRejected(
      () => manager.receiveUpload("curator:a", handle.id, uploadRequest(bytes, "text/markdown")),
      "UPLOAD_NOT_RESUMABLE",
    );
    stream.destroy(new Error("client disconnected"));
    await first.catch(() => undefined);
    await expectRejected(
      () => manager.receiveUpload("curator:a", handle.id, uploadRequest(bytes, "text/markdown")),
      "NOT_FOUND",
    );
    expect(await fs.readdir(root)).to.deep.equal([]);
  });

  it("enforces aggregate/session quotas and expiry", async () => {
    const bytes = Buffer.alloc(8 * 1024 * 1024);
    await create(bytes, "one.pdf");
    await create(bytes, "two.pdf");
    await expectRejected(() => create(Buffer.alloc(1), "three.pdf"), "SESSION_LIMIT");

    const expiring = new TransferManager(path.join(root, "expiry"), {
      maxFileBytes: 1024,
      maxAggregateBytes: 1024,
      maxSessionsPerPrincipal: 1,
      ttlMs: 20,
    });
    await expiring.initialize();
    const item = await expiring.createUpload("curator:x", "curator", {
      kind: "document",
      filename: "old.txt",
      contentType: "text/plain",
      size: 1,
      sha256: createHash("sha256").update("x").digest("hex"),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expectRejected(
      () => expiring.receiveUpload("curator:x", item.id, uploadRequest(Buffer.from("x"), "text/plain")),
      "EXPIRED",
    );
    await expiring.dispose();
  });

  it("streams an admin archive download as a single-use bounded handle", async () => {
    const archivePath = path.join(root, "export.rag");
    const bytes = Buffer.from("archive bytes");
    const upload = await create(bytes, "import.rag", "admin:a", "archive");
    await manager.receiveUpload("admin:a", upload.id, uploadRequest(bytes, "application/vnd.ragnarok.archive", true));
    expect(
      await manager.consumeUpload("admin:a", upload.id, "archive", async (filePath) => (await fs.stat(filePath)).size),
    ).to.equal(bytes.length);
    await fs.writeFile(archivePath, bytes);
    const handle = await manager.createDownload("admin:a", {
      filePath: archivePath,
      filename: "topic.rag",
      contentType: "application/vnd.ragnarok.archive",
    });
    const response = Object.assign(new PassThrough(), {
      headers: {} as Record<string, string>,
      status(code: number) {
        (this as any).statusCode = code;
        return this;
      },
      setHeader(name: string, value: string) {
        (this as any).headers[name.toLowerCase()] = value;
      },
    });
    const chunks: Buffer[] = [];
    response.on("data", (chunk) => chunks.push(chunk));
    await manager.serveDownload("admin:a", handle.id, response as any);
    expect(Buffer.concat(chunks)).to.deep.equal(bytes);
    expect((response as any).headers).to.not.have.property("x-server-path");
    await expectRejected(() => manager.serveDownload("admin:a", handle.id, response as any), "NOT_FOUND");
  });

  it("serves immutable staged bytes when the original path is recreated after handle creation", async () => {
    const archivePath = path.join(root, "replaceable-export.rag");
    const original = Buffer.from("verified archive bytes");
    const replacement = Buffer.from("tampered replacement");
    await fs.writeFile(archivePath, original);
    const handle = await manager.createDownload("admin:a", {
      filePath: archivePath,
      filename: "topic.rag",
      contentType: "application/vnd.ragnarok.archive",
    });
    await fs.writeFile(archivePath, replacement);
    const response = Object.assign(new PassThrough(), {
      headers: {} as Record<string, string>,
      status() {
        return this;
      },
      setHeader(name: string, value: string) {
        (this as any).headers[name.toLowerCase()] = value;
      },
    });
    const chunks: Buffer[] = [];
    response.on("data", (chunk) => chunks.push(chunk));
    await manager.serveDownload("admin:a", handle.id, response as any);
    expect(Buffer.concat(chunks)).to.deep.equal(original);
    expect(handle.size).to.equal(original.length);
    expect(handle.sha256).to.equal(createHash("sha256").update(original).digest("hex"));
  });

  it("does not expire or unlink an actively streaming download", async () => {
    const archivePath = path.join(root, "active-export.rag");
    await fs.writeFile(archivePath, "active archive");
    const handle = await manager.createDownload("admin:a", {
      filePath: archivePath,
      filename: "topic.rag",
      contentType: "application/vnd.ragnarok.archive",
    });
    const download = (manager as any).downloads.get(handle.id);
    download.state = "streaming";
    download.expiresAt = 0;
    await (manager as any).cleanupExpired();
    expect((manager as any).downloads.has(handle.id)).to.equal(true);
    expect((await fs.stat(download.filePath)).isFile()).to.equal(true);
    download.state = "ready";
    download.expiresAt = Date.now() + 5_000;
  });

  it("rejects an expired download at point of use and removes its file", async () => {
    const expiringRoot = path.join(root, "download-expiry");
    const expiring = new TransferManager(expiringRoot, {
      maxFileBytes: 1024,
      maxAggregateBytes: 1024,
      maxSessionsPerPrincipal: 1,
      ttlMs: 20,
    });
    await expiring.initialize();
    const archivePath = path.join(expiringRoot, "export.rag");
    await fs.writeFile(archivePath, "archive");
    const handle = await expiring.createDownload("admin:a", {
      filePath: archivePath,
      filename: "topic.rag",
      contentType: "application/vnd.ragnarok.archive",
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const response = Object.assign(new PassThrough(), {
      status() {
        return this;
      },
      setHeader() {},
    });
    await expectRejected(() => expiring.serveDownload("admin:a", handle.id, response as any), "EXPIRED");
    await expectRejected(() => expiring.serveDownload("admin:a", handle.id, response as any), "NOT_FOUND");
    const missing = await fs.stat(archivePath).catch((error: NodeJS.ErrnoException) => error);
    expect((missing as NodeJS.ErrnoException).code).to.equal("ENOENT");
    await expiring.dispose();
  });

  it("keeps RSS bounded while streaming a multi-megabyte chunked upload", async () => {
    const chunk = Buffer.alloc(64 * 1024, 0x5a);
    const chunks = 128;
    const digest = createHash("sha256");
    for (let index = 0; index < chunks; index++) {
      digest.update(chunk);
    }
    const handle = await manager.createUpload("curator:rss", "curator", {
      kind: "document",
      filename: "large.pdf",
      contentType: "application/pdf",
      size: chunk.length * chunks,
      sha256: digest.digest("hex"),
    });
    const before = process.memoryUsage().rss;
    const request = Object.assign(
      Readable.from(
        (async function* () {
          for (let index = 0; index < chunks; index++) {
            yield chunk;
          }
        })(),
      ),
      { headers: { "content-type": "application/pdf" } },
    );
    await manager.receiveUpload("curator:rss", handle.id, request as any);
    const size = await manager.consumeUpload("curator:rss", handle.id, "document", async (filePath) => {
      return (await fs.stat(filePath)).size;
    });
    expect(size).to.equal(chunk.length * chunks);
    expect(process.memoryUsage().rss - before).to.be.lessThan(96 * 1024 * 1024);
  });
});

async function expectRejected(operation: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await operation();
    expect.fail(`Expected ${code}`);
  } catch (error) {
    expect(error).to.be.instanceOf(TransferError);
    expect((error as TransferError).code).to.equal(code);
  }
}
