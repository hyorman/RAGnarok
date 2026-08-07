import { expect } from "chai";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { addDocumentsWithLifecycleSignal, NoDocumentsIngestedError } from "../src/commands";
import { ExtensionLifecycle, ExtensionStoppingError, waitForAbortableUi } from "../src/extensionLifecycle";

describe("extension lifecycle", function () {
  it("stops admission, aborts and drains active work, then awaits durable resources in order", async function () {
    const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragnarok-vscode-lifecycle-"));
    await fs.writeFile(
      path.join(storageDir, ".ragnarok.lock"),
      JSON.stringify({ version: 1, pid: process.pid, hostname: os.hostname() }),
    );
    const lifecycle = new ExtensionLifecycle(storageDir);
    const order: string[] = [];
    let operationAborted = false;
    lifecycle.addDisposable({
      dispose: () => {
        order.push("listener");
      },
    });
    const active = lifecycle.run(
      "active mutation",
      (signal) =>
        new Promise<void>((resolve) => {
          const abort = () => {
            operationAborted = true;
            order.push("operation");
            resolve();
          };
          if (signal.aborted) {
            abort();
          } else {
            signal.addEventListener("abort", abort, { once: true });
          }
        }),
    );
    lifecycle.setResources({
      ragTool: {
        dispose: () => undefined,
        disposeAsync: async () => {
          order.push("tool");
        },
      },
      memoryStore: {
        dispose: async () => {
          order.push("memory");
        },
      },
      checkpointer: {
        dispose: async () => {
          order.push("checkpointer");
        },
      },
      topicManager: {
        dispose: async () => {
          order.push("topic");
          await fs.writeFile(
            path.join(storageDir, ".ragnarok.lock"),
            JSON.stringify({ version: 1, pid: process.pid, hostname: os.hostname(), releasedAt: Date.now() }),
          );
        },
      },
      embeddingService: {
        dispose: async () => {
          order.push("embedding");
        },
      },
    });

    await lifecycle.dispose();
    await active;
    expect(operationAborted).to.equal(true);
    expect(order).to.deep.equal(["operation", "listener", "tool", "memory", "checkpointer", "topic", "embedding"]);
    expect(lifecycle.activeOperationCount).to.equal(0);
    try {
      await lifecycle.run("late", async () => undefined);
      expect.fail("expected stopped admission");
    } catch (error) {
      expect(error).to.be.instanceOf(ExtensionStoppingError);
    }
    await lifecycle.dispose();
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  it("passes the lifecycle signal into document ingestion and drains cancellation", async function () {
    const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragnarok-vscode-command-cancel-"));
    const lifecycle = new ExtensionLifecycle(storageDir);
    let ingestionSignal: AbortSignal | undefined;
    let ingestionStarted!: () => void;
    const started = new Promise<void>((resolve) => (ingestionStarted = resolve));
    const topicManager = {
      addDocuments: async (_topicId: string, _paths: string[], options: { signal?: AbortSignal }) => {
        ingestionSignal = options.signal;
        ingestionStarted();
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(options.signal?.reason ?? new Error("cancelled"));
          if (options.signal?.aborted) {
            abort();
          } else {
            options.signal?.addEventListener("abort", abort, { once: true });
          }
        });
        return [];
      },
    };

    try {
      const active = lifecycle.run("add document", (signal) =>
        addDocumentsWithLifecycleSignal(topicManager as any, "topic", ["/document.txt"], signal),
      );
      const outcome = active.then(
        () => undefined,
        (error) => error,
      );
      await started;
      expect(ingestionSignal?.aborted).to.equal(false);

      await lifecycle.dispose();
      const error = await outcome;
      expect(error).to.be.instanceOf(ExtensionStoppingError);
      expect(ingestionSignal?.aborted).to.equal(true);
      expect(lifecycle.activeOperationCount).to.equal(0);
    } finally {
      await fs.rm(storageDir, { recursive: true, force: true });
    }
  });

  it("does not hang shutdown on a VS Code UI promise that never resolves", async function () {
    const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragnarok-vscode-ui-cancel-"));
    const lifecycle = new ExtensionLifecycle(storageDir);
    const never = new Promise<string>(() => undefined);
    const active = lifecycle.run("waiting for input", (signal) => waitForAbortableUi(signal, never));
    const outcome = active.then(
      () => undefined,
      (error) => error,
    );

    await lifecycle.dispose();
    expect(await outcome).to.be.instanceOf(ExtensionStoppingError);
    expect(lifecycle.activeOperationCount).to.equal(0);
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  it("rejects a zero-result ingestion so command handlers cannot report false success", async function () {
    const topicManager = {
      addDocuments: async () => [],
    };
    let caught: unknown;
    try {
      await addDocumentsWithLifecycleSignal(topicManager as any, "topic", ["/missing.txt"], undefined);
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(NoDocumentsIngestedError);
  });
});
