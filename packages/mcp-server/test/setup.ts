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
 *
 * On Windows the suite finishes but a native addon thread keeps the process alive, so a
 * process still running 10 s after the last test is ended with Mocha's own exit code
 * (process.exit() with no argument lets Mocha's exit listener supply its failure count).
 */
const reportActiveResources = Boolean(process.env.RAGNAROK_REPORT_ACTIVE_RESOURCES);
// RAGNAROK_TEST_FORCE_EXIT_GRACE=1 applies the Windows grace exit on any OS (test-only, to verify it).
const graceExit = process.platform === "win32" || process.env.RAGNAROK_TEST_FORCE_EXIT_GRACE === "1";

export const mochaHooks: Mocha.RootHookObject =
  reportActiveResources || graceExit
    ? {
        afterAll(): void {
          setTimeout(
            () => {
              console.error(
                "Active resources after the suite:",
                (process as ProcessWithActiveResources).getActiveResourcesInfo(),
              );
              if (graceExit) {
                console.error(
                  "Forcing exit: the process did not exit on its own (native handles); see the Windows note in the plan",
                );
                process.exit();
              }
            },
            graceExit ? 10_000 : 2000,
          ).unref();
        },
      }
    : {};
