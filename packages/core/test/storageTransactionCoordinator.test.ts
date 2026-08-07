import { expect } from "chai";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { StorageTransactionCoordinator } from "../src/utils/storageTransactionCoordinator";

describe("StorageTransactionCoordinator", function () {
  let temporaryDir: string;

  beforeEach(async function () {
    temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), "storage-tx-"));
  });

  afterEach(async function () {
    await fs.rm(temporaryDir, { recursive: true, force: true });
  });

  it("publishes replacements/deletions and writes checksummed prepare+commit records", async function () {
    const source = path.join(temporaryDir, "source.json");
    const destination = path.join(temporaryDir, "destination.json");
    const deleted = path.join(temporaryDir, "deleted");
    await fs.writeFile(source, "new");
    await fs.writeFile(destination, "old");
    await fs.mkdir(deleted);
    await fs.writeFile(path.join(deleted, "data"), "remove");

    const coordinator = new StorageTransactionCoordinator(temporaryDir, {
      ownerId: "owner-a",
      assertOwned: async () => undefined,
    });
    const transactionId = await coordinator.commit("fixture", [
      { type: "replace", source, destination },
      { type: "delete", destination: deleted },
    ]);

    expect(await fs.readFile(destination, "utf8")).to.equal("new");
    let deletedExists = true;
    try {
      await fs.access(deleted);
    } catch {
      deletedExists = false;
    }
    expect(deletedExists).to.equal(false);
    const records = (await fs.readFile(path.join(temporaryDir, ".transactions", `${transactionId}.wal`), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.map((record) => record.state)).to.deep.equal(["prepared", "committed"]);
    expect(records.every((record) => /^[a-f0-9]{64}$/.test(record.checksum))).to.equal(true);
  });

  it("leaves a fenced partial publication for the next owner to roll back idempotently", async function () {
    const firstSource = path.join(temporaryDir, "first-source");
    const secondSource = path.join(temporaryDir, "second-source");
    const firstDestination = path.join(temporaryDir, "first-destination");
    const secondDestination = path.join(temporaryDir, "second-destination");
    await fs.writeFile(firstSource, "new-first");
    await fs.writeFile(secondSource, "new-second");
    await fs.writeFile(firstDestination, "old-first");
    await fs.writeFile(secondDestination, "old-second");

    let assertions = 0;
    const displaced = new StorageTransactionCoordinator(temporaryDir, {
      ownerId: "owner-old",
      assertOwned: async () => {
        assertions += 1;
        if (assertions >= 4) {
          throw new Error("lease lost");
        }
      },
    });
    let error: Error | undefined;
    try {
      await displaced.commit("fenced", [
        { type: "replace", source: firstSource, destination: firstDestination },
        { type: "replace", source: secondSource, destination: secondDestination },
      ]);
    } catch (caught) {
      error = caught as Error;
    }
    expect(error?.message).to.equal("lease lost");
    expect(await fs.readFile(firstDestination, "utf8")).to.equal("new-first");
    expect(await fs.readFile(secondDestination, "utf8")).to.equal("old-second");

    const recovery = new StorageTransactionCoordinator(temporaryDir, {
      ownerId: "owner-new",
      assertOwned: async () => undefined,
    });
    await recovery.initialize();
    expect(await fs.readFile(firstDestination, "utf8")).to.equal("old-first");
    expect(await fs.readFile(secondDestination, "utf8")).to.equal("old-second");

    // Recovery is idempotent after the abort record and staging cleanup.
    await new StorageTransactionCoordinator(temporaryDir, {
      ownerId: "owner-new",
      assertOwned: async () => undefined,
    }).initialize();
    expect(await fs.readFile(firstDestination, "utf8")).to.equal("old-first");
  });

  it("stops before each destructive rollback step when the lease is displaced", async function () {
    const firstSource = path.join(temporaryDir, "first-source");
    const secondSource = path.join(temporaryDir, "second-source");
    const firstDestination = path.join(temporaryDir, "first-destination");
    const blockingParent = path.join(temporaryDir, "blocking-parent");
    await fs.writeFile(firstSource, "new-first");
    await fs.writeFile(secondSource, "new-second");
    await fs.writeFile(firstDestination, "old-first");
    await fs.writeFile(blockingParent, "not-a-directory");

    let assertions = 0;
    const displaced = new StorageTransactionCoordinator(temporaryDir, {
      ownerId: "owner-old",
      assertOwned: async () => {
        assertions += 1;
        if (assertions >= 7) {
          throw new Error("lease lost during rollback");
        }
      },
    });
    const error = await (async () => {
      try {
        await displaced.commit("rollback-fence", [
          { type: "replace", source: firstSource, destination: firstDestination },
          { type: "replace", source: secondSource, destination: path.join(blockingParent, "child") },
        ]);
      } catch (caught) {
        return caught as Error;
      }
      throw new Error("Expected commit to reject");
    })();
    expect(error.message).to.equal("lease lost during rollback");
    expect(await fs.readFile(firstDestination, "utf8")).to.equal("new-first");

    await new StorageTransactionCoordinator(temporaryDir, {
      ownerId: "owner-new",
      assertOwned: async () => undefined,
    }).initialize();
    expect(await fs.readFile(firstDestination, "utf8")).to.equal("old-first");
  });

  it("does not delete a restored original when recovery replays rollback before the abort WAL", async function () {
    const replacement = path.join(temporaryDir, "replacement");
    const existingDestination = path.join(temporaryDir, "existing-destination");
    const absentDestination = path.join(temporaryDir, "absent-destination");
    await fs.writeFile(replacement, "new");
    await fs.writeFile(existingDestination, "old");

    const fence = {
      ownerId: "owner",
      assertOwned: async () => undefined,
    };
    const interrupted = new StorageTransactionCoordinator(temporaryDir, fence);
    const internals = interrupted as any;
    const applyPrepared = internals.applyPrepared.bind(interrupted);
    internals.applyPrepared = async (record: unknown) => {
      await applyPrepared(record);
      throw new Error("force rollback");
    };
    const appendWal = internals.appendWal.bind(interrupted);
    internals.appendWal = async (payload: { state: string }) => {
      if (payload.state === "aborted") {
        throw new Error("simulated crash before abort WAL");
      }
      return appendWal(payload);
    };

    let error: Error | undefined;
    try {
      await interrupted.commit("rollback-replay", [
        { type: "replace", source: replacement, destination: existingDestination },
        { type: "replace", source: replacement, destination: absentDestination },
      ]);
    } catch (caught) {
      error = caught as Error;
    }
    expect(error?.message).to.equal("simulated crash before abort WAL");
    expect(await fs.readFile(existingDestination, "utf8")).to.equal("old");
    await expectMissing(absentDestination);

    await new StorageTransactionCoordinator(temporaryDir, fence).initialize();
    expect(await fs.readFile(existingDestination, "utf8")).to.equal("old");
    await expectMissing(absentDestination);
  });

  it("removes payload and WAL artifacts when preparation fails before publication", async function () {
    const coordinator = new StorageTransactionCoordinator(temporaryDir, {
      ownerId: "owner",
      assertOwned: async () => undefined,
    });
    let rejected = false;
    try {
      await coordinator.commit("missing-source", [
        {
          type: "replace",
          source: path.join(temporaryDir, "does-not-exist"),
          destination: path.join(temporaryDir, "destination"),
        },
      ]);
    } catch {
      rejected = true;
    }
    expect(rejected).to.equal(true);
    expect(await fs.readdir(path.join(temporaryDir, ".transactions"))).to.deep.equal([]);

    const validSource = path.join(temporaryDir, "valid-source");
    const validDestination = path.join(temporaryDir, "valid-destination");
    await fs.writeFile(validSource, "value");
    await coordinator.commit("retry-without-restart", [
      { type: "replace", source: validSource, destination: validDestination },
    ]);
    expect(await fs.readFile(validDestination, "utf8")).to.equal("value");
  });

  it("fails closed on a corrupt WAL checksum", async function () {
    const transactionRoot = path.join(temporaryDir, ".transactions");
    await fs.mkdir(transactionRoot);
    await fs.writeFile(
      path.join(transactionRoot, "bad.wal"),
      `${JSON.stringify({
        version: 1,
        transactionId: "bad",
        sequence: 1,
        state: "prepared",
        timestamp: 1,
        kind: "corrupt",
        ownerId: "owner",
        operations: [],
        checksum: "0".repeat(64),
      })}\n`,
    );
    const coordinator = new StorageTransactionCoordinator(temporaryDir, {
      ownerId: "owner",
      assertOwned: async () => undefined,
    });
    let error: Error | undefined;
    try {
      await coordinator.initialize();
    } catch (caught) {
      error = caught as Error;
    }
    expect(error?.message).to.include("failed checksum validation");
  });
});

async function expectMissing(candidate: string): Promise<void> {
  let exists = true;
  try {
    await fs.access(candidate);
  } catch {
    exists = false;
  }
  expect(exists).to.equal(false);
}
