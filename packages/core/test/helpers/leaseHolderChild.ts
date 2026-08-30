/**
 * Child process for the two-process storage lease E2E (storageLeaseE2E.test.ts).
 *
 * Never imported by the suite: the parent forks the COMPILED copy under
 * `dist-test/test/helpers/leaseHolderChild.js`, so this is a real second OS
 * process with its own module registry — the only way to prove that the
 * cross-process lock file, and not the in-process refcount, is what serialises
 * writes.
 *
 * IPC protocol (all messages are `{ type, ... }`):
 *   parent -> child   acquire      take a bare operation lease and hold it
 *                     release      give the held lease back
 *                     create-topic run a real TopicManager.createTopic
 *                     exit         dispose and exit(0)
 *   child  -> parent  ready        TopicManager.create resolved
 *                     held         { pid } the lease is held
 *                     released     the lease was released
 *                     created      { id } the topic is committed
 *                     error        { message } anything threw
 */
import {
  TopicManager,
  acquireOperationLease,
  setLoggerFactory,
  type IConfigProvider,
  type ILogger,
  type ILoggerFactory,
  type INotifier,
  type StorageLockHandle,
} from "../../src/index";
import type { EmbeddingService } from "../../src/embeddings/embeddingService";
import type { EmbeddingServiceRegistry } from "../../src/embeddings/embeddingServiceRegistry";

class NoopLogger implements ILogger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}

const noopLoggerFactory: ILoggerFactory = {
  createLogger(): ILogger {
    return new NoopLogger();
  },
};

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

function send(message: Record<string, unknown>): void {
  process.send?.(message);
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function main(): Promise<void> {
  setLoggerFactory(noopLoggerFactory);

  const storageDir = process.argv[2];
  if (!storageDir) {
    throw new Error("usage: leaseHolderChild <storageDir>");
  }

  const manager = await TopicManager.create({
    storageDir,
    config,
    notifier,
    embeddingService: stubEmbeddingService(),
    embeddingRegistry: stubEmbeddingRegistry(),
  });

  let lease: StorageLockHandle | null = null;

  const handle = async (message: { type?: string; name?: string }): Promise<void> => {
    switch (message?.type) {
      case "acquire": {
        // A generous wait: the parent never holds the lease while asking for
        // this, so a StorageBusyError here would be a real defect, not a race.
        lease = await acquireOperationLease(storageDir, { waitMs: 20_000 });
        send({ type: "held", pid: process.pid });
        return;
      }
      case "release": {
        await lease?.release();
        lease = null;
        send({ type: "released" });
        return;
      }
      case "create-topic": {
        const topic = await manager.createTopic({ name: message.name ?? "child-topic" });
        send({ type: "created", id: topic.id });
        return;
      }
      case "exit": {
        await lease?.release();
        lease = null;
        await manager.dispose();
        // No ack: process.exit can drop an in-flight IPC message, so the
        // parent observes termination through the `exit` event instead.
        process.exit(0);
        return;
      }
      default:
        throw new Error(`unknown message: ${JSON.stringify(message)}`);
    }
  };

  process.on("message", (raw: { type?: string; name?: string }) => {
    void handle(raw).catch((error: unknown) => send({ type: "error", message: describeError(error) }));
  });

  send({ type: "ready" });
}

void main().catch((error: unknown) => {
  send({ type: "error", message: describeError(error) });
  process.exit(1);
});
