type OperationKind = "read" | "mutation" | "reset";

interface PendingOperation<T> {
  kind: OperationKind;
  operation: () => Promise<T>;
  signal?: AbortSignal;
  abortListener?: () => void;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export class MemoryOperationCoordinator {
  private readonly queue: PendingOperation<unknown>[] = [];
  private readonly active = new Set<Promise<unknown>>();
  private activeReaders = 0;
  private activeMutation = false;
  private activeReset = false;
  private accepting = true;
  private stopReason: unknown = new Error("Memory operations are stopping");

  runRead<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.enqueue("read", operation, signal);
  }

  runMutation<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.enqueue("mutation", operation, signal);
  }

  runReset<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.enqueue("reset", operation, signal);
  }

  stopAdmission(reason: unknown = this.stopReason): void {
    this.accepting = false;
    this.stopReason = reason;
  }

  async drain(): Promise<void> {
    while (this.queue.length > 0 || this.active.size > 0) {
      if (this.active.size === 0) {
        await new Promise<void>((resolve) => queueMicrotask(resolve));
      } else {
        await Promise.allSettled([...this.active]);
      }
    }
  }

  private enqueue<T>(kind: OperationKind, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!this.accepting) {
      return Promise.reject(this.stopReason);
    }
    try {
      signal?.throwIfAborted();
    } catch (error) {
      return Promise.reject(error);
    }

    return new Promise<T>((resolve, reject) => {
      const pending: PendingOperation<T> = { kind, operation, signal, resolve, reject };
      if (signal) {
        pending.abortListener = () => this.cancelQueued(pending as PendingOperation<unknown>);
        signal.addEventListener("abort", pending.abortListener, { once: true });
      }
      this.queue.push(pending as PendingOperation<unknown>);
      this.pump();
    });
  }

  private cancelQueued(pending: PendingOperation<unknown>): void {
    const index = this.queue.indexOf(pending);
    if (index === -1) {
      return;
    }
    this.queue.splice(index, 1);
    this.removeAbortListener(pending);
    try {
      pending.signal?.throwIfAborted();
    } catch (error) {
      pending.reject(error);
    }
    this.pump();
  }

  private pump(): void {
    if (this.activeReset || this.activeMutation || this.queue.length === 0) {
      return;
    }
    const next = this.queue[0];
    if (next.kind === "reset" || next.kind === "mutation") {
      if (this.activeReaders === 0) {
        this.start(this.queue.shift()!);
      }
      return;
    }
    while (this.queue[0]?.kind === "read" && !this.activeMutation && !this.activeReset) {
      this.start(this.queue.shift()!);
    }
  }

  private start(pending: PendingOperation<unknown>): void {
    this.removeAbortListener(pending);
    if (pending.kind === "read") {
      this.activeReaders += 1;
    }
    if (pending.kind === "mutation") {
      this.activeMutation = true;
    }
    if (pending.kind === "reset") {
      this.activeReset = true;
    }

    let running: Promise<unknown>;
    try {
      pending.signal?.throwIfAborted();
      running = Promise.resolve(pending.operation());
    } catch (error) {
      running = Promise.reject(error);
    }
    this.active.add(running);
    void running.then(pending.resolve, pending.reject).finally(() => {
      this.active.delete(running);
      if (pending.kind === "read") {
        this.activeReaders -= 1;
      }
      if (pending.kind === "mutation") {
        this.activeMutation = false;
      }
      if (pending.kind === "reset") {
        this.activeReset = false;
      }
      this.pump();
    });
  }

  private removeAbortListener(pending: PendingOperation<unknown>): void {
    if (pending.abortListener) {
      pending.signal?.removeEventListener("abort", pending.abortListener);
      pending.abortListener = undefined;
    }
  }
}
