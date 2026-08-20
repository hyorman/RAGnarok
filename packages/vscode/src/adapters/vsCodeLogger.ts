/**
 * VS Code implementation of ILoggerFactory / ILogger
 * Wraps vscode.window.createOutputChannel()
 */

import * as vscode from "vscode";
import { ILogger, ILoggerFactory, LogLevel, CONFIG } from "@ragnarok/core";
import { VSCODE_CONFIG } from "../constants";

export class VsCodeLogger implements ILogger {
  private static outputChannel: vscode.OutputChannel | null = null;
  private static logLevel: LogLevel = LogLevel.INFO;

  constructor(private context: string) {
    if (!VsCodeLogger.outputChannel) {
      VsCodeLogger.outputChannel = vscode.window.createOutputChannel("RAGnarōk");
      VsCodeLogger.refreshLogLevel();
    }
  }

  public static setLogLevel(level: LogLevel): void {
    VsCodeLogger.logLevel = level;
  }

  public static getConfiguredLogLevel(): LogLevel {
    const config = vscode.workspace.getConfiguration(VSCODE_CONFIG.ROOT);
    const levelStr = config.get<string>(CONFIG.LOG_LEVEL, "info").toLowerCase();
    switch (levelStr) {
      case "debug":
        return LogLevel.DEBUG;
      case "info":
        return LogLevel.INFO;
      case "warn":
        return LogLevel.WARN;
      case "error":
        return LogLevel.ERROR;
      default:
        return LogLevel.INFO;
    }
  }

  public static refreshLogLevel(): void {
    VsCodeLogger.logLevel = VsCodeLogger.getConfiguredLogLevel();
  }

  debug(message: string, ...args: any[]): void {
    this.log(LogLevel.DEBUG, message, args);
  }

  info(message: string, ...args: any[]): void {
    this.log(LogLevel.INFO, message, args);
  }

  warn(message: string, ...args: any[]): void {
    this.log(LogLevel.WARN, message, args);
  }

  error(message: string, error?: Error | unknown): void {
    this.log(LogLevel.ERROR, message, error);
    if (error instanceof Error && error.stack) {
      VsCodeLogger.outputChannel?.appendLine(error.stack);
    }
  }

  private log(level: LogLevel, message: string, data?: any): void {
    if (level < VsCodeLogger.logLevel) {
      return;
    }

    const timestamp = new Date().toISOString();
    const levelStr = LogLevel[level];
    const prefix = `[${timestamp}] [${levelStr}] [${this.context}]`;

    VsCodeLogger.outputChannel?.appendLine(`${prefix} ${message}`);

    if (data !== undefined && data !== null) {
      try {
        if (typeof data === "object") {
          VsCodeLogger.outputChannel?.appendLine(JSON.stringify(data, null, 2));
        } else {
          VsCodeLogger.outputChannel?.appendLine(String(data));
        }
      } catch (err) {
        VsCodeLogger.outputChannel?.appendLine(`[Error stringifying data: ${err}]`);
      }
    }
  }

  public static show(): void {
    VsCodeLogger.outputChannel?.show();
  }

  public static clear(): void {
    VsCodeLogger.outputChannel?.clear();
  }

  public static dispose(): void {
    VsCodeLogger.outputChannel?.dispose();
    VsCodeLogger.outputChannel = null;
  }
}

export class VsCodeLoggerFactory implements ILoggerFactory {
  createLogger(context: string): ILogger {
    return new VsCodeLogger(context);
  }
}
