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

  debug(message: string, ...args: any[]): void {
    if (Logger.getLogLevel() <= LogLevel.DEBUG) {
      console.debug(`[DEBUG] [${this.context}] ${message}`, ...args);
    }
  }

  info(message: string, ...args: any[]): void {
    if (Logger.getLogLevel() <= LogLevel.INFO) {
      console.log(`[INFO] [${this.context}] ${message}`, ...args);
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
 */
export class Logger {
  private delegate: ILogger;
  private static logLevel: LogLevel = LogLevel.INFO;

  constructor(context: string) {
    this.delegate = loggerFactory.createLogger(context);
  }

  public static setLogLevel(level: LogLevel): void {
    Logger.logLevel = level;
  }

  public static getLogLevel(): LogLevel {
    return Logger.logLevel;
  }

  public debug(message: string, ...args: any[]): void {
    this.delegate.debug(message, ...args);
  }

  public info(message: string, ...args: any[]): void {
    this.delegate.info(message, ...args);
  }

  public warn(message: string, ...args: any[]): void {
    this.delegate.warn(message, ...args);
  }

  public error(message: string, error?: Error | unknown): void {
    this.delegate.error(message, error);
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
