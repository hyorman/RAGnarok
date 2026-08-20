import { expect } from "chai";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  MemoryOperationCoordinator,
  MemoryService,
  MemoryStore,
  type MemoryHostContext,
  type MemoryStoreOptions,
} from "../src";
import type { EmbeddingFingerprint } from "../src/embeddings/embeddingBackend";
import type { EmbeddingService } from "../src/embeddings/embeddingService";

const contextA: MemoryHostContext = { workingDir: "/host-a", branchContext: { state: "unavailable" } };
const contextB: MemoryHostContext = { workingDir: "/host-b", branchContext: { state: "unavailable" } };

describe("MemoryService store isolation", function () {
  this.timeout(120_000);

  let tempRoot: string;
  let storeA: MemoryStore;
  let storeB: MemoryStore;
  let serviceA: MemoryService | undefined;
  let serviceB: MemoryService | undefined;

  beforeEach(async function () {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-service-isolation-"));
    const rootA = path.join(tempRoot, "a");
    const rootB = path.join(tempRoot, "b");
    await Promise.all([fs.mkdir(rootA), fs.mkdir(rootB)]);
    storeA = createStore(rootA);
    storeB = createStore(rootB);
    await Promise.all([storeA.validateEmbeddingFingerprint(), storeB.validateEmbeddingFingerprint()]);
    serviceA = new MemoryService(storeA, new MemoryOperationCoordinator());
    serviceB = new MemoryService(storeB, new MemoryOperationCoordinator());
  });

  afterEach(async function () {
    await Promise.allSettled([storeA.dispose(), storeB.dispose()]);
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("keeps host stores isolated", async function () {
    await serviceA!.execute({ action: "store", content: "only A" }, contextA);
    expect((await serviceB!.execute({ action: "list" }, contextB)).count).to.equal(0);

    await serviceA!.reset();
    await serviceB!.execute({ action: "store", content: "only B" }, contextB);
    expect((await serviceA!.execute({ action: "list" }, contextA)).count).to.equal(0);
    expect((await serviceB!.execute({ action: "list" }, contextB)).count).to.equal(1);
  });

  it("does not own or dispose the injected store", async function () {
    expect(serviceA).not.to.have.property("dispose");
    serviceA = undefined;

    await storeA.store({ content: "store remains usable" });
    expect(await storeA.list()).to.have.length(1);
  });
});

function createStore(storageDir: string): MemoryStore {
  const options: MemoryStoreOptions = {
    storageDir,
    workingDir: storageDir,
    markdownPath: null,
    embeddingService: createEmbeddingService(),
  };
  return new MemoryStore(options);
}

function createEmbeddingService(): EmbeddingService {
  const fingerprint: EmbeddingFingerprint = {
    backendKind: "test",
    providerFormat: "test",
    model: "memory-service-isolation",
    revision: "1",
    dimension: 32,
    endpointHash: "local",
  };
  return {
    embed: async (text: string, signal?: AbortSignal): Promise<number[]> => {
      signal?.throwIfAborted();
      return textToVector(text);
    },
    embedBatch: async (texts: string[], _progress?: unknown, signal?: AbortSignal): Promise<number[][]> => {
      signal?.throwIfAborted();
      return texts.map(textToVector);
    },
    getFingerprint: async () => fingerprint,
  } as unknown as EmbeddingService;
}

function textToVector(text: string): number[] {
  const hash = crypto.createHash("sha256").update(text).digest();
  const vector = Array.from(hash, (value) => (value - 128) / 128);
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return vector.map((value) => value / norm);
}
