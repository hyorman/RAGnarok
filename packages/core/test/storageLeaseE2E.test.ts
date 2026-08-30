/**
 * Two-process end-to-end proof for lock-free reads + operation-scoped write
 * leases.
 *
 * A real second OS process (forked from the compiled
 * `dist-test/test/helpers/leaseHolderChild.js`) opens its own TopicManager on
 * the SAME storage directory and either holds a bare operation lease or
 * commits a real topic write, while this process asserts the four properties
 * the design promises:
 *
 *   1. reads never touch the lock — they succeed while a foreign writer holds it;
 *   2. a mutation against a live foreign lease fails fast and typed
 *      (StorageBusyError), and succeeds once that lease is released;
 *   3. a foreign commit reaches this process through the watcher, with no refresh();
 *   4. a writer killed mid-lease is reclaimed by the next acquire (dead same-host
 *      pid detection), with no manual lock cleanup.
 *
 * In-process mutexes cannot fake any of this: everything below crosses a
 * process boundary.
 */
import { expect } from "chai";
import { fork, type ChildProcess } from "child_process";
import * as fsSync from "fs";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  STORAGE_LOCK_FILENAME,
  StorageBusyError,
  TopicManager,
  acquireOperationLease,
  type IConfigProvider,
  type INotifier,
  type LockFileInfo,
  type StorageExternalChange,
} from "../src/index";
import type { EmbeddingService } from "../src/embeddings/embeddingService";
import type { EmbeddingServiceRegistry } from "../src/embeddings/embeddingServiceRegistry";

const CHILD_ENTRY = path.join(__dirname, "helpers", "leaseHolderChild.js");

const config: IConfigProvider = {
  get<T>(_key: string, defaultValue: T): T {
    return defaultValue;
  },
};

const notifier: INotifier = {
  showInfo: () => undefined,
  showWarning: () => undefined,
  showError: () => undefined,
  withProgress: async <T>(_title: string, task: (report: (message: string) => void) => Promise<T>): Promise<T> =>
    task(() => undefined),
};

function stubEmbeddingService(): EmbeddingService {
  return {
    initialize: async () => undefined,
    getCurrentModel: () => "test-model",
    dispose: () => undefined,
    getFingerprint: async () => ({
      backendKind: "huggingface",
      providerFormat: "huggingface",
      model: "test-model",
      revision: "unknown",
      dimension: 4,
      endpointHash: "local",
    }),
    isBackendAvailable: async () => true,
  } as unknown as EmbeddingService;
}

function stubEmbeddingRegistry(): EmbeddingServiceRegistry {
  return {
    get: async () => stubEmbeddingService(),
  } as unknown as EmbeddingServiceRegistry;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `check` until it returns true, or fail with `label` after `timeoutMs`. */
async function pollUntil(check: () => boolean, label: string, timeoutMs = 15_000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`${label}: condition not met within ${timeoutMs}ms`);
    }
    await delay(intervalMs);
  }
}

interface ChildMessage {
  type: string;
  pid?: number;
  id?: string;
  message?: string;
}

/** Fork + request/response wrapper around the compiled lease-holder child. */
class LeaseHolderChild {
  readonly proc: ChildProcess;
  private readonly inbox: ChildMessage[] = [];
  private stderr = "";
  private exited = false;
  private readonly exitPromise: Promise<void>;

  constructor(storageDir: string) {
    this.proc = fork(CHILD_ENTRY, [storageDir], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    this.proc.on("message", (message) => {
      this.inbox.push(message as ChildMessage);
    });
    this.proc.stderr?.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
    this.exitPromise = new Promise<void>((resolve) => {
      this.proc.on("exit", () => {
        this.exited = true;
        resolve();
      });
    });
  }

  get pid(): number {
    if (this.proc.pid === undefined) {
      throw new Error("child failed to fork");
    }
    return this.proc.pid;
  }

  send(message: Record<string, unknown>): void {
    this.proc.send(message);
  }

  /** Resolve with the first buffered message of `type`; child errors reject. */
  async waitFor(type: string, timeoutMs = 30_000): Promise<ChildMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.inbox.findIndex((message) => message.type === type);
      if (index >= 0) {
        return this.inbox.splice(index, 1)[0];
      }
      const failure = this.inbox.find((message) => message.type === "error");
      if (failure) {
        throw new Error(`child reported an error while waiting for "${type}": ${failure.message}${this.diagnostics()}`);
      }
      if (this.exited) {
        throw new Error(`child exited before sending "${type}"${this.diagnostics()}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out after ${timeoutMs}ms waiting for child "${type}"${this.diagnostics()}`);
      }
      await delay(25);
    }
  }

  /** Send a request and wait for its reply in one step. */
  async request(message: Record<string, unknown>, replyType: string, timeoutMs?: number): Promise<ChildMessage> {
    this.send(message);
    return this.waitFor(replyType, timeoutMs);
  }

  async kill(signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
    if (!this.exited) {
      this.proc.kill(signal);
    }
    // Awaiting `exit` also reaps the zombie: until the child is reaped,
    // `kill(pid, 0)` still reports it alive and no reclaim could happen.
    await this.exitPromise;
  }

  async shutdown(): Promise<void> {
    if (this.exited) {
      return;
    }
    this.send({ type: "exit" });
    // The timer is cleared on the happy path: a dangling 10s timeout would
    // hold the mocha event loop open after the suite finishes.
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), 10_000);
    });
    try {
      if ((await Promise.race([this.exitPromise.then(() => "exited" as const), timeout])) === "timeout") {
        this.proc.kill("SIGKILL");
        await this.exitPromise;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private diagnostics(): string {
    return this.stderr ? `\n--- child stderr ---\n${this.stderr}` : "";
  }
}

function readLockFile(storageDir: string): LockFileInfo | null {
  try {
    return JSON.parse(fsSync.readFileSync(path.join(storageDir, STORAGE_LOCK_FILENAME), "utf8")) as LockFileInfo;
  } catch {
    return null;
  }
}

describe("two-process storage lease E2E", function () {
  this.timeout(60_000);

  let storageDir: string;
  let manager: TopicManager | null;
  let child: LeaseHolderChild | null;

  before(function () {
    expect(fsSync.existsSync(CHILD_ENTRY), `compiled child helper missing: ${CHILD_ENTRY}`).to.equal(true);
  });

  beforeEach(async function () {
    storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "lease-e2e-"));
    manager = await TopicManager.create({
      storageDir,
      config,
      notifier,
      embeddingService: stubEmbeddingService(),
      embeddingRegistry: stubEmbeddingRegistry(),
    });
    child = null;
  });

  afterEach(async function () {
    if (child) {
      await child.shutdown().catch(() => undefined);
      child = null;
    }
    if (manager) {
      await manager.dispose().catch(() => undefined);
      manager = null;
    }
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  /** Start the child and wait until its own TopicManager is open. */
  async function startChild(): Promise<LeaseHolderChild> {
    const started = new LeaseHolderChild(storageDir);
    child = started;
    await started.waitFor("ready");
    return started;
  }

  it("serves parent reads while a second process holds a write lease", async function () {
    const parent = manager!;
    const topic = await parent.createTopic({ name: "parent-topic" });

    const holder = await startChild();
    const held = await holder.request({ type: "acquire" }, "held");
    expect(held.pid, "child did not report its pid").to.equal(holder.pid);

    // Precondition: the lock file really is held by the child, unreleased.
    const lockWhileHeld = readLockFile(storageDir);
    expect(lockWhileHeld?.pid, "lock file is not owned by the child").to.equal(holder.pid);
    expect(lockWhileHeld?.releasedAt, "child lease is already marked released").to.equal(undefined);

    // Reads, repeatedly, with the foreign lease live the whole time.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const topics = parent.getAllTopics();
      expect(topics.map((entry) => entry.id)).to.include(topic.id);
      const stats = await parent.getTopicStats(topic.id);
      expect(stats, "getTopicStats returned null under a foreign write lease").to.not.equal(null);
      expect(stats!.documentCount).to.equal(0);
      await delay(50);
    }

    // Reads never touch the lock: the child's lease generation is untouched.
    const lockAfterReads = readLockFile(storageDir);
    expect(lockAfterReads?.ownerId, "a read changed the lock owner").to.equal(lockWhileHeld?.ownerId);
    expect(lockAfterReads?.pid).to.equal(holder.pid);
    expect(lockAfterReads?.releasedAt, "a read released the foreign lease").to.equal(undefined);

    await holder.request({ type: "release" }, "released");
  });

  it("fails a parent mutation with StorageBusyError during the held lease, and succeeds after release", async function () {
    const parent = manager!;
    const holder = await startChild();
    await holder.request({ type: "acquire" }, "held");

    // (a) The lock contract itself, on a short wait: no plumbing, no ambiguity
    // about which layer produced the error.
    let direct: unknown;
    try {
      await acquireOperationLease(storageDir, { waitMs: 200, pollIntervalMs: 25 });
      expect.fail("acquireOperationLease resolved while a foreign process held the lease");
    } catch (error) {
      direct = error;
    }
    expect(direct).to.be.instanceOf(StorageBusyError);
    expect((direct as StorageBusyError).name).to.equal("StorageBusyError");
    expect((direct as StorageBusyError).holder?.pid, "busy error does not name the child as the holder").to.equal(
      holder.pid,
    );
    expect((direct as StorageBusyError).lockPath).to.equal(path.join(storageDir, STORAGE_LOCK_FILENAME));

    // (b) The real mutation path. TopicManager.createTopic does not expose
    // waitMs, so this rides the built-in 5s bounded wait and then reports the
    // same typed error rather than hanging.
    let mutation: unknown;
    try {
      await parent.createTopic({ name: "blocked-topic" });
      expect.fail("createTopic resolved while a foreign process held the lease");
    } catch (error) {
      mutation = error;
    }
    expect(mutation, `expected StorageBusyError, got: ${String(mutation)}`).to.be.instanceOf(StorageBusyError);
    expect((mutation as StorageBusyError).holder?.pid).to.equal(holder.pid);
    expect(parent.getAllTopics().map((entry) => entry.name)).to.not.include("blocked-topic");

    // After the child releases, the very same mutation goes through.
    await holder.request({ type: "release" }, "released");
    const created = await parent.createTopic({ name: "blocked-topic" });
    expect(created.name).to.equal("blocked-topic");
    expect(parent.getAllTopics().map((entry) => entry.id)).to.include(created.id);
  });

  it("surfaces a second process's committed topic through onExternalChange without refresh()", async function () {
    const parent = manager!;
    await parent.createTopic({ name: "parent-topic" });

    const writer = await startChild();
    const events: StorageExternalChange[] = [];
    const subscription = parent.onExternalChange((change) => events.push(change));

    try {
      const created = await writer.request({ type: "create-topic", name: "child-committed" }, "created");
      const childTopicId = created.id!;
      expect(childTopicId, "child did not report the created topic id").to.be.a("string");

      await pollUntil(
        () => events.some((event) => event.kind === "topics-changed"),
        "no topics-changed event after the child's commit",
      );
      // No refresh() anywhere in this test: freshness comes from the watcher.
      await pollUntil(
        () => parent.getAllTopics().some((entry) => entry.id === childTopicId),
        "child topic never appeared in the parent's cache",
      );

      const stats = await parent.getTopicStats(childTopicId);
      expect(stats, "the child's topic has no stats in the parent").to.not.equal(null);
    } finally {
      subscription.dispose();
    }
  });

  it("reclaims the lease from a writer SIGKILLed mid-lease on the parent's next mutation", async function () {
    const parent = manager!;
    const holder = await startChild();
    await holder.request({ type: "acquire" }, "held");

    const childPid = holder.pid;
    await holder.kill("SIGKILL");
    child = null;

    // SIGKILL runs no exit hook: the lease file survives, still claiming the
    // (now dead) child, with no releasedAt marker. That is the precondition
    // this test exists for.
    const orphaned = readLockFile(storageDir);
    expect(orphaned?.pid, "the killed child's lock file is gone").to.equal(childPid);
    expect(orphaned?.releasedAt, "the killed child somehow marked its lease released").to.equal(undefined);

    // No manual cleanup: one ordinary mutation must reclaim the dead
    // same-host lease inside a single acquire.
    const created = await parent.createTopic({ name: "after-kill" });
    expect(created.name).to.equal("after-kill");
    expect(parent.getAllTopics().map((entry) => entry.id)).to.include(created.id);

    // A further mutation still works: the reclaimed lease was released
    // normally, not leaked.
    const second = await parent.createTopic({ name: "after-kill-2" });
    expect(parent.getAllTopics().map((entry) => entry.id)).to.include(second.id);
  });
});
