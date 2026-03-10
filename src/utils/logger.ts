/**
 * Logging utility for RAGnarōk
 * Provides structured logging with different levels and context
 */

import * as vscode from 'vscode';
import { CONFIG } from './constants';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export class Logger {
  private context: string;
  private static outputChannel: vscode.OutputChannel | null = null;
  private static logLevel: LogLevel = LogLevel.INFO;

  constructor(context: string) {
    this.context = context;

    if (!Logger.outputChannel) {
      Logger.outputChannel = vscode.window.createOutputChannel('RAGnarōk');
      Logger.refreshLogLevel();
    }
  }

  /**
   * Set global log level
   */
  public static setLogLevel(level: LogLevel): void {
    Logger.logLevel = level;
  }

  /**
   * Get log level from configuration
   */
  public static getConfiguredLogLevel(): LogLevel {
    const config = vscode.workspace.getConfiguration(CONFIG.ROOT);
    const levelStr = config.get<string>(CONFIG.LOG_LEVEL, 'info').toLowerCase();

    switch (levelStr) {
      case 'debug':
        return LogLevel.DEBUG;
      case 'info':
        return LogLevel.INFO;
      case 'warn':
        return LogLevel.WARN;
      case 'error':
        return LogLevel.ERROR;
      default:
        return LogLevel.INFO;
    }
  }

  /**
   * Log debug message
   */
  public debug(message: string, ...args: any[]): void {
    this.log(LogLevel.DEBUG, message, args);
  }

  /**
   * Log info message
   */
  public info(message: string, ...args: any[]): void {
    this.log(LogLevel.INFO, message, args);
  }

  /**
   * Log warning message
   */
  public warn(message: string, ...args: any[]): void {
    this.log(LogLevel.WARN, message, args);
  }

  /**
   * Log error message
   */
  public error(message: string, error?: Error | unknown): void {
    this.log(LogLevel.ERROR, message, error);

    if (error instanceof Error && error.stack) {
      Logger.outputChannel?.appendLine(error.stack);
    }
  }

  /**
   * Internal log method
   */
  private log(level: LogLevel, message: string, data?: any): void {
    // Check if we should log this level
    if (level < Logger.logLevel) {
      return;
    }

    const timestamp = new Date().toISOString();
    const levelStr = LogLevel[level];
    const prefix = `[${timestamp}] [${levelStr}] [${this.context}]`;

    Logger.outputChannel?.appendLine(`${prefix} ${message}`);

    if (data !== undefined && data !== null) {
      try {
        if (typeof data === 'object') {
          Logger.outputChannel?.appendLine(JSON.stringify(data, null, 2));
        } else {
          Logger.outputChannel?.appendLine(String(data));
        }
      } catch (err) {
        Logger.outputChannel?.appendLine(`[Error stringifying data: ${err}]`);
      }
    }
  }

  /**
   * Refresh log level from workspace configuration
   */
  public static refreshLogLevel(): void {
    Logger.logLevel = Logger.getConfiguredLogLevel();
  }

  /**
   * Show the output channel
   */
  public show(): void {
    Logger.outputChannel?.show();
  }

  /**
   * Clear the output channel
   */
  public static clear(): void {
    Logger.outputChannel?.clear();
  }

  /**
   * Dispose the output channel
   */
  public static dispose(): void {
    Logger.outputChannel?.dispose();
    Logger.outputChannel = null;
  }
}

/**
 * Extract a user-friendly message from an error and strip local file-system paths
 * to avoid leaking usernames/directory structures in VS Code notifications.
 */
export function sanitizeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\/Users\/[\w/.-]+/g, '<path>')
    .replace(/C:\\[\w\\.-]+/g, '<path>');
}
