/**
 * MCP Server test setup
 * This file runs before all tests.
 */
import { setLoggerFactory, ILoggerFactory, ILogger } from "@ragnarok/core";

/** No-op logger to keep test output quiet */
class NoopLogger implements ILogger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}

const noopFactory: ILoggerFactory = {
  createLogger(_context: string): ILogger {
    return new NoopLogger();
  },
};

// Silence all log output during tests
setLoggerFactory(noopFactory);

// This package resolves its own @types/node 18 (a transitive pin), whose Process lacks
// getActiveResourcesInfo, which every supported runtime (Node >=22) has.
type ProcessWithActiveResources = NodeJS.Process & { getActiveResourcesInfo(): string[] };

/**
 * Set RAGNAROK_REPORT_ACTIVE_RESOURCES=1 to learn what keeps the process alive after the
 * suite (mocha runs without --exit, so one leaked handle hangs it). The report timer is
 * unref'd: a suite that exits normally never prints it.
 */
export const mochaHooks: Mocha.RootHookObject = process.env.RAGNAROK_REPORT_ACTIVE_RESOURCES
  ? {
      afterAll(): void {
        setTimeout(() => {
          console.error(
            "Active resources after the suite:",
            (process as ProcessWithActiveResources).getActiveResourcesInfo(),
          );
        }, 2000).unref();
      },
    }
  : {};
