import { expect } from "chai";
import { spawnSync } from "child_process";
import fsSync from "fs";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import sinon from "sinon";
import { StorageDirectoryWatcher } from "../src/utils/storageDirectoryWatcher";

const until = async (check: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("condition not met");
    }
    await new Promise((r) => setTimeout(r, 20));
  }
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A promise a test settles by hand, to hold a handler "in flight". */
function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Wraps fs.watch so a test can count the handles the watcher holds open, feed
 * one an error, or make construction fail the way ENOSPC/EMFILE do.
 */
function instrumentWatch(): { handles: fsSync.FSWatcher[]; open(): number; failWith(error: Error | null): void } {
  const realWatch = fsSync.watch as (...args: unknown[]) => fsSync.FSWatcher;
  const handles: fsSync.FSWatcher[] = [];
  const closed = new Set<fsSync.FSWatcher>();
  let failure: Error | null = null;
  sinon.stub(fsSync, "watch").callsFake(((...args: unknown[]) => {
    if (failure) {
      throw failure;
    }
    const handle = realWatch(...args);
    const close = handle.close.bind(handle);
    handle.close = () => {
      closed.add(handle);
      close();
    };
    handles.push(handle);
    return handle;
  }) as typeof fsSync.watch);
  return {
    handles,
    open: () => handles.filter((handle) => !closed.has(handle)).length,
    failWith: (error) => {
      failure = error;
    },
  };
}

function systemError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: watch failed`), { code });
}

describe("StorageDirectoryWatcher", function () {
  this.timeout(15000);
  let dir: string;
  let watcher: StorageDirectoryWatcher | undefined;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "sdw-"));
  });
  afterEach(async () => {
    watcher?.stop();
    sinon.restore();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("debounces accepted names into one change and ignores the rest", async () => {
    let changes = 0;
    watcher = new StorageDirectoryWatcher({
      directory: dir,
      accepts: (n) => n === "topics.json",
      debounceMs: 100,
      onChange: () => void changes++,
    });
    expect(watcher.start()).to.equal(true);
    await fs.writeFile(path.join(dir, "other.txt"), "x");
    await fs.writeFile(path.join(dir, "topics.json"), "1");
    await fs.writeFile(path.join(dir, "topics.json"), "2");
    await until(() => changes === 1);
    await new Promise((r) => setTimeout(r, 250));
    expect(changes).to.equal(1);
  });

  it("re-arms when the handler asks", async () => {
    let calls = 0;
    watcher = new StorageDirectoryWatcher({
      directory: dir,
      accepts: () => true,
      debounceMs: 50,
      onChange: () => (++calls < 2 ? "rearm" : undefined),
    });
    watcher.start();
    await fs.writeFile(path.join(dir, "a"), "x");
    await until(() => calls === 2);
  });

  it("fires nothing after stop()", async () => {
    let changes = 0;
    watcher = new StorageDirectoryWatcher({
      directory: dir,
      accepts: () => true,
      debounceMs: 50,
      onChange: () => void changes++,
    });
    watcher.start();
    await fs.writeFile(path.join(dir, "a"), "x");
    watcher.stop();
    await new Promise((r) => setTimeout(r, 200));
    expect(changes).to.equal(0);
    expect(watcher.watching).to.equal(false);
  });

  it("reports a vanished directory and recovers when it returns", async () => {
    const events: string[] = [];
    let present = true;
    watcher = new StorageDirectoryWatcher({
      directory: dir,
      accepts: () => true,
      debounceMs: 50,
      onChange: () => undefined,
      outage: {
        pollMs: 50,
        retryMs: 50,
        exists: async () => present,
        onUnavailable: () => events.push("unavailable"),
        onRecovered: async () => void events.push("recovered"),
      },
    });
    watcher.start();
    present = false;
    await until(() => events.includes("unavailable"));
    present = true;
    await until(() => events.includes("recovered"));
    expect(events).to.deep.equal(["unavailable", "recovered"]);
  });

  it("stays unavailable and retries when fs.watch fails as the directory returns", async () => {
    const watches = instrumentWatch();
    const events: string[] = [];
    let present = true;
    watcher = new StorageDirectoryWatcher({
      directory: dir,
      accepts: () => true,
      debounceMs: 50,
      onChange: () => undefined,
      outage: {
        pollMs: 50,
        retryMs: 50,
        exists: async () => present,
        onUnavailable: () => events.push("unavailable"),
        onRecovered: async () => void events.push("recovered"),
      },
    });
    expect(watcher.start()).to.equal(true);
    present = false;
    await until(() => events.includes("unavailable"));

    watches.failWith(systemError("ENOSPC"));
    present = true;
    await sleep(300); // several retry periods with the directory back and no watch possible
    expect(events, "recovery is announced only once a watch is armed").to.deep.equal(["unavailable"]);
    expect(watcher.watching).to.equal(false);

    watches.failWith(null);
    await until(() => events.includes("recovered"));
    expect(events).to.deep.equal(["unavailable", "recovered"]);
    expect(watcher.watching).to.equal(true);
    expect(watches.open()).to.equal(1);
  });

  it("reports a construction failure to onError, once per run of failures", async () => {
    const watches = instrumentWatch();
    const errors: unknown[] = [];
    watcher = new StorageDirectoryWatcher({
      directory: dir,
      accepts: () => true,
      debounceMs: 50,
      onChange: () => undefined,
      onError: (error) => errors.push(error),
    });
    const emfile = systemError("EMFILE");
    watches.failWith(emfile);

    expect(watcher.start()).to.equal(false);
    expect(watcher.start()).to.equal(false);
    expect(errors, "a caller that retries start() must not be flooded").to.deep.equal([emfile]);

    watches.failWith(null);
    expect(watcher.start()).to.equal(true);
    const enospc = systemError("ENOSPC");
    watches.failWith(enospc);
    expect(watcher.start()).to.equal(false);
    expect(errors, "a failure after a success is a new run").to.deep.equal([emfile, enospc]);
  });

  it("reports one construction failure per outage streak and keeps exactly one retry timer pending", async () => {
    const clock = sinon.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const watches = instrumentWatch();
    const errors: unknown[] = [];
    const events: string[] = [];
    let present = true;
    watcher = new StorageDirectoryWatcher({
      directory: dir,
      accepts: () => true,
      debounceMs: 50,
      onChange: () => undefined,
      onError: (error) => errors.push(error),
      outage: {
        pollMs: 1000,
        retryMs: 50,
        exists: async () => present,
        onUnavailable: () => events.push("unavailable"),
        onRecovered: async () => void events.push("recovered"),
      },
    });
    expect(watcher.start()).to.equal(true);
    expect(clock.countTimers(), "only the outage poll is armed while watching").to.equal(1);

    present = false;
    watcher.reportOutage();
    watcher.reportOutage(); // a second report while unavailable must not arm a second retry
    expect(clock.countTimers(), "one retry timer, no poll").to.equal(1);
    for (let retry = 0; retry < 3; retry++) {
      await clock.tickAsync(50);
      expect(clock.countTimers(), `one retry timer while the directory is gone (retry ${retry + 1})`).to.equal(1);
    }

    const enospc = systemError("ENOSPC");
    watches.failWith(enospc);
    present = true;
    for (let retry = 0; retry < 4; retry++) {
      await clock.tickAsync(50);
      expect(clock.countTimers(), `one retry timer while fs.watch fails (retry ${retry + 1})`).to.equal(1);
    }
    expect(errors, "a streak of failed retries is reported once").to.deep.equal([enospc]);

    watches.failWith(null);
    await clock.tickAsync(50);
    expect(events).to.deep.equal(["unavailable", "recovered"]);
    expect(clock.countTimers(), "recovered: the poll is armed again and no retry is left").to.equal(1);
    expect(watches.open()).to.equal(1);
  });

  it("keeps recovering when the host's onError throws", async () => {
    const clock = sinon.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const watches = instrumentWatch();
    const events: string[] = [];
    let present = true;
    let reported = 0;
    watcher = new StorageDirectoryWatcher({
      directory: dir,
      accepts: () => true,
      debounceMs: 50,
      onChange: () => undefined,
      onError: () => {
        reported += 1;
        throw new Error("host logger is closed");
      },
      outage: {
        pollMs: 1000,
        retryMs: 50,
        exists: async () => present,
        onUnavailable: () => events.push("unavailable"),
        onRecovered: async () => void events.push("recovered"),
      },
    });
    watcher.start();
    present = false;
    watcher.reportOutage();

    watches.failWith(systemError("EMFILE"));
    present = true;
    await clock.tickAsync(50); // retry 1: fs.watch fails and the host callback throws
    await clock.tickAsync(50); // retry 2: still failing; reported once per streak
    watches.failWith(null);
    await clock.tickAsync(50); // retry 3: the watch is armed again

    expect(reported).to.equal(1);
    expect(events, "a throwing host callback must not strand the watcher").to.deep.equal(["unavailable", "recovered"]);
    expect(watcher.watching).to.equal(true);
  });

  it("re-arms exactly one handle when start() follows a watch error", async () => {
    const watches = instrumentWatch();
    const errors: unknown[] = [];
    watcher = new StorageDirectoryWatcher({
      directory: dir,
      accepts: () => true,
      debounceMs: 50,
      onChange: () => undefined,
      onError: (error) => errors.push(error),
    });
    expect(watcher.start()).to.equal(true);
    expect(watches.open()).to.equal(1);

    // No outage policy: the error closes the watch and leaves start() to the caller.
    const failure = systemError("EIO");
    watches.handles[0].emit("error", failure);
    expect(errors).to.deep.equal([failure]);
    expect(watcher.watching).to.equal(false);
    expect(watches.open()).to.equal(0);

    expect(watcher.start()).to.equal(true);
    expect(watcher.watching).to.equal(true);
    expect(watches.open(), "exactly one live handle after the re-arm").to.equal(1);

    expect(watcher.start(), "start() is idempotent").to.equal(true);
    expect(watches.open()).to.equal(1);
  });

  it("treats reportOutage() without an outage policy as a no-op", async () => {
    let changes = 0;
    watcher = new StorageDirectoryWatcher({
      directory: dir,
      accepts: () => true,
      debounceMs: 50,
      onChange: () => void changes++,
    });
    watcher.start();

    watcher.reportOutage();

    expect(watcher.watching, "the watch is neither closed nor torn down").to.equal(true);
    await fs.writeFile(path.join(dir, "a"), "x");
    await until(() => changes === 1);
  });

  it("stop() while onChange is in flight cancels the re-arm", async () => {
    let calls = 0;
    const entered = deferred();
    const release = deferred<"rearm">();
    watcher = new StorageDirectoryWatcher({
      directory: dir,
      accepts: () => true,
      debounceMs: 20,
      onChange: () => {
        calls++;
        entered.resolve();
        return release.promise;
      },
    });
    watcher.start();
    await fs.writeFile(path.join(dir, "a"), "x");
    await entered.promise;

    watcher.stop();
    release.resolve("rearm");
    await sleep(150);

    expect(calls, "a handler that finishes after stop() must not schedule another run").to.equal(1);
    expect(watcher.watching).to.equal(false);
  });

  it("stop() while a recovery is in flight leaves nothing armed", async () => {
    const events: string[] = [];
    let exists = 0;
    let present = true;
    const recovering = deferred();
    const recovery = deferred();
    watcher = new StorageDirectoryWatcher({
      directory: dir,
      accepts: () => true,
      debounceMs: 50,
      onChange: () => undefined,
      outage: {
        pollMs: 50,
        retryMs: 50,
        exists: async () => {
          exists++;
          return present;
        },
        onUnavailable: () => events.push("unavailable"),
        onRecovered: async () => {
          recovering.resolve();
          await recovery.promise;
        },
      },
    });
    watcher.start();
    present = false;
    await until(() => events.includes("unavailable"));
    present = true;
    await recovering.promise;
    expect(watcher.watching, "the watch is re-established before onRecovered runs").to.equal(true);

    watcher.stop();
    expect(watcher.watching).to.equal(false);
    recovery.reject(new Error("reload failed after dispose")); // would re-enter the outage if not stopped
    await sleep(200);

    expect(events, "a stopped watcher never re-enters the outage").to.deep.equal(["unavailable"]);
    const settled = exists;
    await sleep(200);
    expect(exists, "no retry or poll keeps running").to.equal(settled);
    expect(watcher.watching).to.equal(false);
  });

  it("never keeps the process alive when a caller forgets to stop it", function () {
    const modulePath = path.resolve(__dirname, "../src/utils/storageDirectoryWatcher.js");
    const script = `
      const { StorageDirectoryWatcher } = require(${JSON.stringify(modulePath)});
      const dir = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "sdw-leak-"));
      new StorageDirectoryWatcher({ directory: dir, accepts: () => true, debounceMs: 50, onChange() {},
        outage: { pollMs: 50, retryMs: 50, exists: async () => true, onUnavailable() {}, async onRecovered() {} } }).start();`;
    const result = spawnSync(process.execPath, ["-e", script], { timeout: 10_000 });
    expect(result.error, "child timed out: the watcher kept the event loop alive").to.equal(undefined);
    expect(result.status).to.equal(0);
  });
});
