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
