import { expect } from "chai";
import { spawnSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { StorageDirectoryWatcher } from "../src/utils/storageDirectoryWatcher";

const until = async (check: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("StorageDirectoryWatcher", function () {
  this.timeout(15000);
  let dir: string;
  let watcher: StorageDirectoryWatcher | undefined;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "sdw-"));
  });
  afterEach(async () => {
    watcher?.stop();
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
