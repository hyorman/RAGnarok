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
