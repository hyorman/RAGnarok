import type { MemoryOperationCoordinator } from "@ragnarok/core";

export interface ToolRuntime {
  run<T>(operation: () => Promise<T>): Promise<T>;
  stopAdmission?(): void;
  drain?(): Promise<void>;
}

export function createToolRuntime(): Required<ToolRuntime> {
  let acceptingOperations = true;
  let activeOperations = 0;
  const drainWaiters: Array<() => void> = [];

  return {
    async run<T>(operation: () => Promise<T>): Promise<T> {
      if (!acceptingOperations) {
        throw new Error("SERVER_DRAINING: new tool operations are not accepted");
      }
      activeOperations += 1;
      try {
        return await operation();
      } finally {
        activeOperations -= 1;
        if (activeOperations === 0) {
          for (const resolve of drainWaiters.splice(0)) {
            resolve();
          }
        }
      }
    },
    stopAdmission(): void {
      acceptingOperations = false;
    },
    drain(): Promise<void> {
      return activeOperations === 0 ? Promise.resolve() : new Promise((resolve) => drainWaiters.push(resolve));
    },
  };
}

export async function drainToolRuntimeThenMemory(
  runtime: Required<Pick<ToolRuntime, "stopAdmission" | "drain">>,
  coordinator: Pick<MemoryOperationCoordinator, "stopAdmission" | "drain">,
): Promise<void> {
  runtime.stopAdmission();
  await runtime.drain();
  coordinator.stopAdmission();
  await coordinator.drain();
}
