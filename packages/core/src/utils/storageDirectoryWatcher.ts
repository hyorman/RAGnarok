import * as fsSync from "fs";

export interface StorageDirectoryWatcherOptions {
  /** Watch the directory, never a file: atomic rename-over writes silence an inode-following file watch. */
  directory: string;
  /** Names that schedule a change. A null name (the platform did not say) always does. */
  accepts(filename: string): boolean;
  debounceMs: number;
  /** Debounced handler. Return "rearm" to run again after another debounce period. */
  onChange(): void | "rearm" | Promise<void | "rearm">;
  /**
   * A watch error, reported before it is handled. Without an outage policy the
   * watch is then closed and `start()` may be called again; with one, the
   * error enters the outage path. Also receives the error when `fs.watch`
   * cannot be constructed, once per run of failed `start()` calls.
   */
  onError?(error: unknown): void;
  /** Poll for a vanished directory (macOS FSEvents does not report one) and retry until it returns. */
  outage?: {
    pollMs: number;
    retryMs: number;
    exists(): Promise<boolean>;
    onUnavailable(): void;
    /** The directory is back and the watch re-established. A throw re-enters the outage. */
    onRecovered(): Promise<void>;
  };
}

/**
 * Watch + filter + debounce + outage for one storage directory. Every handle
 * and timer is unref'd: a watcher must never be what keeps a host process
 * alive. Hosts still stop() it on dispose.
 */
export class StorageDirectoryWatcher {
  private handle: fsSync.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private unavailable = false;
  private startFailureReported = false;

  constructor(private readonly options: StorageDirectoryWatcherOptions) {}

  get watching(): boolean {
    return this.handle !== null;
  }

  /** Idempotent. False when fs.watch could not be constructed (nothing is watched). */
  start(): boolean {
    if (this.stopped) {
      return false;
    }
    this.closeHandle();
    let handle: fsSync.FSWatcher;
    try {
      handle = fsSync.watch(this.options.directory, (_event, filename) => this.onRawEvent(filename));
    } catch (error) {
      if (!this.startFailureReported) {
        this.startFailureReported = true;
        this.reportError(error);
      }
      return false;
    }
    this.startFailureReported = false;
    handle.unref?.();
    handle.on("error", (error) => {
      this.reportError(error);
      if (this.options.outage) {
        this.reportOutage();
      } else {
        this.closeHandle();
      }
    });
    this.handle = handle;
    if (this.options.outage) {
      this.pollTimer = setInterval(() => void this.poll(), this.options.outage.pollMs);
      this.pollTimer.unref?.();
    }
    return true;
  }

  /** Enter the outage path now (e.g. a reload hit ENOENT). No-op without an outage policy. */
  reportOutage(): void {
    const outage = this.options.outage;
    if (!outage || this.stopped || this.unavailable) {
      return;
    }
    this.unavailable = true;
    this.clearDebounce();
    this.closeHandle();
    outage.onUnavailable();
    this.scheduleRetry();
  }

  /** Idempotent; nothing fires afterwards. */
  stop(): void {
    this.stopped = true;
    this.clearDebounce();
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.closeHandle();
  }

  /** Hand an error to the host. A throwing callback is swallowed: it must not skip the outage path or the retry. */
  private reportError(error: unknown): void {
    try {
      this.options.onError?.(error);
    } catch {
      // The host's reporting failed; recovery does not depend on it.
    }
  }

  private onRawEvent(filename: string | Buffer | null): void {
    if (this.stopped) {
      return;
    }
    const name = filename ? filename.toString() : null;
    if (name !== null && !this.options.accepts(name)) {
      return;
    }
    this.scheduleChange();
  }

  private scheduleChange(): void {
    this.clearDebounce();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.runChange();
    }, this.options.debounceMs);
    this.debounceTimer.unref?.();
  }

  private async runChange(): Promise<void> {
    if (this.stopped) {
      return;
    }
    if ((await this.options.onChange()) === "rearm" && !this.stopped) {
      this.scheduleChange();
    }
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.unavailable || !this.options.outage) {
      return;
    }
    if (!(await this.options.outage.exists()) && !this.stopped) {
      this.reportOutage();
    }
  }

  private scheduleRetry(): void {
    const outage = this.options.outage;
    if (!outage || this.stopped) {
      return;
    }
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null;
      if (this.stopped) {
        return;
      }
      if (!(await outage.exists())) {
        this.scheduleRetry();
        return;
      }
      if (this.stopped) {
        return;
      }
      // fs.watch can fail (ENOSPC/EMFILE) just as the directory returns. Stay
      // unavailable and retry: recovery is announced only once a watch is armed.
      if (!this.start()) {
        this.scheduleRetry();
        return;
      }
      this.unavailable = false;
      try {
        await outage.onRecovered();
      } catch {
        this.reportOutage();
      }
    }, outage.retryMs);
    this.retryTimer.unref?.();
  }

  private clearDebounce(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private closeHandle(): void {
    if (this.handle) {
      try {
        this.handle.close();
      } catch {
        // Already closed.
      }
      this.handle = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
