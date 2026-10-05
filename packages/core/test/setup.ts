/**
 * Core package test setup
 * Runs before all tests.
 */
import { setLoggerFactory, ILoggerFactory, ILogger } from "../src/index";
import { suiteHooks } from "./helpers/suiteDiagnostics";

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

// The leaked-handle report, the stall watchdog and the Windows grace exit: see helpers/suiteDiagnostics.ts.
export const mochaHooks: Mocha.RootHookObject = suiteHooks(process.env, process.platform);
