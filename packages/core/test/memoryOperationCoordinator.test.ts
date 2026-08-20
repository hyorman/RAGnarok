import { expect } from "chai";
import { MemoryOperationCoordinator as CoreMemoryOperationCoordinator } from "../src";
import { MemoryOperationCoordinator } from "../src/memory";

describe("MemoryOperationCoordinator", function () {
  it("runs adjacent reads concurrently", async function () {
    const coordinator = new MemoryOperationCoordinator();
    const gate = deferred<void>();
    const events: string[] = [];

    const first = coordinator.runRead(async () => {
      events.push("first:start");
      await gate.promise;
      events.push("first:end");
    });
    const second = coordinator.runRead(async () => {
      events.push("second:start");
      await gate.promise;
      events.push("second:end");
    });

    await tick();
    expect(events).to.deep.equal(["first:start", "second:start"]);
    gate.resolve();
    await Promise.all([first, second]);
    expect(events).to.deep.equal(["first:start", "second:start", "first:end", "second:end"]);
  });

  it("serializes mutations", async function () {
    const coordinator = new MemoryOperationCoordinator();
    const firstGate = deferred<void>();
    const events: string[] = [];

    const first = coordinator.runMutation(async () => {
      events.push("first:start");
      await firstGate.promise;
      events.push("first:end");
    });
    const second = coordinator.runMutation(async () => {
      events.push("second:start");
    });

    await tick();
    expect(events).to.deep.equal(["first:start"]);
    firstGate.resolve();
    await Promise.all([first, second]);
    expect(events).to.deep.equal(["first:start", "first:end", "second:start"]);
  });

  it("makes reset exclusive and queues later reads behind it", async function () {
    const coordinator = new MemoryOperationCoordinator();
    const firstRead = deferred<void>();
    const resetGate = deferred<void>();
    const events: string[] = [];

    const read = coordinator.runRead(async () => {
      events.push("read:start");
      await firstRead.promise;
      events.push("read:end");
    });
    const reset = coordinator.runReset(async () => {
      events.push("reset:start");
      await resetGate.promise;
      events.push("reset:end");
    });
    const laterRead = coordinator.runRead(async () => {
      events.push("later-read");
    });

    await tick();
    expect(events).to.deep.equal(["read:start"]);
    firstRead.resolve();
    await tick();
    expect(events).to.deep.equal(["read:start", "read:end", "reset:start"]);
    resetGate.resolve();
    await Promise.all([read, reset, laterRead]);
    expect(events).to.deep.equal(["read:start", "read:end", "reset:start", "reset:end", "later-read"]);
  });

  it("does not let later mutations bypass a queued reset", async function () {
    const coordinator = new MemoryOperationCoordinator();
    const mutationGate = deferred<void>();
    const resetGate = deferred<void>();
    const events: string[] = [];

    const first = coordinator.runMutation(async () => {
      events.push("mutation:start");
      await mutationGate.promise;
      events.push("mutation:end");
    });
    const reset = coordinator.runReset(async () => {
      events.push("reset:start");
      await resetGate.promise;
      events.push("reset:end");
    });
    const later = coordinator.runMutation(async () => {
      events.push("later-mutation");
    });

    await tick();
    expect(events).to.deep.equal(["mutation:start"]);
    mutationGate.resolve();
    await tick();
    expect(events).to.deep.equal(["mutation:start", "mutation:end", "reset:start"]);
    resetGate.resolve();
    await Promise.all([first, reset, later]);
    expect(events).to.deep.equal(["mutation:start", "mutation:end", "reset:start", "reset:end", "later-mutation"]);
  });

  it("removes a cancelled queued operation without executing it", async function () {
    const coordinator = new MemoryOperationCoordinator();
    const gate = deferred<void>();
    const controller = new AbortController();
    let executed = false;

    const blocking = coordinator.runMutation(async () => gate.promise);
    const cancelled = coordinator.runRead(async () => {
      executed = true;
    }, controller.signal);
    controller.abort(new Error("cancel queued read"));

    await expectRejectedWith(cancelled, "cancel queued read");
    gate.resolve();
    await blocking;
    await coordinator.drain();
    expect(executed).to.equal(false);
  });

  it("rejects a pre-cancelled operation without executing it", async function () {
    const coordinator = new MemoryOperationCoordinator();
    const controller = new AbortController();
    const reason = new Error("already cancelled");
    let executed = false;
    controller.abort(reason);

    const operation = coordinator.runRead(async () => {
      executed = true;
    }, controller.signal);

    expect(await rejectionOf(operation)).to.equal(reason);
    expect(executed).to.equal(false);
  });

  it("rejects new admissions with the stop reason while completing admitted work", async function () {
    const coordinator = new MemoryOperationCoordinator();
    const gate = deferred<void>();
    const reason = new Error("host shutting down");
    let rejectedOperationRan = false;

    const admitted = coordinator.runMutation(async () => gate.promise);
    coordinator.stopAdmission(reason);
    const rejected = coordinator.runRead(async () => {
      rejectedOperationRan = true;
    });

    expect(await rejectionOf(rejected)).to.equal(reason);
    gate.resolve();
    await admitted;
    expect(rejectedOperationRan).to.equal(false);
  });

  it("drains queued and active operations even when an operation rejects", async function () {
    const coordinator = new MemoryOperationCoordinator();
    const gate = deferred<void>();
    const events: string[] = [];

    const active = coordinator.runMutation(async () => {
      await gate.promise;
      events.push("active:end");
      throw new Error("operation failed");
    });
    const queued = coordinator.runRead(async () => {
      events.push("queued:end");
    });
    let drained = false;
    const drain = coordinator.drain().then(() => {
      drained = true;
    });

    await tick();
    expect(drained).to.equal(false);
    gate.resolve();
    await expectRejectedWith(active, "operation failed");
    await Promise.all([queued, drain]);
    expect(events).to.deep.equal(["active:end", "queued:end"]);
    expect(drained).to.equal(true);
  });

  it("is exported from the core entry point", function () {
    expect(CoreMemoryOperationCoordinator).to.equal(MemoryOperationCoordinator);
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject");
}

async function expectRejectedWith(promise: Promise<unknown>, message: string): Promise<void> {
  const error = await rejectionOf(promise);
  expect(error).to.be.instanceOf(Error);
  expect((error as Error).message).to.equal(message);
}
