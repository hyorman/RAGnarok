import { expect } from "chai";
import { MemoryOperationCoordinator } from "@ragnarok/core";
import { createToolRuntime, drainToolRuntimeThenMemory } from "../src/toolRuntime";

describe("tool runtime shutdown", function () {
  it("lets an admitted tool finish asynchronous setup and memory admission before stopping the coordinator", async function () {
    const runtime = createToolRuntime();
    const coordinator = new MemoryOperationCoordinator();
    const branchDetection = deferred<void>();
    const events: string[] = [];

    const admitted = runtime.run(async () => {
      events.push("tool:admitted");
      await branchDetection.promise;
      events.push("branch:detected");
      await coordinator.runMutation(async () => {
        events.push("memory:completed");
      });
    });
    const shutdown = drainToolRuntimeThenMemory(runtime, coordinator).then(() => {
      events.push("shutdown:drained");
    });
    const rejected = runtime.run(async () => {
      events.push("late-tool:ran");
    });

    await expectRejectedWith(rejected, "SERVER_DRAINING");
    branchDetection.resolve();
    await Promise.all([admitted, shutdown]);
    expect(events).to.deep.equal(["tool:admitted", "branch:detected", "memory:completed", "shutdown:drained"]);
  });
});

function deferred<T>(): { promise: Promise<T>; resolve(value?: T | PromiseLike<T>): void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function expectRejectedWith(promise: Promise<unknown>, message: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.include(message);
    return;
  }
  expect.fail("Expected promise to reject");
}
