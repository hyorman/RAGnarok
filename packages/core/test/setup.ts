/**
 * Core package test setup
 * Runs before all tests.
 */
import { setLoggerFactory, ILoggerFactory, ILogger } from "../src/index";

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

// Silence log output during tests
setLoggerFactory(noopFactory);

/**
 * Set RAGNAROK_REPORT_ACTIVE_RESOURCES=1 to learn what keeps the process alive after the
 * suite (mocha runs without --exit, so one leaked handle hangs it). The report timer is
 * unref'd: a suite that exits normally never prints it.
 */
export const mochaHooks: Mocha.RootHookObject = process.env.RAGNAROK_REPORT_ACTIVE_RESOURCES
  ? {
      afterAll(): void {
        setTimeout(() => {
          console.error("Active resources after the suite:", process.getActiveResourcesInfo());
        }, 2000).unref();
      },
    }
  : {};
