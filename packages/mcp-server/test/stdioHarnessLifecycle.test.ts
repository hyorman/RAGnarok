import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { StdioHarness, withStdioHarness } from "./helpers/stdioHarness";

async function killForTest(harness: StdioHarness | undefined): Promise<void> {
  if (!harness || harness.proc.exitCode !== null || harness.proc.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) => harness.proc.once("exit", () => resolve()));
  harness.proc.kill("SIGKILL");
  await exited;
}

describe("stdio harness lifecycle", function () {
  this.timeout(120_000);

  it("closes a started fixture child when setup fails", async () => {
    const setupError = new Error("fixture setup failed");
    let closeCalls = 0;
    const harness = {
      async close(): Promise<number> {
        closeCalls += 1;
        return 0;
      },
      async forceClose(): Promise<number> {
        throw new Error("forceClose must not run after a clean close");
      },
    };

    let observed: unknown;
    try {
      await withStdioHarness(
        () => harness,
        async () => {
          throw setupError;
        },
        "fixture child",
      );
    } catch (error) {
      observed = error;
    }

    expect(observed).to.equal(setupError);
    expect(closeCalls).to.equal(1);
  });

  it("does not swallow close failures after successful setup", async () => {
    const closeError = new Error("close failed");
    let forceCloseCalls = 0;

    let observed: unknown;
    try {
      await withStdioHarness(
        () => ({
          async close(): Promise<number> {
            throw closeError;
          },
          async forceClose(): Promise<number> {
            forceCloseCalls += 1;
            return 0;
          },
        }),
        async () => "created-topic-id",
        "fixture child",
      );
    } catch (error) {
      observed = error;
    }

    expect(observed).to.equal(closeError);
    expect(forceCloseCalls).to.equal(1);
  });

  it("rejects a nonzero fixture child exit after successful setup", async () => {
    let forceCloseCalls = 0;
    let observed: unknown;
    try {
      await withStdioHarness(
        () => ({
          async close(): Promise<number> {
            return 7;
          },
          async forceClose(): Promise<number> {
            forceCloseCalls += 1;
            return 7;
          },
        }),
        async () => "created-topic-id",
        "fixture child",
      );
    } catch (error) {
      observed = error;
    }

    expect(observed).to.be.instanceOf(Error);
    expect((observed as Error).message).to.equal("fixture child exited with code 7");
    expect(forceCloseCalls).to.equal(1);
  });

  it("releases fixture ownership before a later setup reuses the storage", async () => {
    let locked = false;
    const create = () => {
      if (locked) {
        throw new Error("storage remains locked");
      }
      locked = true;
      return {
        async close(): Promise<number> {
          locked = false;
          return 0;
        },
        async forceClose(): Promise<number> {
          locked = false;
          return 0;
        },
      };
    };

    let observed: unknown;
    try {
      await withStdioHarness(
        create,
        async () => {
          throw new Error("setup failed");
        },
        "fixture child",
      );
    } catch (error) {
      observed = error;
    }
    expect(observed).to.be.instanceOf(Error);
    expect((observed as Error).message).to.equal("setup failed");
    expect(await withStdioHarness(create, async () => "reused", "fixture child")).to.equal("reused");
    expect(locked).to.equal(false);
  });

  it("propagates an operation that throws undefined", async () => {
    let rejected = false;
    let observed: unknown = "not rejected";
    try {
      await withStdioHarness(
        () => ({
          async close(): Promise<number> {
            return 0;
          },
          async forceClose(): Promise<number> {
            throw new Error("forceClose must not run after a clean close");
          },
        }),
        async () => {
          // eslint-disable-next-line no-throw-literal -- Exercise a valueless rejection explicitly.
          throw undefined;
        },
        "fixture child",
      );
    } catch (error) {
      rejected = true;
      observed = error;
    }

    expect(rejected).to.equal(true);
    expect(observed).to.equal(undefined);
  });

  it("propagates close rejecting undefined after forced termination", async () => {
    let rejected = false;
    let observed: unknown = "not rejected";
    let forceCloseCalls = 0;
    try {
      await withStdioHarness(
        () => ({
          close(): Promise<number> {
            return Promise.reject(undefined);
          },
          async forceClose(): Promise<number> {
            forceCloseCalls += 1;
            return 0;
          },
        }),
        async () => "created-topic-id",
        "fixture child",
      );
    } catch (error) {
      rejected = true;
      observed = error;
    }

    expect(rejected).to.equal(true);
    expect(observed).to.equal(undefined);
    expect(forceCloseCalls).to.equal(1);
  });

  it("preserves operation and cleanup failures without masking either", async () => {
    const operationError = new Error("operation failed");
    const cleanupError = new Error("cleanup failed");
    let observed: unknown;
    try {
      await withStdioHarness(
        () => ({
          async close(): Promise<number> {
            throw cleanupError;
          },
          async forceClose(): Promise<number> {
            return 0;
          },
        }),
        async () => {
          throw operationError;
        },
        "fixture child",
      );
    } catch (error) {
      observed = error;
    }

    expect(observed).to.be.instanceOf(Error);
    expect(observed).to.have.property("operationError", operationError);
    expect(observed).to.have.property("cleanupError", cleanupError);
  });

  it("force-terminates a real child when normal close rejects and permits storage reuse", async () => {
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "ragnarok-harness-lifecycle-"));
    const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "ragnarok-harness-work-"));
    const closeError = new Error("simulated normal close failure");
    let first: StdioHarness | undefined;
    let second: StdioHarness | undefined;
    try {
      let observed: unknown;
      try {
        await withStdioHarness(
          () => {
            first = new StdioHarness(storageDir, workingDir);
            first.close = async () => {
              throw closeError;
            };
            return first;
          },
          async (harness) => {
            expect((await harness.discover(700)).error).to.equal(undefined);
          },
          "real fixture child",
        );
      } catch (error) {
        observed = error;
      }

      expect(observed).to.equal(closeError);
      expect(first?.proc.exitCode !== null || first?.proc.signalCode !== null).to.equal(true);

      await withStdioHarness(
        () => {
          second = new StdioHarness(storageDir, workingDir);
          return second;
        },
        async (harness) => {
          expect((await harness.discover(701)).error).to.equal(undefined);
        },
        "storage reuse child",
      );
    } finally {
      await killForTest(first);
      await killForTest(second);
      fs.rmSync(storageDir, { recursive: true, force: true });
      fs.rmSync(workingDir, { recursive: true, force: true });
    }
  });

  it("preserves the live keys a pre-seeded config.json carries across first boot", async () => {
    // ensureConfigFile refreshes the $defaults/$envOnly blocks it authors by
    // rewriting the whole file. If that rewrite dropped keys it did not author,
    // every harness-driven test would silently lose its configuration and the
    // loss would look like a server bug rather than a harness one.
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "ragnarok-seeded-"));
    const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "ragnarok-seeded-wd-"));
    try {
      await withStdioHarness(
        () => new StdioHarness(storageDir, workingDir, { reranker: { maxCandidates: 7 } }),
        async (harness) => {
          expect((await harness.discover(720)).error).to.equal(undefined);
        },
        "seeded config child",
      );
      const written = JSON.parse(fs.readFileSync(path.join(storageDir, "config.json"), "utf8"));
      expect(written.reranker.maxCandidates).to.equal(7);
      expect(written.security.allowedPaths).to.deep.equal([workingDir]);
      expect(written.$defaults, "the server must still author its documentation blocks").to.be.an("object");
    } finally {
      fs.rmSync(storageDir, { recursive: true, force: true });
      fs.rmSync(workingDir, { recursive: true, force: true });
    }
  });
});
