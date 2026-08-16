import * as fs from "fs/promises";
import * as path from "path";

export class ExtensionStoppingError extends Error {
  constructor() {
    super("RAGnarōk is shutting down and is not accepting new operations");
    this.name = "ExtensionStoppingError";
  }
}

export class ExtensionShutdownError extends Error {
  constructor(public readonly failures: unknown[]) {
    super(`RAGnarōk extension shutdown encountered ${failures.length} cleanup failure(s)`);
    this.name = "ExtensionShutdownError";
  }
}

export type ExtensionOperationRunner = <T>(label: string, operation: (signal: AbortSignal) => Promise<T>) => Promise<T>;

/**
 * Make pre-mutation UI waits responsive to extension shutdown. VS Code's
 * picker/input APIs do not accept an AbortSignal, so detach their eventual
 * result after abort while keeping rejection handlers attached.
 */
export function waitForAbortableUi<T>(signal: AbortSignal | undefined, operation: PromiseLike<T>): Promise<T> {
  if (!signal) {
    return Promise.resolve(operation);
  }
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(signal.reason ?? new ExtensionStoppingError()));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

interface AwaitableDisposable {
  dispose(): void | Promise<void>;
}

interface AsyncToolRegistration extends AwaitableDisposable {
  disposeAsync(): Promise<void>;
}

interface DisposableRegistry {
  disposeAll(): Promise<void>;
}

interface MemoryCoordinatorLifecycle {
  stopAdmission(reason?: unknown): void;
  drain(): Promise<void>;
}

export interface ExtensionLifecycleResources {
  memoryTools?: AwaitableDisposable;
  graphCommand?: AwaitableDisposable;
  graphPanel?: AwaitableDisposable;
  memoryCoordinator?: MemoryCoordinatorLifecycle;
  memoryStore?: AwaitableDisposable;
  topicManager?: AwaitableDisposable;
  embeddingService?: AwaitableDisposable;
  /**
   * Closed after topicManager: the manager's stores hold services owned by the
   * registry, so releasing the registry first would pull them out from under it.
   */
  embeddingRegistry?: DisposableRegistry;
  ragTool?: AsyncToolRegistration;
}

/**
 * Owns extension operations and durable services.
 *
 * VS Code does not await Disposable.dispose(), so durability cleanup lives in
 * the exported deactivate() promise. New work is rejected first, active work
 * is aborted/drained, and storage-owning services are then closed in dependency
 * order.
 */
export class ExtensionLifecycle {
  private readonly operations = new Set<Promise<unknown>>();
  private readonly operationControllers = new Set<AbortController>();
  private readonly ownedDisposables = new Set<AwaitableDisposable>();
  private resources: ExtensionLifecycleResources = {};
  private accepting = true;
  private shutdownPromise: Promise<void> | undefined;

  constructor(private readonly storageDir: string) {}

  readonly run: ExtensionOperationRunner = async <T>(
    _label: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    if (!this.accepting) {
      throw new ExtensionStoppingError();
    }
    const controller = new AbortController();
    this.operationControllers.add(controller);
    let pending: Promise<T>;
    try {
      pending = operation(controller.signal);
    } catch (error) {
      pending = Promise.reject(error);
    }
    this.operations.add(pending);
    try {
      return await pending;
    } finally {
      this.operations.delete(pending);
      this.operationControllers.delete(controller);
    }
  };

  setResources(resources: Partial<ExtensionLifecycleResources>): void {
    this.resources = { ...this.resources, ...resources };
  }

  addDisposable(disposable: AwaitableDisposable): void {
    this.ownedDisposables.add(disposable);
  }

  get isAcceptingOperations(): boolean {
    return this.accepting;
  }

  get activeOperationCount(): number {
    return this.operations.size;
  }

  private stopAdmission(): void {
    if (!this.accepting) {
      return;
    }
    this.accepting = false;
    const reason = new ExtensionStoppingError();
    for (const controller of this.operationControllers) {
      controller.abort(reason);
    }
  }

  private async drainOperations(): Promise<void> {
    while (this.operations.size > 0) {
      await Promise.allSettled([...this.operations]);
    }
  }

  private async waitForStorageLeaseRelease(timeoutMs = 5_000): Promise<void> {
    const lockPath = path.join(this.storageDir, ".ragnarok.lock");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      try {
        const lock = JSON.parse(await fs.readFile(lockPath, "utf8")) as { releasedAt?: number };
        if (typeof lock.releasedAt === "number") {
          return;
        }
      } catch (error: any) {
        if (error?.code === "ENOENT") {
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for the storage lease to release: ${lockPath}`);
  }

  dispose(): Promise<void> {
    if (!this.shutdownPromise) {
      this.shutdownPromise = this.disposeOnce();
    }
    return this.shutdownPromise;
  }

  private async disposeOnce(): Promise<void> {
    this.stopAdmission();
    const failures: unknown[] = [];
    const close = async (resource: AwaitableDisposable | undefined): Promise<void> => {
      if (!resource) {
        return;
      }
      try {
        await resource.dispose();
      } catch (error) {
        failures.push(error);
      }
    };

    await close(this.resources.memoryTools);
    await close(this.resources.graphCommand);
    await close(this.resources.graphPanel);

    for (const disposable of this.ownedDisposables) {
      await close(disposable);
    }
    this.ownedDisposables.clear();

    if (this.resources.memoryCoordinator) {
      try {
        this.resources.memoryCoordinator.stopAdmission(new ExtensionStoppingError());
      } catch (error) {
        failures.push(error);
      }
    }
    await this.drainOperations();

    if (this.resources.memoryCoordinator) {
      try {
        await this.resources.memoryCoordinator.drain();
      } catch (error) {
        failures.push(error);
      }
    }

    if (this.resources.ragTool) {
      try {
        await this.resources.ragTool.disposeAsync();
      } catch (error) {
        failures.push(error);
      }
    }
    await close(this.resources.memoryStore);
    await close(this.resources.topicManager);
    if (this.resources.topicManager) {
      try {
        await this.waitForStorageLeaseRelease();
      } catch (error) {
        failures.push(error);
      }
    }
    if (this.resources.embeddingRegistry) {
      try {
        await this.resources.embeddingRegistry.disposeAll();
      } catch (error) {
        failures.push(error);
      }
    }
    await close(this.resources.embeddingService);

    if (failures.length > 0) {
      throw new ExtensionShutdownError(failures);
    }
  }
}
