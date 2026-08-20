/**
 * Portable logging facade for RAGnarōk core
 * Uses a pluggable factory pattern — call setLoggerFactory() at bootstrap time
 * Default fallback: ConsoleLogger (no VS Code dependency)
 */

import { LogLevel, ILogger, ILoggerFactory } from "./interfaces";
export { LogLevel };

/**
 * Console-based logger factory (default fallback)
 */
class ConsoleLoggerFactory implements ILoggerFactory {
  createLogger(context: string): ILogger {
    return new ConsoleLogger(context);
  }
}

class ConsoleLogger implements ILogger {
  constructor(private context: string) {}

  // Diagnostics go to stderr: stdout may be owned by a protocol stream
  // (e.g. MCP stdio transport), and mixing log text into it corrupts framing.
  debug(message: string, ...args: any[]): void {
    if (Logger.getLogLevel() <= LogLevel.DEBUG) {
      console.error(`[DEBUG] [${this.context}] ${message}`, ...args);
    }
  }

  info(message: string, ...args: any[]): void {
    if (Logger.getLogLevel() <= LogLevel.INFO) {
      console.error(`[INFO] [${this.context}] ${message}`, ...args);
    }
  }

  warn(message: string, ...args: any[]): void {
    if (Logger.getLogLevel() <= LogLevel.WARN) {
      console.warn(`[WARN] [${this.context}] ${message}`, ...args);
    }
  }

  error(message: string, error?: Error | unknown): void {
    if (Logger.getLogLevel() <= LogLevel.ERROR) {
      console.error(`[ERROR] [${this.context}] ${message}`, error ?? "");
    }
  }
}

let loggerFactory: ILoggerFactory = new ConsoleLoggerFactory();

/**
 * Set the global logger factory. Call once at bootstrap time.
 * VS Code extension passes VsCodeLoggerFactory, MCP server passes ConsoleLoggerFactory.
 */
export function setLoggerFactory(factory: ILoggerFactory): void {
  loggerFactory = factory;
}

/**
 * Logger class that delegates to the configured factory.
 * Drop-in replacement — existing code keeps `new Logger('context')` unchanged.
 *
 * The delegate is resolved lazily so Loggers constructed before
 * setLoggerFactory() (e.g. at module import time) still pick up the
 * bootstrapped factory instead of keeping a stale default delegate.
 */
export class Logger {
  private context: string;
  private delegate: ILogger | null = null;
  private delegateSource: ILoggerFactory | null = null;
  private static logLevel: LogLevel = LogLevel.INFO;

  constructor(context: string) {
    this.context = context;
  }

  public static setLogLevel(level: LogLevel): void {
    Logger.logLevel = level;
  }

  public static getLogLevel(): LogLevel {
    return Logger.logLevel;
  }

  private getDelegate(): ILogger {
    if (this.delegate === null || this.delegateSource !== loggerFactory) {
      this.delegate = loggerFactory.createLogger(this.context);
      this.delegateSource = loggerFactory;
    }
    return this.delegate;
  }

  public debug(message: string, ...args: any[]): void {
    this.getDelegate().debug(message, ...args);
  }

  public info(message: string, ...args: any[]): void {
    this.getDelegate().info(message, ...args);
  }

  public warn(message: string, ...args: any[]): void {
    this.getDelegate().warn(message, ...args);
  }

  public error(message: string, error?: Error | unknown): void {
    this.getDelegate().error(message, error);
  }
}

/**
 * Extract a user-friendly message from an error and strip local file-system paths
 * to avoid leaking usernames/directory structures in notifications.
 */
export function sanitizeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\/Users\/[\w/.-]+/g, "<path>").replace(/C:\\[\w\\.-]+/g, "<path>");
}
